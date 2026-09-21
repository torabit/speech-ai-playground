// Phase 2 の検証。録音済みの wav を実時間でサーバへ流し、文の切り出し・翻訳・合成の
// 応答と遅延を測る。Phase 1 との違いはバイナリが返る点。`speech` の JSON の直後の
// 1 フレームが、その文の mp3 だという契約になっている
//
// 前提
// - `npm run dev:server` は止めておく。サーバはこのスクリプトが起動し、最後に落とす
// - server/.env に DEEPGRAM_API_KEY がある
// - server/.env に GEMINI_API_KEY が無い/空でも実行はできる。その場合は全文が
//   translate_error になり、翻訳・合成に依存する項目は n=0 で FAIL する。それが正しい挙動で、
//   最初の PASS/FAIL 行（鍵の有無）を見ればなぜ後続が落ちているか分かるようにしてある
// - recordings/ に日本語の録音が 1 つ以上ある
//
// 実行: npm run verify:phase2              # recordings/ の最新を流す
//       npm run verify:phase2 -- <wav>     # wav を指定する
//
// 流した音声はサーバがそのまま recordings/ に保存する。実行するたびに wav が 1 つ増える

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const FRAME = 640; // 20ms @ 16kHz / mono / 16bit
// 最後の文の翻訳・合成が終わるまで待つ時間。Phase 1 の 3000ms では TTS の分が足りない。
// translate・speak それぞれタイムアウトが 5000ms あり、直列に待つと最悪 10s を超える
const TAIL_MS = 12000;
const MIN_AUDIO_SEC = 5; // これより短い録音では発話が足りず遅延が測れない

// 段ごとの p95 の閾値。GEMINI_API_KEY が無く実測がまだ無いので仮値を置く。
// 実測が取れたら、その p95 の 2 倍に締め直す
const TRANSLATE_P95_MS = 3000;
const SPEAK_P95_MS = 5000;
const END_TO_MP3_P95_MS = 8000;

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

const file = process.argv[2] ?? latestRecording();
const pcm = readPcm(file);
const audioSec = pcm.length / 2 / 16000;
console.log(`${file}  ${audioSec.toFixed(2)}s\n`);
if (audioSec < MIN_AUDIO_SEC) throw new Error(`録音が短すぎる（${audioSec.toFixed(2)}s < ${MIN_AUDIO_SEC}s）`);

const hasGeminiKey = readGeminiKeyPresence();

const server = startServer();
await waitForPort();

// seq -> { seq, text, startMs, endMs, reason, translateMs?, english?, speakMs?, queuedMs?, mp3?, at?, error? }
// Map の反復順は挿入順、つまり "sentence" イベントが届いた順になる。これを seq の連番検査に使う
const sentences = new Map();
// "speech" の JSON を受けてから、直後のバイナリが届くまでの間だけ埋まる
let awaitingSpeech = null;
// 説明のないバイナリ（awaitingSpeech が無い時に届いたもの）の件数。1 件でもあれば実装がおかしい
let strayBinary = 0;

const ws = new WebSocket("ws://localhost:8787/audio");
ws.binaryType = "arraybuffer";
const started = performance.now();

// sentences に無い seq を参照するイベントが来た場合の共通処理。
// サーバの実装上は起こらない想定（sentence が必ず先に届く）だが、起きたらクラッシュではなく報告する
const sentenceOf = (seq) => {
  const s = sentences.get(seq);
  if (!s) console.log(`seq=${seq} の sentence が見つからない（順序が壊れている）`);
  return s;
};

