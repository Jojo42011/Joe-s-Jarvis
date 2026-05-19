import { getSystemState, logExecution, setSystemState } from "../db/queries";
import { gmailCircuit } from "./circuitBreaker";
import { logServiceError } from "../utils/logError";

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify"
].join(" ");

const TOKEN_EXPIRY_KEY = "gmail_access_token_expires_at";
const ACCESS_TOKEN_KEY = "gmail_access_token";
const REFRESH_FAIL_LOGGED_KEY = "gmail_refresh_fail_logged_at";

const clientId = process.env.GMAIL_CLIENT_ID;
const clientSecret = process.env.GMAIL_CLIENT_SECRET;
const redirectUri =
  process.env.GMAIL_REDIRECT_URI || "http://localhost:3000/api/auth/google/callback";

let memoryAccessToken: string | null = null;
let memoryExpiresAt = 0;
let refreshFailureLogged = false;

function requireGoogleOAuthConfig() {
  if (!clientId || !clientSecret) {
    throw new Error("GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET are required");
  }
}

function loadPersistedToken(): { token: string | null; expiresAt: number } {
  const token = getSystemState(ACCESS_TOKEN_KEY) || null;
  const rawExpiry = getSystemState(TOKEN_EXPIRY_KEY);
  const expiresAt = rawExpiry ? Number(rawExpiry) : 0;
  if (token && Number.isFinite(expiresAt) && expiresAt > Date.now()) {
    memoryAccessToken = token;
    memoryExpiresAt = expiresAt;
  }
  return { token: memoryAccessToken, expiresAt: memoryExpiresAt };
}

function persistAccessToken(token: string, expiresInSec: number) {
  const expiresAt = Date.now() + (expiresInSec || 3600) * 1000;
  memoryAccessToken = token;
  memoryExpiresAt = expiresAt;
  setSystemState(ACCESS_TOKEN_KEY, token);
  setSystemState(TOKEN_EXPIRY_KEY, String(expiresAt));
  refreshFailureLogged = false;
  setSystemState(REFRESH_FAIL_LOGGED_KEY, "");
}

function logRefreshFailureOnce() {
  if (refreshFailureLogged) return;
  const last = getSystemState(REFRESH_FAIL_LOGGED_KEY);
  const today = new Date().toISOString().slice(0, 10);
  if (last?.startsWith(today)) {
    refreshFailureLogged = true;
    return;
  }
  refreshFailureLogged = true;
  setSystemState(REFRESH_FAIL_LOGGED_KEY, new Date().toISOString());
  logExecution({
    type: "email",
    action: "gmail.token_refresh_failed",
    summary: "[Gmail] Token refresh failed — manual re-auth required",
    result: "failed"
  });
}

async function refreshAccessToken(): Promise<string> {
  requireGoogleOAuthConfig();
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN?.trim();
  if (!refreshToken) {
    throw new Error("GMAIL_REFRESH_TOKEN is required");
  }

  return gmailCircuit.execute("token_refresh", async () => {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId!,
        client_secret: clientSecret!,
        refresh_token: refreshToken,
        grant_type: "refresh_token"
      })
    });

    const payload = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };

    if (!response.ok || !payload.access_token) {
      throw new Error(
        payload.error_description ||
          payload.error ||
          `Gmail token refresh failed with ${response.status}`
      );
    }

    persistAccessToken(payload.access_token, payload.expires_in || 3600);
    return payload.access_token;
  });
}

/** Returns a valid access token; refreshes if expiring within 5 minutes. */
export async function getGmailAccessToken(): Promise<string> {
  requireGoogleOAuthConfig();

  const persisted = loadPersistedToken();
  const fiveMinutesMs = 5 * 60 * 1000;

  if (persisted.token && persisted.expiresAt - Date.now() > fiveMinutesMs) {
    return persisted.token;
  }

  if (memoryAccessToken && memoryExpiresAt - Date.now() > fiveMinutesMs) {
    return memoryAccessToken;
  }

  try {
    return await refreshAccessToken();
  } catch (error) {
    logRefreshFailureOnce();
    logServiceError("Gmail", "token refresh", error);
    throw error;
  }
}

export function createGoogleAuthUrl() {
  requireGoogleOAuthConfig();

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId!);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_SCOPES);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");

  return url.toString();
}

export async function exchangeCodeForTokens(code: string) {
  requireGoogleOAuthConfig();

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      code,
      client_id: clientId!,
      client_secret: clientSecret!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    })
  });

  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok) {
    throw new Error(
      payload.error_description ||
        payload.error ||
        `Google token exchange failed with ${response.status}`
    );
  }

  if (payload.access_token) {
    persistAccessToken(payload.access_token, payload.expires_in || 3600);
  }

  return payload;
}
