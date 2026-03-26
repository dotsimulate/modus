#!/usr/bin/env bun
import { ModusClient, ModusError } from "./client";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const DEFAULT_URL = process.env.MODUS_URL ?? "http://localhost:3777";
const DEFAULT_TOKEN = process.env.MODUS_TOKEN ?? "";
const DEFAULT_PIN = process.env.MODUS_PIN ?? "";

function loadPin(): string {
  if (DEFAULT_PIN) return DEFAULT_PIN;
  // Read from secrets file (same source as the server)
  const secretsPath = process.env.HARNESS_SECRETS_FILE
    ?? join(homedir(), ".config", "agent-dev-zone", "secrets.env");
  if (existsSync(secretsPath)) {
    const content = readFileSync(secretsPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("HARNESS_PIN=")) {
        let val = trimmed.slice("HARNESS_PIN=".length).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
          val = val.slice(1, -1);
        return val;
      }
    }
  }
  return "";
}

function client(): ModusClient {
  const token = DEFAULT_TOKEN || undefined;
  const pin = token ? undefined : loadPin() || undefined;
  return new ModusClient({ url: DEFAULT_URL, token, pin });
}

function usage(): never {
  console.log(`Usage: modus <command> [options]

Commands:
  interact   [--profile <name>] [--session <id>] [--mode bypass|interactive] <prompt>
  send       <session-id> <prompt> [--moves name1,name2]
  sessions   [--limit <n>] [--active] [--archived]
  status     <session-id>
  messages   <session-id> [--seq <n>]
  stop       <session-id>
  archive    <session-id>
  unarchive  <session-id>
  branch     <session-id> <seq>
  search     <query> [--limit <n>]
  tag        <session-id> add|remove <tag>
  config     <session-id> --model <model> --provider <provider>
  pause      <session-id>
  resume     <session-id>
  permit     <session-id> <request-id> allow|deny
  steer      <session-id> <prompt>
  profiles   [--cwd <path>]
  providers
  provider   <name> models
  moves      --cwd <path>
  move       <name> --cwd <path>
  activate   <session-id> <move-name> --cwd <path> [--inputs '{"k":"v"}']
  ambient    <session-id> [remove <move-name>]
  actions    [--user-profile <name>]
  action     <name> [enable|disable]
  trigger    <name> [--user-profile <name>]
  runs       <action-name> [--limit <n>]
  missions   --cwd <path>
  mission    start <name> --cwd <path> | <run-id> [pause|resume]
  git        status|log --cwd <path> [--limit <n>]
  memories   [--cwd <path>] [--user-profile <name>]
  activity   [--limit <n>] [--user-profile <name>]
  stats      [--user-profile <name>]
  prompts    [--cwd <path>]

Environment:
  MODUS_URL    Server URL (default: http://localhost:3777)
  MODUS_TOKEN  Auth token`);
  process.exit(1);
}

function parseArgs(args: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(args[i]);
    }
  }
  return { flags, positional };
}

