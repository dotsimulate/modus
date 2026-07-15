import type {
  MoveContext,
  MoveApiContext,
  MoveApiHandler,
  SessionRef,
} from "../../../harness/move-types";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "fs";
import { join, relative } from "path";

type RoomMember = {
  sessionId: string;
  displayName: string;
  role?: string;
  joinedAt: string;
  notify: boolean;
};

type RoomMeta = {
  name: string;
  created: string;
  updated: string;
  members: RoomMember[];
  messageCount: number;
};

type RoomMessage = {
  seq: number;
  author: string;
  sessionId?: string;
  timestamp: string;
  filename: string;
  content?: string;
};

type RoomDetail = RoomMeta & {
  briefPath: string;
  brief: string;
  messages: RoomMessage[];
};

const ROOMS_DIR = ".modus/rooms";
const MAX_READ_CHARS = 5000;

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function roomDir(cwd: string, name: string): string {
  return join(cwd, ROOMS_DIR, name);
}

function roomsRoot(cwd: string): string {
  return join(cwd, ROOMS_DIR);
}

function nowIso(): string {
  return new Date().toISOString();
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function readRoomMeta(cwd: string, rawName: string): RoomMeta | null {
  const name = sanitizeName(rawName);
  if (!name) return null;
  return readJson<RoomMeta>(join(roomDir(cwd, name), "room.json"));
}

function writeRoomMeta(cwd: string, name: string, meta: RoomMeta): void {
  meta.updated = nowIso();
  writeFileSync(join(roomDir(cwd, name), "room.json"), JSON.stringify(meta, null, 2));
}

function defaultBrief(name: string, created: string, brief?: string): string {
  return [
    "---",
    `room: ${name}`,
    `created: ${created}`,
    "---",
    "",
    "# Room Brief",
    "",
    "This room is shared context for multiple Modus sessions.",
    "Members post concise updates, findings, requests, and handoffs as markdown messages.",
    "",
    brief?.trim() ? `## Context\n\n${brief.trim()}\n` : "",
  ].filter(Boolean).join("\n");
}

function ensureRoom(cwd: string, rawName: string, brief?: string): RoomMeta {
  const name = sanitizeName(rawName);
  if (!name) throw new Error("Invalid room name");

  const dir = roomDir(cwd, name);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let meta = readRoomMeta(cwd, name);
  if (!meta) {
    const created = nowIso();
    meta = {
      name,
      created,
      updated: created,
      members: [],
      messageCount: 0,
    };
    writeRoomMeta(cwd, name, meta);
  }

  const briefPath = join(dir, "brief.md");
  if (!existsSync(briefPath)) {
    writeFileSync(briefPath, defaultBrief(name, meta.created, brief));
  } else if (brief?.trim()) {
    writeFileSync(briefPath, defaultBrief(name, meta.created, brief));
  }

  return meta;
}

function listRoomNames(cwd: string): string[] {
  try {
    return readdirSync(roomsRoot(cwd), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !!readRoomMeta(cwd, name))
      .sort();
  } catch {
    return [];
  }
}

function listMessageFiles(cwd: string, roomName: string): string[] {
  try {
    return readdirSync(roomDir(cwd, roomName))
      .filter((file) => /^\d{3,}-.*-\d{13,}\.md$/.test(file))
      .sort();
  } catch {
    return [];
  }
}

function parseFrontMatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith("---\n")) return { meta: {}, body: raw };
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return { meta: {}, body: raw };
  const lines = raw.slice(4, end).split("\n");
  const meta: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: raw.slice(end + 5).trim() };
}

function readRoomBrief(cwd: string, roomName: string): string {
  try {
    return readFileSync(join(roomDir(cwd, roomName), "brief.md"), "utf-8");
  } catch {
    return "";
  }
}

