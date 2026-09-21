import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSpeakUrl } from "./speak.ts";

test("モデルと encoding をクエリに置く", () => {
  const url = new URL(buildSpeakUrl("aura-2-thalia-en"));
  assert.equal(url.origin + url.pathname, "https://api.deepgram.com/v1/speak");
  assert.equal(url.searchParams.get("model"), "aura-2-thalia-en");
  assert.equal(url.searchParams.get("encoding"), "mp3");
});
