import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { encodeWav } from "./wav.ts";
import { connectStt, type SttConnection } from "./deepgram.ts";

// server/.env を読む。無くても起動はする（Phase 0 の録音だけなら鍵は要らない）
try {
  process.loadEnvFile(join(import.meta.dirname, "../.env"));
} catch {
  console.warn("[server] server/.env が読めなかった。STT は無効になる");
}

const PORT = Number(process.env.PORT ?? 8787);
const SAMPLE_RATE = 16000;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const RECORDINGS_DIR = join(import.meta.dirname, "../../recordings");

mkdirSync(RECORDINGS_DIR, { recursive: true });

let connectionSeq = 0;
let openConnections = 0;

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// 検証用: 直近の録音を返す。ブラウザでそのまま聞けるようにする
app.get("/api/recordings/latest", (c) => {
  const latest = readdirSync(RECORDINGS_DIR).filter((f) => f.endsWith(".wav")).sort().at(-1);
  if (!latest) return c.notFound();
  const wav = readFileSync(join(RECORDINGS_DIR, latest));

  // Range に応えないと、ブラウザは途中位置へシークできず先頭から再生する
  const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
  if (!range) {
    return c.body(wav, 200, {
      "content-type": "audio/wav",
      "accept-ranges": "bytes",
      "content-length": String(wav.length),
    });
  }

  const start = range[1] ? Number(range[1]) : 0;
  const end = range[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
  if (start >= wav.length || start > end) {
    return c.body(null, 416, { "content-range": `bytes */${wav.length}` });
  }
  return c.body(wav.subarray(start, end + 1), 206, {
    "content-type": "audio/wav",
    "accept-ranges": "bytes",
    "content-range": `bytes ${start}-${end}/${wav.length}`,
    "content-length": String(end - start + 1),
  });
});

app.get(
  "/audio",
  upgradeWebSocket(() => {
    const id = (++connectionSeq).toString().padStart(3, "0");
    const connectedAt = performance.now();
    const chunks: Buffer[] = [];
    const intervals: number[] = [];
    let lastArrival: number | undefined;
    let stt: SttConnection | undefined;
    let forwardedBytes = 0;

    // ブラウザへは JSON のテキストで返す。音声はバイナリ、結果はテキストで方向が分かれる
    const toBrowser = (ws: { send: (data: string) => void }, message: Record<string, unknown>) => {
      const t = Math.round(performance.now() - connectedAt);
      const audioMs = Math.round(forwardedBytes / 2 / (SAMPLE_RATE / 1000));
      // lag は「送った音声の長さ」と「いまの時刻」の差。転送と認識がどれだけ遅れているか
      ws.send(JSON.stringify({ ...message, t, audioMs, lagMs: t - audioMs }));
    };

    return {
      onOpen: (_event, ws) => {
        console.log(`${new Date().toISOString().slice(11,23)} [audio ${id}] open (concurrent=${++openConnections})`);
        if (!DEEPGRAM_API_KEY) {
          toBrowser(ws, { type: "stt_error", reason: "DEEPGRAM_API_KEY が設定されていない" });
          return;
        }
        stt = connectStt(DEEPGRAM_API_KEY, {
          onPartial: (text) => toBrowser(ws, { type: "partial", text }),
          onFinal: (text, speechFinal, startMs, endMs) =>
            toBrowser(ws, { type: "final", text, speechFinal, startMs, endMs }),
          onSpeechStarted: () => toBrowser(ws, { type: "speech_started" }),
          onUtteranceEnd: () => toBrowser(ws, { type: "utterance_end" }),
          onError: (reason) => {
            console.error(`[stt] ${reason}`);
            toBrowser(ws, { type: "stt_error", reason });
          },
        });
      },
      // バイナリは ArrayBuffer、テキストは string で届く。
      // 接続直後にハンドラの準備が終わる前に届いたフレームは、まとめて後から渡されるので、
      // 先頭数フレームの到着間隔は実際より詰まって見えることがある
      onMessage: (event) => {
        if (typeof event.data === "string") return;
        const now = performance.now();
        if (lastArrival !== undefined) intervals.push(now - lastArrival);
        lastArrival = now;
        const pcm = event.data as ArrayBuffer;
        chunks.push(Buffer.from(pcm));
        forwardedBytes += pcm.byteLength;
        stt?.send(pcm);
      },
      onClose: (event) => {
        openConnections--;
        stt?.close();
        const pcm = Buffer.concat(chunks);
        const audioSec = pcm.length / 2 / SAMPLE_RATE;
        const wallSec = (performance.now() - connectedAt) / 1000;
        console.log(
          `${new Date().toISOString().slice(11, 23)} [audio ${id}] closed code=${event.code} frames=${chunks.length} audio=${audioSec.toFixed(2)}s wall=${wallSec.toFixed(2)}s`,
        );
        console.log(`[audio ${id}] arrival interval ms ${summarize(intervals)}`);
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
