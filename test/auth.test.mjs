// @ts-nocheck — tests assert at runtime; a possibly-undefined lookup here fails the test loudly anyway.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createVerify, createPublicKey } from "node:crypto";

import { createTokenProvider, signAssertion, SCOPE, TOKEN_URL } from "../src/play/auth.mjs";
import { testPrivateKey } from "./helpers/mock-play.mjs";

const EMAIL = "release@test-project.iam.gserviceaccount.com";

test("the assertion is an RS256 JWT with the claims Google expects", () => {
  const key = testPrivateKey();
  const jwt = signAssertion({ clientEmail: EMAIL, privateKey: key, nowSeconds: 1_700_000_000 });
  const [h, p, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "RS256", typ: "JWT" });
  const payload = JSON.parse(Buffer.from(p, "base64url"));
  assert.equal(payload.iss, EMAIL);
  assert.equal(payload.scope, SCOPE);
  assert.equal(payload.aud, TOKEN_URL);
  assert.equal(payload.exp - payload.iat, 3600);
  // The signature verifies against the public half of the same key.
  const verify = createVerify("sha256").update(`${h}.${p}`);
  assert.equal(verify.verify(createPublicKey(key), Buffer.from(s, "base64url")), true);
});

test("the token exchange posts a form-encoded jwt-bearer grant and caches the result", async () => {
  const posts = [];
  const fetchImpl = async (url, init) => {
    posts.push({ url, init });
    return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 3600 }), { status: 200 });
  };
  let now = 1_700_000_000_000;
  const provider = createTokenProvider({ clientEmail: EMAIL, privateKey: testPrivateKey(), fetchImpl, now: () => now });

  assert.equal(await provider(), "tok-1");
  assert.equal(await provider(), "tok-1");
  assert.equal(posts.length, 1, "a second call within the token's life must not mint again");
  assert.equal(posts[0].url, TOKEN_URL);
  assert.equal(posts[0].init.headers["Content-Type"], "application/x-www-form-urlencoded");
  const body = Object.fromEntries(new URLSearchParams(posts[0].init.body));
  assert.equal(body.grant_type, "urn:ietf:params:oauth:grant-type:jwt-bearer");
  assert.match(body.assertion, /^[\w-]+\.[\w-]+\.[\w-]+$/);

  // Five minutes before expiry it refreshes.
  now += (3600 - 200) * 1000;
  assert.equal(await provider(), "tok-1");
  assert.equal(posts.length, 2, "past the refresh margin a new token is minted");
});

test("parallel first calls mint exactly one token", async () => {
  let posts = 0;
  const fetchImpl = async () => {
    posts += 1;
    await new Promise((r) => setTimeout(r, 5));
    return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
  };
  const provider = createTokenProvider({ clientEmail: EMAIL, privateKey: testPrivateKey(), fetchImpl });
  await Promise.all([provider(), provider(), provider()]);
  assert.equal(posts, 1);
});

test("a refused grant surfaces Google's reason, not a JSON parse error", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: "invalid_grant", error_description: "Invalid JWT Signature." }), {
      status: 400,
    });
  const provider = createTokenProvider({ clientEmail: EMAIL, privateKey: testPrivateKey(), fetchImpl });
  await assert.rejects(
    provider,
    (e) => e.name === "TokenError" && e.code === "invalid_grant" && /Invalid JWT Signature/.test(e.message),
  );
});
