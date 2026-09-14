// Google Play Developer API HTTP client. Single responsibility: authenticated
// requests + uniform errors. Knows nothing about specific resources (see
// edits.mjs for the transaction, ops/ for the resources).
//
// Dry run lives here rather than in each operation. An operation that forgets an
// `if (dryRun)` branch would quietly mutate production; a client that refuses
// every non-GET cannot be forgotten. The one carve-out is the edit lifecycle
// (insert / validate / delete): reads only exist inside an edit on this API, so
// those calls are marked `lifecycle` and go through — commit never is.

import { shouldRetry, backoffMs, retryAfterMs, sleep, RETRY_DEFAULTS } from "./retry.mjs";

export const DEFAULT_BASE_URL = "https://androidpublisher.googleapis.com/androidpublisher/v3";
export const DEFAULT_UPLOAD_BASE_URL = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3";
const DEFAULT_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 600_000;

export class PlayApiError extends Error {
  /**
   * @param {number} status
   * @param {string} method
   * @param {string} path
   * @param {{ message?: string, status?: string, errors?: Array<{message?: string, reason?: string, domain?: string}> }} [error]
   * @param {string} [rawBody]
   */
  constructor(status, method, path, error, rawBody) {
    const reasons = (error?.errors ?? []).map((e) => e.reason).filter(Boolean);
    const detail = error?.message ? ` — ${error.message}${reasons.length ? ` [${reasons.join(", ")}]` : ""}` : "";
    super(`HTTP ${status} ${method} ${path}${detail}`);
    this.name = "PlayApiError";
    this.status = status;
    this.method = method;
    this.path = path;
    this.googleStatus = error?.status; // e.g. PERMISSION_DENIED, NOT_FOUND, INVALID_ARGUMENT
    this.errors = error?.errors ?? [];
    this.message_ = error?.message ?? "";
    this.rawBody = rawBody;
    /** @type {import("../core/findings.mjs").Finding[]} filled in by hints.mjs */
    this.hints = [];
  }

  /** Google's reason codes, e.g. applicationNotFound, forbidden, badRequest. */
  get reasons() {
    return this.errors.map((e) => e.reason).filter(Boolean);
  }

  /** The human message Google sent, without our own prefix. */
  get googleMessage() {
    return this.message_;
  }
}

export class PlayClient {
  /**
   * @param {{
   *   tokenProvider: () => Promise<string>,
   *   packageName?: string,
   *   fetchImpl?: typeof fetch,
   *   baseUrl?: string,
   *   uploadBaseUrl?: string,
   *   dryRun?: boolean,
   *   log?: import("../core/events.mjs").Log | null,
   *   retry?: { attempts?: number, baseMs?: number, capMs?: number },
   *   timeoutMs?: number,
   *   random?: () => number,
   * }} deps
   */
  constructor({
    tokenProvider,
    packageName = "",
    fetchImpl = fetch,
    baseUrl = DEFAULT_BASE_URL,
    uploadBaseUrl = DEFAULT_UPLOAD_BASE_URL,
    dryRun = false,
    log = null,
    retry = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    random = Math.random,
  }) {
    this._token = tokenProvider;
    this._fetch = fetchImpl;
    this._baseUrl = baseUrl;
    this._uploadBaseUrl = uploadBaseUrl;
    this._log = log;
    this._retry = { ...RETRY_DEFAULTS, ...retry };
    this._timeoutMs = timeoutMs;
    this._random = random;
    this.packageName = packageName;
    this.dryRun = dryRun;
    this.requestCount = 0;
    this._dryCounter = 0;
  }