ws.addEventListener("message", (e) => {
  if (typeof e.data !== "string") {
    if (awaitingSpeech === null) {
      strayBinary++;
      console.log("説明のないバイナリが届いた");
      return;
    }
    const s = sentenceOf(awaitingSpeech.seq);
    if (s) {
      s.mp3 = new Uint8Array(e.data);
      s.at = awaitingSpeech.at; // speech の JSON を受けた時刻（サーバの t）
    }
    awaitingSpeech = null;
    return;
  }
  const m = JSON.parse(e.data);
  const delay = m.latencyMs === undefined ? `lag=${String(m.lagMs).padStart(4)}ms` : `lat=${String(m.latencyMs).padStart(4)}ms`;
  const head = `${String(Math.round(performance.now() - started)).padStart(5)}ms audio=${String(m.audioMs).padStart(5)}ms ${delay}`;

  if (m.type === "sentence") {
    sentences.set(m.seq, { ...m });
    console.log(`${head} SENTENCE seq=${m.seq}  ${m.reason.padEnd(11)}  ${m.text}`);
  } else if (m.type === "translation") {
    const s = sentenceOf(m.seq);
    if (s) Object.assign(s, { english: m.text, translateMs: m.translateMs });
    console.log(`${head} translation seq=${m.seq}  ${m.text}`);
  } else if (m.type === "speech") {
    const s = sentenceOf(m.seq);
    if (s) Object.assign(s, { speakMs: m.speakMs, queuedMs: m.queuedMs });
    awaitingSpeech = { seq: m.seq, at: m.t };
    console.log(`${head} speech seq=${m.seq}  bytes=${m.bytes}  speak=${m.speakMs}ms  queued=${m.queuedMs}ms`);
  } else if (m.type === "translate_error" || m.type === "speak_error") {
    const s = sentenceOf(m.seq);
    if (s) Object.assign(s, { error: m.reason });
    console.log(`${head} ${m.type} seq=${m.seq}  ${m.reason}`);
  } else {
    // partial / final / speech_started / utterance_end / stt_error は Phase 1 の検証対象。
    // ここでは文の追跡に関係ないのでログだけ出す
    console.log(`${head} ${m.type}${m.reason ? `  ${m.reason}` : ""}`);
  }
});

try {
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", () => reject(new Error("サーバに接続できない")));
  });

  // 実時間で送る。sleep(20) だと 1 フレームごとの遅れが積み上がり、
  // lag が Deepgram の遅れではなく送信側のずれを測ってしまう。絶対時刻に合わせる
  const sendStart = performance.now();
  let sent = 0;
  for (let i = 0; i + FRAME <= pcm.length; i += FRAME) {
    ws.send(pcm.subarray(i, i + FRAME));
    sent += FRAME;
    // 次のフレームを送る時刻は「送った音声の長さ」で決める。sleep の誤差を持ち越さない
    const wait = sendStart + sent / 2 / 16 - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  const sendElapsed = performance.now() - sendStart;
  const sentMs = sent / 2 / 16;
  console.log(`--- 送り終えた audio=${(sentMs / 1000).toFixed(2)}s wall=${(sendElapsed / 1000).toFixed(2)}s ---`);
  await new Promise((r) => setTimeout(r, TAIL_MS));
  ws.close(1000);

  report();
} catch (e) {
  check("検証を最後まで実行できる", false, e instanceof Error ? e.message.split("\n")[0] : String(e));
} finally {
  server.kill();
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);

