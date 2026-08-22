export type CommandArgumentSpec = {
  flags?: string[];
  valueFlags?: string[];
  positionals?: number;
};

/** Return a user-facing error for the first argument outside a command's grammar. */
export function validateCommandArguments(
  command: string,
  args: string[],
  spec: CommandArgumentSpec,
): string | null {
  const flags = new Set(spec.flags ?? []);
  const valueFlags = new Set(spec.valueFlags ?? []);
  let positionals = 0;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const equals = argument.indexOf("=");
    const flag = equals > 0 ? argument.slice(0, equals) : argument;

    if (valueFlags.has(flag)) {
      if (equals > 0) {
        if (!argument.slice(equals + 1)) return `${flag} requires a value`;
      } else {
        const value = args[index + 1];
        if (!value || value.startsWith("-")) return `${flag} requires a value`;
        index += 1;
      }
      continue;
    }
    if (flags.has(argument)) continue;
    if (argument.startsWith("-")) return `Unknown option for modus ${command}: ${argument}`;

    positionals += 1;
    if (positionals > (spec.positionals ?? 0)) {
      return `Unexpected argument for modus ${command}: ${argument}`;
    }
  }
  return null;
}
