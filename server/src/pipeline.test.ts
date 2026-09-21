import { test } from "node:test";
import assert from "node:assert/strict";
import { createPipeline, type PipelineEvent } from "./pipeline.ts";
import type { Sentence } from "./sentences.ts";

const sentence = (seq: number, text: string): Sentence => ({
  seq, text, startMs: seq * 1000, endMs: seq * 1000 + 500, reason: "punctuation",
});

// 解決の順番を外から決められる Promise
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const mp3 = new Uint8Array([0xff, 0xf3, 0x00]);

test("訳と音声を seq 順に出す", async () => {
  const events: PipelineEvent[] = [];
  const p = createPipeline({
    translate: async (japanese) => `en:${japanese}`,
    speak: async () => mp3,
    onEvent: (e) => events.push(e),
  });
  p.submit(sentence(1, "一。"));
  p.submit(sentence(2, "二。"));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(events.map((e) => [e.type, e.seq]), [
    ["translation", 1], ["speech", 1], ["translation", 2], ["speech", 2],
  ]);
});

test("後の文が先に終わっても順序を保って送る", async () => {
  const events: PipelineEvent[] = [];
  const first = deferred<string>();
  const p = createPipeline({
    translate: async (japanese) => (japanese === "一。" ? first.promise : `en:${japanese}`),
    speak: async () => mp3,
    onEvent: (e) => events.push(e),
  });
  p.submit(sentence(1, "一。"));
  p.submit(sentence(2, "二。"));
  await new Promise((r) => setTimeout(r, 20));
  // 2 の翻訳と合成が終わっていても、1 を待つ間は何も出ない
  assert.deepEqual(events, []);
  first.resolve("en:一。");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(events.map((e) => [e.type, e.seq]), [
    ["translation", 1], ["speech", 1], ["translation", 2], ["speech", 2],
  ]);
  // 2 は自分の処理を終えてから 1 を待った。その待ち時間が queuedMs に出る
  const speech2 = events.find((e) => e.type === "speech" && e.seq === 2) as { queuedMs: number };
  assert.ok(speech2.queuedMs > 0, `queuedMs=${speech2.queuedMs}`);
});

test("翻訳が失敗しても後続が届く", async () => {
  const events: PipelineEvent[] = [];
  const p = createPipeline({
    translate: async (japanese) => {
      if (japanese === "一。") throw new Error("boom");
      return `en:${japanese}`;
    },
    speak: async () => mp3,
    onEvent: (e) => events.push(e),
  });
  p.submit(sentence(1, "一。"));
  p.submit(sentence(2, "二。"));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(events.map((e) => [e.type, e.seq]), [
    ["translate_error", 1], ["translation", 2], ["speech", 2],
  ]);
  assert.match((events[0] as { reason: string }).reason, /boom/);
});

test("合成だけ失敗したら訳は出して音声を落とす", async () => {
  const events: PipelineEvent[] = [];
  const p = createPipeline({
    translate: async () => "en",
    speak: async () => { throw new Error("tts down"); },
    onEvent: (e) => events.push(e),
  });
  p.submit(sentence(1, "一。"));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(events.map((e) => e.type), ["translation", "speak_error"]);
});

test("直前の文の訳を次の文の文脈に渡す", async () => {
  const seen: (undefined | { japanese: string; english: string })[] = [];
  const p = createPipeline({
    translate: async (japanese, context) => { seen.push(context); return `en:${japanese}`; },
    speak: async () => mp3,
    onEvent: () => {},
  });
  p.submit(sentence(1, "一。"));
  await new Promise((r) => setTimeout(r, 20));
  p.submit(sentence(2, "二。"));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen, [undefined, { japanese: "一。", english: "en:一。" }]);
});

test("translateMs と queuedMs を測る", async () => {
  const events: PipelineEvent[] = [];
  let clock = 0;
  const p = createPipeline({
    translate: async () => { clock += 300; return "en"; },
    speak: async () => { clock += 700; return mp3; },
    onEvent: (e) => events.push(e),
    now: () => clock,
  });
  p.submit(sentence(1, "一。"));
  await new Promise((r) => setTimeout(r, 20));
  const translation = events[0] as { translateMs: number };
  const speech = events[1] as { speakMs: number; queuedMs: number };
  assert.equal(translation.translateMs, 300);
  assert.equal(speech.speakMs, 700);
  assert.equal(speech.queuedMs, 0);
});
