/**
 * Quick test for prompt-loader — run from harness/: bun run tests/manual/test-prompts.ts
 * Tests scanning, loading, rendering via context.ts gather().
 */

import { loadPrompts, listPrompts, renderPrompt, getPrompt } from "../../prompt-loader";

console.log("=== Prompt System Test (gather-based) ===\n");

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
  inputs: {},
  project: { name: "my-app", slug: "my-app" },
});
if ("error" in r1) {
  console.error("ERROR:", r1.error);
} else {
  console.log(r1.rendered);
}

// 4. Render explore with focus + text
console.log("\n--- Render: explore (with focus + text) ---");
const r2 = await renderPrompt("explore", {
  inputs: {
    text: "especially interested in the API layer",
    focus: "backend architecture",
  },
  project: { name: "my-app", slug: "my-app" },
});
if ("error" in r2) {
  console.error("ERROR:", r2.error);
} else {
  console.log(r2.rendered);
  if (!r2.rendered.includes("backend architecture")) {
    console.error("FAILED — focus not interpolated");
    process.exit(1);
  }
  if (!r2.rendered.includes("API layer")) {
    console.error("FAILED — text not interpolated");
    process.exit(1);
  }
}

// 5. Render setup-agents
console.log("\n--- Render: setup-agents ---");
const r3 = await renderPrompt("setup-agents", {
  inputs: {
    description: "I need a code reviewer and a test runner agent",
  },
  project: { name: "my-app", slug: "my-app" },
});
if ("error" in r3) {
  console.error("ERROR:", r3.error);
} else {
  console.log(r3.rendered);
  if (!r3.rendered.includes("code reviewer")) {
    console.error("FAILED — description not interpolated");
    process.exit(1);
  }
}

// 6. Render nonexistent
console.log("\n--- Render: nonexistent ---");
const r4 = await renderPrompt("nonexistent", { inputs: {} });
if ("error" in r4) {
  console.log("Expected error:", r4.error);
} else {
  console.error("FAILED — expected error for nonexistent prompt");
  process.exit(1);
}

// 7. Filter by tag
console.log("\n--- List: tag=setup ---");
const setup = listPrompts({ tags: ["setup"] });
console.log(`Found ${setup.length} prompt(s) with tag "setup":`, setup.map(p => p.name));

// 8. Render project-status — exercises ctx.read(), ctx.run(), ctx.git()
console.log("\n--- Render: project-status (async I/O helpers) ---");
const r5 = await renderPrompt("project-status", {
  inputs: { text: "focus on recent changes" },
  project: { name: "agent-dev-zone", slug: "agent-dev-zone" },
});
if ("error" in r5) {
  console.error("ERROR:", r5.error);
} else {
  console.log(r5.rendered);
  // Verify git output is present (should have branch name at minimum)
  if (!r5.rendered.includes("main") && !r5.rendered.includes("master")) {
    console.warn("WARNING: git branch output may be missing");
  }
  // Verify it's not showing old-style unresolved placeholders
  if (r5.rendered.includes("[not resolved]") || r5.rendered.includes("{{")) {
    console.error("FAILED — unresolved template placeholders found");
    process.exit(1);
  }
  console.log("\nAsync I/O helpers resolved successfully.");
}

// 9. Render gitops-commit — was previously broken with input.mode pattern
console.log("\n--- Render: gitops-commit (validates inputs.mode) ---");
const r6 = await renderPrompt("gitops-commit", {
  inputs: { mode: "all", showFirst: "yes" },
});
if ("error" in r6) {
  console.error("ERROR:", r6.error);
} else {
  if (!r6.rendered.includes("Mode: all")) {
    console.error("FAILED — mode not interpolated");
    process.exit(1);
  }
  if (!r6.rendered.includes("Scope: all changes")) {
    console.error("FAILED — mode conditional not applied");
    process.exit(1);
  }
  console.log("gitops-commit rendered correctly with inputs.mode = 'all'");
}

console.log("\n=== All tests passed ===");
