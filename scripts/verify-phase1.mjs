// Phase 1 の検証。録音済みの wav を実時間でサーバへ流し、STT の応答と遅延を測る。
// マイクを使わないので、同じ音声で何度でも比べられる。
//
// 前提
// - `npm run dev:server` は止めておく。サーバはこのスクリプトが起動し、最後に落とす
// - server/.env に DEEPGRAM_API_KEY がある
// - recordings/ に日本語の録音が 1 つ以上ある
//
// 実行: npm run verify:phase1              # recordings/ の最新を流す
//       npm run verify:phase1 -- <wav>     # wav を指定する
//
// 流した音声はサーバがそのまま recordings/ に保存する。実行するたびに wav が 1 つ増える

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const FRAME = 640; // 20ms @ 16kHz / mono / 16bit
const TAIL_MS = 3000; // 送り終えてから結果を待つ時間
const MIN_AUDIO_SEC = 5; // これより短い録音では発話が足りず遅延が測れない

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

const server = startServer();
await waitForPort();

/** @type {{type: string, t: number, audioMs: number, lagMs: number, endMs?: number, latencyMs?: number, text?: string, speechFinal?: boolean, reason?: string}[]} */
const events = [];
const ws = new WebSocket("ws://localhost:8787/audio");
ws.binaryType = "arraybuffer";
const started = performance.now();

ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  events.push(m);
  const delay = m.latencyMs === undefined ? `lag=${String(m.lagMs).padStart(4)}ms` : `lat=${String(m.latencyMs).padStart(4)}ms`;
  const head = `${String(Math.round(performance.now() - started)).padStart(5)}ms audio=${String(m.audioMs).padStart(5)}ms ${delay}`;
  if (m.type === "partial") console.log(`${head} partial  ${m.text}`);
  else if (m.type === "final") console.log(`${head} FINAL    ${m.text}${m.speechFinal ? "  (speech_final)" : ""}`);
  else console.log(`${head} ${m.type}${m.reason ? `  ${m.reason}` : ""}`);
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

  report(sentMs, sendElapsed);
} catch (e) {
  check("検証を最後まで実行できる", false, e instanceof Error ? e.message.split("\n")[0] : String(e));
} finally {
  server.kill();
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);

function report(sentMs, sendElapsed) {
  const errors = events.filter((e) => e.type === "stt_error");
  const partials = events.filter((e) => e.type === "partial");
  const finals = events.filter((e) => e.type === "final");

  // partial は同じ内容が何度も届く。2 度目以降は単語を話し終えてからの経過が伸びるだけなので、
  // その単語が初めて画面に出た瞬間だけを数える
  let maxEnd = -1;
  const firstAppearance = [];
  for (const e of partials) {
    if (e.endMs <= maxEnd) continue;
    maxEnd = e.endMs;
    firstAppearance.push(e.latencyMs);
  }

  // utterance_end は単語時刻を持たないので、直前の final の最終単語を基準にする
  const utteranceLatency = [];
  for (const e of events) {
    if (e.type !== "utterance_end") continue;
    const prev = finals.filter((f) => f.t <= e.t).at(-1);
    if (prev) utteranceLatency.push(e.t - prev.endMs);
  }

  console.log("\n--- 遅延（話し終えてから結果が届くまで）---");
  console.log(`partial の初出        ${summarize(firstAppearance)}`);
  console.log(`final の確定          ${summarize(finals.map((e) => e.latencyMs))}`);
  console.log(`utterance_end         ${summarize(utteranceLatency)}`);
  console.log(`送信ペースのずれ      ${(sendElapsed - sentMs).toFixed(1)}ms / ${(sentMs / 1000).toFixed(2)}s\n`);

  check("STT がエラーを返さない", errors.length === 0, errors[0]?.reason ?? "");
  check("partial が返る", partials.length > 0, `n=${partials.length}`);
  check("final が返る", finals.length > 0, `n=${finals.length}`);
  check("final の text が空でない", finals.every((e) => e.text?.trim()), `空 ${finals.filter((e) => !e.text?.trim()).length} 件`);
  check("partial が final より先に届く", partials[0] && finals[0] && partials[0].t < finals[0].t, `partial=${partials[0]?.t}ms final=${finals[0]?.t}ms`);
  check("発話の終端を speech_final で知らせる", finals.some((e) => e.speechFinal));
  // 送信が実時間から外れると、下の遅延はすべて送信側のずれを含んでしまう
  check("送信が実時間から 250ms 以上ずれない", Math.abs(sendElapsed - sentMs) < 250, `${(sendElapsed - sentMs).toFixed(1)}ms`);
  check("partial の初出 p95 が 1500ms 未満", p(firstAppearance, 0.95) < 1500, `${p(firstAppearance, 0.95)}ms`);
  check("final の確定 p95 が 2500ms 未満", p(finals.map((e) => e.latencyMs), 0.95) < 2500, `${p(finals.map((e) => e.latencyMs), 0.95)}ms`);
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
