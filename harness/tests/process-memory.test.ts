import { describe, expect, test } from "bun:test";
import {
  measureProcessTree,
  normalizeImageName,
  parsePsOutput,
  parseTasklistCsv,
  parseWmicProcessCsv,
  type ProcessTable,
} from "../process-memory";

const MB = 1024 * 1024;

function table(rows: Array<[pid: number, ppid: number, name: string, rssBytes: number]>): ProcessTable {
  return new Map(rows.map(([pid, ppid, name, rssBytes]) => [pid, { pid, ppid, name, rssBytes }]));
}

describe("normalizeImageName", () => {
  test("ignores case, directories and a Windows executable suffix", () => {
    expect(normalizeImageName("CLAUDE.EXE")).toBe("claude");
    expect(normalizeImageName("C:\\tools\\claude.exe")).toBe("claude");
    expect(normalizeImageName("/usr/local/bin/claude")).toBe("claude");
  });
});

describe("parseWmicProcessCsv", () => {
  // wmic emits columns alphabetically rather than in the requested order, so
  // the parser resolves them from the header.
  const output = [
    "",
    "Node,Name,ParentProcessId,ProcessId,WorkingSetSize",
    "HOST,claude.exe,4120,43728,408420352",
    "HOST,cmd.exe,32784,4120,5271552",
    "",
  ].join("\r\n");

  test("reads rows by header position", () => {
    const parsed = parseWmicProcessCsv(output);
    expect(parsed.get(43728)).toEqual({
      pid: 43728,
      ppid: 4120,
      name: "claude.exe",
      rssBytes: 408420352,
    });
    expect(parsed.get(4120)?.name).toBe("cmd.exe");
  });

  test("survives a reordered column layout", () => {
    const reordered = [
      "Node,WorkingSetSize,ProcessId,ParentProcessId,Name",
      "HOST,1048576,77,7,codex.exe",
    ].join("\r\n");
    expect(parseWmicProcessCsv(reordered).get(77)).toEqual({
      pid: 77,
      ppid: 7,
      name: "codex.exe",
      rssBytes: 1048576,
    });
  });

  test("returns an empty table for unusable output", () => {
    expect(parseWmicProcessCsv("").size).toBe(0);
    expect(parseWmicProcessCsv("ERROR: Description = Invalid query").size).toBe(0);
  });
});

describe("parseTasklistCsv", () => {
  test("reads kilobytes regardless of the locale's digit separator", () => {
    const parsed = parseTasklistCsv([
      '"claude.exe","33616","Console","1","127,788 K"',
      '"claude.exe","33708","Console","1","34.360 K"',
    ].join("\r\n"));
    expect(parsed.get(33616)?.rssBytes).toBe(127788 * 1024);
    expect(parsed.get(33708)?.rssBytes).toBe(34360 * 1024);
  });

  test("tolerates a row with no memory reading", () => {
    const parsed = parseTasklistCsv('"claude.exe","9","Console","1","N/A"');
    expect(parsed.get(9)?.rssBytes).toBe(0);
  });

  test("skips lines that are not process rows", () => {
    expect(parseTasklistCsv("INFO: No tasks are running.").size).toBe(0);
  });
});

describe("parsePsOutput", () => {
  test("reads pid, parent, kilobytes and image name", () => {
    const parsed = parsePsOutput([
      "  4120     1   5148 cmd",
      " 43728  4120 398848 claude",
    ].join("\n"));
    expect(parsed.get(43728)).toEqual({
      pid: 43728,
      ppid: 4120,
      name: "claude",
      rssBytes: 398848 * 1024,
    });
    expect(parsed.size).toBe(2);
  });
});

describe("measureProcessTree", () => {
  //   100 cmd.exe          -> the wrapper Modus spawned and registered
  //   200 claude.exe       -> the provider CLI
  //   201 claude.exe       -> a CLI helper process
  //   300 cargo.exe        -> a build the agent left running
  //   900 chrome.exe       -> unrelated, outside the tree
  const fixture = table([
    [100, 1, "cmd.exe", 5 * MB],
    [200, 100, "claude.exe", 400 * MB],
    [201, 200, "claude.exe", 120 * MB],
    [300, 200, "cargo.exe", 6000 * MB],
    [900, 1, "chrome.exe", 800 * MB],
  ]);

  test("sums every descendant of the registered root", () => {
    const footprint = measureProcessTree(fixture, [100], ["claude"]);
    expect(footprint.totalBytes).toBe((5 + 400 + 120 + 6000) * MB);
    expect(footprint.pids.sort((a, b) => a - b)).toEqual([100, 200, 201, 300]);
  });

  test("counts only the provider's own processes toward the matched total", () => {
    // This separation is what stops a legitimate build from reading as a leak.
    const footprint = measureProcessTree(fixture, [100], ["claude"]);
    expect(footprint.matchedBytes).toBe((400 + 120) * MB);
  });

  test("excludes processes outside the tree", () => {
    expect(measureProcessTree(fixture, [100], ["claude"]).pids).not.toContain(900);
  });

  test("reports zero for a root that has already exited", () => {
    const footprint = measureProcessTree(fixture, [4242], ["claude"]);
    expect(footprint.totalBytes).toBe(0);
    expect(footprint.pids).toEqual([]);
  });

  test("counts a process shared by two roots once", () => {
    const footprint = measureProcessTree(fixture, [100, 200], ["claude"]);
    expect(footprint.totalBytes).toBe((5 + 400 + 120 + 6000) * MB);
  });

  test("terminates when recycled pids form a parent cycle", () => {
    const cyclic = table([
      [10, 11, "a.exe", 1 * MB],
      [11, 10, "b.exe", 2 * MB],
    ]);
    expect(measureProcessTree(cyclic, [10]).totalBytes).toBe(3 * MB);
  });

  test("does not attribute the whole machine to a session parented at pid 0", () => {
    // Windows reports unrelated processes under pid 0 and 4; descending into
    // them would report every process on the machine as this session's cost.
    const rooted = table([
      [0, 0, "System Idle Process", 8 * MB],
      [4, 0, "System", 100 * MB],
      [500, 4, "unrelated.exe", 900 * MB],
    ]);
    expect(measureProcessTree(rooted, [4]).totalBytes).toBe(100 * MB);
  });

  test("matching is case-insensitive and suffix-insensitive", () => {
    const mixed = table([[1, 0, "Claude.EXE", 32 * MB]]);
    expect(measureProcessTree(mixed, [1], ["claude"]).matchedBytes).toBe(32 * MB);
  });
});
