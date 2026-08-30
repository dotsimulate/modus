/**
 * Fold the many spellings of one tool onto a single key.
 *
 * Providers disagree about casing (`Read`/`read`) and separators
 * (`todo_write` vs `TodoWrite`), so UI special-cases have to match the
 * folded form rather than any one provider's wire name.
 */
export function canonicalToolName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, "");
}

/** Claude `TodoWrite`, Grok `todo_write`, and the same list under other separators. */
export function isTodoTool(name: string): boolean {
  return canonicalToolName(name) === "todowrite";
}
