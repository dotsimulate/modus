import { relative, sep } from "path";

export type EntityKind =
  | "page"
  | "move"
  | "action"
  | "agent-profile"
  | "user-profile"
  | "theme"
  | "font"
  | "panel-layout"
  | "dashboard"
  | "ui-extensions"
  | "memory"
  | "global-config";

export type EntityRef = {
  kind: EntityKind;
  id: string;
};

export function projectEntities(absPath: string, workTree: string): EntityRef[] {
  const rel = relative(workTree, absPath).split(sep).join("/");
  if (!rel || rel.startsWith("..")) return [];

  const parts = rel.split("/");
  const top = parts[0];

  if (top === "pages" && parts.length === 2 && parts[1]!.endsWith(".json")) {
    return [{ kind: "page", id: parts[1]!.replace(/\.json$/, "") }];
  }

  if (top === "moves" && parts.length >= 2) {
    return [{ kind: "move", id: parts[1]! }];
  }

  if (top === "actions" && parts.length >= 2) {
    return [{ kind: "action", id: parts[1]! }];
  }

  if (top === "profiles" && parts[1] === "agents" && parts.length === 3 && parts[2]!.endsWith(".json")) {
    return [{ kind: "agent-profile", id: parts[2]!.replace(/\.json$/, "") }];
  }

  if (top === "themes" && parts.length >= 2) {
    return [{ kind: "theme", id: parts.length === 2 ? parts[1]!.replace(/\.css$/, "") : parts[1]! }];
  }

  if (top === "fonts" && parts.length >= 2) {
    return [{ kind: "font", id: parts.length === 2 ? parts[1]!.replace(/\.(css|woff2?|ttf|otf)$/, "") : parts[1]! }];
  }

  if (top === "memory" && parts.length >= 2) {
    return [{ kind: "memory", id: parts.slice(1).join("/").replace(/\.md$/, "") }];
  }

  if (rel === "_global.json") {
    return [{ kind: "global-config", id: "project" }];
  }

  if (top === "ui" && parts[1] === "profiles") {
    if (parts.length === 4 && parts[3]!.endsWith(".json")) {
      const userName = parts[3]!.replace(/\.json$/, "");
      return uiSliceEntities(userName);
    }
  }

  return [];
}

export function userEntities(absPath: string, workTree: string): EntityRef[] {
  const rel = relative(workTree, absPath).split(sep).join("/");
  if (!rel || rel.startsWith("..")) return [];

  const parts = rel.split("/");
  const top = parts[0];

  if (top === "agents" && parts.length === 2 && parts[1]!.endsWith(".json")) {
    return [{ kind: "agent-profile", id: parts[1]!.replace(/\.json$/, "") }];
  }

  if (top === "users" && parts.length === 2 && parts[1]!.endsWith(".json")) {
    return [{ kind: "user-profile", id: parts[1]!.replace(/\.json$/, "") }];
  }

  if (top === "ui" && parts[1] === "agents" && parts.length === 3 && parts[2]!.endsWith(".json")) {
    return [{ kind: "agent-profile", id: parts[2]!.replace(/\.json$/, "") }];
  }

  if (top === "ui" && parts[1] === "users" && parts.length === 3 && parts[2]!.endsWith(".json")) {
    const userName = parts[2]!.replace(/\.json$/, "");
    return uiSliceEntities(userName);
  }

  if (rel === "_global.json") {
    return [{ kind: "global-config", id: "user" }];
  }

  if (rel === "_users.json") {
    return [{ kind: "global-config", id: "user-data" }];
  }

  if (rel === "prompt-cache.json") {
    return [{ kind: "global-config", id: "prompt-cache" }];
  }

  return [];
}

function uiSliceEntities(userName: string): EntityRef[] {
  return [
    { kind: "panel-layout", id: userName },
    { kind: "dashboard", id: userName },
    { kind: "ui-extensions", id: userName },
  ];
}
