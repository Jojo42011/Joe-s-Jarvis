import { Router } from "express";
import { createGoogleAuthUrl, exchangeCodeForTokens } from "../services/googleAuth";

export const authRouter = Router();

authRouter.get("/auth/google", (_req, res, next) => {
  try {
    res.redirect(createGoogleAuthUrl());
  } catch (error) {
    next(error);
  }
});

authRouter.get("/auth/google/callback", async (req, res, next) => {
  try {
    const code = String(req.query.code || "");

    if (!code) {
      res.status(400).send("Missing Google OAuth code.");
      return;
    }

    const tokens = await exchangeCodeForTokens(code);

    res.type("html").send(`
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>JARVIS Gmail OAuth</title>
          <style>
            body {
              margin: 0;
              min-height: 100vh;
              display: grid;
              place-items: center;
              background: #050505;
              color: #e0e0e0;
              font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }
            main {
              width: min(760px, calc(100vw - 32px));
              border: 1px solid rgba(204, 0, 0, 0.35);
              border-radius: 18px;
              padding: 28px;
              background: linear-gradient(145deg, rgba(30, 4, 7, 0.92), rgba(0, 0, 0, 0.82));
              box-shadow: 0 0 60px rgba(204, 0, 0, 0.16);
            }
            h1 { margin: 0 0 12px; color: white; }
            p { line-height: 1.55; color: #b8b8b8; }
            code, textarea {
              width: 100%;
              box-sizing: border-box;
              display: block;
              border: 1px solid rgba(255, 255, 255, 0.14);
              border-radius: 10px;
              padding: 14px;
              color: #fff;
              background: rgba(0, 0, 0, 0.52);
              font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
              word-break: break-all;
            }
            textarea { min-height: 120px; resize: vertical; }
            .warning { color: #ff6b6b; }
          </style>
        </head>
        <body>
          <main>
            <h1>Gmail OAuth Approved</h1>
            ${
              tokens.refresh_token
                ? `<p>Copy this refresh token into <code>GMAIL_REFRESH_TOKEN=</code> in your local <code>.env</code> file.</p>
                   <textarea readonly>${tokens.refresh_token}</textarea>`
                : `<p class="warning">Google did not return a refresh token. Visit <code>/api/auth/google</code> again and approve consent. If it still does not appear, remove this app from your Google account permissions and retry.</p>`
            }
            <p>Scope granted: <code>${tokens.scope || "unknown"}</code></p>
            <p>You can close this tab after saving the token.</p>
          </main>
        </body>
      </html>
    `);
  } catch (error) {
    next(error);
  }
});
