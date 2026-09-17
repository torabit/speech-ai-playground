import { createServer } from "node:http";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { encodeWav } from "./wav.ts";

const PORT = Number(process.env.PORT ?? 8787);
const SAMPLE_RATE = 16000;
const RECORDINGS_DIR = join(import.meta.dirname, "../../recordings");

mkdirSync(RECORDINGS_DIR, { recursive: true });

// 検証用: 直近の録音を返す。ブラウザでそのまま聞けるようにする
const server = createServer((req, res) => {
  if (req.url?.startsWith("/api/recordings/latest")) {
    const latest = readdirSync(RECORDINGS_DIR).filter((f) => f.endsWith(".wav")).sort().at(-1);
    if (!latest) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "audio/wav" }).end(readFileSync(join(RECORDINGS_DIR, latest)));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server, path: "/audio" });

wss.on("connection", (ws) => {
  const connectedAt = performance.now();
  const chunks: Buffer[] = [];
  const intervals: number[] = [];
  let lastArrival: number | undefined;

  ws.on("message", (data, isBinary) => {
    if (!isBinary) return;
    const now = performance.now();
    if (lastArrival !== undefined) intervals.push(now - lastArrival);
    lastArrival = now;
    chunks.push(data as Buffer);
  });

  ws.on("close", (code) => {
    const pcm = Buffer.concat(chunks);
    const audioSec = pcm.length / 2 / SAMPLE_RATE;
    const wallSec = (performance.now() - connectedAt) / 1000;
    console.log(
      `[audio] closed code=${code} frames=${chunks.length} audio=${audioSec.toFixed(2)}s wall=${wallSec.toFixed(2)}s`,
    );
    console.log(`[audio] arrival interval ms ${summarize(intervals)}`);
    if (pcm.length === 0) return;

    const file = join(RECORDINGS_DIR, `${new Date().toISOString().replaceAll(":", "-")}.wav`);
    writeFileSync(file, encodeWav(pcm, SAMPLE_RATE));
    console.log(`[audio] saved ${file}`);
  });
});

function summarize(values: number[]): string {
  if (values.length === 0) return "n/a";
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!.toFixed(1);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return `mean=${mean.toFixed(1)} min=${sorted[0]!.toFixed(1)} p5=${pick(0.05)} p50=${pick(0.5)} p95=${pick(0.95)} max=${pick(1)}`;
}

server.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
