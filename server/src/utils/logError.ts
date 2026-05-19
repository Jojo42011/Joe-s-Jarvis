function reasonFromError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Single-line production log; stack only in development. */
export function logServiceError(service: string, operation: string, error: unknown): void {
  const reason = reasonFromError(error).replace(/\s+/g, " ").slice(0, 300);
  console.error(`[${service}] ${operation} failed — ${reason}`);
  if (process.env.NODE_ENV === "development" && error instanceof Error && error.stack) {
    console.error(error.stack);
  }
}

export function logServiceWarn(service: string, operation: string, error: unknown): void {
  const reason = reasonFromError(error).replace(/\s+/g, " ").slice(0, 300);
  console.warn(`[${service}] ${operation} failed — ${reason}`);
  if (process.env.NODE_ENV === "development" && error instanceof Error && error.stack) {
    console.warn(error.stack);
  }
}
