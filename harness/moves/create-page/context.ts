import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { MoveContext, SubmitResult } from "../../move-types";

type WidgetInfo = { type: string; description: string };

type WidgetSpec = { type: string; [key: string]: unknown };

type PageBlock =
  | { kind: "widget"; widget: WidgetSpec }
  | { kind: "module"; module: "actions" | "git"; [key: string]: unknown }
  | { kind: "text"; markdown: string; [key: string]: unknown };

type PagePanelItem = { kind: "widget"; widget: WidgetSpec };

type PageLayoutNode =
  | {
      kind: "grid";
      id?: string;
      columns: number;
      gap?: number;
      templateColumns?: string[];
      templateRows?: string[];
      children: PageLayoutNode[];
    }
  | {
      kind: "panel";
      id?: string;
      title?: string;
      mode?: "list" | "tabs";
      columnSpan?: number;
      rowSpan?: number;
      items: PagePanelItem[];
    };

type ConfigPage = {
  id: string;
  title: string;
  blocks?: PageBlock[];
  layout?: PageLayoutNode;
  padding?: number;
};

const WIDGETS: WidgetInfo[] = [
  { type: "account", description: "Account/session identity and provider account details." },
  { type: "agent-activity", description: "Live view of agent activity in the current workspace." },
  { type: "claude-pricing", description: "Claude pricing reference widget." },
  { type: "code-editor", description: "Embedded editor for project files." },
  { type: "config-inspector", description: "Inspect runtime config and resolved settings." },
  { type: "deep-analytics", description: "Expanded analytics and trends for sessions and usage." },
  { type: "default-agent", description: "Shows or controls the default agent/profile." },
  { type: "extensions", description: "Installed extensions and extension state." },
  { type: "moves", description: "Available moves and move activation UI." },
  { type: "persistent-terminal", description: "Persistent terminal; for page scopes use ownerType=page and ownerName=pageid:label." },
  { type: "processes", description: "Running process list." },
  { type: "profile-card", description: "Profile summary card." },
  { type: "project-theme", description: "Current project theme info and controls." },
  { type: "provider-status", description: "Provider connectivity and availability." },
  { type: "provider-usage", description: "Provider usage and budget metrics." },
  { type: "session-control", description: "Controls for the active session." },
  { type: "session-edits", description: "Recent file edits for the session." },
  { type: "session-info", description: "Metadata for the current session." },
  { type: "session-list", description: "Sidebar-style list of sessions." },
  { type: "session-terminal", description: "Terminal tied to the active session." },
  { type: "sessions", description: "General sessions overview widget." },
  { type: "stats", description: "Compact project/session statistics." },
  { type: "terminals", description: "Registry/list of terminals." },
];

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function listExistingPages(cwd: string): Array<{ file: string; preview: string }> {
  const pagesDir = join(cwd, ".modus", "pages");
  if (!existsSync(pagesDir)) return [];

  return readdirSync(pagesDir)
    .filter((name) => name.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const fullPath = join(pagesDir, name);
      const text = readText(fullPath) ?? "";
      return {
        file: name,
        preview: text.slice(0, 1200).trim(),
      };
    });
}

function detectWidgetTypes(cwd: string): string[] {
  const widgetDir = join(cwd, "harness", "ui", "src", "widgets");
  if (!existsSync(widgetDir)) return WIDGETS.map((widget) => widget.type);
  return readdirSync(widgetDir)
    .filter((name) => name.endsWith(".widget.tsx"))
    .map((name) => name.replace(".widget.tsx", ""))
    .sort((a, b) => a.localeCompare(b));
}

