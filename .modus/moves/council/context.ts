import type {
  MoveContext,
  MoveApiContext,
  MoveApiHandler,
  MoveStateAPI,
} from "../../../harness/move-types";
import {
  buildStateApi,
} from "../../../harness/move-runner";
import {
  watchSessionExchanges,
  queueMessage,
} from "../../../harness/session-manager";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

// ── Types ──

interface CouncilMemberConfig {
  name: string;
  profile: string;
  stance: string;       // "none" = pass-through, or a named stance
  isJudge: boolean;
}

interface CouncilMember extends CouncilMemberConfig {
  sessionId: string;
}

interface CouncilMessage {
  name: string;
  role: string;
  content: string;
  round: number;
  timestamp: string;
}

interface CouncilSetup {
  topic: string;
  roundLimit: number;
  responseLength: string;
  members: CouncilMemberConfig[];
  status: "setup";
}

interface CouncilState {
  topic: string;
  roundLimit: number;
  responseLength: string;
  members: CouncilMember[];
  messages: CouncilMessage[];
  currentRound: number;
  turnIndex: number;
  status: "setup" | "initializing" | "active" | "judging" | "complete";
}

// ── Module-level tracking ──
// NOTE: This Map is fragile — if move-runner reloads the module (cache bust),
// the Map is lost and watchers silently die. A process-scoped instance store
// in move-runner would fix this (future harness feature).

interface CouncilTracker {
  stateApi: MoveStateAPI;
  state: CouncilState;
  watchers: Array<() => void>;
  initialized: Set<string>;
  lastSeenByMember: Map<string, number>;
  harness: {
    sendMessage: (sessionId: string, content: string) => Promise<void>;
  };
}

const councils = new Map<string, CouncilTracker>();

// ── Stances ──

const STANCES: Record<string, { label: string; prompt: (topic: string) => string }> = {
  advocate: {
    label: "Advocate",
    prompt: () => `Your stance: argue FOR the proposition. Find compelling reasons, present evidence, build a persuasive case. When counterarguments arise, acknowledge them but refute them.`,
  },
  skeptic: {
    label: "Skeptic",
    prompt: () => `Your stance: challenge assumptions, probe weaknesses, present counterarguments. Be rigorous but fair — your goal is to strengthen the discussion, not just oppose.`,
  },
  synthesizer: {
    label: "Synthesizer",
    prompt: () => `Your stance: integrate other members' perspectives, identify common ground, highlight the strongest arguments from all sides, and build toward a nuanced conclusion. Each round, build on what evolved — don't repeat prior synthesis.`,
  },
  devils_advocate: {
    label: "Devil's Advocate",
    prompt: () => `Your stance: take the most contrarian position possible. Whatever consensus forms, disrupt it. Find the uncomfortable truths, the overlooked risks, the arguments nobody wants to make. You exist to stress-test ideas.`,
  },
  pragmatist: {
    label: "Pragmatist",
    prompt: () => `Your stance: focus on what's practical and actionable. Cut through theoretical arguments and ask: what would this look like in practice? What are the real constraints? Push for concrete proposals over abstract debate.`,
  },
  visionary: {
    label: "Visionary",
    prompt: () => `Your stance: be bold and creative. Push past what's conventional. Propose wild ideas, make unexpected connections, imagine what could be rather than what is. Inspire others to think bigger.`,
  },
  challenger: {
    label: "Challenger",
    prompt: () => `Your stance: be edgy and provocative. Push boundaries, question sacred cows, say what others won't. Your job is to make people uncomfortable with the status quo. Challenge the room.`,
  },
  reframer: {
    label: "Reframer",
    prompt: () => `Your stance: step back and reframe. When others are debating details, zoom out. What assumptions is the whole group making? Is the question itself right? Offer meta-perspectives that recontextualize the debate.`,
  },
  traditionalist: {
    label: "Traditionalist",
    prompt: () => `Your stance: defend proven approaches and established wisdom. What has worked before? What are we risking by departing from what's known? Ground the discussion in history, precedent, and stability.`,
  },
  mediator: {
    label: "Mediator",
    prompt: () => `Your stance: find compromise and build bridges. When positions clash, look for the overlap. Propose solutions that incorporate the strongest elements from each side. Your goal is productive resolution.`,
  },
};

const RESPONSE_LENGTHS: Record<string, string> = {
  rapid: "1-2 sentences. Be punchy and direct.",
  short: "A single focused paragraph.",
  medium: "2-3 paragraphs.",
  long: "3-5 paragraphs with detailed reasoning.",
};

