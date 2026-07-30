/**
 * Move op request parsing.
 *
 * `POST /api/moves/:name/op` was JSON-only, which meant authored content could
 * not accept media. A plugin wanting to send audio, an image, or a file had to
 * base64 it into a JSON string — a third larger on the wire, and decoded twice.
 *
 * This module adds a multipart form to that route without touching the JSON
 * path. It lives outside `index.ts` because that module starts a server on
 * import, so anything that needs a unit test has to be reachable without it.
 *
 * Shape of a multipart call:
 *
 *   apiToken=mapi-…            required (or inside `json`)
 *   op=transcribe              required (or inside `json`)
 *   json={"language":"en"}     optional — a JSON object, merged with real types
 *   language=en                plain fields, always strings
 *   file=<binary>              becomes a `File` in the data record
 *
 * The `json` part exists because multipart has no types: a handler written
 * against the JSON path and given `"false"` instead of `false` breaks in a way
 * that is tedious to find. Coercing field values by guessing would break any
 * field that is legitimately the string "false", so instead the caller states
 * which values are structured and which are text.
 */

export type MoveOpRequest = {
  apiToken: string;
  op: string;
  data: Record<string, unknown>;
};

export type MoveOpParseError = { error: string };

/** Field names consumed by the envelope rather than passed to the handler. */
const ENVELOPE_FIELDS = new Set(["apiToken", "op", "json"]);

function isFileLike(value: unknown): value is File {
  return typeof File !== "undefined" && value instanceof File;
}

/**
 * Parse a multipart body into the same `{ apiToken, op, data }` envelope the
 * JSON path produces.
 *
 * Precedence, lowest to highest: `json` object → plain text fields → files. So a
 * caller can send a typed default and override one key with a plain field, and a
 * file always wins over a same-named text field (which would otherwise silently
 * discard the upload).
 */
export function parseMoveOpFormData(form: FormData): MoveOpRequest | MoveOpParseError {
  const data: Record<string, unknown> = {};

  const rawJson = form.get("json");
  if (typeof rawJson === "string" && rawJson.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      return { error: "the `json` part is not valid JSON" };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { error: "the `json` part must be a JSON object" };
    }
    Object.assign(data, parsed as Record<string, unknown>);
  }

  const files: Record<string, File | File[]> = {};
  for (const key of new Set(form.keys())) {
    if (ENVELOPE_FIELDS.has(key)) continue;
    const values = form.getAll(key);
    const fileValues = values.filter(isFileLike);
    if (fileValues.length > 0) {
      // Repeated keys stay an array so a handler can accept several uploads;
      // a single one is not wrapped, matching how a JSON caller would send it.
      files[key] = fileValues.length === 1 ? fileValues[0]! : fileValues;
      continue;
    }
    const textValues = values.map((value) => String(value));
    data[key] = textValues.length === 1 ? textValues[0] : textValues;
  }
  Object.assign(data, files);

  // The envelope fields may arrive as parts or inside `json`; a part wins.
  const formToken = form.get("apiToken");
  const apiToken = typeof formToken === "string" && formToken
    ? formToken
    : typeof data.apiToken === "string" ? data.apiToken : undefined;
  const formOp = form.get("op");
  const op = typeof formOp === "string" && formOp
    ? formOp
    : typeof data.op === "string" ? data.op : undefined;

  if (!apiToken) return { error: "apiToken required" };
  if (!op) return { error: "op required" };

  // Never forward the envelope to the handler, even when it came in via `json`.
  delete data.apiToken;
  delete data.op;

  return { apiToken, op, data };
}

/**
 * Parse the JSON body shape. Kept here so both content types produce the
 * envelope through one code path and the route stays a thin dispatcher.
 */
export function parseMoveOpJson(body: unknown): MoveOpRequest | MoveOpParseError {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "apiToken required" };
  }
  const { apiToken, op, ...rest } = body as Record<string, unknown>;
  if (typeof apiToken !== "string") return { error: "apiToken required" };
  if (typeof op !== "string") return { error: "op required" };
  return { apiToken, op, data: rest };
}

export function isMoveOpParseError(value: MoveOpRequest | MoveOpParseError): value is MoveOpParseError {
  return "error" in value;
}