function formatWidgetSection(cwd: string): string {
  const detected = new Set(detectWidgetTypes(cwd));
  const described = WIDGETS
    .filter((widget) => detected.has(widget.type))
    .map((widget) => `- \`${widget.type}\` - ${widget.description}`);

  const undocumented = [...detected]
    .filter((type) => !WIDGETS.some((widget) => widget.type === type))
    .map((type) => `- \`${type}\``);

  return [
    ...described,
    ...(undocumented.length > 0 ? ["", "Additional detected widget types:", ...undocumented] : []),
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validatePageBlock(block: unknown, path: string): string | null {
  if (!isRecord(block)) return `${path} must be an object`;
  if (block.kind === "widget") {
    if (!isRecord(block.widget)) return `${path}.widget must be an object`;
    if (typeof block.widget.type !== "string" || !block.widget.type.trim()) {
      return `${path}.widget.type must be a non-empty string`;
    }
    return null;
  }
  if (block.kind === "module") {
    if (block.module !== "actions" && block.module !== "git") {
      return `${path}.module must be "actions" or "git"`;
    }
    return null;
  }
  if (block.kind === "text") {
    if (typeof block.markdown !== "string") return `${path}.markdown must be a string`;
    return null;
  }
  return `${path}.kind must be "widget", "module", or "text"`;
}

function validatePanelItem(item: unknown, path: string): string | null {
  if (!isRecord(item)) return `${path} must be an object`;
  if (item.kind !== "widget") return `${path}.kind must be "widget"`;
  if (!isRecord(item.widget)) return `${path}.widget must be an object`;
  if (typeof item.widget.type !== "string" || !item.widget.type.trim()) {
    return `${path}.widget.type must be a non-empty string`;
  }
  return null;
}

function validateLayoutNode(node: unknown, path: string): string | null {
  if (!isRecord(node)) return `${path} must be an object`;
  if (node.kind === "grid") {
    if (!Number.isInteger(node.columns) || Number(node.columns) < 1) {
      return `${path}.columns must be an integer >= 1`;
    }
    if (!Array.isArray(node.children)) return `${path}.children must be an array`;
    for (let i = 0; i < node.children.length; i += 1) {
      const error = validateLayoutNode(node.children[i], `${path}.children[${i}]`);
      if (error) return error;
    }
    return null;
  }
  if (node.kind === "panel") {
    if (!Array.isArray(node.items) || node.items.length === 0) {
      return `${path}.items must be a non-empty array`;
    }
    for (let i = 0; i < node.items.length; i += 1) {
      const error = validatePanelItem(node.items[i], `${path}.items[${i}]`);
      if (error) return error;
    }
    if (node.mode !== undefined && node.mode !== "list" && node.mode !== "tabs") {
      return `${path}.mode must be "list" or "tabs"`;
    }
    if (node.columnSpan !== undefined && (!Number.isInteger(node.columnSpan) || Number(node.columnSpan) < 1)) {
      return `${path}.columnSpan must be an integer >= 1`;
    }
    if (node.rowSpan !== undefined && (!Number.isInteger(node.rowSpan) || Number(node.rowSpan) < 1)) {
      return `${path}.rowSpan must be an integer >= 1`;
    }
    return null;
  }
  return `${path}.kind must be "grid" or "panel"`;
}

function validateConfigPage(data: Record<string, unknown>): string | null {
  if (typeof data.id !== "string" || !data.id.trim()) return "id is required";
  if (typeof data.title !== "string" || !data.title.trim()) return "title is required";
  if (!Array.isArray(data.blocks) && !isRecord(data.layout)) {
    return "page must include either blocks or layout";
  }
  if (data.blocks !== undefined) {
    if (!Array.isArray(data.blocks)) return "blocks must be an array";
    for (let i = 0; i < data.blocks.length; i += 1) {
      const error = validatePageBlock(data.blocks[i], `blocks[${i}]`);
      if (error) return error;
    }
  }
  if (data.layout !== undefined) {
    const error = validateLayoutNode(data.layout, "layout");
    if (error) return error;
  }
  if (data.padding !== undefined && typeof data.padding !== "number") {
    return "padding must be a number";
  }
  return null;
}

export async function gather(ctx: MoveContext): Promise<string> {
  const pages = listExistingPages(ctx.cwd);
  const pageSummary = pages.length > 0
    ? pages.map((page) => `- \`${page.file}\`\n\`\`\`json\n${page.preview}\n\`\`\``).join("\n\n")
    : "No existing page files found in `.modus/pages/`.";

  return [
    "# Create Page Move",
    "",
    "You are inside the `create-page` move.",
    "Your job is to create or edit a page config in `.modus/pages/<id>.json`.",
    "Ask the user what layout they want if they have not already been specific enough. If they are specific enough, build the page immediately.",
    "When the page config is ready, submit the full page object through `modus_submit`.",
    "",
    "## Existing pages",
    pageSummary,
    "",
    "## Available widget types",
    formatWidgetSection(ctx.cwd),
    "",
    "## Page file schema",
    "- Submit a single `ConfigPage` object, not a `{ pages: [...] }` wrapper.",
    "- Required fields: `id`, `title`, and at least one of `layout` or `blocks`.",
    "- Normal output for this move should use `layout` unless the user explicitly wants top-level blocks.",
    "- The saved file path will be `.modus/pages/<id>.json`.",
    "",
    "```ts",
    "type ConfigPage = {",
    "  id: string;",
    "  title: string;",
    "  padding?: number;",
    "  blocks?: Array<",
    "    | { kind: \"widget\"; widget: { type: string; [key: string]: unknown } }",
    "    | { kind: \"module\"; module: \"actions\" | \"git\"; [key: string]: unknown }",
    "    | { kind: \"text\"; markdown: string; [key: string]: unknown }",
    "  >;",
    "  layout?:",
    "    | {",
    "        kind: \"grid\";",
    "        id?: string;",
    "        columns: number;",
    "        gap?: number;",
    "        templateColumns?: string[];",
    "        templateRows?: string[];",
    "        children: PageLayoutNode[];",
    "      }",
    "    | {",
    "        kind: \"panel\";",
    "        id?: string;",
    "        title?: string;",
    "        mode?: \"list\" | \"tabs\";",
    "        columnSpan?: number;",
    "        rowSpan?: number;",
    "        items: Array<{ kind: \"widget\"; widget: { type: string; [key: string]: unknown } }>;",
    "      };",
    "};",
    "```",
    "",
    "## Important constraints",
    "- `layout.kind = \"grid\"` requires `columns` and `children`.",
    "- `layout.kind = \"panel\"` requires `items` and every item must be `{ kind: \"widget\", widget: { type: ... } }`.",
    "- For `persistent-terminal`, use `ownerType: \"page\"` and `ownerName: \"<page-id>:<label>\"`.",
    "- Keep widget-specific extra fields inside `widget`.",
    "",
    "## Example snippets",
    "Simple 2x2 terminal page:",
    "```json",
    "{",
    "  \"id\": \"terminals-2x2\",",
    "  \"title\": \"terminals 2x2\",",
    "  \"padding\": 0,",
    "  \"layout\": {",
    "    \"kind\": \"grid\",",
    "    \"columns\": 2,",
    "    \"gap\": 12,",
    "    \"children\": [",
    "      {",
    "        \"kind\": \"panel\",",
    "        \"id\": \"term-a\",",
    "        \"mode\": \"tabs\",",
    "        \"items\": [",
    "          {",
    "            \"kind\": \"widget\",",
    "            \"widget\": {",
    "              \"id\": \"terminal-a\",",
    "              \"type\": \"persistent-terminal\",",
    "              \"ownerType\": \"page\",",
    "              \"ownerName\": \"terminals-2x2:terminal-a\"",
    "            }",
    "          }",
    "        ]",
    "      }",
    "    ]",
    "  }",
    "}",
    "```",
    "",
    "Cockpit reference: `.modus/pages/cockpit.json` is a larger working example with a session rail, editor, persistent terminals, processes, and terminals widgets.",
    "",
    "## Submit",
    `Call \`modus_submit\` with token \`${ctx.token}\` and the full page object matching this shape: \`${ctx.schema}\``,
    `Date: ${ctx.date ?? "unknown"}`,
  ].join("\n");
}

export async function onSubmit(
  ctx: MoveContext,
  data: Record<string, unknown>,
): Promise<SubmitResult> {
  const error = validateConfigPage(data);
  if (error) return { error };

  const page = data as unknown as ConfigPage;
  const pagesDir = join(ctx.cwd, ".modus", "pages");
  mkdirSync(pagesDir, { recursive: true });

  const filePath = join(pagesDir, `${page.id}.json`);
  writeFileSync(filePath, `${JSON.stringify(page, null, 2)}\n`, "utf-8");

  return {
    message: `Page saved to ${filePath}`,
  };
}