function readRoomMessages(cwd: string, roomName: string, includeContent: boolean): RoomMessage[] {
  return listMessageFiles(cwd, roomName).map((filename) => {
    const match = filename.match(/^(\d{3,})-(.*)-(\d{13,})\.md$/);
    const fallback: RoomMessage = {
      seq: match?.[1] ? Number(match[1]) : 0,
      author: match?.[2] ?? "unknown",
      timestamp: match?.[3] ? new Date(Number(match[3])).toISOString() : "",
      filename,
    };
    try {
      const raw = readFileSync(join(roomDir(cwd, roomName), filename), "utf-8");
      const parsed = parseFrontMatter(raw);
      return {
        ...fallback,
        author: parsed.meta.author ?? fallback.author,
        sessionId: parsed.meta.session,
        timestamp: parsed.meta.timestamp ?? fallback.timestamp,
        content: includeContent ? parsed.body.slice(0, MAX_READ_CHARS) : undefined,
      };
    } catch {
      return fallback;
    }
  });
}

function readRoomDetail(cwd: string, rawName: string, includeContent: boolean): RoomDetail | null {
  const name = sanitizeName(rawName);
  const meta = readRoomMeta(cwd, name);
  if (!meta) return null;
  return {
    ...meta,
    briefPath: `${ROOMS_DIR}/${name}/brief.md`,
    brief: readRoomBrief(cwd, name),
    messages: readRoomMessages(cwd, name, includeContent),
  };
}

function sessionLabel(session: SessionRef | null, fallbackId: string): string {
  if (!session) return `session-${fallbackId.slice(0, 8)}`;
  const profile = session.profile ?? "agent";
  return `${profile}-${session.id.slice(0, 8)}`;
}

function upsertMember(
  meta: RoomMeta,
  member: Omit<RoomMember, "joinedAt"> & { joinedAt?: string },
): RoomMember {
  const existing = meta.members.find((m) => m.sessionId === member.sessionId);
  if (existing) {
    existing.displayName = member.displayName || existing.displayName;
    existing.role = member.role || existing.role;
    existing.notify = member.notify;
    return existing;
  }

  const created: RoomMember = {
    sessionId: member.sessionId,
    displayName: member.displayName,
    role: member.role,
    joinedAt: member.joinedAt ?? nowIso(),
    notify: member.notify,
  };
  meta.members.push(created);
  return created;
}

function memberForPost(meta: RoomMeta, data: Record<string, unknown>, ctx: MoveApiContext): RoomMember | null {
  const explicitSession = typeof data.sessionId === "string" ? data.sessionId.trim() : "";
  const sessionId = explicitSession || ctx.sessionId;
  if (!sessionId) return null;
  return meta.members.find((member) => member.sessionId === sessionId) ?? null;
}

function memberToken(ctx: MoveApiContext): string {
  return `mapi-room-${ctx.instanceId}`;
}

function buildOnboardingMessage(
  roomName: string,
  member: RoomMember,
  cwd: string,
  apiToken: string,
): string {
  const detail = readRoomDetail(cwd, roomName, false);
  const relDir = `${ROOMS_DIR}/${roomName}`;
  const recent = detail?.messages.slice(-12).map((msg) => `- ${relDir}/${msg.filename}`).join("\n");

  return [
    `# Room: ${roomName}`,
    "",
    `You have been added to room "${roomName}" as "${member.displayName}".`,
    `Your sessionId for room API calls: ${member.sessionId}`,
    `Room token: ${apiToken}`,
    "",
    `Read the room brief first: ${relDir}/brief.md`,
    "",
    "## Room protocol",
    "",
    "Use the modus_submit tool with the room token. Do not use shell commands to post.",
    "",
    "Post to the room:",
    "```json",
    JSON.stringify({ op: "post", room: roomName, sessionId: member.sessionId, content: "message markdown" }, null, 2),
    "```",
    "",
    "Read room state:",
    "```json",
    JSON.stringify({ op: "read-room", room: roomName, sessionId: member.sessionId, includeContent: true }, null, 2),
    "```",
    "",
    "Keep posts concise, sourced when relevant, and oriented toward the other room members.",
    recent ? ["", "Recent message files:", recent].join("\n") : "",
  ].filter(Boolean).join("\n");
}

