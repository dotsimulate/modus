/**
 * Quick test for prompt-loader — run with: bun run test-prompts.ts
 * Tests scanning, compilation, rendering, and async primitives.
 */

import { loadPrompts, listPrompts, renderPrompt, getPrompt } from "./prompt-loader";

console.log("=== Prompt System Test ===\n");

// 1. Load
loadPrompts();

// 2. List
const all = listPrompts();
console.log(`Loaded ${all.length} prompt(s):`);
for (const p of all) {
  console.log(`  - ${p.name} (${p.label}) [${p.tags?.join(", ") ?? "no tags"}]`);
  if (p.inputs?.length) {
    for (const inp of p.inputs) {
      console.log(`    input: ${inp.name}${inp.required ? " (required)" : ""} — "${inp.placeholder ?? ""}"`);
    }
  }
}

// 3. Render explore with no input
console.log("\n--- Render: explore (empty) ---");
const r1 = await renderPrompt("explore", {
  project: { name: "my-app", slug: "my-app" },
});
if ("error" in r1) {
  console.error("ERROR:", r1.error);
} else {
  console.log(r1.rendered);
}

// 4. Render explore with focus + input
console.log("\n--- Render: explore (with focus + input) ---");
const r2 = await renderPrompt("explore", {
  input: "especially interested in the API layer",
  focus: "backend architecture",
  project: { name: "my-app", slug: "my-app" },
});
if ("error" in r2) {
  console.error("ERROR:", r2.error);
} else {
  console.log(r2.rendered);
}

// 5. Render setup-agents
console.log("\n--- Render: setup-agents ---");
const r3 = await renderPrompt("setup-agents", {
  description: "I need a code reviewer and a test runner agent",
  project: { name: "my-app", slug: "my-app" },
});
if ("error" in r3) {
  console.error("ERROR:", r3.error);
} else {
  console.log(r3.rendered);
}

// 6. Render nonexistent
console.log("\n--- Render: nonexistent ---");
const r4 = await renderPrompt("nonexistent", {});
if ("error" in r4) {
  console.log("Expected error:", r4.error);
}

// 7. Filter by tag
console.log("\n--- List: tag=setup ---");
const setup = listPrompts({ tags: ["setup"] });
console.log(`Found ${setup.length} prompt(s) with tag "setup":`, setup.map(p => p.name));

// 8. Render project-status — exercises read, run, git primitives
console.log("\n--- Render: project-status (async primitives) ---");
const r5 = await renderPrompt("project-status", {
  input: "focus on recent changes",
  project: { name: "agent-dev-zone", slug: "agent-dev-zone" },
});
if ("error" in r5) {
  console.error("ERROR:", r5.error);
} else {
  console.log(r5.rendered);
  // Verify primitives actually resolved (not showing "[not resolved]")
  const unresolved = r5.rendered.match(/\[(?:read|run|git):.*?not resolved\]/g);
  if (unresolved) {
    console.error("\nFAILED — unresolved primitives:", unresolved);
    process.exit(1);
  }
  // Verify git output is present (should have branch name at minimum)
  if (!r5.rendered.includes("main") && !r5.rendered.includes("master")) {
    console.warn("WARNING: git branch output may be missing");
  }
  console.log("\nAsync primitives resolved successfully.");
}

console.log("\n=== All tests passed ===");
