import { afterEach, describe, expect, it } from "bun:test";
import {
  loadClientExtensions,
  unloadClientExtensions,
  type ClientExtensionModuleLoader,
} from "../../ui/src/client-extensions";
import type { ClientExtensionManifestItem } from "../../sdk/types";

function manifestItem(id: string): ClientExtensionManifestItem {
  return {
    id,
    fileName: `${id}.js`,
    source: "plugin",
    pluginId: "test-plugin",
    enabled: true,
    moduleUrl: `/api/client-extensions/${id}/module`,
    settingsValues: {},
  } as ClientExtensionManifestItem;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

// A refresh fires on every settle step of a project or user-profile switch.
// The contract: the currently loaded set stays registered until the incoming
// set has fully evaluated, and a cancelled or failed refresh changes nothing.
// Before this contract, every refresh unloaded first, so the composer lost its
// extensions (mic, shortcuts) for the whole fetch+import pipeline.
describe("client extension refresh swap", () => {
  afterEach(async () => {
    await unloadClientExtensions();
  });

  it("keeps the current set registered until the replacement is evaluated", async () => {
    const events: string[] = [];
    await loadClientExtensions([manifestItem("a")], {
      moduleLoader: async () => () => {
        events.push("a:load");
        return () => { events.push("a:cleanup"); };
      },
    });
    expect(events).toEqual(["a:load"]);

    const gate = deferred();
    const refresh = loadClientExtensions([manifestItem("b")], {
      moduleLoader: async () => {
        await gate.promise;
        return () => { events.push("b:load"); };
      },
    });
    await Bun.sleep(10);
    // Evaluation is still in flight: nothing may have been unloaded yet.
    expect(events).toEqual(["a:load"]);
    gate.resolve();
    await refresh;
    expect(events).toEqual(["a:load", "a:cleanup", "b:load"]);
  });

  it("leaves the current set untouched when the refresh is cancelled", async () => {
    const events: string[] = [];
    await loadClientExtensions([manifestItem("a")], {
      moduleLoader: async () => () => {
        events.push("a:load");
        return () => { events.push("a:cleanup"); };
      },
    });
    await loadClientExtensions([manifestItem("b")], {
      isCancelled: () => true,
      moduleLoader: async () => () => { events.push("b:load"); },
    });
    expect(events).toEqual(["a:load"]);
  });

  it("leaves the current set untouched when a module fails to evaluate", async () => {
    const events: string[] = [];
    await loadClientExtensions([manifestItem("a")], {
      moduleLoader: async () => () => {
        events.push("a:load");
        return () => { events.push("a:cleanup"); };
      },
    });
    await expect(loadClientExtensions([manifestItem("b")], {
      moduleLoader: async () => { throw new Error("boom"); },
    })).rejects.toThrow("boom");
    expect(events).toEqual(["a:load"]);
  });

  it("skips disabled items without evaluating them", async () => {
    const events: string[] = [];
    await loadClientExtensions(
      [{ ...manifestItem("off"), enabled: false }],
      { moduleLoader: async () => () => { events.push("off:load"); } },
    );
    expect(events).toEqual([]);
  });

  it("keeps an identical loaded manifest without fetching or re-registering it", async () => {
    const events: string[] = [];
    const item = manifestItem("same");
    await loadClientExtensions([item], {
      moduleLoader: async () => () => {
        events.push("same:load");
        return () => { events.push("same:cleanup"); };
      },
    });
    await loadClientExtensions([{ ...item, moduleUrl: `${item.moduleUrl}?cwd=another-project`, settingsValues: {} }], {
      moduleLoader: async () => {
        events.push("same:evaluate-again");
        return () => { events.push("same:load-again"); };
      },
    });

    expect(events).toEqual(["same:load"]);
  });
});