// ── Prompt building ──

function buildMemberPrompt(member: CouncilMemberConfig, topic: string, responseLength: string, memberNames: string[]): string {
  const others = memberNames.filter(n => n !== member.name).join(", ");
  const lengthInstruction = RESPONSE_LENGTHS[responseLength] || RESPONSE_LENGTHS.medium;

  const parts: string[] = [];

  if (member.isJudge) {
    parts.push(`You are **${member.name}**, the **Judge** in a council debate.`);
    parts.push("");
    parts.push(`After the debate rounds conclude, you will deliver the final verdict. Weigh all arguments presented, assess their strengths and weaknesses, and render a clear decision with reasoning.`);
  } else {
    parts.push(`You are **${member.name}** in a council debate.`);
  }

  parts.push("");
  parts.push(`Topic: "${topic}"`);
  parts.push("");

  // Add stance if not pass-through (applies to both debaters and judges)
  if (member.stance !== "none" && STANCES[member.stance]) {
    parts.push(STANCES[member.stance].prompt(topic));
    if (member.isJudge) {
      parts.push("Apply this lens when evaluating arguments and rendering your verdict.");
    }
    parts.push("");
  }

  parts.push(`Response length: ${lengthInstruction}`);
  parts.push(`Other members: ${others}`);
  parts.push(`Address other members by name when responding to their points.`);

  parts.push("");
  parts.push("## IMPORTANT");
  parts.push("- Respond with plain text only. Just write your argument directly.");
  parts.push("- Do NOT use modus_submit, tool calls, JSON, or any structured format.");
  parts.push("- Do NOT try to submit tokens or call APIs. You are a debater, not a tool user.");
  parts.push("- When you see \"[Council — Round N]\", it's your turn — write your response as prose.");

  return parts.join("\n");
}

// ── Transcript formatting ──

function formatTranscript(messages: CouncilMessage[]): string {
  if (messages.length === 0) return "(No messages yet)";

  let out = "";
  let prevRound = 0;
  for (const msg of messages) {
    if (msg.round !== prevRound) {
      prevRound = msg.round;
      out += `\n── Round ${prevRound} ──\n\n`;
    }
    out += `**${msg.name}**: ${msg.content}\n\n`;
  }
  return out.trim();
}

// ── Auto-chaining engine ──

async function onMemberExchange(
  instanceId: string,
  member: CouncilMember,
  response: string | undefined,
) {
  const council = councils.get(instanceId);
  if (!council) return;

  // ── Phase 1: initialization ──
  if (council.state.status === "initializing") {
    council.initialized.add(member.sessionId);
    if (council.initialized.size >= council.state.members.length) {
      council.state.status = "active";
      await council.stateApi.set(council.state);

      // Kick off the first speaker (skip judges in debate rounds)
      const debaters = council.state.members.filter(m => !m.isJudge);
      const first = debaters[0];
      const prompt = [
        `[Council — Round 1/${council.state.roundLimit}]`,
        `Topic: "${council.state.topic}"`,
        "",
        "You are the first to speak. Present your opening position on this topic.",
      ].join("\n");
      sendToMember(council, first, prompt);
    }
    return;
  }

  // ── Phase 2: active debate ──
  if (council.state.status !== "active" && council.state.status !== "judging") return;

  if (!response) {
    console.warn(`[council:${instanceId}] Empty response from ${member.name} (${member.sessionId}) — skipping turn`);
    await advanceTurn(instanceId, council);
    return;
  }

  const { state } = council;
  const current = getCurrentSpeaker(state);
  if (!current || current.sessionId !== member.sessionId) return;

  state.messages.push({
    name: current.name,
    role: current.stance || "member",
    content: response,
    round: state.currentRound,
    timestamp: new Date().toISOString(),
  });

  await advanceTurn(instanceId, council);
}

function getCurrentSpeaker(state: CouncilState): CouncilMember | null {
  if (state.status === "judging") {
    return state.members.find(m => m.isJudge) || null;
  }
  const debaters = state.members.filter(m => !m.isJudge);
  return debaters[state.turnIndex] || null;
}

