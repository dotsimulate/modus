import type { MoveContext } from "../../../harness/move-types";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const STATUS_FILE = "memory/project-status.md";
const MEMORY_DIR = "memory";

function readFileOr(path: string, fallback: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return fallback;
  }
}

export async function gather(ctx: MoveContext): Promise<string> {
  const statusPath = join(ctx.cwd, STATUS_FILE);
  const previousStatus = readFileOr(statusPath, "");

  // Read all memory files for context
  const memoryDir = join(ctx.cwd, MEMORY_DIR);
  let memoryContext = "";
  try {
    const files = readdirSync(memoryDir).filter(
      (f: string) => f.endsWith(".md") && f !== "MEMORY.md" && f !== "project-status.md"
    );
    for (const file of files) {
      const content = readFileOr(join(memoryDir, file), "");
      if (content) memoryContext += `\n--- ${file} ---\n${content}\n`;
    }
  } catch {
    // memory dir might not exist yet
  }

  const hasPrevious = previousStatus.trim().length > 0;
  const today = ctx.date ?? new Date().toISOString().split("T")[0];

  let prompt = `# Check-In\n\nToday: ${today}\n\n`;

  prompt += `## Your Role\n\n`;
  prompt += `This is a structured but conversational check-in — not a form, not an interrogation. You're a friend who remembers what they told you last time and asks good follow-up questions.\n\n`;
  prompt += `Guide the conversation naturally through:\n`;
  prompt += `1. **What's in flight** — what are you working on right now?\n`;
  prompt += `2. **What changed** — anything shift since last time?\n`;
  prompt += `3. **What's stuck** — anything blocked or draining energy?\n`;
  prompt += `4. **What's next** — where does attention want to go?\n\n`;
  prompt += `Don't run through these like a checklist. Let the conversation flow. Ask follow-ups. Notice what's unsaid. If energy or mood comes up, note it.\n\n`;
  prompt += `**Important:** Have the actual conversation first. Ask questions, listen, follow threads. When the conversation winds down naturally, save what you learned to \`memory/project-status.md\` and append a summary to \`memory/check-in-history.md\`.\n\n`;

  if (memoryContext) {
    prompt += `## What You Know\n\n${memoryContext}\n\n`;
  }

  if (hasPrevious) {
    prompt += `## Last Check-In Status\n\n${previousStatus}\n\n`;
    prompt += `Use this to notice what changed, what dropped off, what's new. Reference it naturally — "last time you mentioned X was stuck, how's that going?"\n\n`;
  } else {
    prompt += `## No Previous Check-In\n\nThis is the first check-in. Start broad — get the lay of the land. What's on the plate? What's taking up the most headspace?\n\n`;
  }

  return prompt;
}
