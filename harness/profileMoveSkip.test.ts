import { describe, expect, test } from "bun:test";
import { validate, ProfileSchema } from "./profile-schemas";
import { CreateSessionRequestSchema } from "./session-schemas";


/**
 * The composer shows a profile's inline moves as pending attachments before the
 * first message and lets the user drop any of them. Both halves of that ride on
 * `POST /api/sessions`, so the request schema has to accept them — a rejection
 * here is a 400 the composer has no way to surface.
 */
describe("create-session request carries move decisions", () => {
  test("accepts moves attached in the composer on the session's first message", () => {
    const req = validate(CreateSessionRequestSchema, {
      prompt: "hello",
      moves: [{ name: "briefing", inputs: { depth: "short" } }],
    });
    expect(req.ok).toBe(true);
  });

  test("accepts skipProfileMoves", () => {
    const req = validate(CreateSessionRequestSchema, {
      prompt: "hello",
      skipProfileMoves: ["house-style"],
    });
    expect(req.ok).toBe(true);
  });

  test("both are optional — an ordinary create is unaffected", () => {
    expect(validate(CreateSessionRequestSchema, { prompt: "hello" }).ok).toBe(true);
  });

  test("a move binding still requires a name", () => {
    const req = validate(CreateSessionRequestSchema, {
      prompt: "hello",
      moves: [{ inputs: {} }],
    });
    expect(req.ok).toBe(false);
  });

  test("skipProfileMoves must be strings, not binding objects", () => {
    const req = validate(CreateSessionRequestSchema, {
      prompt: "hello",
      skipProfileMoves: [{ name: "house-style" }],
    });
    expect(req.ok).toBe(false);
  });
});

describe("agent profile move bindings", () => {
  test("ask is accepted alongside inputs", () => {
    const profile = validate(ProfileSchema, {
      description: "test profile",
      prompt: "you are a test",
      moves: [{ name: "briefing", ask: true, inputs: { depth: "short" } }],
    });
    expect(profile.ok).toBe(true);
  });

  test("a binding without ask still validates", () => {
    const profile = validate(ProfileSchema, {
      description: "test profile",
      prompt: "you are a test",
      moves: [{ name: "house-style" }],
    });
    expect(profile.ok).toBe(true);
  });

  test("ask must be a boolean", () => {
    const profile = validate(ProfileSchema, {
      description: "test profile",
      prompt: "you are a test",
      moves: [{ name: "briefing", ask: "yes" }],
    });
    expect(profile.ok).toBe(false);
  });
});