async function advanceTurn(instanceId: string, council: CouncilTracker) {
  const { state } = council;

  // If judge just spoke, we're done
  if (state.status === "judging") {
    state.status = "complete";
    await council.stateApi.set(state);
    for (const unsub of council.watchers) unsub();
    console.log(`[council:${instanceId}] Complete — judge has ruled.`);
    return;
  }

  const debaters = state.members.filter(m => !m.isJudge);
  state.turnIndex++;

  if (state.turnIndex >= debaters.length) {
    // Round complete
    state.currentRound++;
    state.turnIndex = 0;

    if (state.currentRound > state.roundLimit) {
      // Check if there's a judge
      const judge = state.members.find(m => m.isJudge);
      if (judge) {
        state.status = "judging";
        await council.stateApi.set(state);

        // Send full transcript to judge for final verdict
        const transcript = formatTranscript(state.messages);
        const prompt = [
          `[Council — Final Verdict]`,
          `Topic: "${state.topic}"`,
          "",
          `The debate has concluded after ${state.roundLimit} round${state.roundLimit > 1 ? "s" : ""}. Here is the full transcript:`,
          "",
          transcript,
          "",
          "──",
          `${judge.name}, deliver your final verdict. Weigh all arguments and render your decision.`,
        ].join("\n");
        sendToMember(council, judge, prompt);
        return;
      }

      // No judge — just complete
      state.status = "complete";
      await council.stateApi.set(state);
      for (const unsub of council.watchers) unsub();
      console.log(`[council:${instanceId}] Complete after ${state.roundLimit} rounds.`);
      return;
    }
  }

  await council.stateApi.set(state);

  // Poke the next speaker with only OTHER members' new messages
  const next = debaters[state.turnIndex];
  const lastSeen = council.lastSeenByMember.get(next.sessionId) ?? 0;
  const newMessages = state.messages.slice(lastSeen).filter(m => m.name !== next.name);
  council.lastSeenByMember.set(next.sessionId, state.messages.length);

  const delta = newMessages.length > 0
    ? formatTranscript(newMessages)
    : "(No new messages from other members)";
  const prompt = [
    `[Council — Round ${state.currentRound}/${state.roundLimit}]`,
    `Topic: "${state.topic}"`,
    "",
    lastSeen > 0
      ? `New from other members since your last turn:`
      : `What others have said:`,
    "",
    delta,
    "",
    "──",
    `It's your turn, ${next.name}. Respond to what's been said above.`,
  ].join("\n");

  sendToMember(council, next, prompt);
}

function sendToMember(council: CouncilTracker, member: CouncilMember, prompt: string) {
  const queued = queueMessage(member.sessionId, prompt);
  if (!queued) {
    council.harness.sendMessage(member.sessionId, prompt).catch((err: Error) => {
      console.error(`[council] Failed to send to ${member.name}:`, err.message);
    });
  }
}

// ── gather() ──

export async function gather(ctx: MoveContext): Promise<string> {
  const instanceId = ctx.instanceId!;
  const stateApi = buildStateApi(instanceId, "council", ctx.cwd, true);
  const stored = await stateApi.get<CouncilSetup>();

  if (!stored?.topic || !stored?.members?.length) {
    return "Council not configured. Use the widget to set up the council first.";
  }

  const { topic, roundLimit, responseLength, members: memberConfigs } = stored;
  const memberNames = memberConfigs.map(m => m.name);

  // Spawn member sessions with tags for sidebar visibility
  const memberPromises = memberConfigs.map(async (cfg) => {
    const prompt = buildMemberPrompt(cfg, topic, responseLength, memberNames);
    const sessionId = await ctx.harness.createSession({
      profile: cfg.profile,
      prompt,
      cwd: ctx.cwd,
      userProfile: ctx.userProfile,
      tags: [`council:${instanceId}`, `member:${cfg.name.toLowerCase().replace(/\s+/g, "-")}`],
    });
    return { ...cfg, sessionId };
  });
  const members = await Promise.all(memberPromises);

  const debaters = members.filter(m => !m.isJudge);
  const judge = members.find(m => m.isJudge);

  // Initialize state
  const state: CouncilState = {
    topic,
    roundLimit,
    responseLength,
    members,
    messages: [],
    currentRound: 1,
    turnIndex: 0,
    status: "initializing",
  };
  await stateApi.set(state);

  // Set up exchange watchers
  const watchers: Array<() => void> = [];
  const tracker: CouncilTracker = {
    stateApi,
    state,
    watchers,
    initialized: new Set(),
    lastSeenByMember: new Map(),
    harness: { sendMessage: ctx.harness.sendMessage },
  };
  councils.set(instanceId, tracker);

  for (const member of members) {
    const unsub = watchSessionExchanges(member.sessionId, (payload) => {
      onMemberExchange(instanceId, member, payload.lastResponse);
    });
    watchers.push(unsub);
  }

  const debaterList = debaters.map(m => {
    const stanceLabel = m.stance !== "none" && STANCES[m.stance]
      ? ` (${STANCES[m.stance].label})`
      : "";
    return `- **${m.name}**${stanceLabel} — profile: ${m.profile}`;
  }).join("\n");

  const judgeInfo = judge
    ? `\nJudge: **${judge.name}** — will deliver final verdict after debate\n`
    : "";

  const turnOrder = debaters.map(m => m.name).join(" → ");

  return [
    `**Council convened** on: "${topic}"`,
    "",
    `Rounds: ${roundLimit} | Response length: ${responseLength}`,
    "",
    "Members:",
    debaterList,
    judgeInfo,
    `Turn order: ${turnOrder}`,
    "",
    "The council is initializing and will begin debating autonomously.",
    "Watch the **Council** widget panel for the live thread.",
    "",
    `To inject a moderator message, use the broadcast input in the widget or call:`,
    `\`modus_submit("${ctx.apiToken}", "broadcast", { "message": "your message" })\``,
  ].join("\n");
}

