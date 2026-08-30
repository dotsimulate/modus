import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import { APP_PATHS } from "./app-paths";
import {
  getPluginLensesDir,
  getPluginProjectionsDir,
  listModusPlugins,
  type ModusPlugin,
} from "./modus-plugins";
import { isPluginAllowed } from "./vault-policy";
import { lintConversationLens } from "./ui/src/page-lint";
import { WIDGET_META } from "./ui/src/widgets/catalog";
import type {
  ConversationCapabilityId,
  ConversationLensDefinitionV1,
  ConversationLensRegistryEntry,
  ConversationProjectionDefinitionV1,
  ConversationProjectionRegistryEntry,
  ConversationResourceRegistry,
  ConversationResourceSource,
  ConversationResourceStatus,
} from "./sdk/types";

const CAPABILITIES = new Set<ConversationCapabilityId>([
  "conversation.permissions",
  "conversation.turn-content",
  "conversation.turn-index",
  "conversation.compose",
  "conversation.history",
  "conversation.artifacts",
]);

const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;

type ResourceKind = "lens" | "projection";

type SourceSpec = {
  kind: ConversationResourceSource["kind"];
  label: string;
  dir: string;
  plugin?: ModusPlugin;
  exposed?: Set<string>;
  active: boolean;
  disabledReason?: string;
};

type InternalLensEntry = ConversationLensRegistryEntry & { filePath: string };
type InternalProjectionEntry = ConversationProjectionRegistryEntry & {
  filePath: string;
  componentPath?: string;
};

function sourceKey(kind: string, filePath: string, pluginId?: string): string {
  const digest = createHash("sha256").update(filePath).digest("hex").slice(0, 16);
  return `${kind}:${pluginId ?? "local"}:${digest}`;
}

function sourceFor(spec: SourceSpec, filePath: string): ConversationResourceSource {
  return {
    kind: spec.kind,
    label: spec.label,
    ...(spec.plugin ? { pluginId: spec.plugin.id } : {}),
    key: sourceKey(spec.kind, filePath, spec.plugin?.id),
  };
}

function readJson(filePath: string): { value?: unknown; error?: string } {
  try {
    return { value: JSON.parse(readFileSync(filePath, "utf8")) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function validateCapabilities(value: unknown, field: string, errors: string[]): void {
  if (value == null) return;
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return;
  }
  for (const capability of value) {
    if (typeof capability !== "string" || !CAPABILITIES.has(capability as ConversationCapabilityId)) {
      errors.push(`${field} contains unsupported capability ${JSON.stringify(capability)}`);
    }
  }
}

function validateLayout(value: unknown, path = "layout", depth = 0): string[] {
  if (depth > 40) return [`${path} exceeds maximum nesting depth`];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [`${path} must be an object`];
  const node = value as Record<string, unknown>;
  const errors: string[] = [];
  const kind = node.kind;
  if (kind === "widget") {
    const widget = node.widget;
    if (!widget || typeof widget !== "object" || typeof (widget as Record<string, unknown>).type !== "string") {
      errors.push(`${path}.widget.type must be a string`);
    }
    return errors;
  }
  if (kind !== "grid" && kind !== "split" && kind !== "overlay" && kind !== "scope" && kind !== "tabs" && kind !== "list") {
    return [`${path}.kind is not a supported LayoutNode kind`];
  }
  if (kind === "grid" && (typeof node.columns !== "number" || node.columns < 1)) {
    errors.push(`${path}.columns must be a positive number`);
  }
  if (kind === "split" && node.axis !== "horizontal" && node.axis !== "vertical") {
    errors.push(`${path}.axis must be horizontal or vertical`);
  }
  if (!Array.isArray(node.children)) {
    errors.push(`${path}.children must be an array`);
    return errors;
  }
  node.children.forEach((child, index) => {
    errors.push(...validateLayout(child, `${path}.children[${index}]`, depth + 1));
  });
  return errors;
}

function resourceId(value: unknown, filePath: string): string {
  if (value && typeof value === "object" && typeof (value as Record<string, unknown>).id === "string") {
    return (value as Record<string, unknown>).id as string;
  }
  return basename(filePath).replace(/\.json$/i, "");
}

function commonDefinitionErrors(value: unknown, spec: SourceSpec, filePath: string): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["definition must be an object"];
  const definition = value as Record<string, unknown>;
  if (typeof definition.id !== "string" || !ID_PATTERN.test(definition.id)) {
    errors.push("id must match /^[a-z0-9][a-z0-9._:-]*$/");
  }
  if (typeof definition.label !== "string" || !definition.label.trim()) errors.push("label is required");
  if (spec.kind !== "harness" && typeof definition.id === "string" && definition.id.startsWith("core:")) {
    errors.push("the core: namespace is reserved for harness resources");
  }
  if (spec.exposed && typeof definition.id === "string" && !spec.exposed.has(definition.id)) {
    errors.push(`resource is not exposed by plugin manifest: ${definition.id}`);
  }
  if (relative(dirname(filePath), filePath).startsWith("..")) errors.push("resource path escaped its source directory");
  return errors;
}

function validateLens(value: unknown, spec: SourceSpec, filePath: string): { status: ConversationResourceStatus; errors: string[] } {
  const errors = commonDefinitionErrors(value, spec, filePath);
  if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "invalid", errors };
  const definition = value as Record<string, unknown>;
  if (definition.contract !== "conversation-lens@1") {
    return { status: "incompatible", errors: [...errors, `unsupported contract ${JSON.stringify(definition.contract)}`] };
  }
  errors.push(...validateLayout(definition.layout));
  if (definition.layouts != null) {
    if (!definition.layouts || typeof definition.layouts !== "object" || Array.isArray(definition.layouts)) {
      errors.push("layouts must be an object");
    } else {
      const mobile = (definition.layouts as Record<string, unknown>).mobile;
      if (mobile != null) errors.push(...validateLayout(mobile, "layouts.mobile"));
    }
  }
  if (definition.capabilities != null) {
    if (!definition.capabilities || typeof definition.capabilities !== "object" || Array.isArray(definition.capabilities)) {
      errors.push("capabilities must be an object");
    } else {
      const capabilities = definition.capabilities as Record<string, unknown>;
      validateCapabilities(capabilities.required, "capabilities.required", errors);
      validateCapabilities(capabilities.optional, "capabilities.optional", errors);
    }
  }
  return { status: errors.length ? "invalid" : "available", errors };
}

