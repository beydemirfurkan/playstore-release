// Service-account authentication, with nothing installed: an RS256 JWT signed by
// node:crypto, exchanged at Google's token endpoint for a bearer token that lives
// an hour. Cached, refreshed a little early, and minted at most once at a time
// so a burst of parallel requests does not mint a token each.

import crypto from "node:crypto";

export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const TTL_SECONDS = 3600;
/** Refresh when this much of the token's life is left. */
const REFRESH_MARGIN_SECONDS = 300;

const base64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

/**
 * Build the signed assertion Google's token endpoint expects.
 *
 * @param {{ clientEmail: string, privateKey: string, scope?: string, tokenUrl?: string, nowSeconds: number }} p
 */
export function signAssertion({ clientEmail, privateKey, scope = SCOPE, tokenUrl = TOKEN_URL, nowSeconds }) {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iss: clientEmail, scope, aud: tokenUrl, iat: nowSeconds, exp: nowSeconds + TTL_SECONDS };
  const signingInput = `${base64url(header)}.${base64url(payload)}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

/**
 * @param {{
 *   clientEmail: string,
 *   privateKey: string,
 *   fetchImpl?: typeof fetch,
 *   tokenUrl?: string,
 *   scope?: string,
 *   now?: () => number,
 * }} deps
 * @returns {() => Promise<string>} a bearer token, fresh or cached
 */
export function createTokenProvider({
  clientEmail,
  privateKey,
  fetchImpl = fetch,
  tokenUrl = TOKEN_URL,
  scope = SCOPE,
  now = Date.now,
}) {
  /** @type {{ token: string, expiresAt: number } | null} */
  let cached = null;
  /** @type {Promise<string> | null} */
  let inflight = null;

  const mint = async () => {
    const nowSeconds = Math.floor(now() / 1000);
    const assertion = signAssertion({ clientEmail, privateKey, scope, tokenUrl, nowSeconds });
    const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion });
    const res = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* handled below */
    }
    if (!res.ok || !json.access_token) {
      const reason = json.error_description ?? json.error ?? text.slice(0, 200) ?? "no body";
      throw new TokenError(res.status, `Google refused the service account (${res.status}): ${reason}`, json.error);
    }
    const ttl = Number(json.expires_in) || TTL_SECONDS;
    cached = { token: json.access_token, expiresAt: now() + (ttl - REFRESH_MARGIN_SECONDS) * 1000 };
    return cached.token;
  };

  return async () => {
    if (cached && cached.expiresAt > now()) return cached.token;
    if (!inflight) {
      inflight = mint().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  };
}

export class TokenError extends Error {
  /** @param {number} status @param {string} message @param {string} [code] */
  constructor(status, message, code) {
    super(message);
    this.name = "TokenError";
    this.status = status;
    this.code = code;
  }
}
