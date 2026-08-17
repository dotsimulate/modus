import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { AlertBroker } from "../alert-broker";
import { AlertStore } from "../alert-store";

function createStore(): AlertStore {
  return new AlertStore(new Database(":memory:"));
}

describe("AlertBroker", () => {
  test("Space policy selects transports instead of the publisher", async () => {
    const store = createStore();
    const delivered: string[] = [];
    const broker = new AlertBroker({
      store,
      resolveRoutes: (intent) => intent.spaceId === "health" ? ["private-phone"] : ["discord"],
      deliver: async (channel) => {
        delivered.push(channel);
        return { ok: true };
      },
    });

    const id = await broker.publish({
      id: "health-alert",
      spaceId: "health",
      source: "health-agent",
      title: "Medication",
      body: "Time for the evening dose.",
      sensitivity: "sensitive",
    }, 1_000);

    expect(id).toBe("health-alert");
    expect(delivered).toEqual(["private-phone"]);
    expect(store.listDeliveries("health", id).map((row) => row.channel)).toEqual(["private-phone"]);
  });

  test("persists before delivery and retries adapter failures", async () => {
    const store = createStore();
    let attempts = 0;
    const statesSeenDuringDelivery: string[] = [];
    const broker = new AlertBroker({
      store,
      retryBaseMs: 100,
      retryMaxMs: 1_000,
      resolveRoutes: () => ["phone"],
      deliver: async (_channel, delivery) => {
        statesSeenDuringDelivery.push(store.get("house", delivery.alert_id)?.state ?? "missing");
        attempts += 1;
        return attempts === 1 ? { ok: false, error: "phone offline" } : { ok: true };
      },
    });

    await broker.publish({
      id: "retry-alert",
      spaceId: "house",
      source: "chore-agent",
      title: "Laundry",
      body: "Move the load.",
    }, 1_000);

    expect(statesSeenDuringDelivery).toEqual(["pending"]);
    expect(store.listDueDeliveries(1_099)).toEqual([]);
    expect(store.listDueDeliveries(1_100)).toHaveLength(1);

    await broker.flush(1_100);
    expect(attempts).toBe(2);
    expect(store.get("house", "retry-alert")?.state).toBe("delivered");
  });

  test("coalesces concurrent flushes so one delivery is not sent twice", async () => {
    const store = createStore();
    store.enqueue({
      id: "once",
      spaceId: "house",
      source: "chore-agent",
      title: "Dishes",
      body: "Unload the dishwasher.",
    }, ["speaker"], 1_000);

    let sends = 0;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const broker = new AlertBroker({
      store,
      resolveRoutes: () => ["speaker"],
      deliver: async () => {
        sends += 1;
        await paused;
        return { ok: true };
      },
    });

    const first = broker.flush(1_000);
    const second = broker.flush(1_000);
    release();

    expect(await first).toBe(1);
    expect(await second).toBe(1);
    expect(sends).toBe(1);
  });
});
