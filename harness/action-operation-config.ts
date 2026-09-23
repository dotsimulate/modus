import type { ActionConfig } from "./action-types";
import type { ActionInputSchema } from "./action-operation-types";

export function validateActionInputs(schema: ActionInputSchema | undefined, values: unknown): Record<string, unknown> {
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("Action inputs must be an object");
  if (JSON.stringify(values).length > 16_384) throw new Error("Action inputs exceed 16 KiB");
  const result = { ...values } as Record<string, unknown>;
  if (!schema) {
    if (Object.keys(result).length) throw new Error("Invocation inputs require inputSchema");
    return result;
  }
  for (const name of Object.keys(result)) {
    if (!Object.hasOwn(schema.properties, name)) throw new Error(`Unknown action input: ${name}`);
  }
  for (const [name, field] of Object.entries(schema.properties)) {
    if (result[name] === undefined && field.default !== undefined) result[name] = field.default;
    const value = result[name];
    if (value === undefined) {
      if (schema.required?.includes(name)) throw new Error(`Missing action input: ${name}`);
      continue;
    }
    const type = field.type === "integer" ? "number" : field.type;
    if (typeof value !== type || (typeof value === "number" && (!Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value))))) {
      throw new Error(`Action input ${name} must be ${field.type}`);
    }
    if (field.enum && !field.enum.includes(value as string | number | boolean)) throw new Error(`Invalid choice for action input: ${name}`);
    if (typeof value === "string" && ((field.minLength !== undefined && value.length < field.minLength) || (field.maxLength !== undefined && value.length > field.maxLength))) throw new Error(`Invalid length for action input: ${name}`);
    if (typeof value === "number" && ((field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum))) throw new Error(`Action input ${name} is out of range`);
  }
  return result;
}

export function operationConfigError(config: ActionConfig): string | null {
  try {
    if (config.inputSchema) {
      const schema = config.inputSchema;
      if (schema.type !== "object" || !schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) throw new Error("inputSchema requires object properties");
      if (Object.keys(schema).some(k => !["type", "properties", "required", "additionalProperties"].includes(k)) || (schema.additionalProperties !== undefined && schema.additionalProperties !== false)) throw new Error("Unsupported inputSchema keyword");
      if (schema.required && (!Array.isArray(schema.required) || schema.required.some(k => !Object.hasOwn(schema.properties, k)))) throw new Error("inputSchema.required must name declared inputs");
      for (const [name, field] of Object.entries(schema.properties)) {
        if (["__proto__", "constructor", "prototype"].includes(name)) throw new Error("Reserved input name");
        if (!field || !["string", "number", "integer", "boolean"].includes(field.type)) throw new Error(`Unsupported input type: ${name}`);
        if (Object.keys(field).some(k => !["type", "title", "description", "default", "enum", "minLength", "maxLength", "minimum", "maximum"].includes(k))) throw new Error(`Unsupported input keyword: ${name}`);
        if (field.enum && (!Array.isArray(field.enum) || !field.enum.length)) throw new Error(`Invalid input enum: ${name}`);
        for (const key of ["minLength", "maxLength", "minimum", "maximum"] as const) if (field[key] !== undefined && !Number.isFinite(field[key])) throw new Error(`Invalid input constraint: ${name}.${key}`);
        if (field.default !== undefined) validateActionInputs({ type: "object", properties: { [name]: field } }, { [name]: field.default });
      }
    }
    if (!config.execution) return null;
    if (!["command", "code"].includes(config.execution.type)) throw new Error("execution.type must be command or code");
    const conflicts = ["answerer", "agentProfile", "steps", "provider", "model", "maxTurns", "effort", "tools", "disallowedTools", "providerControls", "loadProjectSettings", "moves", "skills", "maxRetries", "maxTransientRetries", "onGatherError", "onTransientFailure", "retryBackoff"] as const;
    for (const key of conflicts) if (config[key] !== undefined) throw new Error(`Command/Code actions cannot configure ${key}`);
    if (config.trigger.type === "webhook" && config.trigger.sessionKey) throw new Error("Command/Code webhooks cannot configure sessionKey");
    for (const key of ["timeoutMs", "concurrency"] as const) if (config[key] !== undefined && (!Number.isSafeInteger(config[key]) || config[key]! < 1)) throw new Error(`${key} must be a positive integer`);
    if (config.timeoutMs !== undefined && config.timeoutMs > 2_147_483_647) throw new Error("timeoutMs exceeds the timer limit");
    if (config.execution.type === "command") {
      const command = config.execution;
      if (typeof command.executable !== "string" || !command.executable.trim()) throw new Error("Command requires executable");
      if (command.shell !== undefined && typeof command.shell !== "boolean") throw new Error("shell must be boolean");
      if (command.shell && command.args?.length) throw new Error("Shell scripts cannot interpolate args; use executable and argument arrays for inputs");
      if (command.args !== undefined && (!Array.isArray(command.args) || command.args.some(a => typeof a !== "string" && (!a || typeof a.input !== "string" || !config.inputSchema?.properties[a.input])))) throw new Error("Invalid command args or input reference");
    }
    if (config.env && Object.values(config.env).some(v => !v || typeof v.secret !== "string")) throw new Error("env values must be secret references");
    return null;
  } catch (err) { return String((err as Error).message); }
}
