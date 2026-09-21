import { test } from "node:test";
import assert from "node:assert/strict";
import { createAssembler, type Sentence } from "./sentences.ts";

// 集めた文を配列で受ける小道具
function collect(maxChars?: number) {
  const out: Sentence[] = [];
  return { out, a: createAssembler((s) => out.push(s), maxChars) };
}

test("句点で 1 文を出す", () => {
  const { out, a } = collect();
  a.pushFinal("オーディオコンテキスト。", true, 1360, 2880);
  assert.deepEqual(out, [{ seq: 1, text: "オーディオコンテキスト。", startMs: 1360, endMs: 2880, reason: "punctuation" }]);
});

test("読点で終わる断片は溜め、次の句点で 1 文に結合する", () => {
  const { out, a } = collect();
  a.pushFinal("オーディオコンテキストインターフェースは、", false, 3490, 7890);
  assert.equal(out.length, 0);
  a.pushFinal("音声処理グラフを表します。", true, 8380, 12620);
  assert.deepEqual(out, [{
    seq: 1,
    text: "オーディオコンテキストインターフェースは、音声処理グラフを表します。",
    startMs: 3490,
    endMs: 12620,
    reason: "punctuation",
  }]);
});

test("1 つの final に句点が 2 つあれば 2 文出す", () => {
  const { out, a } = collect();
  a.pushFinal("はい。わかりました。", false, 1000, 3000);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((s) => [s.seq, s.text]), [[1, "はい。"], [2, "わかりました。"]]);
});

test("句点の後ろに残りがあれば次の文として持つ", () => {
  const { out, a } = collect();
  a.pushFinal("はい。それで", false, 1000, 3000);
  assert.deepEqual(out.map((s) => s.text), ["はい。"]);
  a.pushFinal("進めます。", false, 3200, 4000);
  assert.deepEqual(out.map((s) => s.text), ["はい。", "それで進めます。"]);
});

test("speech_final なら句点がなくても出す", () => {
  const { out, a } = collect();
  a.pushFinal("毎回新しいものを初期化するのではなく", true, 26370, 29090);
  assert.deepEqual(out, [{
    seq: 1,
    text: "毎回新しいものを初期化するのではなく",
    startMs: 26370,
    endMs: 29090,
    reason: "silence",
  }]);
});

test("utterance_end で溜まっているものを出す。空なら何も出さない", () => {
  const { out, a } = collect();
  a.pushUtteranceEnd();
  assert.equal(out.length, 0);
  a.pushFinal("一つのオーディオコンテキストを", false, 35290, 38090);
  a.pushUtteranceEnd();
  assert.deepEqual(out.map((s) => [s.text, s.reason]), [["一つのオーディオコンテキストを", "silence"]]);
});

test("句点が来ないまま上限を超えたら出す", () => {
  const { out, a } = collect(10);
  a.pushFinal("あいうえおかきくけこさ", false, 0, 1000);
  assert.deepEqual(out.map((s) => [s.text, s.reason]), [["あいうえおかきくけこさ", "length"]]);
});

test("flush で溜まっているものを出し、2 回目は何も出さない", () => {
  const { out, a } = collect();
  a.pushFinal("途中で止めた", false, 0, 1000);
  a.flush();
  a.flush();
  assert.equal(out.length, 1);
});

test("？ と ！ も文末として扱う", () => {
  const { out, a } = collect();
  a.pushFinal("聞こえますか？はい！", false, 0, 2000);
  assert.deepEqual(out.map((s) => s.text), ["聞こえますか？", "はい！"]);
});

test("空文字の final は無視する", () => {
  const { out, a } = collect();
  a.pushFinal("", false, 0, 100);
  a.pushUtteranceEnd();
  assert.equal(out.length, 0);
});
