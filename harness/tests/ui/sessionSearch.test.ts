import { expect, test } from "bun:test";
import { scheduleSessionSearch } from "../../ui/src/session-search-request";
import type { SearchHit } from "../../sdk/index";

const pause = () => new Promise(resolve => setTimeout(resolve, 280));

test("clearing or unmounting during debounce never sends the search", async () => {
  let called = false;
  const cancel = scheduleSessionSearch(async () => { called = true; return []; }, "old", {}, () => {}, () => {});
  cancel();
  await pause();
  expect(called).toBe(false);
});

test("late responses cannot replace the current query, sort or project results", async () => {
  let resolveOld!: (hits: SearchHit[]) => void;
  const seen: string[] = [];
  const cancel = scheduleSessionSearch(() => new Promise(resolve => { resolveOld = resolve; }), "old", {}, () => seen.push("old"), () => seen.push("old error"));
  await pause();
  cancel();
  scheduleSessionSearch(async () => [], "new", { sort: "latest", userProfile: "example" }, () => seen.push("new"), () => seen.push("new error"));
  await pause();
  resolveOld([]);
  await Promise.resolve();
  expect(seen).toEqual(["new"]);
});

test("current failures are reported but failures from cancelled searches are ignored", async () => {
  let rejectOld!: (error: Error) => void;
  const errors: unknown[] = [];
  const cancel = scheduleSessionSearch(() => new Promise((_, reject) => { rejectOld = reject; }), "old", {}, () => {}, error => errors.push(error));
  await pause();
  cancel();
  rejectOld(new Error("stale"));
  scheduleSessionSearch(async () => { throw new Error("offline"); }, "new", {}, () => {}, error => errors.push(error));
  await pause();
  expect(errors.map(error => (error as Error).message)).toEqual(["offline"]);
});
