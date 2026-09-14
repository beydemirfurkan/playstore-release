// @ts-nocheck — tests assert at runtime; a possibly-undefined lookup here fails the test loudly anyway.
import { generateKeyPairSync, createHash } from "node:crypto";

// A fake Google Play, injected through the client's `fetchImpl` seam — and the
// token endpoint with it, so authentication is exercised rather than stubbed.
//
// `strict` is the important option: an unrouted request throws and names itself,
// so a failing test tells you exactly which call the code made that it should
// not have, instead of a null dereference three frames later.

/** @typedef {{ method: string, host: string, path: string, pathname: string, body?: any, raw?: Buffer, contentType?: string }} Call */

export const PACKAGE = "com.example.test";
export const API = "https://androidpublisher.googleapis.com/androidpublisher/v3";
export const UPLOAD = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3";
export const TOKEN = "https://oauth2.googleapis.com/token";
export const EDIT_ID = "edit-1";

/** App-relative route key → absolute pattern. */
const app = (rel) => `${API}/applications/${PACKAGE}${rel}`;
const upload = (rel) => `${UPLOAD}/applications/${PACKAGE}${rel}`;

/**
 * @param {{ routes?: Record<string, any>, strict?: boolean, token?: boolean }} [opts]
 */
export function createMockPlay({ routes = {}, strict = true, token = true } = {}) {
  /** @type {Call[]} */
  const calls = [];
  const all = { ...(token ? tokenRoutes() : {}), ...routes };
  const compiled = Object.entries(all).map(([key, value]) => {
    const [method, pattern] = key.split(" ");
    return { method, ...compile(pattern), value };
  });

  /** @type {typeof fetch} */
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const contentType = init.headers?.["Content-Type"] ?? init.headers?.["content-type"];
    let body;
    let raw;
    if (typeof init.body === "string") {
      body = contentType?.includes("json") ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body));
    } else if (init.body) {
      raw = Buffer.from(init.body);
    }
    const call = {
      method,
      host: url.host,
      path: url.pathname + url.search,
      pathname: url.pathname,
      body,
      raw,
      contentType,
    };
    calls.push(call);

    for (const route of compiled) {
      if (route.method !== method) continue;
      const params = route.match(`${url.origin}${url.pathname}`);
      if (!params) continue;
      const resolved = typeof route.value === "function" ? route.value({ params, call, url }) : route.value;
      return respond(resolved);
    }

    if (strict) throw new Error(`mock-play: no route for ${method} ${url.origin}${url.pathname}${url.search}`);
    return respond({ status: 404, body: { error: { code: 404, message: "Not found (mock)", status: "NOT_FOUND" } } });
  };

  return {
    fetchImpl,
    calls,
    /** Every request that was not a read and not the token exchange. */
    mutations: () => calls.filter((c) => c.method !== "GET" && c.host !== "oauth2.googleapis.com"),
    /** Writes excluding the edit lifecycle — what an idempotent second run must not send. */
    writes: () =>
      calls.filter(
        (c) =>
          c.method !== "GET" &&
          c.host !== "oauth2.googleapis.com" &&
          !/\/edits$/.test(c.pathname) &&
          !/\/edits\/[^/]+$/.test(c.pathname) &&
          !/\/edits\/[^/]+:validate$/.test(c.pathname),
      ),
    commits: () => calls.filter((c) => /:commit$/.test(c.pathname)),
    reset: () => calls.splice(0, calls.length),
  };
}

/** Turn "https://host/x/:id/y" into a matcher yielding { id }; ":id:verb" keeps the verb literal. */
function compile(pattern) {
  const names = [];
  const source = pattern
    .split("/")
    .map((seg) => {
      const m = /^:(\w+)(:\w+)?$/.exec(seg);
      if (!m) return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      names.push(m[1]);
      return `([^/:]+)${m[2] ? m[2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : ""}`;
    })
    .join("/");
  const re = new RegExp(`^${source}$`);
  return {
    match(absolute) {
      const m = re.exec(absolute);
      if (!m) return null;
      return Object.fromEntries(names.map((n, i) => [n, m[i + 1]]));
    },
  };
}

