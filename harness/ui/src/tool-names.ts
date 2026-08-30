/**
 * Fold the many spellings of one tool onto a single key.
 *
 * Providers disagree about casing (`Read`/`read`) and separators
 * (`todo_write` vs `TodoWrite`, `read_file` vs `Read`), so UI special-cases
 * have to match the folded form rather than any one provider's wire name.
 */
export function canonicalToolName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, "");
}

const PATH_KEYS = [
  "file_path", "filePath", "target_file", "target_directory", "directory", "path", "notebook_path",
] as const;
const COMMAND_KEYS = ["command", "cmd", "script"] as const;
const WRITE_CONTENT_KEYS = ["content", "contents"] as const;

export function toolInputPath(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

export function toolInputCommand(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of COMMAND_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string")) {
      return value.join(" ");
    }
  }
  return undefined;
}

export function toolWriteContent(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of WRITE_CONTENT_KEYS) {
    const value = input[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

export type ToolFamily = "read" | "write" | "edit" | "shell" | "todo" | "grep" | "list" | "web";

/**
 * Semantic family for the tools that have a dedicated transcript/activity card.
 * Unknown names return undefined so callers fall through to generic rendering.
 */
export function toolFamily(name: string): ToolFamily | undefined {
  const key = canonicalToolName(name);
  if (key === "read" || key === "readfile") return "read";
  if (key === "write" || key === "writefile") return "write";
  if (
    key === "edit"
    || key === "searchreplace"
    || key === "multiedit"
    || key === "notebookedit"
    || key === "applypatch"
    || key === "filechange"
  ) return "edit";
  if (
    key === "bash"
    || key === "shell"
    || key === "exec"
    || key === "powershell"
    || key === "commandexecution"
    || key === "runterminalcmd"
    || key === "runterminalcommand"
  ) return "shell";
  if (key === "todowrite") return "todo";
  if (key === "grep" || key === "grepsearch") return "grep";
  if (key === "ls" || key === "listdir" || key === "listdirectory") return "list";
  if (
    key === "websearch"
    || key === "webfetch"
    || key === "openpage"
    || key === "openpagewithfind"
    || key === "xsearch"
    || key === "xkeywordsearch"
    || key === "xsemanticsearch"
    || key === "xusersearch"
    || key === "xthreadfetch"
  ) return "web";
  return undefined;
}

export function isReadTool(name: string): boolean {
  return toolFamily(name) === "read";
}

export function isWriteTool(name: string): boolean {
  return toolFamily(name) === "write";
}

/** Write or in-place edit — the transcript diff/detail body. */
export function isDiffTool(name: string): boolean {
  const family = toolFamily(name);
  return family === "edit" || family === "write";
}

export function isShellTool(name: string): boolean {
  return toolFamily(name) === "shell";
}

/** Claude `TodoWrite`, Grok `todo_write`, and the same list under other separators. */
export function isTodoTool(name: string): boolean {
  return toolFamily(name) === "todo";
}

export function isGrepTool(name: string): boolean {
  return toolFamily(name) === "grep";
}

export function isListTool(name: string): boolean {
  return toolFamily(name) === "list";
}
