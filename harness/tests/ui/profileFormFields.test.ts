/**
 * The profile editor must be a partial editor, not a truncating one.
 *
 * `PUT /api/profiles/:name` replaces the whole file, so any field the form does not render has to
 * ride along in the payload. From 2026-03-07 to 2026-08-20 it did not, and saving a profile from
 * the UI silently deleted `permissionPolicy`, `moves`, `skills`, `providerControls`, `ui` and the
 * rest. The first test below is the one that matters: it walks every non-form key of a fully
 * populated profile rather than listing a few, so a newly added `Profile` field is covered the
 * day it lands.
 */

import { describe, expect, test } from "bun:test";
import {
  FORM_MANAGED_FIELDS,
  buildProfileSavePayload,
  unmanagedProfileFields,
  type ProfileFormValues,
} from "../../ui/src/profile-form-fields";

/** Every field the editor does not render, with a value distinguishable from a default. */
const FULL_PROFILE = {
  name: "fns-architect",
  key: "fns-architect",
  displayName: "fns-architect",
  origin: "project" as const,
  description: "architect",
  prompt: "you are an architect",
  promptMode: "append" as const,
  provider: "claude-code",
  model: "claude-fable-5",
  effort: "high",
  maxTurns: 40,
  tools: ["Read", "Bash"],
  loadProjectSettings: true,
  mcpServers: { TD: { type: "http" as const, url: "http://127.0.0.1:13320/mcp" } },
  // Not rendered by the form — all of this must survive a save.
  permissionPolicy: { default: "approve" as const, requireApproval: ["Bash"] },
  providerControls: { claude: { permissionMode: "dontAsk" as const } },
  ui: { label: "sdtd 032 + TD", placeholder: "what are we building in TouchDesigner?" },
  moves: [{ name: "modus-brain" }],
  skills: ["create-profile"],
  disallowedTools: ["WebFetch"],
  additionalDirectories: ["C:/extra"],
  cwdSuggestions: ["C:/a"],
  cwd: "C:/VJ/TD",
  env: { FOO: "bar" },
  maxBudgetUsd: 5,
};

const FORM: ProfileFormValues = {
  description: "architect",
  prompt: "you are an architect",
  promptMode: "append",
  loadProjectSettings: true,
  provider: "claude-code",
  model: "claude-fable-5",
  effort: "high",
  maxTurns: "40",
  tools: ["Read", "Bash"],
  mcpServers: FULL_PROFILE.mcpServers,
  permissionPolicy: FULL_PROFILE.permissionPolicy,
};

describe("buildProfileSavePayload", () => {
  test("preserves every profile field the form does not render", () => {
    const payload = buildProfileSavePayload(FULL_PROFILE, FORM);
    const managed = new Set<string>(FORM_MANAGED_FIELDS);
    const decoration = new Set(["name", "key", "displayName", "origin", "pluginId", "pluginName", "pluginPath"]);

    const shouldSurvive = Object.keys(FULL_PROFILE)
      .filter((key) => !managed.has(key) && !decoration.has(key));

    // Guard against the fixture silently losing its point.
    expect(shouldSurvive.length).toBeGreaterThan(8);
    for (const key of shouldSurvive) {
      expect(payload).toHaveProperty(key);
      expect(payload[key]).toEqual((FULL_PROFILE as Record<string, unknown>)[key]);
    }
  });

  test("permissionPolicy survives — losing it drops the profile to the bypass default", () => {
    const payload = buildProfileSavePayload(FULL_PROFILE, FORM);
    expect(payload.permissionPolicy).toEqual({ default: "approve", requireApproval: ["Bash"] });
  });

  test("resolution metadata never reaches the request body", () => {
    const payload = buildProfileSavePayload(FULL_PROFILE, FORM);
    for (const key of ["name", "key", "displayName", "origin"]) {
      expect(payload).not.toHaveProperty(key);
    }
  });

  test("form values win over the loaded profile", () => {
    const payload = buildProfileSavePayload(FULL_PROFILE, { ...FORM, description: "edited", effort: "low" });
    expect(payload.description).toBe("edited");
    expect(payload.effort).toBe("low");
  });

  test("clearing an optional form field removes it rather than sending it empty", () => {
    const payload = buildProfileSavePayload(FULL_PROFILE, {
      ...FORM,
      model: "",
      effort: "",
      maxTurns: "",
      tools: null,
      mcpServers: {},
    });
    for (const key of ["model", "effort", "maxTurns", "tools", "mcpServers"]) {
      expect(payload).not.toHaveProperty(key);
    }
    // ...while the untouched half is still intact.
    expect(payload.permissionPolicy).toBeDefined();
    expect(payload.moves).toBeDefined();
  });

  test("a new profile has nothing to carry forward", () => {
    const payload = buildProfileSavePayload({}, FORM);
    expect(Object.keys(payload).sort()).toEqual(
      ["description", "effort", "loadProjectSettings", "maxTurns", "mcpServers", "model", "permissionPolicy", "prompt", "promptMode", "provider", "tools"],
    );
  });

  test("an empty tool surface is sent as [], not dropped into meaning 'all'", () => {
    // The SDK documents `tools: []` as "disable all built-in tools". Omitting the key restores
    // the full default set, so collapsing [] to absent silently granted a locked-down profile
    // every tool — an escalation, not a cosmetic default.
    const payload = buildProfileSavePayload(FULL_PROFILE, { ...FORM, tools: [] });
    expect(payload).toHaveProperty("tools");
    expect(payload.tools).toEqual([]);
  });

  test("null tools means inherit, and is the only thing that omits the key", () => {
    expect(buildProfileSavePayload(FULL_PROFILE, { ...FORM, tools: null })).not.toHaveProperty("tools");
    expect(buildProfileSavePayload(FULL_PROFILE, { ...FORM, tools: ["Read"] }).tools).toEqual(["Read"]);
  });

  test("maxTurns crosses as a number, not the input's string", () => {
    const payload = buildProfileSavePayload({}, { ...FORM, maxTurns: "12" });
    expect(payload.maxTurns).toBe(12);
  });
});

describe("unmanagedProfileFields", () => {
  test("excludes exactly the form-managed keys", () => {
    const unmanaged = unmanagedProfileFields(FULL_PROFILE);
    for (const key of FORM_MANAGED_FIELDS) {
      expect(unmanaged).not.toHaveProperty(key);
    }
  });
});
