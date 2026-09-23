import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { APP_PATHS } from "../../app-paths";
import type { MoveApiHandler, MoveContext } from "../../move-types";
import { startMission } from "../../mission-runner";

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function listMissionDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function summarizeMission(root: string, name: string): string {
  const missionDir = join(root, name);
  const missionJson = readText(join(missionDir, "mission.json"));
  const brief = readText(join(missionDir, "brief.md"));
  const status = readText(join(missionDir, "context", "status.md"));

  const parts: string[] = [`- \`${name}\``];

  if (missionJson) {
    parts.push("  mission.json:");
    parts.push("  ```json");
    parts.push(missionJson.slice(0, 1500).trim());
    parts.push("  ```");
  }
  if (brief) {
    parts.push("  brief.md:");
    parts.push("  ```md");
    parts.push(brief.slice(0, 1200).trim());
    parts.push("  ```");
  }
  if (status) {
    parts.push("  context/status.md:");
    parts.push("  ```md");
    parts.push(status.slice(0, 800).trim());
    parts.push("  ```");
  }

  return parts.join("\n");
}

export async function gather(ctx: MoveContext): Promise<string> {
  const missionRoot = join(ctx.cwd, ".modus", "missions");
  const skillPath = [
    join(ctx.cwd, ".claude", "skills", "create-mission", "SKILL.md"),
    join(ctx.cwd, ".modus", "skills", "create-mission", "SKILL.md"),
    join(APP_PATHS.resourcesDir, "templates", "skills", "create-mission", "SKILL.md"),
  ].find((path) => Boolean(readText(path)?.trim()));
  const missionNames = listMissionDirs(missionRoot);

  ctx.setStore?.({
    userProfile: ctx.userProfile,
  });

  const missionSummary = missionNames.length > 0
    ? missionNames.slice(0, 5).map((name) => summarizeMission(missionRoot, name)).join("\n\n")
    : "No missions exist yet in `.modus/missions/`.";

  return [
    "# Create Mission Move",
    "",
    "You are inside the `create-mission` move.",
    "Your only job in this move is to create, revise, duplicate, and optionally start missions.",
    "Do not do the mission's actual domain work yourself. Do not pivot into product design or implementation work.",
    "",
    "## Required workflow",
    skillPath
      ? `- Read and follow the create-mission skill at \`${skillPath}\` before writing mission files.`
      : "- No readable create-mission skill is available in this project or the packaged resources. Use the requirements below to create the mission, and do not claim to have followed a skill.",
    "- Treat this as a mission-creation wrapper around the skill when available.",
    "- Default to creating a new mission.",
    "- If the user asks to edit an existing mission, edit it in place.",
    "- If the user asks to duplicate a mission, copy and adapt it cleanly.",
    "- Follow the user's shape closely. Do not over-prescribe the mission.",
    "- Keep the brief goal-oriented and structural so the orchestrator can plan at runtime.",
    "",
    "## Conversation behavior",
    "- If the user is uncertain, exploratory, or asking questions, discuss the mission first and ask focused follow-up questions.",
    "- If the user is clear enough, create the real mission scaffold immediately.",
    "- If the user's first message is effectively 'create this mission and start it', create it and then start it.",
    "- If the user only wants the mission defined, create or revise it and stop there.",
    "- If the user is uncertain, do not start it without confirmation.",
    "",
    "## Required files",
    "- Create the real mission scaffold in `.modus/missions/<name>/`.",
    "- At minimum write `mission.json`, `brief.md`, and `context/status.md`.",
    "",
    "## Start behavior",
    "- You may start a mission from this move only after the files are written and the user has asked to start it or clearly confirmed starting it.",
    "- When starting, use the `start-mission` operation provided by this move. Do not merely tell the user that they can start it later.",
    "",
    `Create-mission skill path: ${skillPath ?? "unavailable"}`,
    ctx.apiToken
      ? [
          "",
          "## Mission start operation",
          `Token: \`${ctx.apiToken}\``,
          "",
          "When the mission exists on disk and the user wants it started, call:",
          "```json",
          `{ "token": "${ctx.apiToken}", "data": { "op": "start-mission", "missionName": "<mission-name>" } }`,
          "```",
          "Only do this after the mission files are written and the directory name matches the mission name you are starting.",
        ].join("\n")
      : "",
    "",
    "## Existing mission context",
    missionSummary,
    "",
    `Today: ${ctx.date ?? "unknown"}`,
    "",
    "Stay inside the mission-creator role for the rest of this move.",
  ].join("\n");
}

export const handlers: Record<string, MoveApiHandler> = {
  "start-mission": async (ctx, data) => {
    const missionName = typeof data.missionName === "string" ? data.missionName.trim() : "";
    if (!missionName) {
      return { ok: false, error: "missionName is required" };
    }

    const stored = ctx.store<{ userProfile?: string }>() ?? {};
    const result = await startMission({
      missionName,
      cwd: ctx.cwd,
      userProfile: stored.userProfile,
    });

    if ("error" in result) {
      return { ok: false, error: result.error };
    }

    return {
      ok: true,
      message: `Mission "${missionName}" started. Run ID: ${result.runId}.`,
    };
  },
};
