import { describe, expect, test } from "bun:test";
import { redactProviderDiagnostic } from "./provider-diagnostics";

describe("redactProviderDiagnostic", () => {
  test("redacts bearer, structured, URL-query, and URL-userinfo credentials", () => {
    const diagnostic = [
      "Authorization: Bearer bearer-canary",
      '"x-api-key":"json-canary"',
      '"token":"bare-token-canary"',
      "API_TOKEN=env-canary",
      "GITHUB_TOKEN=github-canary",
      "https://example.invalid/path?token=query-canary&ok=yes",
      "https://user-canary:password-canary@example.invalid/path",
    ].join("\n");

    const redacted = redactProviderDiagnostic(diagnostic);
    for (const canary of [
      "bearer-canary",
      "json-canary",
      "bare-token-canary",
      "env-canary",
      "github-canary",
      "query-canary",
      "user-canary",
      "password-canary",
    ]) {
      expect(redacted).not.toContain(canary);
    }
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).toContain("ok=yes");
  });

  test("preserves ordinary provider errors", () => {
    expect(redactProviderDiagnostic("model not found: claude-example")).toBe("model not found: claude-example");
  });
});
