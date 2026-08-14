/**
 * The session config bar's item list is user-selectable, which makes its
 * resolution the load-bearing part: a config written by an older or newer build
 * must still produce a usable bar rather than an empty one or a crash.
 */

import { describe, expect, test } from "bun:test";
import {
  CONFIG_BAR_ITEMS,
  DEFAULT_INTERFACE_SETTINGS,
  resolveInterfaceSettings,
} from "../../ui/src/interface-settings";

describe("config bar item resolution", () => {
  test("an absent list falls back to the defaults", () => {
    expect(resolveInterfaceSettings().configBar.items)
      .toEqual(DEFAULT_INTERFACE_SETTINGS.configBar.items);
    expect(resolveInterfaceSettings({ configBar: {} }).configBar.items)
      .toEqual(DEFAULT_INTERFACE_SETTINGS.configBar.items);
  });

  test("context is on by default", () => {
    expect(DEFAULT_INTERFACE_SETTINGS.configBar.items).toContain("context");
  });

  test("an explicit empty list means show nothing, not show everything", () => {
    expect(resolveInterfaceSettings({ configBar: { items: [] } }).configBar.items).toEqual([]);
  });

  test("items render in catalog order however the list was written", () => {
    const items = resolveInterfaceSettings({
      configBar: { items: ["effort", "profile", "context", "model"] },
    }).configBar.items;
    expect(items).toEqual(["profile", "model", "effort", "context"]);
  });

  test("an id this build does not know is dropped, not fatal", () => {
    const items = resolveInterfaceSettings({
      configBar: { items: ["profile", "some-future-readout", "context"] },
    }).configBar.items;
    expect(items).toEqual(["profile", "context"]);
  });

  test("a malformed value falls back rather than producing an empty bar", () => {
    const items = resolveInterfaceSettings({
      configBar: { items: "profile" as unknown as string[] },
    }).configBar.items;
    expect(items).toEqual(DEFAULT_INTERFACE_SETTINGS.configBar.items);
  });

  test("every default is a real catalog id", () => {
    const known = new Set(CONFIG_BAR_ITEMS.map((item) => item.id));
    for (const id of DEFAULT_INTERFACE_SETTINGS.configBar.items) {
      expect(known.has(id)).toBe(true);
    }
  });
});

describe("deferral setting", () => {
  test("defaults to on so heavy turns stay on demand", () => {
    expect(DEFAULT_INTERFACE_SETTINGS.conversation.deferHeavyDetails).toBe(true);
  });

  test("can be turned off explicitly", () => {
    expect(resolveInterfaceSettings({ conversation: { deferHeavyDetails: false } })
      .conversation.deferHeavyDetails).toBe(false);
  });
});
