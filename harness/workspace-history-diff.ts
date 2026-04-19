import type { EntityRef, EntityKind } from "./workspace-entities";

export type JsonDiffOp =
  | { type: "add"; path: string; value: unknown }
  | { type: "remove"; path: string; value: unknown }
  | { type: "change"; path: string; from: unknown; to: unknown };

export type EntityDiff = {
  ref: EntityRef;
  format: "json" | "text";
  ops?: JsonDiffOp[];
  textDiff?: string;
  summary: string;
};

const JSON_KINDS: Set<string> = new Set<string>([
  "page", "move", "action", "agent-profile", "user-profile",
  "panel-layout", "dashboard", "ui-extensions", "global-config",
]);

function isJsonBacked(kind: EntityKind): boolean {
  return JSON_KINDS.has(kind);
}

function jsonDiffRecursive(a: unknown, b: unknown, path: string): JsonDiffOp[] {
  if (a === b) return [];

  if (
    a === null || b === null ||
    typeof a !== typeof b ||
    typeof a !== "object" ||
    Array.isArray(a) !== Array.isArray(b)
  ) {
    return [{ type: "change", path, from: a, to: b }];
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (JSON.stringify(a) === JSON.stringify(b)) return [];
    return [{ type: "change", path, from: a, to: b }];
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const allKeys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
  const ops: JsonDiffOp[] = [];

  for (const key of allKeys) {
    const childPath = `${path}.${key}`;
    if (!(key in aObj)) {
      ops.push({ type: "add", path: childPath, value: bObj[key] });
    } else if (!(key in bObj)) {
      ops.push({ type: "remove", path: childPath, value: aObj[key] });
    } else {
      ops.push(...jsonDiffRecursive(aObj[key], bObj[key], childPath));
    }
  }

  return ops;
}

function computeTextDiff(from: string, to: string): string {
  const fromLines = from.split("\n");
  const toLines = to.split("\n");
  const m = fromLines.length;
  const n = toLines.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = fromLines[i - 1] === toLines[j - 1]
        ? dp[i - 1]![j - 1]! + 1
        : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }

  const result: { marker: string; line: string }[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && fromLines[i - 1] === toLines[j - 1]) {
      result.unshift({ marker: " ", line: fromLines[i - 1]! });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      result.unshift({ marker: "+", line: toLines[j - 1]! });
      j--;
    } else {
      result.unshift({ marker: "-", line: fromLines[i - 1]! });
      i--;
    }
  }

  return result.map((r) => `${r.marker}${r.line}`).join("\n");
}

export function entityDiff(
  ref: EntityRef,
  fromContent: string | null,
  toContent: string | null,
): EntityDiff {
  if (!fromContent && !toContent) {
    return { ref, format: "text", summary: "no content" };
  }

  if (!fromContent && toContent) {
    if (isJsonBacked(ref.kind)) {
      try {
        const parsed = JSON.parse(toContent);
        return {
          ref, format: "json",
          ops: [{ type: "add", path: "$", value: parsed }],
          summary: "entity added",
        };
      } catch { /* fall through to text */ }
    }
    return {
      ref, format: "text",
      textDiff: toContent.split("\n").map((l) => `+${l}`).join("\n"),
      summary: "entity added",
    };
  }

  if (fromContent && !toContent) {
    if (isJsonBacked(ref.kind)) {
      try {
        const parsed = JSON.parse(fromContent);
        return {
          ref, format: "json",
          ops: [{ type: "remove", path: "$", value: parsed }],
          summary: "entity deleted",
        };
      } catch { /* fall through to text */ }
    }
    return {
      ref, format: "text",
      textDiff: fromContent.split("\n").map((l) => `-${l}`).join("\n"),
      summary: "entity deleted",
    };
  }

  if (fromContent === toContent) {
    return { ref, format: "text", summary: "no changes" };
  }

  if (isJsonBacked(ref.kind)) {
    try {
      const a = JSON.parse(fromContent!);
      const b = JSON.parse(toContent!);
      const ops = jsonDiffRecursive(a, b, "$");
      const summary = ops.length === 0
        ? "no changes"
        : `${ops.length} ${ops.length === 1 ? "property" : "properties"} changed`;
      return { ref, format: "json", ops, summary };
    } catch { /* fall through to text */ }
  }

  const diff = computeTextDiff(fromContent!, toContent!);
  const added = diff.split("\n").filter((l) => l.startsWith("+")).length;
  const removed = diff.split("\n").filter((l) => l.startsWith("-")).length;
  return {
    ref, format: "text", textDiff: diff,
    summary: `+${added} -${removed} lines`,
  };
}
