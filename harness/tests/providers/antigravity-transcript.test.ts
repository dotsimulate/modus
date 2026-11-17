import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  AntigravityTranscriptTail,
  antigravityTranscriptPath,
  backgroundTaskFinished,
  backgroundTaskStarted,
  commandLineText,
  stepIsWake,
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
    });
    expect(backgroundTaskFinished({ ...finished, source: "MODEL" })).toBeNull();
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
