---
title: Control Intents
lastUpdated: 2026-09-12
lastCommit: 74327c8
covers: harness/control-intents.ts harness/index.ts harness/ui/src/control-intents.ts harness/ui/src/control-intent-routing.ts harness/ui/src/scroll-navigation.ts harness/ui/src/components/ChatView.tsx harness/ui/src/components/VirtualMessageList.tsx harness/ui/src/providers/SessionProvider.tsx harness/ui/src/widgets/session-history.widget.tsx
audience: dev
---

# Control Intents

A named vocabulary for driving the client's view from outside the browser — a
desk control, a foot switch, a MIDI knob, OSC from another application, a script.

Without this, the client is a pure initiator: it opens SSE streams and nothing
ever pushes a command at it. The only inbound event a client extension can
receive is a keyboard shortcut, and a shortcut requires OS focus — so a physical
control dies the moment you click into another application, which is exactly when
you want it. An intent is published to the harness and fanned out to every
listening client, focused or not.

## The vocabulary

| Intent | Payload | Effect |
|---|---|---|
| `transcript.scroll` | `unit` (`px`, `line`, `page`), `delta` (finite, non-zero) | Scroll the transcript by a distance, as a wheel does. Negative is toward the start. |
| `transcript.scrollTo` | `fraction` (0–1) | Scroll to a position in the loaded transcript. 0 is the top, 1 the end. |
| `transcript.scrollByTurns` | `delta` (non-zero integer) | Move the transcript by whole turns. Negative is toward the start. |
| `transcript.follow` | — | Jump to the live end and resume following it. |
| `session.cycle` | `delta` (non-zero integer) | Move to another session among the rows the list is showing. Wraps. |
| `dictation.toggle` | — | Start or stop dictation into the active composer, through whichever dictation extension is loaded. |

`transcript.scroll` is the everyday one. One turn can hold a long answer and
hundreds of tool calls, so a producer that only knew turns could not read a
transcript — it could only skip through it. The client resolves units, because
only it knows its font scale and viewport: a `line` is one line of message text at
the current font scale (a mouse-wheel notch is typically three), and a `page` is
the viewport less two lines of overlap, like Page Down. Fractional amounts are
allowed. The client glides to the distance, and a request that arrives mid-glide
adds to the distance left instead of restarting the motion, so a fast spin on an
encoder stays smooth. Wheel, touch, or keyboard input from the reader ends the
glide. Scrolling to within reach of the end resumes live-follow, exactly as it
does with a wheel.

`transcript.scrollTo` is for absolute controls — a fader, a MIDI CC, a slider on
another screen. It addresses the loaded transcript, so older pages that have not
been fetched are not part of the range.

A turn anchor is a user message — the same landmark `ChatScrollSpine` indexes in
ruler mode — so `transcript.scrollByTurns` jumps between prompts the way the spine
does. Stepping forward off the newest turn falls through to `transcript.follow`,
because a transcript has an end and running into it means go there.

Step counts are clamped to ±999, and scroll distances to ±100000 px, ±999 lines,
or ±99 pages, rather than rejected, so a runaway producer cannot ask for unbounded
work.

## Why the vocabulary is this small

Every intent here moves the viewport and nothing else. The worst a hostile
publisher can do is change where the user is looking. That bound is the reason
this surface needs no new confirmation boundary, and it is the property to
preserve.

The bound limits what *kind* of effect an intent may have, not how finely it may
have it. A pixel scroll and a turn jump sit in the same class; navigation should
be as expressive as the controls people already use to read, and adding
resolution within it needs no new gate.

An intent that opens the microphone, submits the composer, or answers a
permission prompt is a **different authority class** and does not belong in the
union:

- A microphone gate has its effect in the room, not in the process. Every other
  capability Modus exposes is bounded by the machine.
- `composer.submit` closes an autonomy loop — a producer that can stage text and
  send it is talking to the agent with no human in the ring.
- Permission confirmation *is* the confirmation boundary.

