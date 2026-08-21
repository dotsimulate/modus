const cwd = process.argv[2];
if (!cwd) throw new Error("cwd required");

const warnings: string[] = [];
console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));

const { getProfile } = await import("../../profiles");
const first = getProfile("legacy", cwd);
const second = getProfile("legacy", cwd);

process.stdout.write(JSON.stringify({
  first: first?.permissionPolicy,
  second: second?.permissionPolicy,
  warnings,
}));