function safeComponentPath(dir: string, component: unknown): string | null {
  if (typeof component !== "string" || !component || isAbsolute(component)) return null;
  const absolute = resolve(dir, component);
  const rel = relative(dir, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return absolute;
}

function validateProjection(value: unknown, spec: SourceSpec, filePath: string): {
  status: ConversationResourceStatus;
  errors: string[];
  componentPath?: string;
} {
  const errors = commonDefinitionErrors(value, spec, filePath);
  if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "invalid", errors };
  const definition = value as Record<string, unknown>;
  if (definition.contract !== "conversation-projection@1") {
    return { status: "incompatible", errors: [...errors, `unsupported contract ${JSON.stringify(definition.contract)}`] };
  }
  const componentPath = safeComponentPath(dirname(filePath), definition.component);
  if (!componentPath) errors.push("component must be a relative path inside the projection directory");
  else if (!existsSync(componentPath)) errors.push(`component does not exist: ${definition.component}`);
  if (definition.cache != null && definition.cache !== "module" && definition.cache !== "none") {
    errors.push("cache must be module or none");
  }
  if (definition.capabilities != null) {
    if (!definition.capabilities || typeof definition.capabilities !== "object" || Array.isArray(definition.capabilities)) {
      errors.push("capabilities must be an object");
    } else {
      const capabilities = definition.capabilities as Record<string, unknown>;
      validateCapabilities(capabilities.consumes, "capabilities.consumes", errors);
      validateCapabilities(capabilities.provides, "capabilities.provides", errors);
    }
  }
  const modes = definition.modes;
  if (modes != null && (!Array.isArray(modes) || modes.some((mode) => !["lossless", "overview", "live", "read-only"].includes(String(mode))))) {
    errors.push("modes contains an unsupported value");
  }
  return { status: errors.length ? "invalid" : "available", errors, ...(componentPath ? { componentPath } : {}) };
}

