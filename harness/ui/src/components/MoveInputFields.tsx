import { useEffect, useState } from "react";
import type { KeyboardEvent } from "react";
import type {
  MoveInput, MoveInputOption, MoveInputOptionsSource, MoveInputVisibilityRule, MoveListItem, ProjectInfo, SessionInfo,
} from "../../../sdk/index";
import { modus } from "../modusClient";
import { basename, timeAgo } from "../utils/format";
import { CustomSelect } from "./CustomSelect";

type Values = Record<string, string>;
type Variant = "prompt-picker" | "moves-widget";

type DynamicData = {
  projects: ProjectInfo[];
  sessions: SessionInfo[];
  loading: boolean;
};

type ResolveContext = {
  values: Values;
  profileNames: string[];
  projectCwd?: string;
  allowedProjectPaths?: string[];
  data: DynamicData;
};

function normalizePath(value: string | null | undefined): string {
  return (value ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function projectMatches(projectPath: string, cwd?: string): boolean {
  const project = normalizePath(projectPath);
  const current = normalizePath(cwd);
  if (!project || !current) return false;
  return current === project || current.startsWith(`${project}/`);
}

function trimText(value: string | null | undefined, max = 34): string {
  const text = (value ?? "").trim();
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function inputString(value: string | undefined): string {
  return value ?? "";
}

function coerceOption(option: string | MoveInputOption): MoveInputOption {
  return typeof option === "string"
    ? { value: option, label: option }
    : option;
}

function sourceType(input: MoveInput): MoveInputOptionsSource["type"] | null {
  if (input.optionsSource) return input.optionsSource.type;
  if (input.options === "{{agentProfiles}}") return "agentProfiles";
  return null;
}

function usesDynamicData(inputs: MoveInput[] | undefined, kind: "projects" | "sessions"): boolean {
  return (inputs ?? []).some((input) => sourceType(input) === kind);
}

function buildProjectOptions(
  input: MoveInput,
  projectCwd: string | undefined,
  projects: ProjectInfo[],
  allowedProjectPaths?: string[],
): MoveInputOption[] {
  const allowed = new Set((allowedProjectPaths ?? []).map(normalizePath));
  const currentProject = normalizePath(projectCwd);
  const seen = new Set<string>();
  const options: MoveInputOption[] = [];

  if (input.optionsSource?.defaultToCurrent && currentProject && projectCwd) {
    seen.add(currentProject);
    const currentEntry = projects.find((project) => projectMatches(project.path, projectCwd));
    options.push({
      value: projectCwd,
      label: currentEntry
        ? `${currentEntry.name} (current) · ${currentEntry.path}`
        : `${basename(projectCwd)} (current) · ${projectCwd}`,
    });
  }

  for (const project of projects) {
    const normalized = normalizePath(project.path);
    if (!project.pathExists || seen.has(normalized)) continue;
    if (allowed.size > 0 && !allowed.has(normalized) && !projectMatches(project.path, projectCwd)) continue;
    seen.add(normalized);
    options.push({
      value: project.path,
      label: projectMatches(project.path, projectCwd)
        ? `${project.name} (current) · ${project.path}`
        : `${project.name} · ${project.path}`,
    });
  }

  return options;
}

function buildSessionOptions(
  input: MoveInput,
  values: Values,
  projectCwd: string | undefined,
  sessions: SessionInfo[],
): MoveInputOption[] {
  const targetProject = normalizePath(
    input.optionsSource?.projectField
      ? values[input.optionsSource.projectField]
      : projectCwd,
  );
  const options: MoveInputOption[] = [];

  if (input.optionsSource?.emptyLabel) {
    options.push({ value: "", label: input.optionsSource.emptyLabel });
  }

  if (!targetProject) return options;

  for (const session of sessions) {
    if (!projectMatches(targetProject, session.cwd ?? undefined)) continue;
    const display = trimText(session.title || session.preview || "untitled session");
    const profile = trimText(session.profile || "no-agent", 16);
    options.push({
      value: session.id,
      label: `${display} · ${profile} · ${timeAgo(session.updated_at)}`,
    });
  }

  return options;
}

function resolveOptions(input: MoveInput, ctx: ResolveContext): MoveInputOption[] {
  const kind = sourceType(input);
  if (kind === "agentProfiles") {
    return ctx.profileNames.map((name) => ({ value: name, label: name }));
  }
  if (kind === "projects") {
    return buildProjectOptions(input, ctx.projectCwd, ctx.data.projects, ctx.allowedProjectPaths);
  }
  if (kind === "sessions") {
    return buildSessionOptions(input, ctx.values, ctx.projectCwd, ctx.data.sessions);
  }
  if (Array.isArray(input.options)) {
    return input.options.map(coerceOption);
  }
  if (typeof input.options === "string" && input.options.trim()) {
    return input.options.split("|").map((entry) => entry.trim()).filter(Boolean).map((entry) => ({
      value: entry,
      label: entry,
    }));
  }
  return [];
}

function visibilityMatches(rule: MoveInputVisibilityRule | undefined, values: Values): boolean {
  if (!rule) return true;
  const value = inputString(values[rule.input]).trim();
  if (rule.equals !== undefined && value !== rule.equals) return false;
  if (rule.notEquals !== undefined && value === rule.notEquals) return false;
  if (rule.isEmpty && value.length > 0) return false;
  if (rule.notEmpty && value.length === 0) return false;
  return true;
}

function preferredSelectValue(
  input: MoveInput,
  options: MoveInputOption[],
  currentValue: string,
  projectCwd?: string,
): string {
  if (currentValue && options.some((option) => option.value === currentValue)) return currentValue;

  const rawDefault = stringifyDefault(input.default);
  if (rawDefault && options.some((option) => option.value === rawDefault)) return rawDefault;

  if (input.optionsSource?.type === "projects" && input.optionsSource.defaultToCurrent && projectCwd) {
    const current = options.find((option) => projectMatches(option.value, projectCwd));
    if (current) return current.value;
  }

  return options[0]?.value ?? "";
}

export function stringifyDefault(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return value ? "yes" : "";
  return String(value);
}

export function isMoveInputVisible(input: MoveInput, values: Values): boolean {
  return visibilityMatches(input.visibleWhen, values);
}

export function buildMoveInputs(
  move: MoveListItem,
  values: Values,
  resolveInputOptions: (input: MoveInput) => MoveInputOption[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const input of move.inputs ?? []) {
    if (!isMoveInputVisible(input, values)) continue;
    const raw = values[input.name] ?? stringifyDefault(input.default);
    if (input.type === "toggle") {
      result[input.name] = raw === "yes";
      continue;
    }
    if (input.type === "number") {
      const trimmed = raw.trim();
      if (trimmed) result[input.name] = Number(trimmed);
      continue;
    }
    if (input.type === "select") {
      result[input.name] = preferredSelectValue(input, resolveInputOptions(input), raw);
      continue;
    }
    if (raw.trim()) result[input.name] = raw;
  }
  return result;
}

export function isMoveInputReady(
  move: MoveListItem,
  values: Values,
  resolveInputOptions: (input: MoveInput) => MoveInputOption[],
  dynamicLoading: boolean,
): boolean {
  return (move.inputs ?? []).every((input) => {
    if (!isMoveInputVisible(input, values)) return true;
    if (!input.required) return true;
    if (input.type === "toggle") return values[input.name] !== undefined;
    if (input.type === "select") {
      if (dynamicLoading && sourceType(input)) return false;
      return preferredSelectValue(input, resolveInputOptions(input), values[input.name] ?? "", undefined).length > 0;
    }
    return !!String(values[input.name] ?? stringifyDefault(input.default)).trim();
  });
}

function useDynamicMoveInputData(
  inputs: MoveInput[] | undefined,
  userProfile?: string,
): DynamicData {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const needsProjects = usesDynamicData(inputs, "projects");
    const needsSessions = usesDynamicData(inputs, "sessions");
    if (!needsProjects && !needsSessions) {
      setProjects([]);
      setSessions([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    Promise.all([
      needsProjects ? modus.listProjects() : Promise.resolve([]),
      needsSessions ? modus.listSessions({ limit: 250, userProfile }) : Promise.resolve([]),
    ]).then(([projectRows, sessionRows]) => {
      if (cancelled) return;
      setProjects(projectRows);
      setSessions(sessionRows);
      setLoading(false);
    }).catch(() => {
      if (cancelled) return;
      setProjects([]);
      setSessions([]);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [inputs, userProfile]);

  return { projects, sessions, loading };
}

export function useMoveInputResolver(args: {
  inputs: MoveInput[] | undefined;
  values: Values;
  profileNames: string[];
  projectCwd?: string;
  userProfile?: string;
  allowedProjectPaths?: string[];
}) {
  const data = useDynamicMoveInputData(args.inputs, args.userProfile);
  const resolveInputOptions = (input: MoveInput) => resolveOptions(input, {
    values: args.values,
    profileNames: args.profileNames,
    projectCwd: args.projectCwd,
    allowedProjectPaths: args.allowedProjectPaths,
    data,
  });
  return { resolveInputOptions, dynamicLoading: data.loading };
}

export function MoveInputFields({
  inputs,
  values,
  profileNames,
  projectCwd,
  userProfile,
  allowedProjectPaths,
  onChange,
  variant,
  autoFocusFirst = false,
  onKeyDown,
}: {
  inputs: MoveInput[];
  values: Values;
  profileNames: string[];
  projectCwd?: string;
  userProfile?: string;
  allowedProjectPaths?: string[];
  onChange: (name: string, value: string) => void;
  variant: Variant;
  autoFocusFirst?: boolean;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
}) {
  const { resolveInputOptions } = useMoveInputResolver({
    inputs,
    values,
    profileNames,
    projectCwd,
    userProfile,
    allowedProjectPaths,
  });

  const visibleInputs = inputs.filter((input) => isMoveInputVisible(input, values));

  useEffect(() => {
    const updates: Array<{ name: string; value: string }> = [];
    for (const input of visibleInputs) {
      if (input.type !== "select") continue;
      const nextValue = preferredSelectValue(input, resolveInputOptions(input), values[input.name] ?? "", projectCwd);
      if ((values[input.name] ?? "") !== nextValue) {
        updates.push({ name: input.name, value: nextValue });
      }
    }
    for (const update of updates) onChange(update.name, update.value);
  }, [onChange, projectCwd, resolveInputOptions, values, visibleInputs]);

  return (
    <>
      {visibleInputs.map((input, index) => {
        const label = input.label ?? input.name;
        const currentValue = values[input.name] ?? "";
        const autoFocus = autoFocusFirst && index === 0;

        if (input.type === "select") {
          const resolvedValue = preferredSelectValue(input, resolveInputOptions(input), currentValue, projectCwd);
          if (variant === "prompt-picker") {
            return (
              <div key={input.name} className="prompt-picker-select">
                <span className="prompt-picker-select-label">{label}</span>
                <div className="prompt-picker-select-row">
                  <CustomSelect
                    options={resolveInputOptions(input)}
                    value={resolvedValue}
                    placeholder={input.placeholder ?? label}
                    onChange={(value) => onChange(input.name, value)}
                  />
                </div>
              </div>
            );
          }

          return (
            <div key={input.name} className="moves-input-field">
              <label className="moves-input-label">
                {label}
                {input.required && <span className="moves-input-required">*</span>}
              </label>
              <CustomSelect
                options={resolveInputOptions(input)}
                value={resolvedValue}
                placeholder={input.placeholder ?? label}
                onChange={(value) => onChange(input.name, value)}
              />
            </div>
          );
        }

        if (input.type === "toggle") {
          const checked = (currentValue || stringifyDefault(input.default) || "no") === "yes";
          const toggleLabel = input.label
            ?? input.placeholder?.replace(/\s*\(yes\/no\)\s*/i, "")
            ?? input.name;
          return variant === "prompt-picker" ? (
            <label key={input.name} className="prompt-picker-toggle">
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => onChange(input.name, e.target.checked ? "yes" : "")}
              />
              <span>{toggleLabel}</span>
            </label>
          ) : (
            <div key={input.name} className="moves-input-field">
              <label className="moves-input-toggle">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => onChange(input.name, e.target.checked ? "yes" : "")}
                />
                <span>{toggleLabel}</span>
              </label>
            </div>
          );
        }

        if (input.type === "textarea") {
          return variant === "prompt-picker" ? (
            <textarea
              key={input.name}
              className="prompt-picker-textarea"
              value={currentValue}
              onChange={(e) => onChange(input.name, e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={label}
              rows={3}
              autoFocus={autoFocus}
              spellCheck={false}
            />
          ) : (
            <div key={input.name} className="moves-input-field">
              <label className="moves-input-label">
                {label}
                {input.required && <span className="moves-input-required">*</span>}
              </label>
              <textarea
                className="moves-input-control moves-input-textarea"
                value={currentValue}
                onChange={(e) => onChange(input.name, e.target.value)}
                placeholder={input.placeholder}
                rows={3}
              />
            </div>
          );
        }

        return variant === "prompt-picker" ? (
          <input
            key={input.name}
            className="prompt-picker-input"
            value={currentValue}
            onChange={(e) => onChange(input.name, e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={label}
            autoFocus={autoFocus}
            spellCheck={false}
            type={input.type === "number" ? "number" : "text"}
          />
        ) : (
          <div key={input.name} className="moves-input-field">
            <label className="moves-input-label">
              {label}
              {input.required && <span className="moves-input-required">*</span>}
            </label>
            <input
              className="moves-input-control"
              type={input.type === "number" ? "number" : "text"}
              value={currentValue}
              onChange={(e) => onChange(input.name, e.target.value)}
              placeholder={input.placeholder}
            />
          </div>
        );
      })}
    </>
  );
}
