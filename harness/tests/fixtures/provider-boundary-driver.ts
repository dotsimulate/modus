import { existsSync, readFileSync, writeFileSync } from "node:fs";

const mode = process.env.MODUS_TEST_PROVIDER_MODE;
const fakeExecutable = process.env.CLAUDE_PATH;
const recordPath = process.env.MODUS_TEST_PROVIDER_RECORD;
const reportPath = process.env.MODUS_TEST_PROVIDER_REPORT;
const workspace = process.env.AGENT_CWD;
const sessionCredential = "mcp-session-provider-boundary-canary";

if (!mode || !fakeExecutable || !recordPath || !reportPath || !workspace) {
  throw new Error("missing provider boundary fixture environment");
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(25);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function makeSession() {
  return {
    sessionId: `boundary-${mode}`,
    tempId: `boundary-${mode}`,
    providerSessionId: null,
    status: "starting",
    profile: undefined,
    provider: mode,
    model: undefined,
    seq: 0,
    startedAt: Date.now(),
    lastEventAt: Date.now(),
    costUsd: 0,
    numTurns: 0,
    exchangeCount: 0,
    error: null,
    preview: "boundary probe",
    lastAssistantText: "",
    liveStream: { text: "", thinking: "", feed: "", seq: 0 },
    pendingAssistantTurn: null,
    initialPrompt: "boundary probe",
    initialContent: "boundary probe",
    subscribers: new Set(),
    abortController: new AbortController(),
    dispatchState: "idle",
    pendingDispatch: [],
    turnStartedAt: Date.now(),
    cwd: workspace,
    projectRoot: workspace,
    additionalDirectories: [],
    pauseRequested: false,
    pauseResolver: null,
    pendingPermissions: new Map(),
    sessionApprovals: new Set(),
    osPids: new Set<number>(),
    watchers: new Set(),
    _provider: null as any,
    _providerState: null,
    _configOverrides: {},
  } as any;
}

const session = makeSession();
const provider = mode === "claude-code-pty"
  ? (await import("../../providers/claude-code-pty")).createClaudeCodePtyProvider()
  : mode === "cursor"
    ? (await import("../../providers/cursor")).createCursorProvider()
    : (await import("../../providers/claude-code")).createClaudeCodeProvider({ which: () => fakeExecutable });
session._provider = provider;

const opts = {
  prompt: "boundary probe",
  cwd: workspace,
  provider: mode,
  loadProjectSettings: false,
  permissionPolicy: "bypass",
  mcpServers: {
    modus: {
      type: "http",
      url: "http://127.0.0.1:1/api/mcp/modus/boundary-scope",
      headers: { Authorization: `Bearer ${sessionCredential}` },
    },
  },
};

const ctx = {
  session,
  opts,
  profile: undefined,
  emitEvent() {},
  broadcastEvent() {},
  rekeySession(newId: string) { session.sessionId = newId; },
  setProviderSessionId(providerSessionId: string) { session.providerSessionId = providerSessionId; },
  notifyConfigChange() {},
  updateSessionDb() {},
} as any;

provider.startTurn(ctx);
await Promise.all([
  waitUntil(() => existsSync(recordPath), "fake provider record"),
  waitUntil(() => session.osPids.size > 0, "provider root pid"),
]);

const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
  pid: number;
  pointedFiles: Array<{ path: string; content: string }>;
};
const spawnPids = [...session.osPids];
const pointedPaths = record.pointedFiles.map(file => file.path);
const tempExistsBeforeDispose = pointedPaths.length > 0 && pointedPaths.every(path => existsSync(path));

provider.abort(session);
await Bun.sleep(mode === "claude-code" ? 1_000 : 300);
await provider.dispose?.(session);
const exitDeadline = Date.now() + 5_000;
while (processAlive(record.pid) && Date.now() < exitDeadline) {
  await Bun.sleep(25);
}

const report = {
  mode,
  spawnPids,
  finalPids: [...session.osPids],
  fakePid: record.pid,
  fakeAliveAfterDispose: processAlive(record.pid),
  tempExistsBeforeDispose,
  tempExistsAfterDispose: pointedPaths.some(path => existsSync(path)),
  interruptCalled: true,
};
writeFileSync(reportPath, JSON.stringify(report), "utf8");
process.exit(0);