function lensSources(cwd: string): SourceSpec[] {
  const plugins = listModusPlugins().filter((plugin) => !plugin.builtin);
  return [
    { kind: "project", label: "project", dir: join(cwd, ".modus", "lenses"), active: true },
    { kind: "vault", label: "Vault", dir: join(APP_PATHS.modusHome, "lenses"), active: true },
    ...plugins.map((plugin): SourceSpec => {
      const allowed = isPluginAllowed(plugin.id);
      return {
        kind: "plugin",
        label: plugin.name ?? plugin.id,
        dir: getPluginLensesDir(plugin),
        plugin,
        exposed: new Set(plugin.manifest.integration?.lenses ?? []),
        active: plugin.enabled && allowed,
        disabledReason: !plugin.enabled ? "plugin disabled" : !allowed ? "blocked by Vault policy" : undefined,
      };
    }),
    { kind: "harness", label: "Modus", dir: join(APP_PATHS.resourcesDir, "lenses"), active: true },
  ];
}

function projectionSources(cwd: string): SourceSpec[] {
  const plugins = listModusPlugins().filter((plugin) => !plugin.builtin);
  return [
    { kind: "project", label: "project", dir: join(cwd, ".modus", "projections"), active: true },
    { kind: "vault", label: "Vault", dir: join(APP_PATHS.modusHome, "projections"), active: true },
    ...plugins.map((plugin): SourceSpec => {
      const allowed = isPluginAllowed(plugin.id);
      return {
        kind: "plugin",
        label: plugin.name ?? plugin.id,
        dir: getPluginProjectionsDir(plugin),
        plugin,
        exposed: new Set(plugin.manifest.integration?.projections ?? []),
        active: plugin.enabled && allowed,
        disabledReason: !plugin.enabled ? "plugin disabled" : !allowed ? "blocked by Vault policy" : undefined,
      };
    }),
    { kind: "harness", label: "Modus", dir: join(APP_PATHS.resourcesDir, "projections"), active: true },
  ];
}

function scanLenses(cwd: string): InternalLensEntry[] {
  const entries: InternalLensEntry[] = [];
  for (const spec of lensSources(cwd)) {
    if (!existsSync(spec.dir)) continue;
    for (const name of readdirSync(spec.dir).filter((entry) => entry.endsWith(".json")).sort()) {
      const filePath = join(spec.dir, name);
      const parsed = readJson(filePath);
      const id = resourceId(parsed.value, filePath);
      if (spec.exposed && !spec.exposed.has(id)) continue;
      const source = sourceFor(spec, filePath);
      if (!spec.active) {
        entries.push({ id, status: "disabled", source, reason: spec.disabledReason, filePath });
        continue;
      }
      if (parsed.error) {
        entries.push({ id, status: "invalid", source, reason: parsed.error, filePath });
        continue;
      }
      const result = validateLens(parsed.value, spec, filePath);
      entries.push({
        id,
        status: result.status,
        source,
        ...(result.errors.length ? { reason: result.errors.join("; ") } : {}),
        ...(result.status === "available" ? { definition: parsed.value as ConversationLensDefinitionV1 } : {}),
        filePath,
      });
    }
  }
  return entries;
}