async function streamToConsole(handle: { events: AsyncIterable<import("./types").SSEEvent>; abort: () => void }, debug = false) {
  for await (const evt of handle.events) {
    const d = evt.data as any;
    if (debug) console.error(`[debug] event=${evt.event} type=${d?.type} subtype=${d?.subtype} keys=${Object.keys(d ?? {}).join(",")}`);

    if (evt.event === "stream_event") {
      // Streaming deltas — text is nested inside d.event
      const inner = d?.event;
      if (inner?.type === "content_block_delta") {
        const delta = inner.delta;
        if (delta?.type === "text_delta" && delta.text) {
          process.stdout.write(delta.text);
        }
      }
    } else if (evt.event === "result") {
      // Turn complete — print final text and exit
      const text = d?.text as string;
      if (text) process.stdout.write(text);
      console.log();
      handle.abort();
      return;
    } else if (evt.event === "error" || d?.type === "error") {
      console.error(`\n[error] ${d?.message ?? d?.error ?? JSON.stringify(d)}`);
      handle.abort();
      return;
    }
    // Silently skip: system, user, status, ping, tool_use, tool_result, etc.
  }
  console.log(); // trailing newline
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();

  const command = args[0];
  const { flags, positional } = parseArgs(args.slice(1));
  const c = client();

  switch (command) {
    case "interact": {
      const prompt = positional.join(" ");
      if (!prompt) { console.error("Error: prompt required"); process.exit(1); }
      const handle = await c.interact({
        prompt,
        profile: flags.profile,
        sessionId: flags.session,
        permissionMode: (flags.mode as "bypass" | "interactive") ?? "bypass",
        subscribe: true,
      });
      await streamToConsole(handle, flags.debug === "true");
      break;
    }

    case "send": {
      const sessionId = positional[0];
      const prompt = positional.slice(1).join(" ");
      if (!sessionId || !prompt) { console.error("Error: session-id and prompt required"); process.exit(1); }
      const moves = flags.moves?.split(",").map(name => ({ name: name.trim() }));
      const result = await c.sendMessage(sessionId, { prompt, moves });
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case "sessions": {
      if (flags.archived === "true") {
        const sessions = await c.listArchivedSessions(Number(flags.limit) || 20);
        for (const s of sessions) {
          console.log(`${s.id}  archived  ${s.preview.slice(0, 60)}`);
        }
      } else if (flags.active === "true") {
        const sessions = await c.getActiveSessions();
        console.log(JSON.stringify(sessions, null, 2));
      } else {
        const sessions = await c.listSessions({ limit: Number(flags.limit) || 20 });
        for (const s of sessions) {
          const profile = s.profile ? ` [${s.profile}]` : "";
          const status = s.status;
          console.log(`${s.id}  ${status.padEnd(8)}${profile}  ${s.preview.slice(0, 60)}`);
        }
      }
      break;
    }

    case "status": {
      const id = positional[0];
      if (!id) { console.error("Error: session-id required"); process.exit(1); }
      const status = await c.getSessionStatus(id);
      console.log(JSON.stringify(status, null, 2));
      break;
    }

    case "messages": {
      const id = positional[0];
      if (!id) { console.error("Error: session-id required"); process.exit(1); }
      const seq = flags.seq ? Number(flags.seq) : undefined;
      const msgs = await c.getMessages(id, seq);
      const arr = Array.isArray(msgs) ? msgs : [msgs];
      for (const m of arr) {
        console.log(`\n--- ${m.role} (seq ${m.seq}) ---`);
        console.log(m.text);
      }
      break;
    }

    case "stop": {
      const id = positional[0];
      if (!id) { console.error("Error: session-id required"); process.exit(1); }
      await c.stopSession(id);
      console.log("Stopped.");
      break;
    }

    case "archive": {
      const id = positional[0];
      if (!id) { console.error("Error: session-id required"); process.exit(1); }
      await c.archiveSession(id);
      console.log("Archived.");
      break;
    }

    case "profiles": {
      const profiles = await c.listProfiles(flags.cwd);
      for (const p of profiles) {
        console.log(`${p.name.padEnd(20)} ${p.description}`);
      }
      break;
    }

    case "moves": {
      if (!flags.cwd) { console.error("Error: --cwd required"); process.exit(1); }
      const moves = await c.listMoves(flags.cwd);
      for (const m of moves) {
        const tags = m.tags?.length ? ` [${m.tags.join(", ")}]` : "";
        console.log(`${m.name.padEnd(20)} ${m.description}${tags}`);
      }
      break;
    }

    case "activate": {
      const sessionId = positional[0];
      const moveName = positional[1];
      if (!sessionId || !moveName) { console.error("Error: session-id and move-name required"); process.exit(1); }
      if (!flags.cwd) { console.error("Error: --cwd required"); process.exit(1); }
      const inputs = flags.inputs ? JSON.parse(flags.inputs) : {};
      const result = await c.activateMove(sessionId, moveName, inputs, flags.cwd);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    // ── Phase A: Session Management ──

    case "branch": {
      const id = positional[0];
      const seq = Number(positional[1]);
      if (!id || !seq) { console.error("Error: session-id and seq required"); process.exit(1); }
      const result = await c.branchSession(id, seq);
      console.log(`Branched → ${result.sessionId}`);
      break;
    }

    case "search": {
      const query = positional.join(" ");
      if (!query) { console.error("Error: query required"); process.exit(1); }
      const results = await c.searchSessions(query, { limit: Number(flags.limit) || 20 });
      for (const s of results) {
        console.log(`${s.id}  ${s.status.padEnd(8)}  ${s.preview.slice(0, 60)}`);
      }
      break;
    }

    case "tag": {
      const id = positional[0];
      const action = positional[1];
      const tag = positional[2];
      if (!id || !action || !tag) { console.error("Error: session-id add|remove tag required"); process.exit(1); }
      if (action === "add") await c.addTag(id, tag);
      else if (action === "remove") await c.removeTag(id, tag);
      else { console.error("Error: action must be add or remove"); process.exit(1); }
      const tags = await c.getTags(id);
      console.log(`Tags: ${tags.join(", ")}`);
      break;
    }

    case "config": {
      const id = positional[0];
      if (!id) { console.error("Error: session-id required"); process.exit(1); }
      const config: Record<string, unknown> = {};
      if (flags.model) config.model = flags.model;
      if (flags.provider) config.provider = flags.provider;
      await c.updateConfig(id, config);
      console.log("Config updated.");
      break;
    }

    case "pause": {
      const id = positional[0];
      if (!id) { console.error("Error: session-id required"); process.exit(1); }
      const result = await c.pauseSession(id);
      console.log(`Paused → ${result.status}`);
      break;
    }

    case "resume": {
      const id = positional[0];
      if (!id) { console.error("Error: session-id required"); process.exit(1); }
      const result = await c.resumeSession(id);
      console.log(`Resumed → ${result.status}`);
      break;
    }

    case "permit": {
      const id = positional[0];
      const requestId = positional[1];
      const behavior = positional[2] as "allow" | "deny";
      if (!id || !requestId || !behavior) { console.error("Error: session-id request-id allow|deny required"); process.exit(1); }
      await c.respondToPermission(id, { requestId, behavior });
      console.log(`Permission ${behavior}ed.`);
      break;
    }

    case "steer": {
      const id = positional[0];
      const prompt = positional.slice(1).join(" ");
      if (!id || !prompt) { console.error("Error: session-id and prompt required"); process.exit(1); }
      await c.steerSession(id, prompt);
      console.log("Steered.");
      break;
    }

    case "unarchive": {
      const id = positional[0];
      if (!id) { console.error("Error: session-id required"); process.exit(1); }
      await c.unarchiveSession(id);
      console.log("Unarchived.");
      break;
    }

    // ── Phase B: Actions ──

    case "actions": {
      const actions = await c.listActions(flags["user-profile"]);
      for (const a of actions) {
        const status = a.enabled === false ? "disabled" : "enabled";
        console.log(`${(a.name ?? "").padEnd(25)} ${status.padEnd(10)} ${a.description ?? ""}`);
      }
      break;
    }

    case "action": {
      const name = positional[0];
      if (!name) { console.error("Error: action name required"); process.exit(1); }
      const sub = positional[1];
      if (sub === "enable") {
        await c.patchAction(name, { enabled: true });
        console.log("Enabled.");
      } else if (sub === "disable") {
        await c.patchAction(name, { enabled: false });
        console.log("Disabled.");
      } else {
        const detail = await c.getAction(name);
        console.log(JSON.stringify(detail, null, 2));
      }
      break;
    }

    case "trigger": {
      const name = positional[0];
      if (!name) { console.error("Error: action name required"); process.exit(1); }
      await c.triggerAction(name, flags["user-profile"]);
      console.log("Triggered.");
      break;
    }

    case "runs": {
      const name = positional[0];
      if (!name) { console.error("Error: action name required"); process.exit(1); }
      const runs = await c.getActionRuns(name, Number(flags.limit) || 20);
      for (const r of runs) {
        console.log(`${String(r.id ?? "").padEnd(6)} ${(r.status ?? "").padEnd(10)} ${r.session_id ?? ""}`);
      }
      break;
    }

    // ── Phase C: Moves (extended) ──

    case "move": {
      const name = positional[0];
      if (!name || !flags.cwd) { console.error("Error: move name and --cwd required"); process.exit(1); }
      const move = await c.getMove(name, flags.cwd);
      console.log(JSON.stringify(move, null, 2));
      break;
    }

    case "ambient": {
      const sessionId = positional[0];
      if (!sessionId) { console.error("Error: session-id required"); process.exit(1); }
      if (positional[1] === "remove") {
        const moveName = positional[2];
        if (!moveName) { console.error("Error: move-name required"); process.exit(1); }
        await c.deactivateAmbient(sessionId, moveName);
        console.log("Deactivated.");
      } else {
        const moves = await c.listAmbientMoves(sessionId);
        for (const m of moves) console.log(`${m.moveName.padEnd(25)} activated ${new Date(m.activatedAt).toISOString()}`);
      }
      break;
    }

    // ── Phase D: Missions ──

    case "missions": {
      if (!flags.cwd) { console.error("Error: --cwd required"); process.exit(1); }
      const missions = await c.listMissions(flags.cwd);
      for (const m of missions) console.log(`${(m.name ?? "").padEnd(25)} ${m.description ?? ""}`);
      break;
    }

    case "mission": {
      const sub = positional[0];
      if (sub === "start") {
        const name = positional[1];
        if (!name) { console.error("Error: mission name required"); process.exit(1); }
        const result = await c.startMission({ missionName: name, cwd: flags.cwd, userProfile: flags["user-profile"] });
        console.log(JSON.stringify(result, null, 2));
      } else if (sub && !isNaN(Number(sub))) {
        const runId = Number(sub);
        const action = positional[1];
        if (action === "pause") {
          await c.pauseMission(runId);
          console.log("Paused.");
        } else if (action === "resume") {
          await c.resumeMission(runId);
          console.log("Resumed.");
        } else {
          const run = await c.getMissionRun(runId);
          console.log(JSON.stringify(run, null, 2));
        }
      } else {
        console.error("Error: mission start <name> | mission <run-id> [pause|resume]");
        process.exit(1);
      }
      break;
    }

    // ── Phase E: Providers ──

    case "providers": {
      const providers = await c.listProviders();
      const health = await c.getProviderHealth();
      const healthMap = new Map(health.map(h => [h.name, h.healthy]));
      for (const p of providers) {
        const h = healthMap.get(p.name) ? "✓" : "✗";
        console.log(`${h} ${(p.name ?? "").padEnd(20)} ${p.label ?? ""}`);
      }
      break;
    }

    case "provider": {
      const name = positional[0];
      const sub = positional[1];
      if (!name) { console.error("Error: provider name required"); process.exit(1); }
      if (sub === "models") {
        const models = await c.getProviderModels(name);
        for (const m of models) console.log(m);
      } else {
        console.error("Error: provider <name> models");
        process.exit(1);
      }
      break;
    }

    // ── Phase F: Infrastructure ──

    case "git": {
      const sub = positional[0];
      if (!flags.cwd) { console.error("Error: --cwd required"); process.exit(1); }
      if (sub === "status") {
        console.log(JSON.stringify(await c.gitStatus(flags.cwd), null, 2));
      } else if (sub === "log") {
        const entries = await c.gitLog(flags.cwd, Number(flags.limit) || 10);
        for (const e of entries) console.log(`${e.hash?.slice(0, 7)} ${e.message}`);
      } else {
        console.error("Error: git status|log");
        process.exit(1);
      }
      break;
    }

    case "memories": {
      const mems = await c.queryMemories({ cwd: flags.cwd, userProfile: flags["user-profile"] });
      console.log(JSON.stringify(mems, null, 2));
      break;
    }

    case "activity": {
      const entries = await c.getActivity({ limit: Number(flags.limit) || 20, userProfile: flags["user-profile"] });
      for (const e of entries) {
        console.log(`${(e.eventType ?? "").padEnd(20)} ${e.summary ?? ""}`);
      }
      break;
    }

    case "stats": {
      const stats = await c.getSessionStats(flags["user-profile"]);
      console.log(JSON.stringify(stats, null, 2));
      break;
    }

    case "prompts": {
      const prompts = await c.listPrompts({ projectCwd: flags.cwd });
      for (const p of prompts) console.log(`${(p.name ?? "").padEnd(25)} ${p.description ?? ""}`);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      usage();
  }
}

main().catch((err) => {
  if (err instanceof ModusError) {
    console.error(`Error ${err.status}: ${err.detail}`);
  } else {
    console.error(err.message ?? err);
  }
  process.exit(1);
});