Adding any of those means designing its gate first — device pairing, a
loopback-only origin, an explicit opt-in, and the same fail-closed posture that
remote-backend mode already applies to client extensions — not appending a member
to the union. `session.cycle` is the edge of what counts as navigation: it
changes which session you are reading, and does not create, send, archive, or
spend anything.

## Publishing

```
POST /api/control
{ "intent": "transcript.scroll", "unit": "line", "delta": -3 }

→ 200 { "ok": true, "intent": "transcript.scroll", "delivered": 1 }
→ 400 { "error": "unknown or malformed control intent" }
```

Ordinary harness auth. The route is deliberately **not** in
`allowsQueryCredential`: a publisher is a program, not a browser element that
cannot set headers, so there is no reason to accept a credential from a URL.

`delivered` is how many clients received the intent. Zero means the backend is up
and nothing is watching — a real state, and one a hardware producer should show
differently from a dead backend. It exists so a producer does not need a second
health endpoint to tell those apart.

```bash
curl -s -X POST http://127.0.0.1:$PORT/api/control \
  -H "Authorization: Bearer $HARNESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"intent":"transcript.follow"}'
```

## Subscribing

```
GET /api/events/control          # SSE, event name "control", data is one intent
GET /api/events/hub?channels=control[,session,fs]   # the browser's shared stream
```

Header credential only on both, same reasoning as the publisher. The browser
client uses the fetch-based SSE reader rather than `EventSource` so no token
rides in a URL.

The browser does not open `/api/events/control` itself. Chromium and WebView2
allow six HTTP/1.1 connections per host, so each tab carries every tab-wide
channel — control intents, session lifecycle, filesystem changes — on one
`/api/events/hub` stream (`harness/ui/src/eventHub.ts`), next to the transcript
stream `/api/events/multi`. A hub counts toward `delivered` only when it asked
for the `control` channel. `/api/events/control` remains for non-browser
listeners.

There is no persistence and no replay. A client that is not connected misses the
intent, which is correct: a knob turned while the window was closed should not
fire on reconnect.

## Client side

`harness/ui/src/control-intents.ts` is the import surface. It subscribes to the
hub's `control` channel, re-validates each payload with the same parser the route uses, and hands it to
the registry in `control-intent-routing.ts` (split out so the arithmetic and the
registry are testable without a DOM).

```ts
useEffect(() => onControlIntent("transcript.follow", () => {
  setScrollTrigger((n) => n + 1);
}), []);
```

Three properties worth knowing:

- **One handler per intent, last mount wins.** Handlers are a stack; dispatch
  calls only the top. A physical control has one target — if two transcripts are
  mounted, three detents should move one of them three turns, not two of them
  three turns each. Unregistering pops, so the previous owner takes over again.
- **A fallback sits under the stack.** `onControlIntent(name, handler,
  { fallback: true })` registers at the bottom, so it answers only when no
  surface has claimed the intent. This exists because mount order is not
  precedence: React runs a child's effects before its parent's, so a provider
  registering a generic handler would otherwise outrank the widget that renders
  the thing being driven.
- **The subscription only exists while something is listening.** The hub's
  `control` channel is reference-counted against the registry rather than
  requested at boot, which is what keeps `delivered` an honest answer to "is
  anyone there".

Current handlers: `ChatView` owns every `transcript.*` intent. The distance and
absolute scrolls go through `VirtualMessageList`'s `scrollBy` / `scrollTo`
controls rather than writing `scrollTop` directly, because the list must drop
live-follow before a glide toward the start or an arriving measurement pins the
reader back to the end. `session.cycle` is
owned by the `session-history` widget while it is mounted — it cycles the view
the user is actually looking at, including its search hits — and falls back to
`SessionProvider`'s unfiltered project list on a page with no session list.

## Adding a producer

A producer needs a harness credential and loopback access. It does not need a
plugin, a client extension, or any Modus-side registration — it is an HTTP POST.

Keep the credential on the host adapter, never on the device. A microcontroller
should hold its own transport credential and nothing else; the adapter that talks
to Modus is the only thing that should hold a Modus bearer, and it should refuse
a non-loopback Modus URL rather than warn about one.
