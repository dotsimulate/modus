import { expect, test } from "bun:test";
import { UserProfileCoreSchema, UserProfileUiConfigSchema } from "./profile-schemas";

test("interface settings validate in the UI sidecar and stay out of profile core", () => {
  const interfaceConfig = {
    chat: { fontScale: 125, chatWidth: 1040, spineEnabled: false },
    conversation: {
      showThinking: false,
      showMeta: true,
      toolCalls: "expanded" as const,
      showGitEvents: true,
      showFileChanges: false,
    },
    motion: "reduced" as const,
  };
  expect(UserProfileUiConfigSchema.parse({ interface: interfaceConfig }).interface).toEqual(interfaceConfig);
  expect(UserProfileUiConfigSchema.safeParse({ interface: { chat: { fontScale: 10 } } }).success).toBe(false);

  const core = UserProfileCoreSchema.parse({
    displayName: "Dot",
    projects: [],
    interface: interfaceConfig,
  });
  expect("interface" in core).toBe(false);
});
