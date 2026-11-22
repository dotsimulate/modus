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

// Antigravity spells its arguments in PascalCase (`Path`, `TargetFile`,
// `CommandLine`, `Content`).
const PATH_KEYS = [
  "file_path", "filePath", "target_file", "target_directory", "directory", "path", "notebook_path",
  "Path", "TargetFile", "AbsolutePath",
] as const;
const COMMAND_KEYS = ["command", "cmd", "script", "CommandLine"] as const;
const WRITE_CONTENT_KEYS = ["content", "contents", "Content"] as const;

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

export type ToolEditHunk = { oldString: string; newString: string };

/**
 * Every replacement an edit call carries: Claude `old_string`/`new_string`, a
 * MultiEdit-style `edits` array, Antigravity `edit_file` (`Target`/`Replacement`),
 * or Antigravity `ReplacementChunks` of `TargetContent`/`ReplacementContent`.
 * Empty when the input carries none.
 */
export function toolEditHunks(input: Record<string, unknown> | undefined): ToolEditHunk[] {
  if (!input) return [];
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  if (Array.isArray(input.edits)) {
    return (input.edits as Array<Record<string, unknown>>).map((edit) => ({
      oldString: text(edit?.old_string),
      newString: text(edit?.new_string),
    }));
  }
  if (Array.isArray(input.ReplacementChunks)) {
    return (input.ReplacementChunks as Array<Record<string, unknown>>).map((chunk) => ({
      oldString: text(chunk?.TargetContent),
      newString: text(chunk?.ReplacementContent),
    }));
  }
  if (typeof input.old_string === "string" || typeof input.new_string === "string") {
    return [{ oldString: text(input.old_string), newString: text(input.new_string) }];
  }
  if (typeof input.Target === "string" || typeof input.Replacement === "string") {
    return [{ oldString: text(input.Target), newString: text(input.Replacement) }];
  }
  return [];
}

export type ToolFamily ="read" | "write" | "edit" | "shell" | "todo" | "grep" | "list" | "web";

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
    || key === "editfile"
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
    || key === "runcommand"
  ) return "shell";
  if (key === "todowrite") return "todo";
  if (key === "grep" || key === "grepsearch") return "grep";
  if (key === "ls" || key === "listdir" || key === "listdirectory") return "list";
  if (
    key === "websearch"
    || key === "searchweb"
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
