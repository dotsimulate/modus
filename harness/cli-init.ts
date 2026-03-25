/**
 * CLI entry point for `modus init [path]`
 * Runs standalone — no harness server needed.
 */
import { resolve } from "path";
import { initProject } from "./init";

// argv[2] = explicit path arg, argv[3] = caller's original CWD (passed by shell script)
const target = process.argv[2] ? resolve(process.argv[2]) : (process.argv[3] ? resolve(process.argv[3]) : process.cwd());

console.log(`Initializing .modus/ in: ${target}`);

const result = initProject(target);

if (!result.ok) {
  console.error(`Error: ${result.error}`);
  process.exit(1);
}

if (result.alreadyInitialized) {
  console.log(`Already initialized (project: ${result.projectId})`);
} else {
  console.log(`Project ID: ${result.projectId}`);
}

if (result.created.length > 0) {
  console.log("\nCreated:");
  for (const p of result.created) console.log(`  + ${p}`);
}

if (result.skipped.length > 0) {
  console.log("\nSkipped (already exist):");
  for (const p of result.skipped) console.log(`  ~ ${p}`);
}

console.log("\nDone. Open modus and select this folder as your project.");
