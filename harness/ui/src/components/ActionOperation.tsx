import { useState } from "react";
import type { ActionInfo, ActionRun } from "../../../sdk";
import { modus } from "../modusClient";
import { BACKEND_TARGET } from "../backendTarget";

export function ActionOperationControls({ action, scope }: {
  action: ActionInfo;
  scope: { cwd?: string | null; userProfile?: string | null };
}) {
  const [inputs, setInputs] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const manual = action.trigger.type === "manual" || action.trigger.type === "interval";
  const fields = Object.entries(action.inputSchema?.properties ?? {});
  return <div className="action-operation-controls" onClick={e => e.stopPropagation()}>
    <small>Runs on {BACKEND_TARGET.mode === "browser" ? "connected backend" : BACKEND_TARGET.label}{action.cwd ? ` · ${action.cwd}` : ""}</small>
    {manual && <form onSubmit={async e => {
      e.preventDefault(); setPending(true); setError(undefined);
      try {
        const values = { ...inputs };
        for (const [name, field] of fields) if (field.type === "boolean" && !field.enum && values[name] === undefined) values[name] = field.default ?? false;
        await modus.triggerAction(action.name, scope, values);
      }
      catch (err) { setError(String((err as Error).message)); }
      finally { setPending(false); }
    }}>
      {fields.map(([name, field]) => {
        const value = inputs[name] ?? field.default;
        const set = (next: unknown) => setInputs(previous => ({ ...previous, [name]: next }));
        return <label key={name}>{field.title ?? name}
          {field.enum ? <select value={value === undefined ? "" : String(value)} required={action.inputSchema?.required?.includes(name)} onChange={e => set(field.enum?.find(v => String(v) === e.target.value))}>
            <option value="">Choose…</option>
            {field.enum.map(option => <option key={String(option)} value={String(option)}>{String(option)}</option>)}
          </select> : field.type === "boolean" ? <input type="checkbox" checked={value === true} onChange={e => set(e.target.checked)} /> : <input
            type={field.type === "string" ? "text" : "number"}
            value={value === undefined ? "" : String(value)}
            required={action.inputSchema?.required?.includes(name)}
            min={field.minimum} max={field.maximum} minLength={field.minLength} maxLength={field.maxLength}
            step={field.type === "integer" ? 1 : "any"}
            onChange={e => set(e.target.value === "" ? undefined : field.type === "string" ? e.target.value : Number(e.target.value))}
          />}
          {field.description && <small>{field.description}</small>}
        </label>;
      })}
      <button className="action-card-trigger" disabled={pending || action.activeSessions >= (action.concurrency ?? 1)}>{pending ? "starting…" : "run"}</button>
    </form>}
    {error && <div role="alert">{error}</div>}
  </div>;
}

export function ActionOperationDetails({ run, actionName, scope }: {
  run: ActionRun;
  actionName?: string;
  scope?: { cwd?: string | null; userProfile?: string | null };
}) {
  const [error, setError] = useState<string>();
  const operation = run.operation;
  if (!operation) return null;
  return <div className="action-operation-details" onClick={e => e.stopPropagation()}>
    <span>{operation.outcome} · {run.answerer} · backend</span>
    {operation.exitCode != null && <span> · exit {operation.exitCode}</span>}
    {actionName && run.status === "running" && run.executionId != null && <button onClick={async () => {
      try { await modus.cancelActionExecution(actionName, run.executionId!, scope); }
      catch (err) { setError(String((err as Error).message)); }
    }}>cancel</button>}
    {error && <div role="alert">{error}</div>}
    <details><summary>Logs and result{operation.truncated ? " (truncated)" : ""}</summary>
      <div>{operation.cwd}</div>
      {run.error && <pre>{run.error}</pre>}
      {operation.stdout && <pre aria-label="stdout">{operation.stdout}</pre>}
      {operation.stderr && <pre aria-label="stderr">{operation.stderr}</pre>}
      {operation.result?.data !== undefined && <pre>{JSON.stringify(operation.result.data, null, 2)}</pre>}
      {operation.result?.artifacts?.map(artifact => <div key={artifact.path}>{artifact.name}: {artifact.path}</div>)}
      <small>run {operation.runId} · {operation.caller} · definition {operation.fingerprint.slice(0, 12)}</small>
    </details>
  </div>;
}
