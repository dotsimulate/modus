import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { AlertStore } from "../alert-store";

function createStore(): AlertStore {
  return new AlertStore(new Database(":memory:"));
}

describe("AlertStore", () => {
  test("persists one transport-neutral alert with deduplicated deliveries", () => {
    const store = createStore();
    const alert = store.enqueue({
      id: "alert-1",
      spaceId: "house",
      source: "chore-orchestrator",
      topic: "chores",
      title: "Kitchen reset",
      body: "Clear and wipe the counters.",
      requiresAck: true,
      data: { points: 5 },
    }, ["discord", "home-assistant", "discord"], 1_000);

    expect(alert.space_id).toBe("house");
    expect(alert.state).toBe("pending");
    expect(alert.requires_ack).toBe(1);
    expect(JSON.parse(alert.data_json)).toEqual({ points: 5 });
    expect(store.listDeliveries("house", alert.id).map((row) => row.channel)).toEqual([
      "discord",
      "home-assistant",
    ]);
  });

  test("requires the Space boundary on reads and acknowledgements", () => {
    const store = createStore();
    store.enqueue({
      id: "health-1",
      spaceId: "health",
      source: "health-agent",
      title: "Move",
      body: "Take a ten minute walk.",
      sensitivity: "sensitive",
    }, ["private-phone"], 2_000);

    expect(store.get("work", "health-1")).toBeNull();
    expect(store.list("work")).toEqual([]);
    expect(store.listDeliveries("work", "health-1")).toEqual([]);
    expect(store.acknowledge("work", "health-1", 2_500)).toBe(false);
    expect(store.get("health", "health-1")?.state).toBe("pending");

    expect(store.acknowledge("health", "health-1", 2_500)).toBe(true);
    expect(store.get("health", "health-1")?.state).toBe("acknowledged");
  });

  test("only exposes due, unexpired deliveries to adapters", () => {
    const store = createStore();
    store.enqueue({
      id: "now",
      spaceId: "house",
      source: "chores",
      title: "Now",
      body: "Do it now.",
      expiresAt: 5_000,
    }, ["phone"], 1_000);
    store.enqueue({
      id: "later",
      spaceId: "house",
      source: "chores",
      title: "Later",
      body: "Do it later.",
      deliverAt: 4_000,
    }, ["phone"], 1_000);
    store.enqueue({
      id: "expired",
      spaceId: "house",
      source: "chores",
      title: "Expired",
      body: "Too late.",
      expiresAt: 2_000,
    }, ["phone"], 1_000);

    expect(store.listDueDeliveries(3_000).map((row) => row.alert_id)).toEqual(["now"]);
  });

  test("tracks retry attempts and marks an alert delivered after every route succeeds", () => {
    const store = createStore();
    store.enqueue({
      id: "routed",
      spaceId: "house",
      source: "chores",
      title: "Laundry",
      body: "Move it to the dryer.",
    }, ["phone", "speaker"], 1_000);

    const deliveries = store.listDueDeliveries(1_000);
    const phone = deliveries.find((row) => row.channel === "phone")!;
    const speaker = deliveries.find((row) => row.channel === "speaker")!;

    store.recordDeliveryResult(phone.id, { ok: false, error: "offline", retryAt: 2_000 }, 1_100);
    store.recordDeliveryResult(speaker.id, { ok: true }, 1_100);
    expect(store.get("house", "routed")?.state).toBe("pending");
    expect(store.listDueDeliveries(1_500)).toEqual([]);

    expect(store.listDueDeliveries(2_000).map((row) => row.channel)).toEqual(["phone"]);
    store.recordDeliveryResult(phone.id, { ok: true }, 2_100);

    expect(store.get("house", "routed")?.state).toBe("delivered");
    expect(store.listDeliveries("house", "routed").find((row) => row.channel === "phone")).toMatchObject({
      state: "delivered",
      attempt_count: 2,
      delivered_at: 2_100,
      error: null,
    });
  });

  test("rejects unscoped or unrouted alerts", () => {
    const store = createStore();
    expect(() => store.enqueue({
      spaceId: " ",
      source: "agent",
      title: "No scope",
      body: "Not allowed.",
    }, ["phone"])).toThrow("spaceId is required");
    expect(() => store.enqueue({
      spaceId: "house",
      source: "agent",
      title: "No route",
      body: "Not allowed.",
    }, [])).toThrow("at least one delivery channel is required");
  });
});
