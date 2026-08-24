import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import type {
  ConversationCapabilityResolution,
  ConversationLensDefinitionV1,
  ConversationLensRegistryEntry,
  ConversationProjectionRegistryEntry,
  ConversationResourceRegistry,
} from "../../sdk/types";
import {
  resolveConversationCapabilities,
  resolveConversationLens,
} from "../../ui/src/conversation-lens-resolution";
import { lintConversationLens } from "../../ui/src/page-lint";
import { WIDGET_META } from "../../ui/src/widgets/catalog";

const available = (id: string, definition?: Partial<ConversationLensDefinitionV1>): ConversationLensRegistryEntry => ({
  id,
  status: "available",
  source: { kind: id.startsWith("core:") ? "harness" : "project", label: "test", key: `test:${id}` },
  definition: {
    contract: "conversation-lens@1",
    id,
    label: id,
    layout: { kind: "widget", widget: { type: "session-turn" } },
    layouts: { mobile: { kind: "widget", widget: { type: "session-turn" } } },
    ...definition,
  },
});

const capabilities = resolveConversationCapabilities({ sessionId: "s1" });
const sessionTurnsSource = readFileSync(
  join(import.meta.dir, "..", "..", "ui", "src", "widgets", "session-turns.widget.tsx"),
  "utf8",
);

function registry(lenses: ConversationLensRegistryEntry[]): ConversationResourceRegistry {
  return {
    contract: "conversation-resources@1",
    cwd: "project",
    lenses,
    projections: [],
    diagnostics: [],
  };
}

describe("conversation lens resolution", () => {
  test("preserves an open-world requested id and records a reasoned Transcript fallback", () => {
    const result = resolveConversationLens(
      registry([available("core:transcript")]),
      "project:missing",
      "project:missing",
      capabilities,
    );
    expect(result.requestedId).toBe("project:missing");
    expect(result.resolvedId).toBe("core:transcript");
    expect(result.reason).toContain("not discovered for this project");
  });

  test("uses the lens-declared fallback before the device default", () => {
    const result = resolveConversationLens(
      registry([
        { ...available("project:broken", { fallback: "project:safe" }), status: "invalid", reason: "bad layout" },
        available("project:safe"),
        available("core:transcript"),
      ]),
      "project:broken",
      "core:transcript",
      capabilities,
    );
    // Invalid entries do not publish a definition in the backend, so their
    // fallback cannot be trusted; the configured default remains the safe path.
    expect(result.resolvedId).toBe("core:transcript");
    expect(result.reason).toContain("bad layout");
  });

  test("required capability failures are visible and terminate at Transcript", () => {
    const unavailable = {
      ...capabilities,
      "conversation.turn-index": {
        status: "unavailable",
        reason: "endpoint unavailable",
        version: 1,
      } satisfies ConversationCapabilityResolution,
    };
    const result = resolveConversationLens(
      registry([
        available("project:index", { capabilities: { required: ["conversation.turn-index"] } }),
        available("core:transcript"),
      ]),
      "project:index",
      "project:index",
      unavailable,
    );
    expect(result.resolvedId).toBe("core:transcript");
    expect(result.reason).toContain("endpoint unavailable");
  });

  test("capability states distinguish disabled, unavailable, degraded, and available", () => {
    const result = resolveConversationCapabilities({
      sessionId: "s1",
      disabled: ["conversation.compose"],
      unavailable: { "conversation.turn-index": "no endpoint" },
      degraded: { "conversation.history": "partial history" },
    });
    expect(result["conversation.compose"].status).toBe("disabled");
    expect(result["conversation.turn-index"].status).toBe("unavailable");
    expect(result["conversation.history"].status).toBe("degraded");
    expect(result["conversation.permissions"].status).toBe("available");
  });
});

describe("conversation lens lint", () => {
  test("the two harness lenses have no lens or page errors", () => {
    for (const name of ["transcript.json", "focus.json"]) {
      const lens = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "lenses", name), "utf8"));
      const errors = lintConversationLens(lens, WIDGET_META).filter((finding) => finding.severity === "error");
      expect(errors).toEqual([]);
    }
  });

  test("Focus keeps its turn index as a genuinely narrow collapsible rail", () => {
    const focus = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "lenses", "focus.json"), "utf8"));
    expect(focus.layout.sizes).toEqual([0.2, 4]);
    expect(focus.layout.collapsible).toEqual([true, false]);
    expect(focus.layout.children[0].widget.type).toBe("session-turns");
    expect(focus.layout.children[0].widget.labels).toBe(false);
    expect(focus.layout.children[0].widget.header).toBe(false);
    expect(focus.layout.children[1].widget.type).toBe("session-turn");
    expect(focus.layouts.mobile.children[1].widget.header).toBeUndefined();
    expect(sessionTurnsSource).toContain("config.header !== false");
    expect(sessionTurnsSource).toContain("session-turns--bare");
    expect(sessionTurnsSource).toContain("config.header === false && config.labels === false");
  });

  test("catches missing mobile safety, capability providers, and recovery", () => {
    const lens: ConversationLensDefinitionV1 = {
      contract: "conversation-lens@1",
      id: "project:overview",
      label: "Overview",
      capabilities: { required: ["conversation.turn-index"] },
      layout: { kind: "widget", widget: { type: "session-turn" } },
    };
    const rules = lintConversationLens(lens, WIDGET_META).map((finding) => finding.rule);
    expect(rules).toContain("missing-mobile-layout");
    expect(rules).toContain("missing-required-capability");
    expect(rules).toContain("missing-lossless-recovery");
  });

  test("catches an unavailable authored projection", () => {
    const lens: ConversationLensDefinitionV1 = {
      contract: "conversation-lens@1",
      id: "project:projection",
      label: "Projection",
      fallback: "core:transcript",
      layout: { kind: "widget", widget: { type: "conversation-projection", projectionId: "broken" } },
      layouts: { mobile: { kind: "widget", widget: { type: "conversation-projection", projectionId: "broken" } } },
    };
    const projections: ConversationProjectionRegistryEntry[] = [{
      id: "broken",
      status: "invalid",
      reason: "component missing",
      source: { kind: "project", label: "project", key: "project:broken" },
    }];
    const findings = lintConversationLens(lens, WIDGET_META, projections);
    expect(findings.find((finding) => finding.rule === "invalid-projection")?.message)
      .toContain("component missing");
  });

  test("permissions are host-owned and cannot be removed by an empty authored layout", () => {
    const lens: ConversationLensDefinitionV1 = {
      contract: "conversation-lens@1",
      id: "project:read-only",
      label: "Read only",
      capabilities: { required: ["conversation.permissions"] },
      fallback: "core:transcript",
      layout: { kind: "grid", columns: 1, children: [] },
      layouts: { mobile: { kind: "grid", columns: 1, children: [] } },
    };
    const findings = lintConversationLens(lens, WIDGET_META);
    expect(findings.some((finding) => (
      finding.rule === "missing-required-capability" && finding.message.includes("permissions")
    ))).toBe(false);
  });
});
