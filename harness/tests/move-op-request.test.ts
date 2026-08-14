/**
 * Move op envelope parsing.
 *
 * The multipart path is new; the JSON path is not. Half of these tests exist to
 * prove the JSON path did not change shape, because every existing widget and
 * every `callOp` caller depends on it.
 */
import { describe, expect, test } from "bun:test";
import {
  isMoveOpParseError,
  parseMoveOpFormData,
  parseMoveOpJson,
  type MoveOpRequest,
} from "../move-op-request";

function ok(result: ReturnType<typeof parseMoveOpFormData>): MoveOpRequest {
  if (isMoveOpParseError(result)) throw new Error(`expected success, got: ${result.error}`);
  return result;
}

describe("JSON path (unchanged behavior)", () => {
  test("splits the envelope from the handler payload", () => {
    const result = ok(parseMoveOpJson({ apiToken: "mapi-x", op: "render", text: "hi", n: 3 }));
    expect(result.apiToken).toBe("mapi-x");
    expect(result.op).toBe("render");
    expect(result.data).toEqual({ text: "hi", n: 3 });
  });

  test("preserves JSON types exactly", () => {
    const result = ok(parseMoveOpJson({
      apiToken: "t", op: "o", flag: false, count: 0, nested: { a: [1, 2] }, nothing: null,
    }));
    expect(result.data).toEqual({ flag: false, count: 0, nested: { a: [1, 2] }, nothing: null });
  });

  test("a missing or non-string apiToken is rejected", () => {
    expect(parseMoveOpJson({ op: "o" })).toEqual({ error: "apiToken required" });
    expect(parseMoveOpJson({ apiToken: 7, op: "o" })).toEqual({ error: "apiToken required" });
  });

  test("a missing op is rejected", () => {
    expect(parseMoveOpJson({ apiToken: "t" })).toEqual({ error: "op required" });
  });

  test("a non-object body is rejected rather than destructured", () => {
    expect(parseMoveOpJson(null)).toEqual({ error: "apiToken required" });
    expect(parseMoveOpJson([1, 2])).toEqual({ error: "apiToken required" });
    expect(parseMoveOpJson("nope")).toEqual({ error: "apiToken required" });
  });
});

describe("multipart path", () => {
  test("reads the envelope from parts and passes the rest through", () => {
    const form = new FormData();
    form.set("apiToken", "mapi-x");
    form.set("op", "transcribe");
    form.set("language", "en");
    const result = ok(parseMoveOpFormData(form));
    expect(result.apiToken).toBe("mapi-x");
    expect(result.op).toBe("transcribe");
    expect(result.data).toEqual({ language: "en" });
  });

  test("a file arrives as a File the handler can read, not a base64 string", async () => {
    const form = new FormData();
    form.set("apiToken", "t");
    form.set("op", "transcribe");
    form.set("audio", new File([new Uint8Array([1, 2, 3, 4])], "clip.wav", { type: "audio/wav" }));
    const result = ok(parseMoveOpFormData(form));
    const file = result.data.audio as File;
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("clip.wav");
    expect(file.type).toBe("audio/wav");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  test("repeated file keys become an array, a single one does not", () => {
    const form = new FormData();
    form.set("apiToken", "t");
    form.set("op", "o");
    form.append("shot", new File(["a"], "a.png"));
    form.append("shot", new File(["b"], "b.png"));
    const result = ok(parseMoveOpFormData(form));
    expect(Array.isArray(result.data.shot)).toBe(true);
    expect((result.data.shot as File[]).map((f) => f.name)).toEqual(["a.png", "b.png"]);
  });

  test("the json part restores real types that multipart cannot carry", () => {
    const form = new FormData();
    form.set("apiToken", "t");
    form.set("op", "o");
    form.set("json", JSON.stringify({ stream: false, chunks: 3, opts: { vad: true } }));
    const result = ok(parseMoveOpFormData(form));
    expect(result.data).toEqual({ stream: false, chunks: 3, opts: { vad: true } });
  });

  test("plain fields stay strings — no guessing", () => {
    const form = new FormData();
    form.set("apiToken", "t");
    form.set("op", "o");
    form.set("stream", "false");
    form.set("count", "3");
    const result = ok(parseMoveOpFormData(form));
    // Coercing these would break any field whose value is legitimately "false".
    expect(result.data).toEqual({ stream: "false", count: "3" });
  });

  test("a plain field overrides the same key in json", () => {
    const form = new FormData();
    form.set("apiToken", "t");
    form.set("op", "o");
    form.set("json", JSON.stringify({ language: "de" }));
    form.set("language", "en");
    expect(ok(parseMoveOpFormData(form)).data.language).toBe("en");
  });

  test("a file wins over a same-named text field rather than being dropped", () => {
    const form = new FormData();
    form.set("apiToken", "t");
    form.set("op", "o");
    form.append("blob", "placeholder");
    form.append("blob", new File(["x"], "real.bin"));
    expect((ok(parseMoveOpFormData(form)).data.blob as File).name).toBe("real.bin");
  });

  test("the envelope may travel inside json", () => {
    const form = new FormData();
    form.set("json", JSON.stringify({ apiToken: "mapi-inner", op: "render", x: 1 }));
    const result = ok(parseMoveOpFormData(form));
    expect(result.apiToken).toBe("mapi-inner");
    expect(result.op).toBe("render");
    expect(result.data).toEqual({ x: 1 });
  });

  test("the envelope is never forwarded to the handler", () => {
    const form = new FormData();
    form.set("json", JSON.stringify({ apiToken: "t", op: "o", keep: 1 }));
    form.set("apiToken", "t");
    form.set("op", "o");
    const result = ok(parseMoveOpFormData(form));
    expect(result.data).toEqual({ keep: 1 });
    expect(result.data.apiToken).toBeUndefined();
    expect(result.data.op).toBeUndefined();
  });

  test("malformed json is a clear error, not a silent drop", () => {
    const form = new FormData();
    form.set("apiToken", "t");
    form.set("op", "o");
    form.set("json", "{not json");
    expect(parseMoveOpFormData(form)).toEqual({ error: "the `json` part is not valid JSON" });
  });

  test("a json array is refused — the envelope needs named keys", () => {
    const form = new FormData();
    form.set("apiToken", "t");
    form.set("op", "o");
    form.set("json", "[1,2,3]");
    expect(parseMoveOpFormData(form)).toEqual({ error: "the `json` part must be a JSON object" });
  });

  test("missing envelope fields fail the same way the JSON path does", () => {
    const noToken = new FormData();
    noToken.set("op", "o");
    expect(parseMoveOpFormData(noToken)).toEqual({ error: "apiToken required" });

    const noOp = new FormData();
    noOp.set("apiToken", "t");
    expect(parseMoveOpFormData(noOp)).toEqual({ error: "op required" });
  });

  test("repeated text keys become an array of strings", () => {
    const form = new FormData();
    form.set("apiToken", "t");
    form.set("op", "o");
    form.append("tag", "a");
    form.append("tag", "b");
    expect(ok(parseMoveOpFormData(form)).data.tag).toEqual(["a", "b"]);
  });
});
