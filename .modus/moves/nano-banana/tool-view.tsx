import type { MoveToolViewProps } from "../../../harness/ui/src/move-tool-view";

export default function NanoBananaToolView({ input, result, artifacts, status }: MoveToolViewProps) {
  const ids = Array.isArray(result?.artifactIds)
    ? result.artifactIds.filter((id): id is number => typeof id === "number")
    : [];
  const paths = Array.isArray(result?.paths)
    ? result.paths.filter((path): path is string => typeof path === "string")
    : [];
  const prompt = typeof input.prompt === "string" ? input.prompt : "Image generation";
  const images = ids
    .map((id) => artifacts?.find((artifact) => artifact.id === id))
    .filter((artifact) => artifact !== undefined);

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 7, overflow: "hidden" }}>
      <div style={{ padding: "7px 9px", background: "var(--bg-surface)", display: "flex", gap: 8 }}>
        <strong>Nano Banana</strong>
        <span style={{ color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{prompt}</span>
      </div>
      {status === "running" && <div style={{ padding: 12, color: "var(--text-dim)" }}>Generating…</div>}
      {images.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 6, padding: 6 }}>
          {images.map((artifact, index) => (
            <img key={artifact.id} src={artifact.url} alt={paths[index] ?? artifact.name} style={{ width: "100%", borderRadius: 4 }} />
          ))}
        </div>
      )}
      {status !== "running" && images.length === 0 && (
        <div style={{ padding: 12, color: "var(--error)" }}>{result?.error as string ?? "No generated images"}</div>
      )}
    </div>
  );
}
