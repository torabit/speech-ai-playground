import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSpeakUrl, isMp3FrameSync } from "./speak.ts";

test("モデルと encoding をクエリに置く", () => {
  const url = new URL(buildSpeakUrl("aura-2-thalia-en"));
  assert.equal(url.origin + url.pathname, "https://api.deepgram.com/v1/speak");
  assert.equal(url.searchParams.get("model"), "aura-2-thalia-en");
  assert.equal(url.searchParams.get("encoding"), "mp3");
});

test("フレーム同期のバイト列を通す", () => {
  assert.equal(isMp3FrameSync(new Uint8Array([0xff, 0xf3, 0x00])), true);
});

test("2 バイト未満は弾く", () => {
  assert.equal(isMp3FrameSync(new Uint8Array([0xff])), false);
  assert.equal(isMp3FrameSync(new Uint8Array([])), false);
});

test("JSON のエラー本文を弾く", () => {
  assert.equal(isMp3FrameSync(new TextEncoder().encode('{"error":"boom"}')), false);
});

test("ID3v2 タグ付きの応答を弾く（受け入れない）", () => {
  assert.equal(isMp3FrameSync(new Uint8Array([0x49, 0x44, 0x33, 0x04])), false);
});
