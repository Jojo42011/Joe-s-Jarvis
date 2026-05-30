import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export type RequestLogContext = {
  requestId: string;
  method: string;
  path: string;
  source: string;
  startedAt: number;
  messagePreview?: string;
};

const storage = new AsyncLocalStorage<RequestLogContext>();

function stamp(prefix: string, msg: string): string {
  const ctx = storage.getStore();
  const reqPart = ctx ? `[req:${ctx.requestId}] ` : "";
  return `${reqPart}[${prefix}] ${msg}`;
}

function write(prefix: string, msg: string) {
  console.log(stamp(prefix, msg));
}

export function createRequestId(): string {
  return randomBytes(4).toString("hex");
}

export function runWithRequestContext<T>(
  ctx: RequestLogContext,
  fn: () => T
): T {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestLogContext | undefined {
  return storage.getStore();
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function reqLog(msg: string) {
  write("req", msg);
}

export function routeLog(msg: string) {
  write("route", msg);
}

export function brainLog(msg: string) {
  write("brain", msg);
}

export function claudeLog(msg: string) {
  write("claude", msg);
}

export function memoryLog(msg: string) {
  write("memory", msg);
}

export function briefLog(msg: string) {
  write("brief", msg);
}

export function circuitLog(msg: string) {
  write("circuit", msg);
}

export function gmailLog(msg: string) {
  write("gmail", msg);
}

export function toolLog(msg: string) {
  write("tool", msg);
}

export function logRequestIn(ctx: RequestLogContext) {
  const preview = ctx.messagePreview
    ? ` — message: "${ctx.messagePreview.slice(0, 120)}"`
    : "";
  console.log(
    `[req:${ctx.requestId}] REQUEST IN — ${ctx.method} ${ctx.path} source: ${ctx.source}${preview}`
  );
}

export function logResponseOut(status: number, totalMs: number, extra?: string) {
  const ctx = storage.getStore();
  const id = ctx?.requestId ?? "none";
  const tail = extra ? ` | ${extra}` : "";
  console.log(`[req:${id}] RESPONSE OUT — status: ${status} | total: ${totalMs}ms${tail}`);
}

export function logSpeechBuilt(speech: string, sanitized: boolean) {
  reqLog(`speech: ${speech.length} chars | sanitized: ${sanitized}`);
}
