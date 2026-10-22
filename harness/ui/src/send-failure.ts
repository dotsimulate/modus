/** One line naming why a send was rejected, preferring the server's `{ error }`. */
export function describeSendFailure(err: unknown): string {
  const detail = (err as { detail?: unknown })?.detail;
  if (typeof detail === "string" && detail) {
    try {
      const body = JSON.parse(detail) as { error?: unknown };
      if (typeof body?.error === "string" && body.error) return body.error;
    } catch {}
    return detail;
  }
  return err instanceof Error ? err.message : String(err);
}
