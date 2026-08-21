import { describe, expect, test } from "bun:test";
import { UserProfileUiConfigSchema } from "../../profile-schemas";
import {
  PROJECT_CHAT_OVERRIDE_KEYS,
  projectChatOverrideConfig,
  resolveEffectiveInterfaceSettings,
  resolveInterfaceSettings,
} from "../../ui/src/interface-settings";

describe("interface settings scope", () => {
  const deviceDefaults = resolveInterfaceSettings({
    chat: {
      fontScale: 115,
      chatWidth: 920,
      scrollIndicator: "ruler",
      presentation: "conversation",
      scrollThroughTurns: true,
    },
    conversation: { showThinking: false, toolCalls: "hidden" },
    motion: "reduced",
  });

  test("profile chat values do not override device defaults without an explicit scope", () => {
    const effective = resolveEffectiveInterfaceSettings({
      chat: { fontScale: 85, presentation: "turns" },
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
        presentation: "turns",
        scrollThroughTurns: false,
      },
      conversation: { showThinking: true, toolCalls: "expanded" },
      motion: "system",
    }, deviceDefaults);

    expect(effective.chat).toEqual({
      fontScale: 90,
      chatWidth: 700,
      scrollIndicator: "scroll",
      presentation: "turns",
      scrollThroughTurns: false,
    });
    expect(effective.conversation).toEqual(deviceDefaults.conversation);
    expect(effective.motion).toBe("reduced");
  });

  test("a partial project override inherits missing fields from this device", () => {
    const effective = resolveEffectiveInterfaceSettings({
      chat: { projectOverride: true, presentation: "turns" },
    }, deviceDefaults);

    expect(effective.chat).toEqual({
      ...deviceDefaults.chat,
      presentation: "turns",
    });
  });

  test("the project payload and eligibility catalog contain the same five fields", () => {
    const config = projectChatOverrideConfig(deviceDefaults);
    expect(PROJECT_CHAT_OVERRIDE_KEYS).toEqual([
      "fontScale",
      "chatWidth",
      "scrollIndicator",
      "presentation",
      "scrollThroughTurns",
    ]);
    expect(Object.keys(config).sort()).toEqual([
      ...PROJECT_CHAT_OVERRIDE_KEYS,
      "projectOverride",
    ].sort());
  });

  test("the profile UI schema accepts the explicit project presentation override", () => {
    expect(UserProfileUiConfigSchema.safeParse({
      interface: {
        chat: { projectOverride: true, presentation: "turns", scrollThroughTurns: true },
      },
    }).success).toBe(true);
  });
});
