import { resolve as resolveTestSourceDir } from "node:path";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { settingNumberError, type ExtensionSettingSchema } from "../settings-schema";
import type { ExtensionSettingSchema as SdkExtensionSettingSchema } from "../sdk/types";
import type { PluginSettingDefinition } from "../modus-plugins";
import type { PluginSettingDefinition as SdkPluginSettingDefinition } from "../sdk/types";

// The declarations these three modules publish must be the same type, not merely
// compatible ones. A structural check would pass two copies that happen to agree
// today, which is exactly the state that drifted: `textarea`/`secret-name` and
// `rows` reached the SDK copy and never reached backend discovery. Assigning a
// value typed by one to the other in both directions fails to compile the moment
// either grows a field the other lacks.
describe("one declaration, not two", () => {
  test("the extension schema the SDK publishes is the one discovery reads", () => {
    const declared: ExtensionSettingSchema = { type: "textarea", label: "Vocabulary", rows: 8 };
    const viaSdk: SdkExtensionSettingSchema = declared;
    const back: ExtensionSettingSchema = viaSdk;
    expect(back.rows).toBe(8);
  });

  test("the plugin definition the SDK publishes is the one manifests are parsed into", () => {
    const declared: PluginSettingDefinition = { key: "port", type: "number", min: 1, max: 65535 };
    const viaSdk: SdkPluginSettingDefinition = declared;
    const back: PluginSettingDefinition = viaSdk;
    expect(back.max).toBe(65535);
  });
});

// A type-identity check cannot see a *third* copy appearing somewhere else, and a
// re-declaration is how this drifted the first time. Match the declaration form
// only, so prose in a comment explaining the rule stays legal.
describe("no module re-declares a settings shape", () => {
  const OWNER = "settings-schema.ts";
  const watched = [
    "client-extensions.ts",
    "modus-plugins.ts",
    "sdk/types.ts",
  ];
  const shapes = [
    "ExtensionSettingSchema",
    "ExtensionSettingType",
    "ExtensionSettingScope",
    "ExtensionMeta",
    "PluginSettingDefinition",
    "PluginSettingScope",
  ];

  for (const file of watched) {
    test(`${file} imports the shapes rather than declaring them`, () => {
      const source = readFileSync(join(resolveTestSourceDir(import.meta.dir, ".."), file), "utf8");
      for (const shape of shapes) {
        const declaration = new RegExp(`(export\\s+)?type\\s+${shape}\\s*=`);
        expect({ file, shape, declares: declaration.test(source) })
          .toEqual({ file, shape, declares: false });
      }
      expect(source).toContain(OWNER.replace(".ts", ""));
    });
  }
});

describe("settingNumberError", () => {
  test("accepts a value inside the declared bounds", () => {
    expect(settingNumberError("port", 8080, { min: 1, max: 65535 })).toBeNull();
  });

  test("rejects a non-number regardless of bounds", () => {
    expect(settingNumberError("port", "8080", {})).toBe("port must be a finite number");
    expect(settingNumberError("port", NaN, {})).toBe("port must be a finite number");
  });

  test("bounds are inclusive", () => {
    expect(settingNumberError("gain", 0, { min: 0, max: 10 })).toBeNull();
    expect(settingNumberError("gain", 10, { min: 0, max: 10 })).toBeNull();
    expect(settingNumberError("gain", -1, { min: 0, max: 10 })).toBe("gain must be at least 0");
    expect(settingNumberError("gain", 11, { min: 0, max: 10 })).toBe("gain must be at most 10");
  });

  test("an undeclared bound does not constrain", () => {
    expect(settingNumberError("gain", -9999, { max: 10 })).toBeNull();
    expect(settingNumberError("gain", 9999, { min: 0 })).toBeNull();
  });

  // step describes stepper granularity for the renderer. Rejecting an off-step
  // value the user typed deliberately would be worse than accepting it.
  test("step is advisory and never rejects", () => {
    expect(settingNumberError("gain", 2.5, { min: 0, max: 10, step: 1 })).toBeNull();
  });
});