function report() {
  // Map の反復順 = sentence イベントが届いた順。seq の連番・順序の検査にそのまま使う
  const list = [...sentences.values()];
  const reasons = { punctuation: 0, silence: 0, length: 0 };
  for (const s of list) reasons[s.reason]++;

  const translated = list.filter((s) => s.translateMs !== undefined);
  const spoken = list.filter((s) => s.mp3 !== undefined);
  const errored = list.filter((s) => s.error !== undefined);
  // 遅延はサーバの t（最初の音声フレームからの経過）と文の startMs / endMs の差で出す。
  // Phase 1 の latencyMs と同じ原点なので、フェーズをまたいで数字を比べられる
  const endToMp3 = spoken.map((s) => s.at - s.endMs);
  const startToMp3 = spoken.map((s) => s.at - s.startMs);

  console.log("\n--- 文の切り出し ---");
  console.log(`件数 ${list.length}  句点=${reasons.punctuation} 無音=${reasons.silence} 長さ=${reasons.length}  失敗=${errored.length}${errored[0] ? `（例: ${errored[0].error}）` : ""}`);

  console.log("\n--- 遅延（ms）---");
  console.log(`翻訳 translateMs      ${summarize(translated.map((s) => s.translateMs))}`);
  console.log(`合成 speakMs          ${summarize(spoken.map((s) => s.speakMs))}`);
  console.log(`順番待ち queuedMs     ${summarize(spoken.map((s) => s.queuedMs))}`);
  console.log(`文末から mp3 まで     ${summarize(endToMp3)}`);
  console.log(`文頭から mp3 まで     ${summarize(startToMp3)}\n`);

  // 鍵が無いとここから先は全部 n=0 で FAIL する。これを一番上に置くことで、
  // 後続の FAIL が実装の不具合ではなく環境（鍵が無い）由来だと読み手がすぐ分かる
  check("GEMINI_API_KEY が設定されている", hasGeminiKey);
  check("文が 1 つ以上ある", list.length > 0, `n=${list.length}`);
  check(
    "句点で終わる文が 8 割以上",
    list.length > 0 && reasons.punctuation / list.length >= 0.8,
    `punctuation=${reasons.punctuation}/${list.length}`,
  );
  // .every は空配列で true を返すので、n=0 のときに空の翻訳が「すべて ASCII」と誤判定されない
  // よう n > 0 を先に置く。鍵が無い環境ではここが正しく FAIL する
  check(
    "訳がすべて ASCII 主体（日本語が残っていない）",
    translated.length > 0 && translated.every((s) => !/[ぁ-んァ-ヶ一-龠]/.test(s.english)),
    `n=${translated.length}`,
  );
  check(
    "mp3 の先頭がフレーム同期になっている",
    spoken.length > 0 && spoken.every((s) => s.mp3.length >= 2 && s.mp3[0] === 0xff && (s.mp3[1] & 0xe0) === 0xe0),
    `n=${spoken.length}`,
  );
  check("説明のないバイナリが届いていない", strayBinary === 0, `n=${strayBinary}`);
  check(...seqOrderCheck(list));
  check(
    `翻訳 p95 が ${TRANSLATE_P95_MS}ms 未満`,
    translated.length > 0 && p(translated.map((s) => s.translateMs), 0.95) < TRANSLATE_P95_MS,
    `n=${translated.length} p95=${p(translated.map((s) => s.translateMs), 0.95)}ms`,
  );
  check(
    `合成 p95 が ${SPEAK_P95_MS}ms 未満`,
    spoken.length > 0 && p(spoken.map((s) => s.speakMs), 0.95) < SPEAK_P95_MS,
    `n=${spoken.length} p95=${p(spoken.map((s) => s.speakMs), 0.95)}ms`,
  );
  check(
    `文末から mp3 まで p95 が ${END_TO_MP3_P95_MS}ms 未満`,
    endToMp3.length > 0 && p(endToMp3, 0.95) < END_TO_MP3_P95_MS,
    `n=${endToMp3.length} p95=${p(endToMp3, 0.95)}ms`,
  );
}

// seq が 1 から連番で、届いた順どおりになっているかを見る。
// list は Map の反復順（＝到着順）なので、抜け（gap）も入れ替わりも seqs[i] !== i+1 に出る
function seqOrderCheck(list) {
  const seqs = list.map((s) => s.seq);
  const ok = seqs.length > 0 && seqs.every((seq, i) => seq === i + 1);
  return ["seq が 1 から連番で順序どおりに届く", ok, `seq=${seqs.join(",") || "-"}`];
}

// server/.env を自分では読み込まない（読み込むのはサーバ側の役目）ので、
// 鍵の有無だけをファイルから直接見る。値そのものは絶対にログへ出さない
function readGeminiKeyPresence() {
  const envPath = join(ROOT, "server/.env");
  if (!existsSync(envPath)) return false;
  const line = readFileSync(envPath, "utf8").split("\n").find((l) => l.startsWith("GEMINI_API_KEY="));
  return Boolean(line && line.slice("GEMINI_API_KEY=".length).trim());
}

function p(values, ratio) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function summarize(values) {
  if (values.length === 0) return "n=0";
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return `n=${String(values.length).padStart(3)} mean=${mean.toFixed(0).padStart(5)} p50=${p(values, 0.5).toFixed(0).padStart(5)} p95=${p(values, 0.95).toFixed(0).padStart(5)} max=${p(values, 1).toFixed(0).padStart(5)}  (ms)`;
}

function latestRecording() {
  const dir = join(ROOT, "recordings");
  const latest = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".wav")).sort().at(-1) : undefined;
  if (!latest) throw new Error("recordings/ に wav がない。先に録音するか、wav を引数で渡す");
  return join(dir, latest);
}

function readPcm(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(24) !== 16000) throw new Error(`16kHz の wav ではない（${buf.readUInt32LE(24)}Hz）`);
  return Buffer.from(buf.buffer, buf.byteOffset + 44, buf.length - 44);
}

function startServer() {
  const child = spawn("node", ["src/index.ts"], { cwd: join(ROOT, "server"), stdio: ["ignore", "inherit", "inherit"] });
  child.on("exit", (code) => {
    if (code !== null && code !== 0) console.error(`server exited with ${code}. dev:server が :8787 を使っていないか確認する`);
  });
  return child;
}

async function waitForPort() {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch("http://localhost:8787/");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("server did not start on :8787");
}
