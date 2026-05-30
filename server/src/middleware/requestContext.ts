import type { NextFunction, Request, Response } from "express";
import {
  createRequestId,
  logRequestIn,
  logResponseOut,
  runWithRequestContext,
  type RequestLogContext
} from "../utils/requestLog";

function detectSource(req: Request): string {
  const fromHeader = req.header("x-jarvis-source")?.trim();
  if (fromHeader) return fromHeader.slice(0, 40);
  const ua = (req.header("user-agent") || "").toLowerCase();
  if (/mobile|android|iphone|ipad/i.test(ua)) return "mobile-web";
  return "web";
}

function messagePreview(req: Request): string | undefined {
  if (req.method !== "POST") return undefined;
  const body = req.body as { message?: string } | undefined;
  const msg = typeof body?.message === "string" ? body.message.trim() : "";
  return msg || undefined;
}

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction) {
  const requestId = createRequestId();
  const ctx: RequestLogContext = {
    requestId,
    method: req.method,
    path: req.originalUrl || req.path,
    source: detectSource(req),
    startedAt: Date.now(),
    messagePreview: messagePreview(req)
  };

  res.setHeader("x-request-id", requestId);

  runWithRequestContext(ctx, () => {
    logRequestIn(ctx);

    res.on("finish", () => {
      logResponseOut(res.statusCode, Date.now() - ctx.startedAt);
    });

    next();
  });
}