async function notifyMembers(
  ctx: MoveApiContext,
  meta: RoomMeta,
  authorSessionId: string | undefined,
  message: string,
): Promise<void> {
  const targets = meta.members.filter((member) => member.notify && member.sessionId !== authorSessionId);
  await Promise.all(targets.map((member) => ctx.sendMessage(member.sessionId, message).catch(() => undefined)));
}

function writeRoomMessage(
  cwd: string,
  roomName: string,
  meta: RoomMeta,
  author: string,
  content: string,
  sessionId?: string,
): string {
  const nextSeq = Math.max(meta.messageCount + 1, listMessageFiles(cwd, roomName).length + 1);
  const seq = String(nextSeq).padStart(3, "0");
  const ts = Date.now();
  const safeAuthor = sanitizeName(author) || "user";
  const filename = `${seq}-${safeAuthor}-${ts}.md`;
  const filePath = join(roomDir(cwd, roomName), filename);

  writeFileSync(filePath, [
    "---",
    `author: ${author}`,
    sessionId ? `session: ${sessionId}` : "",
    `seq: ${nextSeq}`,
    `timestamp: ${new Date(ts).toISOString()}`,
    "---",
    "",
    content.trim(),
  ].filter((line) => line !== "").join("\n"));

  meta.messageCount = nextSeq;
  writeRoomMeta(cwd, roomName, meta);
  return relative(cwd, filePath);
}

function resolvePostRoom(ctx: MoveApiContext, data: Record<string, unknown>): { name: string; meta: RoomMeta } | { error: string } {
  const targetRoom = typeof data.room === "string" ? sanitizeName(data.room) : "";
  if (targetRoom) {
    const meta = readRoomMeta(ctx.cwd, targetRoom);
    if (!meta) return { error: `Room not found: ${targetRoom}` };
    return { name: targetRoom, meta };
  }

  const sessionId = typeof data.sessionId === "string" ? data.sessionId : ctx.sessionId;
  const matches = listRoomNames(ctx.cwd)
    .map((name) => ({ name, meta: readRoomMeta(ctx.cwd, name) }))
    .filter((room): room is { name: string; meta: RoomMeta } => !!room.meta)
    .filter((room) => room.meta.members.some((member) => member.sessionId === sessionId));

  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) return { error: "Specify room. This session is not a member of exactly one room." };
  return { error: `Specify room. Member belongs to: ${matches.map((room) => room.name).join(", ")}` };
}

export async function gather(ctx: MoveContext): Promise<string> {
  const rawName = typeof ctx.inputs.room === "string" ? ctx.inputs.room : "";
  const name = sanitizeName(rawName);
  if (!name) {
    return [
      "Room move attached.",
      "",
      "Use the Rooms widget or page to create rooms, add sessions, and send room requests.",
      ctx.apiToken ? `Room API token: ${ctx.apiToken}` : "",
    ].filter(Boolean).join("\n");
  }

  const meta = ensureRoom(ctx.cwd, name, typeof ctx.inputs.brief === "string" ? ctx.inputs.brief : undefined);
  const session = ctx.sessionId ? ctx.db.getSession(ctx.sessionId) : null;
  const displayName = typeof ctx.inputs.displayName === "string" && ctx.inputs.displayName.trim()
    ? ctx.inputs.displayName.trim()
    : sessionLabel(session, ctx.sessionId);

  if (ctx.sessionId) {
    const member = upsertMember(meta, {
      sessionId: ctx.sessionId,
      displayName,
      notify: false,
    });
    writeRoomMeta(ctx.cwd, name, meta);
    return buildOnboardingMessage(name, member, ctx.cwd, ctx.apiToken ?? "");
  }

  return `Room "${name}" is ready. Use the widget to add member sessions.`;
}