  /** Absolute URL for an app-relative path such as `/edits/123/listings`. */
  url(path, { upload = false } = {}) {
    const base = upload ? this._uploadBaseUrl : this._baseUrl;
    if (/^https?:\/\//.test(path)) return path;
    return `${base}/applications/${encodeURIComponent(this.packageName)}${path}`;
  }

  /**
   * @typedef {Object} RequestOptions
   * @property {object} [body]
   * @property {boolean} [throwOnError]     false → API errors resolve to `{ error: PlayApiError }`
   * @property {() => any} [dryRunResult]
   * @property {number} [timeoutMs]
   * @property {boolean} [lifecycle]        edit insert/validate/delete — allowed under dry run
   * @property {{ bytes: Buffer|Uint8Array, contentType: string }} [upload]  raw media body to the upload host
   */

  /**
   * @param {"GET"|"POST"|"PUT"|"PATCH"|"DELETE"} method
   * @param {string} path                app-relative, e.g. "/edits/abc/tracks/internal"
   * @param {RequestOptions} [opts]
   *
   * When throwOnError is false, API errors resolve to `{ error: PlayApiError }`
   * instead of throwing — callers must then check `.error` first.
   */
  async request(method, path, { body, throwOnError = true, dryRunResult, timeoutMs, lifecycle = false, upload } = {}) {
    if (this.dryRun && method !== "GET" && !lifecycle) return this._planned(method, path, body, dryRunResult);

    const url = this.url(path, { upload: Boolean(upload) });
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const started = Date.now();
      let res;
      try {
        const token = await this._token();
        res = await this._fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": upload ? upload.contentType : "application/json",
          },
          body: upload ? upload.bytes : body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs ?? (upload ? UPLOAD_TIMEOUT_MS : this._timeoutMs)),
        });
      } catch (/** @type {any} */ error) {
        if (error?.name === "TokenError") throw error; // never retry a refused credential
        if (shouldRetry({ method, error, attempt, attempts: this._retry.attempts })) {
          await sleep(backoffMs(attempt, this._retry, this._random));
          continue;
        }
        throw error;
      }

      this.requestCount += 1;
      // The Authorization header is never part of the event — these are printed
      // by --verbose and forwarded to MCP hosts.
      this._log?.request({ method, path, status: res.status, durationMs: Date.now() - started, attempt });

      if (!res.ok && shouldRetry({ method, status: res.status, attempt, attempts: this._retry.attempts })) {
        const wait = retryAfterMs(res.headers) ?? backoffMs(attempt, this._retry, this._random);
        await sleep(wait);
        continue;
      }

      return this._parse(res, method, path, throwOnError);
    }
  }

  /** @private */
  async _parse(res, method, path, throwOnError) {
    const text = await res.text();
    let json;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        // Google serves HTML for some 5xx and for a disabled API. A SyntaxError
        // there tells the user nothing about what went wrong.
        if (res.ok) throw new PlayApiError(res.status, method, path, { message: "Response was not JSON" }, text);
        json = {};
      }
    } else {
      json = {};
    }

    if (!res.ok) {
      const err = new PlayApiError(res.status, method, path, json.error, text);
      if (throwOnError) throw err;
      return { error: err };
    }
    return json;
  }

  /**
   * Record what would have happened and hand back an empty response. Play's
   * responses are plain resources, so call sites reading `.id` or `.versionCode`
   * must tolerate `undefined` under dry run — every operation does, by checking
   * `ctx.dryRun` where a later step would need the value.
   * @private
   */
  _planned(method, path, body, dryRunResult) {
    const resource = resourceOf(path);
    const action = method === "POST" ? "create" : method === "DELETE" ? "delete" : "update";
    this._log?.change({ resource, action, after: body, applied: false });
    if (dryRunResult) return dryRunResult();
    this._dryCounter += 1;
    return { id: `dry:${resource}:${this._dryCounter}` };
  }

  get(path, opts) {
    return this.request("GET", path, opts);
  }
  post(path, body, opts) {
    return this.request("POST", path, { ...opts, body });
  }
  put(path, body, opts) {
    return this.request("PUT", path, { ...opts, body });
  }
  patch(path, body, opts) {
    return this.request("PATCH", path, { ...opts, body });
  }
  delete(path, opts) {
    return this.request("DELETE", path, opts);
  }

  /**
   * Raw media upload (`?uploadType=media`) to the upload host, with our bearer.
   * @param {string} path
   * @param {{ bytes: Buffer|Uint8Array, contentType: string, timeoutMs?: number }} opts
   */
  upload(path, { bytes, contentType, timeoutMs }) {
    const sep = path.includes("?") ? "&" : "?";
    return this.request("POST", `${path}${sep}uploadType=media`, { upload: { bytes, contentType }, timeoutMs });
  }

  /**
   * Walk every page of a token-paginated collection (reviews, subscriptions).
   *
   * @param {string} path
   * @param {{ itemsKey: string, tokenParam?: string, maxPages?: number }} opts
   * @returns {AsyncGenerator<any>}
   */
  async *paginate(path, { itemsKey, tokenParam = "token", maxPages = 50 }) {
    let next = path;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.get(next);
      for (const item of res[itemsKey] ?? []) yield item;
      const token = res.tokenPagination?.nextPageToken ?? res.nextPageToken;
      if (!token) return;
      const sep = path.includes("?") ? "&" : "?";
      next = `${path}${sep}${tokenParam}=${encodeURIComponent(token)}`;
    }
    this._log?.warn(`stopped paginating ${path} after ${maxPages} pages`);
  }

  /** Collect an entire paginated collection into an array. */
  async all(path, opts) {
    const out = [];
    for await (const item of this.paginate(path, opts)) out.push(item);
    return out;
  }
}

/** "/edits/x/listings/en-US" → "listings"; "/reviews/r1:reply" → "reviews". */
function resourceOf(path) {
  const clean = path.split("?")[0];
  const afterEdit = /\/edits\/[^/]+\/([^/:]+)/.exec(clean)?.[1];
  if (afterEdit) return afterEdit;
  const segments = clean.split("/").filter(Boolean);
  return (segments[0] ?? "unknown").split(":")[0];
}