function respond(resolved) {
  const { status = 200, body = {}, headers = {} } = resolved?.status || resolved?.body ? resolved : { body: resolved };
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function tokenRoutes() {
  return {
    [`POST ${TOKEN}`]: { access_token: "ya29.test", expires_in: 3600, token_type: "Bearer" },
  };
}

/** Google's error envelope. */
export const googleError = (code, message, status, reason) => ({
  status: code,
  body: { error: { code, message, status, errors: reason ? [{ message, reason, domain: "androidpublisher" }] : [] } },
});

export const sha1 = (bytes) => createHash("sha1").update(bytes).digest("hex");

// ── A coherent app, enough for every operation to run ─────────────────────────

/**
 * Routes describing an app that is ready to publish: an internal release of
 * versionCode 7, a tr-TR listing, icon + feature graphic + two phone shots
 * (with the given sha1s), contact details, no testers.
 *
 * @param {{ locale?: string, images?: Record<string, string[]>, bundles?: any[], tracks?: any[], listing?: any, details?: any }} [opts]
 */
export function readyToPublishRoutes({
  locale = "tr-TR",
  images = { icon: ["sha-icon"], featureGraphic: ["sha-feature"], phoneScreenshots: ["sha-p1", "sha-p2"] },
  bundles = [{ versionCode: 7, sha1: "sha-bundle-7", sha256: "x" }],
  tracks = [
    { track: "internal", releases: [{ name: "1.0.1", status: "completed", versionCodes: ["7"] }] },
    { track: "production", releases: [] },
  ],
  listing = { language: "tr-TR", title: "Test App", shortDescription: "Short", fullDescription: "Full text." },
  details = { defaultLanguage: "tr-TR", contactEmail: "dev@example.com", contactWebsite: "https://example.com" },
} = {}) {
  const imageRoutes = {};
  for (const [type, shas] of Object.entries(images)) {
    imageRoutes[`GET ${app(`/edits/:edit/listings/${locale}/${type}`)}`] = {
      images: shas.map((s, i) => ({ id: `${type}-${i}`, sha1: s, url: `https://lh3.example/${type}-${i}` })),
    };
  }
  for (const type of ["icon", "featureGraphic", "phoneScreenshots", "sevenInchScreenshots", "tenInchScreenshots"]) {
    imageRoutes[`GET ${app(`/edits/:edit/listings/${locale}/${type}`)}`] ??= { images: [] };
  }
  return {
    [`POST ${app("/edits")}`]: { id: EDIT_ID, expiryTimeSeconds: "9999999999" },
    [`DELETE ${app("/edits/:edit")}`]: { status: 204 },
    [`POST ${app("/edits/:edit:validate")}`]: { id: EDIT_ID },
    [`POST ${app("/edits/:edit:commit")}`]: { id: EDIT_ID },
    [`GET ${app("/edits/:edit/bundles")}`]: { kind: "androidpublisher#bundlesListResponse", bundles },
    [`GET ${app("/edits/:edit/tracks")}`]: { kind: "androidpublisher#tracksListResponse", tracks },
    [`GET ${app("/edits/:edit/tracks/:track")}`]: ({ params }) =>
      tracks.find((t) => t.track === params.track) ?? googleError(404, "Track not found", "NOT_FOUND", "notFound"),
    [`GET ${app("/edits/:edit/listings")}`]: {
      kind: "androidpublisher#listingsListResponse",
      listings: listing ? [listing] : [],
    },
    [`GET ${app("/edits/:edit/listings/:lang")}`]: ({ params }) =>
      listing && params.lang === locale ? listing : googleError(404, "Listing not found", "NOT_FOUND", "notFound"),
    [`GET ${app("/edits/:edit/details")}`]: details,
    [`GET ${app("/edits/:edit/testers/:track")}`]: { googleGroups: [] },
    [`GET ${app("/reviews")}`]: { reviews: [] },
    ...imageRoutes,
    // Writes, accepted generically so a test can assert on `calls` instead.
    [`PUT ${app("/edits/:edit/listings/:lang")}`]: ({ call }) => call.body,
    [`PATCH ${app("/edits/:edit/details")}`]: ({ call }) => ({ ...details, ...call.body }),
    [`PUT ${app("/edits/:edit/tracks/:track")}`]: ({ call }) => call.body,
    [`PUT ${app("/edits/:edit/testers/:track")}`]: ({ call }) => call.body,
    [`DELETE ${app("/edits/:edit/listings/:lang/:type/:id")}`]: { status: 204 },
    [`DELETE ${app("/edits/:edit/listings/:lang/:type")}`]: { deleted: [] },
    [`POST ${upload("/edits/:edit/listings/:lang/:type")}`]: ({ call, params }) => ({
      image: {
        id: `new-${params.type}-${call.raw?.length ?? 0}`,
        sha1: sha1(call.raw ?? Buffer.alloc(0)),
        url: "https://lh3.example/new",
      },
    }),
    [`POST ${upload("/edits/:edit/bundles")}`]: ({ call }) => ({
      versionCode: 8,
      sha1: sha1(call.raw ?? Buffer.alloc(0)),
      sha256: "y",
    }),
  };
}

/** A real RSA key, so JWT signing is exercised rather than stubbed. Built once per process. */
let keyPem;
export function testPrivateKey() {
  if (!keyPem) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  }
  return keyPem;
}

/** A service-account JSON as inline text, for createContext in tests. */
export function testServiceAccount() {
  return JSON.stringify({
    type: "service_account",
    project_id: "test-project",
    private_key_id: "abc",
    private_key: testPrivateKey(),
    client_email: "release@test-project.iam.gserviceaccount.com",
    client_id: "1",
    token_uri: TOKEN,
  });
}

/** Credentials wired to that key. */
export function testCredentials({ packageName = PACKAGE } = {}) {
  return { serviceAccount: testServiceAccount(), packageName };
}

/** A structurally valid PNG header with the given size and colour type (2 = RGB, 6 = RGBA). */
export function png(width, height, { tag = "", alpha = false } = {}) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16);
  ihdr.writeUInt8(alpha ? 6 : 2, 17);
  return Buffer.concat([sig, ihdr, Buffer.from(`tail-${tag}`)]);
}

/** A minimal baseline JPEG header: SOI, APP0, SOF0 with the given size. */
export function jpeg(width, height, { tag = "" } = {}) {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  return Buffer.concat([soi, app0, sof, Buffer.from(`tail-${tag}`)]);
}
