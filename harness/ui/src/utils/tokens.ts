/** Rough token estimate: ~4 chars per token for English text */
export function estimateTokens(text: string): string {
  const count = Math.ceil(text.length / 4);
  if (count < 1000) return `~${count} tok`;
  return `~${(count / 1000).toFixed(1)}k tok`;
}
