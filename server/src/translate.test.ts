import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTranslateRequest, readDiagnostic, readTranslation } from "./translate.ts";

test("システム指示と本文を組み立てる", () => {
  const body = buildTranslateRequest("おはよう。") as any;
  assert.match(body.systemInstruction.parts[0].text, /English/);
  assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "おはよう。" }] }]);
  assert.equal(body.generationConfig.temperature, 0.2);
});

test("直前の 1 文を user と model の往復として前に置く", () => {
  const body = buildTranslateRequest("それで進めます。", { japanese: "はい。", english: "Yes." }) as any;
  assert.deepEqual(body.contents, [
    { role: "user", parts: [{ text: "はい。" }] },
    { role: "model", parts: [{ text: "Yes." }] },
    { role: "user", parts: [{ text: "それで進めます。" }] },
  ]);
});

test("応答から訳文を読む", () => {
  const json = { candidates: [{ content: { parts: [{ text: "Good morning.\n" }] } }] };
  assert.equal(readTranslation(json), "Good morning.");
});

test("形が違う応答では null を返す", () => {
  assert.equal(readTranslation({}), null);
  assert.equal(readTranslation({ candidates: [] }), null);
  assert.equal(readTranslation({ candidates: [{ content: { parts: [] } }] }), null);
  assert.equal(readTranslation({ candidates: [{ content: { parts: [{ text: "  " }] } }] }), null);
});

test("finishReason と blockReason を診断として読む", () => {
  assert.equal(readDiagnostic({ candidates: [{ finishReason: "MAX_TOKENS" }] }), "finishReason=MAX_TOKENS");
  assert.equal(readDiagnostic({ promptFeedback: { blockReason: "SAFETY" } }), "blockReason=SAFETY");
  assert.equal(
    readDiagnostic({ candidates: [{ finishReason: "SAFETY" }], promptFeedback: { blockReason: "OTHER" } }),
    "finishReason=SAFETY blockReason=OTHER",
  );
  assert.equal(readDiagnostic({}), null);
});
