import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import {
  customFetch,
  setAuthTokenGetter,
  setBaseUrl,
} from "../src/custom-fetch";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  setBaseUrl(null);
  setAuthTokenGetter(null);
});

after(() => {
  globalThis.fetch = originalFetch;
});

test("same-origin API requests explicitly carry browser session cookies", async () => {
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = async (_input, init) => {
    capturedInit = init;
    return new Response(JSON.stringify({ userId: "user_test" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await customFetch<{ userId: string }>("/api/account", {
    responseType: "json",
  });

  assert.equal(result.userId, "user_test");
  assert.equal(capturedInit?.credentials, "same-origin");
  assert.equal(new Headers(capturedInit?.headers).has("authorization"), false);
});

test("web callers can explicitly opt out of cookies for public endpoints", async () => {
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = async (_input, init) => {
    capturedInit = init;
    return new Response(null, { status: 204 });
  };

  await customFetch("/api/public", { credentials: "omit" });

  assert.equal(capturedInit?.credentials, "omit");
});