export const handlers: Record<string, MoveApiHandler> = {
  "list-rooms": async (ctx) => {
    const rooms = listRoomNames(ctx.cwd).map((name) => {
      const detail = readRoomDetail(ctx.cwd, name, false)!;
      return {
        name,
        created: detail.created,
        updated: detail.updated,
        members: detail.members.length,
        messages: detail.messageCount,
      };
    });
    return { ok: true, message: JSON.stringify(rooms) };
  },

  "list-sessions": async (ctx, data) => {
    if (ctx.caller === "agent") return { ok: false, error: "Widget only" };
    const limit = typeof data.limit === "number" ? Math.max(1, Math.min(100, Math.floor(data.limit))) : 50;
    const sessions = ctx.db.listSessions(limit).map((session) => ({
      id: session.id,
      preview: session.preview,
      profile: session.profile,
      status: session.status,
      lastMessageAt: session.lastMessageAt,
    }));
    return { ok: true, message: JSON.stringify(sessions) };
  },

  "read-room": async (ctx, data) => {
    const name = sanitizeName(String(data.room ?? ""));
    const includeContent = data.includeContent !== false;
    const detail = readRoomDetail(ctx.cwd, name, includeContent);
    if (!detail) return { ok: false, error: "Room not found" };

    if (ctx.caller === "agent") {
      const member = memberForPost(detail, data, ctx);
      if (!member) return { ok: false, error: "Only room members can read this room through the agent API." };
    }

    return { ok: true, message: JSON.stringify(detail) };
  },

  "create-room": async (ctx, data) => {
    if (ctx.caller === "agent") return { ok: false, error: "Widget only" };
    const name = sanitizeName(String(data.name ?? ""));
    if (!name) return { ok: false, error: "Invalid room name" };
    if (existsSync(roomDir(ctx.cwd, name))) return { ok: false, error: `Room already exists: ${name}` };

    ensureRoom(ctx.cwd, name, typeof data.brief === "string" ? data.brief : undefined);
    return { ok: true, message: JSON.stringify(readRoomDetail(ctx.cwd, name, true)) };
  },

  "set-brief": async (ctx, data) => {
    if (ctx.caller === "agent") return { ok: false, error: "Widget only" };
    const name = sanitizeName(String(data.room ?? ""));
    const meta = readRoomMeta(ctx.cwd, name);
    if (!meta) return { ok: false, error: "Room not found" };
    const brief = typeof data.brief === "string" ? data.brief : "";
    writeFileSync(join(roomDir(ctx.cwd, name), "brief.md"), brief);
    writeRoomMeta(ctx.cwd, name, meta);
    return { ok: true, message: "Brief updated" };
  },

  "add-member": async (ctx, data) => {
    if (ctx.caller === "agent") return { ok: false, error: "Widget only" };
    const name = sanitizeName(String(data.room ?? ""));
    const sessionId = typeof data.sessionId === "string" ? data.sessionId.trim() : "";
    if (!sessionId) return { ok: false, error: "sessionId required" };

    const meta = readRoomMeta(ctx.cwd, name);
    if (!meta) return { ok: false, error: `Room not found: ${name}` };

    const session = ctx.db.getSession(sessionId);
    const displayName = typeof data.displayName === "string" && data.displayName.trim()
      ? data.displayName.trim()
      : sessionLabel(session, sessionId);
    const member = upsertMember(meta, {
      sessionId,
      displayName,
      role: typeof data.role === "string" ? data.role : undefined,
      notify: data.notify === true,
    });
    writeRoomMeta(ctx.cwd, name, meta);

    if (data.sendOnboarding !== false) {
      await ctx.sendMessage(sessionId, buildOnboardingMessage(name, member, ctx.cwd, memberToken(ctx)));
    }

    return { ok: true, message: JSON.stringify(member) };
  },

  "add-to-room": async (ctx, data) => {
    const sessionId = typeof data.sessionId === "string" && data.sessionId.trim()
      ? data.sessionId.trim()
      : ctx.sessionId;
    return handlers["add-member"]!(ctx, { ...data, sessionId });
  },

  "remove-member": async (ctx, data) => {
    if (ctx.caller === "agent") return { ok: false, error: "Widget only" };
    const name = sanitizeName(String(data.room ?? ""));
    const sessionId = typeof data.sessionId === "string" ? data.sessionId.trim() : "";
    const meta = readRoomMeta(ctx.cwd, name);
    if (!meta) return { ok: false, error: "Room not found" };
    const before = meta.members.length;
    meta.members = meta.members.filter((member) => member.sessionId !== sessionId);
    writeRoomMeta(ctx.cwd, name, meta);
    return { ok: true, message: before === meta.members.length ? "Member not found" : "Member removed" };
  },

  "set-notify": async (ctx, data) => {
    if (ctx.caller === "agent") return { ok: false, error: "Widget only" };
    const name = sanitizeName(String(data.room ?? ""));
    const sessionId = typeof data.sessionId === "string" ? data.sessionId.trim() : "";
    const meta = readRoomMeta(ctx.cwd, name);
    if (!meta) return { ok: false, error: "Room not found" };
    const member = meta.members.find((m) => m.sessionId === sessionId);
    if (!member) return { ok: false, error: "Member not found" };
    member.notify = data.notify === true;
    writeRoomMeta(ctx.cwd, name, meta);
    return { ok: true, message: JSON.stringify(member) };
  },

  "send-context": async (ctx, data) => {
    if (ctx.caller === "agent") return { ok: false, error: "Widget only" };
    const name = sanitizeName(String(data.room ?? ""));
    const meta = readRoomMeta(ctx.cwd, name);
    if (!meta) return { ok: false, error: "Room not found" };
    const target = typeof data.sessionId === "string" ? data.sessionId : "";
    const members = target ? meta.members.filter((member) => member.sessionId === target) : meta.members;
    await Promise.all(members.map((member) => ctx.sendMessage(
      member.sessionId,
      buildOnboardingMessage(name, member, ctx.cwd, memberToken(ctx)),
    )));
    return { ok: true, message: `Sent context to ${members.length} member${members.length === 1 ? "" : "s"}` };
  },

  request: async (ctx, data) => {
    if (ctx.caller === "agent") return { ok: false, error: "Widget only" };
    const name = sanitizeName(String(data.room ?? ""));
    const meta = readRoomMeta(ctx.cwd, name);
    if (!meta) return { ok: false, error: "Room not found" };
    const prompt = typeof data.prompt === "string" ? data.prompt.trim() : "";
    if (!prompt) return { ok: false, error: "prompt required" };

    const target = typeof data.sessionId === "string" ? data.sessionId : "";
    const members = target ? meta.members.filter((member) => member.sessionId === target) : meta.members;
    if (members.length === 0) return { ok: false, error: "No matching members" };

    const requestText = [
      `[Room request: ${name}]`,
      "",
      prompt,
      "",
      "Before answering, read the room brief and recent messages if needed.",
      "Post your response back to the room with:",
      "```json",
      JSON.stringify({ op: "post", room: name, sessionId: "<your-session-id>", content: "response markdown" }, null, 2),
      "```",
    ].join("\n");

    await Promise.all(members.map((member) => ctx.sendMessage(
      member.sessionId,
      requestText.replace("<your-session-id>", member.sessionId),
    )));

    return { ok: true, message: `Requested ${members.length} member${members.length === 1 ? "" : "s"}` };
  },

  post: async (ctx, data) => {
    const content = typeof data.content === "string" ? data.content.trim() : "";
    if (!content) return { ok: false, error: "content required" };

    const resolved = resolvePostRoom(ctx, data);
    if ("error" in resolved) return { ok: false, error: resolved.error };

    const { name, meta } = resolved;
    const member = memberForPost(meta, data, ctx);
    if (ctx.caller === "agent" && !member) {
      return { ok: false, error: "You are not a member of this room. Include your sessionId if you were onboarded." };
    }

    const author = member?.displayName
      ?? (typeof data.author === "string" && data.author.trim() ? data.author.trim() : "User");
    const authorSessionId = member?.sessionId;
    const relPath = writeRoomMessage(ctx.cwd, name, meta, author, content, authorSessionId);

    await notifyMembers(ctx, meta, authorSessionId, [
      `[Room update: ${name}]`,
      `${author} posted a new room message.`,
      `Read: ${relPath}`,
    ].join("\n"));

    return { ok: true, message: `Posted to ${name}: ${relPath}` };
  },
};
