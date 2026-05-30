/** Detect Anthropic / HTTP 429 rate-limit responses. */
export function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const record = error as Record<string, unknown>;
  if (record.status === 429) return true;

  const nested = record.error;
  if (nested && typeof nested === "object") {
    const type = String((nested as Record<string, unknown>).type || "").toLowerCase();
    if (type.includes("rate_limit")) return true;
  }

  const message = String(record.message || error).toLowerCase();
  return (
    message.includes("429") ||
    message.includes("rate limit") ||
    message.includes("rate_limit") ||
    message.includes("too many requests")
  );
}
