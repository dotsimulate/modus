#!/usr/bin/env bun
import { ModusClient } from "./client";
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
  sessions   [--limit <n>] [--active]
  status     <session-id>
  messages   <session-id> [--seq <n>]
  stop       <session-id>
  archive    <session-id>
  profiles   [--cwd <path>]
  moves      --cwd <path>
  activate   <session-id> <move-name> --cwd <path> [--inputs '{"k":"v"}']

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
      if (flags.active === "true") {
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

    default:
      console.error(`Unknown command: ${command}`);
      usage();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
