import { describe, expect, test } from "bun:test";
import { UserProfileUiConfigSchema } from "../../profile-schemas";
import {
  PROJECT_CHAT_OVERRIDE_KEYS,
  projectChatOverrideConfig,
  resolveEffectiveInterfaceSettings,
  resolveInterfaceSettings,
  writableProjectChatConfig,
} from "../../ui/src/interface-settings";

describe("interface settings scope", () => {
  const deviceDefaults = resolveInterfaceSettings({
    chat: {
      fontScale: 115,
      chatWidth: 920,
      scrollIndicator: "ruler",
      lensId: "project:ledger",
      scrollThroughTurns: true,
    },
    conversation: { showThinking: false, toolCalls: "hidden" },
    motion: "reduced",
  });

  test("profile chat values do not override device defaults without an explicit scope", () => {
    const effective = resolveEffectiveInterfaceSettings({
      chat: { fontScale: 85, lensId: "core:focus" },
    }, deviceDefaults);

    expect(effective).toEqual(deviceDefaults);
  });

  test("an enabled project override replaces only the promoted display fields", () => {
    const effective = resolveEffectiveInterfaceSettings({
      chat: {
        projectOverride: true,
        fontScale: 90,
        chatWidth: 700,
        scrollIndicator: "scroll",
        lensId: "core:focus",
        scrollThroughTurns: false,
      },
      conversation: { showThinking: true, toolCalls: "expanded" },
      motion: "system",
    }, deviceDefaults);

    expect(effective.chat).toEqual({
      fontScale: 90,
      chatWidth: 700,
      scrollIndicator: "scroll",
      lensId: "core:focus",
      scrollThroughTurns: false,
    });
    expect(effective.conversation).toEqual(deviceDefaults.conversation);
    expect(effective.motion).toBe("reduced");
  });

  test("a partial project override inherits missing fields from this device", () => {
    const effective = resolveEffectiveInterfaceSettings({
      chat: { projectOverride: true, lensId: "core:focus" },
    }, deviceDefaults);

    expect(effective.chat).toEqual({
      ...deviceDefaults.chat,
      lensId: "core:focus",
    });
  });

  test("the project payload and eligibility catalog contain the same five fields", () => {
    const config = projectChatOverrideConfig(deviceDefaults);
    expect(PROJECT_CHAT_OVERRIDE_KEYS).toEqual([
      "fontScale",
      "chatWidth",
      "scrollIndicator",
      "lensId",
      "scrollThroughTurns",
    ]);
    expect(Object.keys(config).sort()).toEqual([
      ...PROJECT_CHAT_OVERRIDE_KEYS,
      "projectOverride",
    ].sort());
  });

  test("the profile UI schema accepts an open-world project lens override", () => {
    expect(UserProfileUiConfigSchema.safeParse({
      interface: {
        chat: { projectOverride: true, lensId: "project:contact-sheet", scrollThroughTurns: true },
      },
    }).success).toBe(true);
  });

  test("legacy presentation values migrate while authored ids remain open-world", () => {
    expect(resolveInterfaceSettings({ chat: { presentation: "conversation" } }).chat.lensId)
      .toBe("core:transcript");
    expect(resolveInterfaceSettings({ chat: { presentation: "turns" } }).chat.lensId)
      .toBe("core:focus");
    expect(resolveInterfaceSettings({
      chat: { lensId: "project:contact-sheet", presentation: "conversation" },
    }).chat.lensId).toBe("project:contact-sheet");
  });

  test("project writes converge on lensId and remove the legacy enum", () => {
    const config = writableProjectChatConfig({
      presentation: "turns",
      showLegacyThing: true,
    } as any, deviceDefaults);
    expect(config.lensId).toBe("project:ledger");
    expect(config.presentation).toBeUndefined();
    expect((config as any).showLegacyThing).toBe(true);
  });
});
