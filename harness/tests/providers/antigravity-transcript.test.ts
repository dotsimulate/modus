import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  AntigravityTranscriptTail,
  agyWoke,
  antigravityTranscriptPath,
  backgroundTaskFinished,
  backgroundTaskStarted,
  commandLineText,
  stepIsWake,
  timerSeconds,
} from "../../providers/antigravity-transcript";

const root = mkdtempSync(join(tmpdir(), "modus-agy-transcript-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// Shapes copied from an agy 1.5.9 conversation record, with paths and output replaced.
const started = {
  step_index: 110,
  source: "MODEL",
  type: "GENERIC",
  status: "RUNNING",
  created_at: "2026-11-17T18:33:56Z",
  content: "Created At: 2026-11-17T13:33:56-05:00\nTool is running as a background task with task id: conv-1/task-110\n"
    + "Task Description: voro lab check scene.voro; voro lab look scene.voro\nTask logs are available at: file:///logs/task-110.log\n"
    + "YOU MUST TAKE ONE OF THE FOLLOWING TWO ACTIONS: A) either proceed to other relevant work (if any) or, B) simply update the user",
};

const finished = {
  step_index: 112,
  source: "SYSTEM",
  type: "SYSTEM_MESSAGE",
  status: "DONE",
  created_at: "2026-11-17T18:34:34Z",
  content: "The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n"
    + "[Message] timestamp=2026-11-17T18:34:34Z sender=conv-1/task-110 priority=MESSAGE_PRIORITY_HIGH "
    + "content=Task id \"conv-1/task-110\" finished with result:\nCommand exited with code 0.\n\nCommand output:\n{\r\r\n \"ok\": true\r\r\n}\r\n"
    + "\nLog: file:///logs/task-110.log\n</SYSTEM_MESSAGE>",
};

describe("agy conversation record", () => {
  test("lives under the conversation's brain directory", () => {
    expect(antigravityTranscriptPath("conv-1", "/home/u"))
      .toBe(join("/home/u", ".gemini", "antigravity-cli", "brain", "conv-1", ".system_generated", "logs", "transcript.jsonl"));
  });

  test("reads a backgrounded command and the message that wakes agy when it finishes", () => {
    expect(backgroundTaskStarted(started)).toEqual({
      taskId: "conv-1/task-110",
      description: "voro lab check scene.voro; voro lab look scene.voro",
    });
    expect(backgroundTaskStarted(finished)).toBeNull();
    expect(backgroundTaskFinished(finished)).toEqual({
      taskId: "conv-1/task-110",
      output: "Command exited with code 0.\n\nCommand output:\n{\n \"ok\": true\n}\n\nLog: file:///logs/task-110.log",
      canceled: false,
    });
    expect(backgroundTaskFinished({ ...finished, source: "MODEL" })).toBeNull();
    // A canceled task ends too, so nothing waits on it.
    expect(backgroundTaskFinished({
      ...finished,
      content: "<SYSTEM_MESSAGE>\n[Message] sender=conv-1/task-82 priority=MESSAGE_PRIORITY_LOW "
        + "content=Task id \"conv-1/task-82\" was canceled with result:\nTool execution was canceled\nLog: file:///logs/task-82.log\n</SYSTEM_MESSAGE>",
    })).toEqual({ taskId: "conv-1/task-82", output: "Tool execution was canceled\nLog: file:///logs/task-82.log", canceled: true });
  });

  test("reads a multi-line command's whole description, and a timer's length", () => {
    const multiLine = {
      ...started,
      content: "Created At: 2026-11-20T05:51:42-05:00\nTool is running as a background task with task id: conv-1/task-142\r\n"
        + "Task Description: cd D:/studies/shapes\r\nvoro lab disconnect stage/gallery.voro\nvoro lab look examples/10/scene.voro settle=2\n"
        + "Task logs are available at: file:///logs/task-142.log\nLog output:\n{\r\n \"disconnected\": \"tfbh2f\"\r\n}",
    };
    expect(backgroundTaskStarted(multiLine)).toEqual({
      taskId: "conv-1/task-142",
      description: "cd D:/studies/shapes\nvoro lab disconnect stage/gallery.voro\nvoro lab look examples/10/scene.voro settle=2",
    });
    expect(backgroundTaskStarted(multiLine)?.description)
      .toBe(commandLineText("\"cd D:/studies/shapes\\nvoro lab disconnect stage/gallery.voro\\nvoro lab look examples/10/scene.voro settle=2\""));
    const timer = {
      ...started,
      content: "Tool is running as a background task with task id: conv-1/task-144\n"
        + "Task Description: Timer: 25s, Prompt: Check task-142 progress if it has not yet finished\nTask logs are available at: file:///logs/task-144.log",
    };
    const description = backgroundTaskStarted(timer)?.description ?? "";
    expect(description).toBe("Timer: 25s, Prompt: Check task-142 progress if it has not yet finished");
    expect(timerSeconds(description)).toBe(25);
    expect(timerSeconds("voro lab look scene.voro")).toBeNull();
  });

  test("a system message is a wake only until agy responds to it", () => {
    const returned = Date.parse("2026-11-20T10:52:09.437Z");
    const response = { source: "MODEL", type: "PLANNER_RESPONSE", created_at: "2026-11-20T10:52:04Z" };
    const stale = { ...finished, created_at: "2026-11-20T10:43:14Z" };
    // A finish the run already took in, read late at the hold, is not a wake.
    expect(agyWoke([stale, { ...response, created_at: "2026-11-20T10:43:14Z" }, response], returned)).toBe(false);
    // One posted after agy's last response is, whatever its timestamp.
    expect(agyWoke([response, { ...finished, created_at: "2026-11-20T10:52:08Z" }], returned)).toBe(true);
    // As is any model step agy started after the prompt returned.
    expect(agyWoke([{ ...response, created_at: "2026-11-20T10:52:20Z" }], returned)).toBe(true);
    expect(agyWoke([{ source: "SYSTEM", type: "CHECKPOINT", created_at: "2026-11-20T10:52:20Z" }], returned)).toBe(false);
    expect(agyWoke([], returned)).toBe(false);
  });

  test("counts only steps agy started after the prompt returned as a wake", () => {
    const returned = Date.parse("2026-11-17T18:34:10.400Z");
    expect(stepIsWake(finished, returned)).toBe(true);
    // The reply's last step, written before the prompt returned.
    expect(stepIsWake({ source: "MODEL", created_at: "2026-11-17T18:34:08Z" }, returned)).toBe(false);
    // Same second as the return: too close to call for a model step.
    expect(stepIsWake({ source: "MODEL", created_at: "2026-11-17T18:34:10Z" }, returned)).toBe(false);
    expect(stepIsWake({ source: "MODEL", created_at: "2026-11-17T18:34:12Z" }, returned)).toBe(true);
    expect(stepIsWake({ source: "USER_EXPLICIT", created_at: "2026-11-17T18:58:23Z" }, returned)).toBe(false);
    expect(stepIsWake({ ...finished, created_at: "2026-11-17T18:32:07Z" }, returned)).toBe(false);
  });

  test("unquotes command lines agy records as JSON text", () => {
    expect(commandLineText("\"voro lab look scene.voro\"")).toBe("voro lab look scene.voro");
    expect(commandLineText(" npm run dev ")).toBe("npm run dev");
    expect(commandLineText(undefined)).toBe("");
  });

  test("tails only what was appended since it opened, across partial lines", () => {
    const path = join(root, "transcript.jsonl");
    writeFileSync(path, `${JSON.stringify({ step_index: 1, source: "MODEL" })}\n`);
    const tail = new AntigravityTranscriptTail(path);
    expect(tail.read()).toEqual([]);
    const line = JSON.stringify(finished);
    appendFileSync(path, line.slice(0, 40));
    expect(tail.read()).toEqual([]);
    appendFileSync(path, `${line.slice(40)}\n${JSON.stringify({ step_index: 113, source: "MODEL" })}\n`);
    expect(tail.read().map((step) => step.step_index)).toEqual([112, 113]);
    expect(tail.read()).toEqual([]);
  });

  test("starts from the beginning of a record that does not exist yet", () => {
    const path = join(root, "later.jsonl");
    const tail = new AntigravityTranscriptTail(path);
    expect(tail.read()).toEqual([]);
    writeFileSync(path, `${JSON.stringify(started)}\n`);
    expect(tail.read().map((step) => step.step_index)).toEqual([110]);
  });
});
