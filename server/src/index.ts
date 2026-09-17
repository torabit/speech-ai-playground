import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { encodeWav } from "./wav.ts";

const PORT = Number(process.env.PORT ?? 8787);
const SAMPLE_RATE = 16000;
const RECORDINGS_DIR = join(import.meta.dirname, "../../recordings");

mkdirSync(RECORDINGS_DIR, { recursive: true });

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// 検証用: 直近の録音を返す。ブラウザでそのまま聞けるようにする
app.get("/api/recordings/latest", (c) => {
  const latest = readdirSync(RECORDINGS_DIR).filter((f) => f.endsWith(".wav")).sort().at(-1);
  if (!latest) return c.notFound();
  return c.body(readFileSync(join(RECORDINGS_DIR, latest)), 200, { "content-type": "audio/wav" });
});

app.get(
  "/audio",
  upgradeWebSocket(() => {
    const connectedAt = performance.now();
    const chunks: Buffer[] = [];
    const intervals: number[] = [];
    let lastArrival: number | undefined;

    return {
      // バイナリは ArrayBuffer、テキストは string で届く。
      // 接続直後にハンドラの準備が終わる前に届いたフレームは、まとめて後から渡されるので、
      // 先頭数フレームの到着間隔は実際より詰まって見えることがある
      onMessage: (event) => {
        if (typeof event.data === "string") return;
        const now = performance.now();
        if (lastArrival !== undefined) intervals.push(now - lastArrival);
        lastArrival = now;
        chunks.push(Buffer.from(event.data as ArrayBuffer));
      },
      onClose: (event) => {
        const pcm = Buffer.concat(chunks);
        const audioSec = pcm.length / 2 / SAMPLE_RATE;
        const wallSec = (performance.now() - connectedAt) / 1000;
        console.log(
          `[audio] closed code=${event.code} frames=${chunks.length} audio=${audioSec.toFixed(2)}s wall=${wallSec.toFixed(2)}s`,
        );
        console.log(`[audio] arrival interval ms ${summarize(intervals)}`);
        if (pcm.length === 0) return;

        const file = join(RECORDINGS_DIR, `${new Date().toISOString().replaceAll(":", "-")}.wav`);
        writeFileSync(file, encodeWav(pcm, SAMPLE_RATE));
        console.log(`[audio] saved ${file}`);
      },
    };
  }),
);

function summarize(values: number[]): string {
  if (values.length === 0) return "n/a";
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!.toFixed(1);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return `mean=${mean.toFixed(1)} min=${sorted[0]!.toFixed(1)} p5=${pick(0.05)} p50=${pick(0.5)} p95=${pick(0.95)} max=${pick(1)}`;
}

const server = serve({ fetch: app.fetch, port: PORT }, () => console.log(`[server] listening on :${PORT}`));
injectWebSocket(server);