// ── API Handlers ──

export const handlers: Record<string, MoveApiHandler> = {
  setup: async (ctx: MoveApiContext, data: Record<string, unknown>) => {
    const topic = data.topic as string;
    if (!topic) return { ok: false, error: "Topic required" };

    const members = data.members as CouncilMemberConfig[] | undefined;
    if (!members || members.length < 2) return { ok: false, error: "At least 2 members required" };

    const setup: CouncilSetup = {
      topic,
      roundLimit: (data.roundLimit as number) || 2,
      responseLength: (data.responseLength as string) || "medium",
      members,
      status: "setup",
    };
    await ctx.state.set(setup);
    return { ok: true, message: "Council configured. Ready to start." };
  },

  "read-state": async (ctx: MoveApiContext) => {
    const council = councils.get(ctx.instanceId);
    if (council) {
      return { ok: true, message: JSON.stringify(council.state) };
    }
    const stateApi = buildStateApi(ctx.instanceId, "council", ctx.cwd, true);
    const state = await stateApi.get<CouncilState>();
    if (!state) return { ok: false, error: "No active council" };
    return { ok: true, message: JSON.stringify(state) };
  },

  broadcast: async (ctx: MoveApiContext, data: Record<string, unknown>) => {
    const message = data.message as string;
    if (!message) return { ok: false, error: "Message required" };

    const council = councils.get(ctx.instanceId);
    let state: CouncilState | undefined;
    if (council) {
      state = council.state;
    } else {
      const stateApi = buildStateApi(ctx.instanceId, "council", ctx.cwd, true);
      state = await stateApi.get<CouncilState>();
    }
    if (!state) return { ok: false, error: "No active council" };
    if (state.status !== "active" && state.status !== "judging")
      return { ok: false, error: `Council is ${state.status}` };

    state.messages.push({
      name: "Moderator",
      role: "moderator",
      content: message,
      round: state.currentRound,
      timestamp: new Date().toISOString(),
    });

    if (council) council.state = state;
    const stateApi = buildStateApi(ctx.instanceId, "council", ctx.cwd, true);
    await stateApi.set(state);

    return {
      ok: true,
      message: "Broadcast posted — agents will see it on their next turn.",
    };
  },

  "list-councils": async (ctx: MoveApiContext) => {
    const stateDir = join(ctx.cwd, ".modus/moves/council/state");
    try {
      const files = readdirSync(stateDir).filter(f => f.endsWith(".json") && f !== "_registry.json");
      const summaries: Array<{
        instanceId: string;
        topic: string;
        status: string;
        members: number;
        messages: number;
        rounds: string;
      }> = [];

      for (const file of files) {
        try {
          const raw = readFileSync(join(stateDir, file), "utf-8");
          const state = JSON.parse(raw) as CouncilState;
          if (!state.topic) continue; // skip non-council state files
          summaries.push({
            instanceId: file.replace(".json", ""),
            topic: state.topic,
            status: state.status,
            members: state.members?.length ?? 0,
            messages: state.messages?.length ?? 0,
            rounds: `${Math.min(state.currentRound, state.roundLimit)}/${state.roundLimit}`,
          });
        } catch { /* skip malformed files */ }
      }

      // Most recent first (by file mtime approximation — newest instanceIds last in fs)
      summaries.reverse();

      return { ok: true, message: JSON.stringify(summaries) };
    } catch {
      return { ok: true, message: JSON.stringify([]) };
    }
  },
};
