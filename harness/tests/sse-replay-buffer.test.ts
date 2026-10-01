import { expect, test } from "bun:test";
import { createSSEReplayBuffer } from "../sse-replay-buffer";

test("buffers arrivals during replay and draining, then forwards live events in order", async () => {
  const delivered: string[] = [];
  const replay = createSSEReplayBuffer({
    async write(_event, data) {
      delivered.push(data);
      if (data === "prompt") await replay.writer.write("assistant", "response", "2");
    },
    close() { delivered.push("close"); },
  }, () => true);
  await replay.writer.write("user", "prompt", "1");
  expect(delivered).toEqual([]);
  await replay.flush();
  await replay.writer.write("result", "settled", "3");
  replay.writer.close();
  expect(delivered).toEqual(["prompt", "response", "settled", "close"]);
});

test("overflow closes the connection before delivering an incomplete replay", async () => {
  let closed = false;
  const delivered: string[] = [];
  const replay = createSSEReplayBuffer({
    async write(_event, data) { delivered.push(data); },
    close() { closed = true; },
  }, () => !closed);
  for (let seq = 1; seq <= 257; seq++) await replay.writer.write("user", "prompt", String(seq));
  await replay.flush();
  expect(closed).toBe(true);
  expect(delivered).toEqual([]);
});

test("a normal session close waits behind its buffered events", async () => {
  const delivered: string[] = [];
  let overflowed = false;
  const replay = createSSEReplayBuffer({
    async write(_event, data) { delivered.push(data); },
    close() { delivered.push("close"); },
  }, () => true, () => { overflowed = true; });
  await replay.writer.write("user", "prompt", "1");
  replay.writer.close();
  expect(delivered).toEqual([]);
  await replay.flush();
  expect(delivered).toEqual(["prompt", "close"]);
  expect(overflowed).toBe(false);
});

test("abort and disposal discard buffered writes and reject later delivery", async () => {
  let aborted = false;
  const delivered: string[] = [];
  const replay = createSSEReplayBuffer({
    async write(_event, data) { delivered.push(data); }, close() {},
  }, () => !aborted);
  await replay.writer.write("user", "prompt", "1");
  aborted = true;
  await replay.flush();
  replay.dispose();
  aborted = false;
  await replay.writer.write("user", "later", "2");
  expect(delivered).toEqual([]);
});