function scanProjections(cwd: string): InternalProjectionEntry[] {
  const entries: InternalProjectionEntry[] = [];
  for (const spec of projectionSources(cwd)) {
    if (!existsSync(spec.dir)) continue;
    for (const entry of readdirSync(spec.dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const filePath = join(spec.dir, entry.name, "projection.json");
      if (!existsSync(filePath)) continue;
      const parsed = readJson(filePath);
      const id = resourceId(parsed.value, filePath);
      if (spec.exposed && !spec.exposed.has(id)) continue;
      const source = sourceFor(spec, filePath);
      if (!spec.active) {
        entries.push({ id, status: "disabled", source, reason: spec.disabledReason, filePath });
        continue;
      }
      if (parsed.error) {
        entries.push({ id, status: "invalid", source, reason: parsed.error, filePath });
        continue;
      }
      const result = validateProjection(parsed.value, spec, filePath);
      entries.push({
        id,
        status: result.status,
        source,
        ...(result.errors.length ? { reason: result.errors.join("; ") } : {}),
        ...(result.status === "available" ? {
          definition: parsed.value as ConversationProjectionDefinitionV1,
          moduleUrl: `/api/conversation-projections/${encodeURIComponent(id)}/module?cwd=${encodeURIComponent(cwd)}&source=${encodeURIComponent(source.key)}`,
        } : {}),
        ...(result.componentPath ? { componentPath: result.componentPath } : {}),
        filePath,
      });
    }
  }
  return entries;
}

function selectWinners<T extends { id: string; status: ConversationResourceStatus; source: ConversationResourceSource; reason?: string }>(
  entries: T[],
): { winners: T[]; diagnostics: T[] } {
  const winners = new Map<string, T>();
  const diagnostics: T[] = [];
  for (const entry of entries) {
    // Authored core ids are invalid by contract and, more importantly, must
    // never occupy the first-wins slot ahead of the harness recovery resource.
    // Keep the attempted override visible without letting it shadow safety.
    if (entry.source.kind !== "harness" && entry.id.startsWith("core:")) {
      diagnostics.push(entry);
      continue;
    }
    if (entry.status === "disabled") {
      diagnostics.push(entry);
      continue;
    }
    const winner = winners.get(entry.id);
    if (!winner) {
      winners.set(entry.id, entry);
    } else {
      diagnostics.push({
        ...entry,
        status: "shadowed",
        reason: `shadowed by ${winner.source.label} (${winner.source.kind})`,
      });
    }
  }
  return { winners: [...winners.values()], diagnostics };
}

function projectionIdsInLayout(value: unknown, into = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return into;
  const node = value as Record<string, unknown>;
  if (node.kind === "widget") {
    const widget = node.widget as Record<string, unknown> | undefined;
    if (widget?.type === "conversation-projection" && typeof widget.projectionId === "string") {
      into.add(widget.projectionId);
    }
  }
  if (Array.isArray(node.children)) node.children.forEach((child) => projectionIdsInLayout(child, into));
  return into;
}

function withoutInternal<T extends object>(entry: T): Omit<T, "filePath" | "componentPath"> {
  const { filePath: _filePath, componentPath: _componentPath, ...publicEntry } = entry as T & {
    filePath?: string;
    componentPath?: string;
  };
  return publicEntry;
}

export function listConversationResources(cwd?: string | null): ConversationResourceRegistry {
  const resolvedCwd = cwd ?? "";
  const projectionSelection = selectWinners(scanProjections(resolvedCwd));
  const availableProjectionIds = new Set(
    projectionSelection.winners.filter((entry) => entry.status === "available").map((entry) => entry.id),
  );
  const lensSelection = selectWinners(scanLenses(resolvedCwd));
  const lenses = lensSelection.winners.map((entry) => {
    if (entry.status !== "available" || !entry.definition) return entry;
    const projectionIds = new Set([
      ...projectionIdsInLayout(entry.definition.layout),
      ...projectionIdsInLayout(entry.definition.layouts?.mobile),
    ]);
    const missing = [...projectionIds].filter((id) => !availableProjectionIds.has(id));
    if (missing.length > 0) {
      return { ...entry, status: "invalid" as const, reason: `projection unavailable: ${missing.join(", ")}` };
    }
    const lintErrors = lintConversationLens(
      entry.definition,
      WIDGET_META,
      projectionSelection.winners,
    ).filter((finding) => finding.severity === "error");
    return lintErrors.length > 0
      ? {
          ...entry,
          status: "invalid" as const,
          reason: lintErrors.map((finding) => `${finding.rule}: ${finding.message}`).join("; "),
        }
      : entry;
  });
  return {
    contract: "conversation-resources@1",
    cwd: resolvedCwd,
    lenses: lenses.map(withoutInternal) as ConversationLensRegistryEntry[],
    projections: projectionSelection.winners.map(withoutInternal) as ConversationProjectionRegistryEntry[],
    diagnostics: [
      ...lensSelection.diagnostics.map(withoutInternal),
      ...projectionSelection.diagnostics.map(withoutInternal),
    ] as Array<ConversationLensRegistryEntry | ConversationProjectionRegistryEntry>,
  };
}

export function resolveConversationProjectionComponent(
  id: string,
  cwd: string,
  expectedSourceKey: string,
): { entry: ConversationProjectionRegistryEntry; componentPath: string } | null {
  const selection = selectWinners(scanProjections(cwd));
  const entry = selection.winners.find((candidate) => candidate.id === id);
  if (!entry || entry.status !== "available" || !entry.definition || !entry.componentPath) return null;
  if (entry.source.key !== expectedSourceKey) return null;
  return { entry: withoutInternal(entry) as ConversationProjectionRegistryEntry, componentPath: entry.componentPath };
}
