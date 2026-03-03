# Bun + Lightweight TS Server for Agent Streaming -- Research Report
*Generated: 2026-03-02*

## Summary

This report evaluates the technical landscape for building a thin streaming bridge server on Bun that wraps the Claude Agent SDK (TypeScript). The server's job is narrow: accept messages from a frontend via SSE or WebSocket, forward them to the Agent SDK's `query()` async generator, and stream back typed events (text deltas, tool activity, session lifecycle).

**Recommendation: Hono on Bun.** Hono provides the best balance of lightweight design, first-class SSE support (`streamSSE()`), workable WebSocket support via its Bun adapter, multi-runtime portability, and an active ecosystem with CORS, rate-limiting, and middleware. Elysia is a strong alternative if you want Bun-native type safety and never plan to run on Node, but a filed SSE performance regression (10x slower than Hono, issue #1369) makes it a riskier choice for this streaming-heavy use case. Raw `Bun.serve()` works but offers no routing, middleware, or SSE helpers -- unnecessary friction for even a 5-10 endpoint server.

The Agent SDK itself introduces the primary architectural constraint: each `query()` call spawns a fresh `claude` CLI subprocess with ~12 seconds of startup overhead. This means session pooling, warm-up strategies, and careful process lifecycle management matter more than framework choice.

---

## Findings

### 1. Bun Runtime Assessment

#### Current State (March 2026)

Bun is no longer experimental. Multiple major version releases have shipped (Bun 2.x and 3.x series), and the core APIs are stable. Node.js compatibility covers ~95% of the npm ecosystem without modification. The remaining 5% involves native C++ addons and obscure internal Node APIs -- neither of which the Claude Agent SDK depends on.

Key milestones:
- Bun 3.1 (January 2026) introduced built-in database clients and zero-config frontend tooling [1].
- JavaScriptCore engine delivers ~4x HTTP throughput vs Node.js in synthetic benchmarks [2].
- Express, Fastify, and most npm packages run without code changes on Bun [3].

#### Bun.serve() Built-in Server

`Bun.serve()` provides a high-performance HTTP + WebSocket server with zero dependencies:

```typescript
Bun.serve({
  port: 3001,
  fetch(req, server) {
    // HTTP routing here
    if (req.url.endsWith("/ws")) {
      server.upgrade(req);
      return;
    }
    return new Response("OK");
  },
  websocket: {
    open(ws) { /* ... */ },
    message(ws, data) { /* ... */ },
    close(ws) { /* ... */ },
    drain(ws) { /* backpressure relieved */ },
  },
});
```

Performance characteristics:
- WebSocket: 7x more requests/second than Node.js + `ws` for a chatroom benchmark [4].
- HTTP: sustains ~52,000 req/s vs Node's ~13,000 for Express-style workloads [2].
- Memory: handler-based WebSocket API reuses a single object per connection (less allocation than event-emitter pattern) [4].

#### SDK Compatibility on Bun

The `@anthropic-ai/claude-agent-sdk` spawns the Claude Code CLI as a subprocess via `ProcessTransport`. It does not use native C++ addons. The SDK explicitly supports `executable: 'bun'` as a runtime option [5]. Bun's `Bun.spawn()` and `Bun.$` shell handle subprocess management natively.

Known considerations:
- The SDK spawns a fresh `claude` CLI subprocess for every `query()` call. Each spawn incurs ~12 seconds of initialization overhead (issue #34) [6].
- The `spawnClaudeCodeProcess` option allows custom spawn logic for remote/container environments [5].
- `CLAUDECODE=1` environment variable inheritance can conflict if the SDK is invoked from within Claude Code hooks (issue #573) [7].

#### Bun vs Node.js for Long-Running Servers

| Factor | Bun | Node.js |
|--------|-----|---------|
| HTTP throughput | ~4x higher | Baseline |
| WebSocket throughput | ~7x higher | Baseline |
| Startup time | ~150ms | ~800ms |
| Memory baseline | Lower (JSC engine) | Higher (V8 engine) |
| Debugging | `bun --inspect`, Chrome DevTools | Mature, well-documented |
| Ecosystem maturity | Growing, 95% compat | Decade of stability |
| Process management | PM2 compatible, systemd | PM2, systemd, mature |

For a streaming bridge that spends most of its time waiting on subprocess I/O, the raw throughput difference matters less than stability and subprocess handling. Bun handles both adequately for this workload.

### 2. Framework Comparison

#### Hono

**Overview:** Ultra-lightweight (~14KB), multi-runtime (Bun, Node, Deno, Cloudflare Workers, edge). Express-like API with built-in middleware system.

**SSE support:** First-class via `streamSSE()` helper from `hono/streaming` [8]:
```typescript
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

const app = new Hono();
app.get('/events', (c) => {
  return streamSSE(c, async (stream) => {
    stream.onAbort(() => cleanup());
    for await (const msg of agentQuery) {
      await stream.writeSSE({
        event: msg.type,
        data: JSON.stringify(msg),
        id: msg.uuid,
      });
    }
  });
});
```

**WebSocket support:** Via Bun adapter (`hono/bun`):
```typescript
import { createBunWebSocket } from 'hono/bun';
const { upgradeWebSocket, websocket } = createBunWebSocket();

app.get('/ws', upgradeWebSocket((c) => ({
  onOpen(evt, ws) { /* ... */ },
  onMessage(evt, ws) { /* ... */ },
  onClose() { /* ... */ },
})));

export default { fetch: app.fetch, websocket };
```

Caveat: CORS middleware and WebSocket share headers -- need route separation to avoid immutable header conflicts (issue #1102) [9].

**Middleware ecosystem:** Built-in CORS, Logger, Basic Auth, JWT, ETag, Compress. Third-party: `hono-rate-limiter` with Redis/memory stores [10].

**Community:** ~20K GitHub stars, very active, strong documentation.

#### Elysia

**Overview:** Bun-native, TypeScript-first framework. Compile-time optimizations via ahead-of-time code generation. ~1.8M req/s benchmark claim [11].

**SSE support:** Built-in via generator functions and `sse()` wrapper:
```typescript
new Elysia()
  .get('/events', function* () {
    yield 'Hello';
    yield 'World';
  })
  .listen(3000);
```

**Critical issue:** SSE performance regression -- 10x slower than Hono for SSE workloads (GitHub issue #1369, filed August 2025, status: unresolved as of March 2026) [12]. This is a dealbreaker for a streaming-heavy bridge server.

**WebSocket support:** First-class via `.ws()` method with schema validation:
```typescript
new Elysia()
  .ws('/ws', {
    body: t.Object({ message: t.String() }),
    message(ws, { message }) {
      ws.send({ message, time: Date.now() });
    },
  })
  .listen(3000);
```

**Middleware ecosystem:** Plugin-based: tRPC, GraphQL, WebSocket, Prometheus, Prisma, OpenTelemetry [11]. Smaller ecosystem than Hono.

**Lock-in concern:** Bun-only. If you ever need to run on Node.js (debugging, CI, deployment flexibility), Elysia cannot follow.

#### Raw Bun.serve()

**SSE approach:** Manual `ReadableStream` construction:
```typescript
Bun.serve({
  fetch(req) {
    return new Response(
      new ReadableStream({
        type: "direct",
        async pull(controller) {
          for await (const msg of agentQuery) {
            const payload = `event: ${msg.type}\ndata: ${JSON.stringify(msg)}\n\n`;
            await controller.write(new TextEncoder().encode(payload));
            await controller.flush();
          }
          controller.close();
        },
      }),
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      }
    );
  },
});
```

Note: Bun has a default 10-second idle socket timeout that must be configured per-request [13].

**No routing, no middleware, no CORS helpers.** You write everything yourself. For a server with health checks, CORS, session endpoints, SSE, and WebSocket -- this means reinventing ~200 lines of boilerplate that Hono gives you for free.

#### Express on Bun

Express runs on Bun with ~95% compatibility and gets a ~4x performance boost over Node.js [2]. However:
- Express is 6.5KB heavier than Hono with significantly more baggage.
- No native SSE helper (need `express-sse` or manual implementation).
- No native WebSocket (need `express-ws` or separate upgrade handling).
- Designed for Node.js patterns; fighting the framework to use Bun-native features.

**Verdict:** Only makes sense if you have existing Express middleware you need to reuse. For a greenfield bridge server, Hono is strictly better.

### 3. SSE Patterns on Bun

#### Event Format

SSE messages follow a strict text protocol:
```
event: text_delta
id: msg-001
data: {"text": "Hello"}

event: tool_start
id: msg-002
data: {"tool": "Read", "input": {"path": "/src/main.ts"}}

```

Each message has optional `event:`, `id:`, and required `data:` fields, terminated by double newline (`\n\n`).

#### Hono streamSSE() Pattern

The recommended approach for this project:

```typescript
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { query } from '@anthropic-ai/claude-agent-sdk';

const app = new Hono();

app.post('/agent/stream', async (c) => {
  const { prompt, sessionId } = await c.req.json();

  return streamSSE(c, async (stream) => {
    // Abort handler: clean up SDK session on client disconnect
    stream.onAbort(() => {
      console.log('Client disconnected, aborting query');
      abortController.abort();
    });

    const abortController = new AbortController();
    const agentQuery = query({
      prompt,
      options: {
        includePartialMessages: true,
        resume: sessionId || undefined,
        abortController,
        allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'],
      },
    });

    let eventId = 0;
    for await (const message of agentQuery) {
      await stream.writeSSE({
        event: message.type,
        data: JSON.stringify(message),
        id: String(eventId++),
      });
    }

    // Signal completion
    await stream.writeSSE({
      event: 'done',
      data: JSON.stringify({ status: 'complete' }),
      id: String(eventId++),
    });
  });
});
```

#### Elysia SSE Pattern

```typescript
new Elysia()
  .get('/agent/stream', function* ({ query: { prompt } }) {
    const agentQuery = query({ prompt, options: { includePartialMessages: true } });
    for await (const msg of agentQuery) {
      yield JSON.stringify(msg);
    }
  });
```

Simpler API but suffers from the 10x SSE performance regression (issue #1369) [12].

#### Raw Bun.serve() SSE Pattern

Uses `ReadableStream` with `type: "direct"` for manual control:

```typescript
new ReadableStream({
  type: "direct",
  async pull(controller: ReadableStreamDirectController) {
    for await (const msg of agentQuery) {
      const ssePayload = `event: ${msg.type}\ndata: ${JSON.stringify(msg)}\n\n`;
      await controller.write(new TextEncoder().encode(ssePayload));
      await controller.flush();
    }
    controller.close();
  },
});
```

Requires manual header setting, no abort detection built-in, no error handler callback.

#### Connection Management

- **Disconnect detection:** Hono's `stream.onAbort()` fires when the client closes the connection. Use this to call `abortController.abort()` on the SDK query.
- **Idle timeout:** Bun defaults to 10 seconds. For long-running agent sessions, either send periodic heartbeat events (`event: heartbeat\ndata: {}\n\n`) or configure `server.timeout(req, 0)` to disable.
- **Multiple concurrent SSE connections:** Each SSE connection holds a `ReadableStream` open. Bun handles this efficiently with its event-loop model. Memory cost is proportional to buffered data, not connection count.

### 4. WebSocket Patterns on Bun

#### Bun Native WebSocket

Bun's WebSocket is built into `Bun.serve()` with no external dependencies. It uses uWebSockets under the hood and provides:

- `server.upgrade(req)` to upgrade HTTP to WebSocket
- Handler object: `open`, `message`, `close`, `drain`, `ping`, `pong`
- Built-in pub/sub via `ws.subscribe(topic)` and `ws.publish(topic, data)`
- Backpressure feedback: `ws.send()` returns `-1` (backpressure), `0` (dropped), or `1+` (bytes sent)

Configuration options:
```typescript
websocket: {
  maxPayloadLength: 16 * 1024 * 1024,  // 16 MB default
  backpressureLimit: 1024 * 1024,        // 1 MB default
  closeOnBackpressureLimit: false,
  idleTimeout: 120,                      // seconds, 0 to disable
}
```

#### Hono WebSocket via Bun Adapter

```typescript
import { Hono } from 'hono';
import { createBunWebSocket } from 'hono/bun';

const { upgradeWebSocket, websocket } = createBunWebSocket();
const app = new Hono();

app.get('/ws', upgradeWebSocket((c) => ({
  onOpen(event, ws) {
    console.log('Connection opened');
  },
  onMessage(event, ws) {
    const msg = JSON.parse(event.data as string);
    handleAgentMessage(ws, msg);
  },
  onClose() {
    console.log('Connection closed');
  },
})));

// Must export websocket object for Bun.serve
Bun.serve({ fetch: app.fetch, port: 3001, websocket });
```

Note: CORS middleware must be applied only to HTTP routes, not WebSocket routes, to avoid immutable header conflicts [9].

#### Elysia WebSocket

```typescript
new Elysia()
  .ws('/ws', {
    body: t.Object({
      type: t.String(),
      prompt: t.Optional(t.String()),
      sessionId: t.Optional(t.String()),
    }),
    open(ws) { console.log('Connected'); },
    message(ws, { type, prompt, sessionId }) {
      if (type === 'query') startAgentSession(ws, prompt, sessionId);
    },
    close(ws) { cleanupSession(ws); },
  })
  .listen(3001);
```

Elysia's WebSocket has schema validation built-in, which is genuinely useful for typed agent messages.

#### Message Protocol Design

For agent communication, a discriminated union protocol:

```typescript
// Client -> Server
type ClientMessage =
  | { type: 'query'; prompt: string; sessionId?: string }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'resume'; sessionId: string; prompt: string }
  | { type: 'ping' };

// Server -> Client
type ServerMessage =
  | { type: 'stream_event'; event: RawMessageStreamEvent; sessionId: string }
  | { type: 'assistant'; content: ContentBlock[]; sessionId: string }
  | { type: 'result'; result: string; cost: number; sessionId: string }
  | { type: 'tool_start'; tool: string; input: unknown; sessionId: string }
  | { type: 'tool_end'; tool: string; output: unknown; sessionId: string }
  | { type: 'error'; message: string; sessionId?: string }
  | { type: 'session_init'; sessionId: string }
  | { type: 'pong' };
```

Use text frames (JSON strings), not binary. The overhead of JSON serialization is negligible compared to agent turn latency (~12 seconds per subprocess spawn).

#### Heartbeat Pattern

```typescript
// Server-side: ping every 30 seconds
const PING_INTERVAL = 30_000;
const pingTimers = new Map<WebSocket, Timer>();

function startHeartbeat(ws: ServerWebSocket) {
  pingTimers.set(ws, setInterval(() => ws.ping(), PING_INTERVAL));
}

function stopHeartbeat(ws: ServerWebSocket) {
  clearInterval(pingTimers.get(ws));
  pingTimers.delete(ws);
}
```

### 5. SDK-to-Stream Bridge Pattern

#### Core Bridge Logic

The central pattern is converting the SDK's async generator to SSE or WebSocket events:

```typescript
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

async function bridgeToSSE(
  stream: SSEStreamHandle,
  prompt: string,
  sessionId?: string,
) {
  const abortController = new AbortController();
  stream.onAbort(() => abortController.abort());

  const agentQuery = query({
    prompt,
    options: {
      includePartialMessages: true,
      resume: sessionId,
      abortController,
    },
  });

  let eventId = 0;
  for await (const message of agentQuery) {
    const event = classifyEvent(message);
    await stream.writeSSE({
      event: event.type,
      data: JSON.stringify(event.payload),
      id: String(eventId++),
    });
  }
}

function classifyEvent(msg: SDKMessage) {
  switch (msg.type) {
    case 'stream_event': {
      const evt = msg.event;
      if (evt.type === 'content_block_delta' && evt.delta.type === 'text_delta') {
        return { type: 'text_delta', payload: { text: evt.delta.text, sessionId: msg.session_id } };
      }
      if (evt.type === 'content_block_start' && evt.content_block.type === 'tool_use') {
        return { type: 'tool_start', payload: { tool: evt.content_block.name, sessionId: msg.session_id } };
      }
      return { type: 'stream_event', payload: msg };
    }
    case 'assistant':
      return { type: 'assistant', payload: msg };
    case 'result':
      return { type: 'result', payload: msg };
    default:
      return { type: msg.type, payload: msg };
  }
}
```

#### WebSocket Bridge Variant

```typescript
async function bridgeToWebSocket(
  ws: ServerWebSocket,
  prompt: string,
  sessionId?: string,
) {
  const abortController = new AbortController();
  const agentQuery = query({
    prompt,
    options: {
      includePartialMessages: true,
      resume: sessionId,
      abortController,
    },
  });

  try {
    for await (const message of agentQuery) {
      const sendResult = ws.send(JSON.stringify({
        type: message.type,
        ...message,
      }));

      // Backpressure: sendResult === -1 means queue is building up
      if (sendResult === -1) {
        // Could implement flow control here, but for agent streaming
        // the client is almost always faster than the LLM token rate
        console.warn('WebSocket backpressure detected');
      }
    }
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', message: String(err) }));
  }
}
```

#### Backpressure Analysis

In practice, backpressure is unlikely for this use case. The Claude API generates tokens at ~50-100 tokens/second. Each token is a few bytes of JSON. Even a slow WebSocket client can consume this rate trivially. The bottleneck is always the LLM, not the transport.

Where backpressure could matter:
- Tool output (e.g., `Bash` returning large stdout) -- but the SDK buffers this internally before yielding.
- Network interruption where the client's buffer fills -- Bun's `closeOnBackpressureLimit` handles this.

#### Error Propagation

The SDK can throw or yield errors in several ways:
1. **Subprocess crash** -- the `for await` loop throws, catch at the bridge level.
2. **API error** -- yielded as a `ResultMessage` with error details.
3. **Abort** -- when `abortController.abort()` is called, the generator completes.

Pattern:
```typescript
try {
  for await (const message of agentQuery) {
    stream.writeSSE({ event: message.type, data: JSON.stringify(message) });
  }
} catch (err) {
  stream.writeSSE({ event: 'error', data: JSON.stringify({ error: String(err) }) });
} finally {
  stream.writeSSE({ event: 'done', data: '{}' });
}
```

### 6. Concurrent Session Management

#### Session Tracking

```typescript
interface ActiveSession {
  sessionId: string;
  query: Query;                    // The SDK Query async generator
  abortController: AbortController;
  createdAt: number;
  lastActivity: number;
}

const sessions = new Map<string, ActiveSession>();

function createSession(sessionId: string, prompt: string): ActiveSession {
  const abortController = new AbortController();
  const q = query({
    prompt,
    options: {
      includePartialMessages: true,
      sessionId,
      abortController,
    },
  });

  const session: ActiveSession = {
    sessionId,
    query: q,
    abortController,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };

  sessions.set(sessionId, session);
  return session;
}
```

#### Cleanup on Disconnect

```typescript
function destroySession(sessionId: string) {
  const session = sessions.get(sessionId);
  if (session) {
    session.abortController.abort();
    sessions.delete(sessionId);
    console.log(`Session ${sessionId} cleaned up`);
  }
}

// Periodic cleanup of stale sessions
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TIMEOUT) {
      destroySession(id);
    }
  }
}, 60_000);
```

#### SDK Concurrency Constraints

Each `query()` call spawns a separate Claude CLI subprocess [6]. This means:
- N concurrent sessions = N subprocesses.
- Each subprocess consumes ~100-300MB of memory (Node.js/Bun process + model context).
- The ~12-second startup overhead per subprocess is the main bottleneck [6].
- Sessions are independent -- they don't share state or interfere with each other.

**Memory estimation for concurrent sessions:**

| Concurrent Sessions | Subprocess Memory | Server Memory | Total |
|---------------------|-------------------|---------------|-------|
| 1 | ~200 MB | ~50 MB | ~250 MB |
| 5 | ~1 GB | ~50 MB | ~1.05 GB |
| 10 | ~2 GB | ~50 MB | ~2.05 GB |
| 20 | ~4 GB | ~50 MB | ~4.05 GB |

For a personal/small-team deployment, 5-10 concurrent sessions is a reasonable upper bound.

#### V2 SDK Session Pattern

The V2 SDK preview simplifies multi-turn conversations:

```typescript
import { unstable_v2_createSession } from '@anthropic-ai/claude-agent-sdk';

const session = unstable_v2_createSession({ model: 'claude-opus-4-6' });
await session.send('Hello');
for await (const msg of session.stream()) {
  // Process messages
}

// Later: send follow-up
await session.send('Continue');
for await (const msg of session.stream()) {
  // Process messages
}

session.close();
```

The V2 interface is still marked as `unstable_` (preview), but it maps more naturally to the bridge server's needs: each WebSocket connection can own an `SDKSession`, calling `send()` for each client message and iterating `stream()` for each response.

### 7. Reference Implementations

#### claude-agent-server (dzhng)

Repository: [github.com/dzhng/claude-agent-server](https://github.com/dzhng/claude-agent-server) [14]

Architecture:
- **Runtime:** Bun
- **Transport:** WebSocket via `Bun.serve()`
- **Structure:** Monorepo with `packages/server/` and `packages/client/`
- **Key files:** `index.ts` (server + WebSocket), `message-handler.ts` (SDK bridge), `const.ts` (config)
- **Session model:** Single active connection (rejects concurrent clients)
- **Configuration:** Dynamic via HTTP POST to `/config`

Message protocol:
```typescript
// Client -> Server
{ type: 'user_message', data: { session_id, message, parent_tool_use_id, uuid } }
{ type: 'interrupt' }

// Server -> Client
{ type: 'connected' }
{ type: 'sdk_message', data: SDKMessage }
{ type: 'error', message: string }
```

This implementation targets E2B sandbox deployment. For our use case (bare-metal, multi-session), we'd need to remove the single-connection constraint and add session multiplexing.

#### Anthropic's Hosting Guide

Anthropic's official hosting documentation [15] describes four deployment patterns:

1. **Ephemeral sessions** -- new container per task, destroyed on completion.
2. **Long-running sessions** -- persistent containers with multiple SDK processes.
3. **Hybrid sessions** -- ephemeral with state hydration from DB or SDK resume.
4. **Single container** -- multiple SDK processes in one container (our model).

Resource recommendation: 1 GiB RAM, 5 GiB disk, 1 CPU per SDK instance [15].

#### Hono + AI Streaming Examples

- [hono-stream-example](https://github.com/hellokaton/hono-stream-example) -- Hono + Bun + SSE streaming OpenAI responses [16].
- Pattern: `streamSSE()` wrapping an async iterator from the AI provider SDK.
- Directly applicable to our Claude Agent SDK bridge.

#### blle.co Production Agent API

Blog post: "Building a Production Claude Agent API with Job Queues and Streaming" [17] describes:
- Job queue pattern for handling the ~12-second startup delay.
- SSE streaming of SDK events to the client.
- Structured event types for frontend consumption.

### 8. Production Considerations

#### Process Management

**PM2** is the recommended process manager for Bun servers [18]:

```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'agent-bridge',
    script: 'src/server.ts',
    interpreter: 'bun',
    instances: 1,        // Single instance (sessions are stateful)
    kill_timeout: 10000, // 10s graceful shutdown window
    env: {
      PORT: 3001,
      NODE_ENV: 'production',
    },
  }],
};
```

PM2 provides:
- Auto-restart on crash
- `pm2 startup` for systemd integration
- `pm2 reload` for zero-downtime restarts
- Log rotation and monitoring

**systemd** alternative (simpler, no extra dependency):

```ini
[Unit]
Description=Agent Streaming Bridge
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/bun run /home/dot/dev/infra/agent_bridge/src/server.ts
WorkingDirectory=/home/dot/dev/infra/agent_bridge
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=15
User=dot
Environment=PORT=3001
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

#### Graceful Shutdown

```typescript
let isShuttingDown = false;

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  isShuttingDown = true;

  // Abort all active SDK sessions
  for (const [id, session] of sessions) {
    session.abortController.abort();
    sessions.delete(id);
  }

  // Stop accepting new connections
  server.stop();

  // Give in-flight requests time to complete
  await new Promise((resolve) => setTimeout(resolve, 5000));
  process.exit(0);
});

process.on('SIGINT', () => process.emit('SIGTERM'));
```

Note: Bun historically had issues with `SIGTERM` listeners (issue #1657) [19], but this has been resolved in recent versions.

#### Logging

**Pino** is the recommended structured logging library [20]:
- Async logging (non-blocking I/O)
- JSON output by default
- Actively maintained (unlike Bunyan)
- Compatible with Bun

```typescript
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty' }
    : undefined,
});

logger.info({ sessionId, prompt: prompt.slice(0, 100) }, 'Query started');
logger.error({ err, sessionId }, 'Query failed');
```

#### CORS Configuration

Using Hono's built-in CORS middleware:

```typescript
import { cors } from 'hono/cors';

const app = new Hono();
app.use('/api/*', cors({
  origin: ['http://localhost:3000', 'http://localhost:5173'],
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  exposeHeaders: ['X-Session-Id'],
  maxAge: 3600,
  credentials: true,
}));

// WebSocket routes MUST be outside the CORS middleware scope
// to avoid immutable header conflicts
app.get('/ws', upgradeWebSocket(/* ... */));
```

#### Rate Limiting

Using `hono-rate-limiter` [10]:

```typescript
import { rateLimiter } from 'hono-rate-limiter';

app.use('/api/*', rateLimiter({
  windowMs: 60 * 1000,     // 1 minute
  limit: 10,                // 10 requests per window
  keyGenerator: (c) => c.req.header('x-forwarded-for') || 'anonymous',
}));
```

#### Health Check Endpoint

```typescript
app.get('/health', (c) => {
  if (isShuttingDown) {
    return c.json({ status: 'shutting_down' }, 503);
  }
  return c.json({
    status: 'ok',
    activeSessions: sessions.size,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});
```

---

## Framework Decision Matrix

| Criterion | Hono | Elysia | Raw Bun.serve() | Express on Bun |
|-----------|------|--------|-----------------|----------------|
| **SSE support** | First-class (`streamSSE`) | Built-in (generator) -- but 10x perf regression | Manual ReadableStream | Manual / third-party |
| **WebSocket support** | Bun adapter (good) | First-class (excellent) | Native (excellent) | Third-party (`express-ws`) |
| **Routing** | Built-in, composable | Built-in, type-safe | None | Built-in |
| **Middleware** | CORS, Logger, JWT, etc. | Plugin system | None | Vast ecosystem |
| **TypeScript DX** | Good | Excellent (end-to-end) | Manual types | Adequate |
| **Bundle size** | ~14 KB | ~30 KB | 0 KB | ~200 KB |
| **Multi-runtime** | Yes (Bun, Node, Deno, CF) | Bun only | Bun only | Node primary, Bun compat |
| **Community** | ~20K stars, very active | ~8K stars, active | N/A | ~65K stars, mature |
| **SSE performance** | Excellent | Degraded (issue #1369) | Excellent (manual) | Adequate |
| **WebSocket perf** | Good (via Bun native) | Excellent (Bun native) | Excellent | Poor |
| **Learning curve** | Low (Express-like) | Medium (unique patterns) | Low (but more code) | Very low |
| **Rate limiting** | `hono-rate-limiter` | Community plugin | Manual | `express-rate-limit` |
| **Error handling** | Built-in stream errors | Generator cancellation | Manual | Built-in |

**Winner for this use case: Hono.**

The combination of `streamSSE()` for the primary transport, Bun WebSocket adapter for bidirectional needs, built-in CORS/middleware, and multi-runtime portability makes it the clear choice. The 14 KB footprint and Express-like API mean near-zero learning curve.

---

## Sources

1. [Bun Blog - Latest Releases](https://bun.com/blog)
2. [Bun vs Node.js 2025: Performance Guide - Strapi](https://strapi.io/blog/bun-vs-nodejs-performance-comparison-guide)
3. [Bun vs Node.js 2026 - DEV Community](https://dev.to/alexcloudstar/bun-vs-nodejs-is-it-time-to-switch-in-2026-5821)
4. [Bun WebSocket Documentation](https://bun.com/docs/runtime/http/websockets)
5. [Claude Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript)
6. [SDK query() 12s overhead issue #34](https://github.com/anthropics/claude-agent-sdk-typescript/issues/34)
7. [SDK subprocess env var inheritance issue #573](https://github.com/anthropics/claude-agent-sdk-python/issues/573)
8. [Hono Streaming Helper Documentation](https://hono.dev/docs/helpers/streaming)
9. [Hono WebSocket + middleware immutable headers issue #1102](https://github.com/honojs/hono/issues/1102)
10. [hono-rate-limiter](https://github.com/rhinobase/hono-rate-limiter)
11. [ElysiaJS Official Site](https://elysiajs.com)
12. [Elysia SSE 10x slower than Hono - issue #1369](https://github.com/elysiajs/elysia/issues/1369)
13. [Bun SSE ReadableStream batching discussion #13923](https://github.com/oven-sh/bun/discussions/13923)
14. [claude-agent-server (dzhng)](https://github.com/dzhng/claude-agent-server)
15. [Hosting the Agent SDK - Anthropic](https://platform.claude.com/docs/en/agent-sdk/hosting)
16. [hono-stream-example (SSE + Bun)](https://github.com/hellokaton/hono-stream-example)
17. [Building a Production Claude Agent API - blle.co](https://www.blle.co/blog/claude-agent-sdk-api-implementation)
18. [Run Bun as daemon with PM2](https://bun.com/docs/guides/ecosystem/pm2)
19. [Bun SIGTERM listener issue #1657](https://github.com/oven-sh/bun/issues/1657)
20. [Node.js Logging: Pino vs Winston vs Bunyan](https://medium.com/@muhammedshibilin/node-js-logging-pino-vs-winston-vs-bunyan-complete-guide-99fe3cc59ed9)
21. [Stream responses in real-time - Agent SDK](https://platform.claude.com/docs/en/agent-sdk/streaming-output)
22. [TypeScript SDK V2 Preview](https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview)
23. [Session Management - Agent SDK](https://platform.claude.com/docs/en/agent-sdk/sessions)
24. [Elysia vs Hono for Solo Developers 2026](https://solodevstack.com/blog/elysia-vs-hono-solo-developers)
25. [SSE's Comeback 2025 - portalZINE](https://portalzine.de/sses-glorious-comeback-why-2025-is-the-year-of-server-sent-events/)
26. [Hono CORS Middleware](https://hono.dev/docs/middleware/builtin/cors)
27. [Hono WebSocket Helper](https://hono.dev/docs/helpers/websocket)
28. [Complete Guide to Streaming LLM Responses - DEV Community](https://dev.to/pockit_tools/the-complete-guide-to-streaming-llm-responses-in-web-applications-from-sse-to-real-time-ui-3534)
29. [Bun.serve() Server Documentation](https://bun.com/docs/runtime/http/server)
30. [Hono + Bun graceful shutdown discussion #3731](https://github.com/orgs/honojs/discussions/3731)

---

## Recommended Stack

| Layer | Choice | Reasoning |
|-------|--------|-----------|
| **Runtime** | Bun | Already decided. SDK supports it natively. Performance is excellent. |
| **Framework** | Hono | Best SSE support (`streamSSE`), adequate WebSocket via Bun adapter, multi-runtime escape hatch, 14 KB, active community. |
| **Primary transport** | SSE (via `streamSSE`) | Agent responses are unidirectional (server -> client). SSE is simpler, auto-reconnects, works through proxies. Use POST requests for client -> server messages. |
| **Secondary transport** | WebSocket (via `hono/bun`) | For bidirectional needs: interrupts, multi-turn within a single connection, real-time control messages. |
| **SDK API** | V1 `query()` async generator | V2 is still `unstable_` preview. V1 is battle-tested and maps directly to `for await` -> SSE streaming. Monitor V2 for eventual migration. |
| **Session management** | `Map<string, ActiveSession>` | Simple in-memory tracking. SDK handles persistence via session IDs and JSONL files. |
| **Logging** | Pino | Async, structured JSON, actively maintained. |
| **Process management** | systemd or PM2 | systemd for simplicity on Fedora; PM2 if you want `pm2 monit` dashboards. |
| **Port** | 3001 | Avoids conflicts with Open WebUI (3000), LiteLLM (4000), llama.cpp (8001). |

### Minimal Server Skeleton

```typescript
// src/server.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { createBunWebSocket } from 'hono/bun';
import { query } from '@anthropic-ai/claude-agent-sdk';
import pino from 'pino';

const logger = pino({ level: 'info' });
const { upgradeWebSocket, websocket } = createBunWebSocket();

const app = new Hono();

// Middleware (HTTP routes only)
app.use('/api/*', cors({ origin: '*' }));

// Health check
app.get('/health', (c) => c.json({ status: 'ok', sessions: sessions.size }));

// SSE streaming endpoint
app.post('/api/agent/stream', async (c) => {
  const { prompt, sessionId } = await c.req.json();
  return streamSSE(c, async (stream) => {
    const abort = new AbortController();
    stream.onAbort(() => abort.abort());

    const q = query({
      prompt,
      options: { includePartialMessages: true, resume: sessionId, abortController: abort },
    });

    let id = 0;
    try {
      for await (const msg of q) {
        await stream.writeSSE({ event: msg.type, data: JSON.stringify(msg), id: String(id++) });
      }
    } catch (err) {
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: String(err) }) });
    }
    await stream.writeSSE({ event: 'done', data: '{}', id: String(id++) });
  });
});

// WebSocket endpoint (outside CORS scope)
app.get('/ws', upgradeWebSocket((c) => ({
  onMessage(event, ws) { /* handle bidirectional messages */ },
  onClose() { /* cleanup */ },
})));

// Start server
const sessions = new Map();
const server = Bun.serve({ fetch: app.fetch, port: 3001, websocket });
logger.info({ port: 3001 }, 'Agent bridge started');

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('Shutting down...');
  for (const [, s] of sessions) s.abortController.abort();
  server.stop();
  setTimeout(() => process.exit(0), 5000);
});
```

---

## Open Questions

1. **V1 vs V2 SDK timing:** The V2 `send()`/`stream()` pattern is cleaner for multi-turn WebSocket sessions. When does `unstable_v2_*` become stable? Monitor the [SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md).

2. **12-second startup overhead:** Is there a way to pre-warm SDK subprocesses or pool them? The `continue` option reuses a session but still respawns the CLI process. This needs prototyping.

3. **Session persistence across server restarts:** The SDK persists sessions to JSONL files. Can we reliably resume sessions after the bridge server restarts? Needs testing with `resume: sessionId`.

4. **Subprocess memory under load:** How does memory actually scale with 5-10 concurrent sessions on the target machine? Need to measure with real workloads, not estimates.

5. **SSE vs WebSocket for the frontend:** SSE is simpler for streaming but requires a separate POST endpoint for sending messages. WebSocket handles both directions. The frontend architecture will drive this choice -- prototype both and let the frontend decide.

6. **OAuth/subscription billing flow:** The SDK supports subscription billing via OAuth. How does the auth token flow from the frontend through the bridge to the SDK? Needs investigation of the SDK's `env` option for passing credentials.

7. **Hono WebSocket + CORS route separation:** The workaround (separate route groups) needs validation. Does the Bun adapter handle this cleanly, or are there edge cases?

8. **Agent profiles integration:** Can `.claude/agents/*.md` profiles be loaded dynamically per session via the SDK's `agent` option? This would allow the frontend to select different agent personas.
