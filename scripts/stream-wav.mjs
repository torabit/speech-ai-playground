// 録音済みの wav を実時間でサーバへ流し、サーバが返す JSON を表示する。
// マイクを使わずに STT の挙動と遅延を確かめるための道具。
//
// 実行: node scripts/stream-wav.mjs recordings/<file>.wav

import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) throw new Error("usage: node scripts/stream-wav.mjs <wav>");

const buf = readFileSync(file);
const pcm = Buffer.from(buf.buffer, buf.byteOffset + 44, buf.length - 44);
const FRAME = 640; // 20ms @16kHz, 16bit
const started = performance.now();

const ws = new WebSocket("ws://localhost:8787/audio");
ws.binaryType = "arraybuffer";
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  const head = `${String(Math.round(performance.now() - started)).padStart(5)}ms audio=${String(m.audioMs).padStart(5)}ms lag=${String(m.lagMs).padStart(4)}ms`;
  if (m.type === "partial") console.log(`${head} partial  ${m.text}`);
  else if (m.type === "final") console.log(`${head} FINAL    ${m.text}${m.speechFinal ? "  (speech_final)" : ""}`);
  else console.log(`${head} ${m.type}${m.reason ? `  ${m.reason}` : ""}`);
});

await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });

for (let i = 0; i + FRAME <= pcm.length; i += FRAME) {
  ws.send(pcm.subarray(i, i + FRAME));
  await new Promise((r) => setTimeout(r, 20));
}
console.log(`--- 音声を送り終えた (${(pcm.length / 2 / 16000).toFixed(2)}s) ---`);
await new Promise((r) => setTimeout(r, 3000)); // 残りの結果を待つ
ws.close(1000);
