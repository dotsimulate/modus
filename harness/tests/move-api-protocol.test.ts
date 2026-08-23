import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, test } from "bun:test";

const HARNESS_DIR = join(import.meta.dir, "..");

describe("move API protocol matches the advertised MCP schema", () => {
  const moveRunner = readFileSync(join(HARNESS_DIR, "move-runner.ts"), "utf-8");
  const modusMcp = readFileSync(join(HARNESS_DIR, "modus-mcp.ts"), "utf-8");
  const protocol = moveRunner.slice(
    moveRunner.indexOf("function buildApiOpsProtocol"),
    moveRunner.indexOf("export async function gatherMoveOnce"),
  );

  test("generated move instructions encode data as JSON text", () => {
    expect(protocol).toContain("Its `data` argument is a JSON string");
    expect(protocol).toContain('data: "{\\\\"op\\\\":');
    expect(protocol).not.toContain("data: { \"op\"");
  });

  test("the tool description and schema both advertise a JSON string", () => {
    expect(modusMcp).toContain("operation payload as a JSON string");
    expect(modusMcp).toContain('data: z.string().optional().describe("Operation payload as a JSON string")');
  });
});
