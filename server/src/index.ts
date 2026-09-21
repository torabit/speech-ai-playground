import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { encodeWav } from "./wav.ts";
import { connectStt, type SttConnection } from "./deepgram.ts";
import { createAssembler, type Assembler } from "./sentences.ts";
import { translate } from "./translate.ts";
import { speak } from "./speak.ts";
import { createPipeline } from "./pipeline.ts";

// server/.env を読む。無くても起動はする（Phase 0 の録音だけなら鍵は要らない）
try {
  process.loadEnvFile(join(import.meta.dirname, "../.env"));
} catch {
  console.warn("[server] server/.env が読めなかった。STT は無効になる");
}

const PORT = Number(process.env.PORT ?? 8787);
const SAMPLE_RATE = 16000;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash-lite";
const DEEPGRAM_TTS_MODEL = process.env.DEEPGRAM_TTS_MODEL ?? "aura-2-thalia-en";
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
    // pipeline とセットで接続ごとに作る。seq はどちらも 1 始まりなので、
    // 接続間で使い回すと 2 本目の接続が最初の seq を待ち続けて詰まる
    let assembler: Assembler | undefined;
    let forwardedBytes = 0;
    // 遅延の原点。接続時刻ではなく最初のフレームが届いた時刻にする。
    // マイクの起動はブラウザ側で接続の後に走るので、connectedAt を原点にすると
    // その待ち時間（許可ダイアログを含む）がすべての遅延に乗ってしまう
    let firstFrameAt: number | undefined;

    // ブラウザへは JSON のテキストで返す。音声はバイナリ、結果はテキストで方向が分かれる
    const toBrowser = (ws: { send: (data: string) => void }, message: Record<string, unknown>) => {
      const t = Math.round(performance.now() - (firstFrameAt ?? connectedAt));
      const audioMs = Math.round(forwardedBytes / 2 / (SAMPLE_RATE / 1000));
      // lag は「送った音声の長さ」と「いまの時刻」の差。送信が実時間から遅れていないか。
      // 認識の遅れではない。音声の転送が滞っているかを見る値
      const lagMs = t - audioMs;
      // latency は「その単語を話し終えてから結果が届くまで」。認識の遅れはこちらで測る
      const endMs = message["endMs"];
      const latency = typeof endMs === "number" ? { latencyMs: t - endMs } : {};
      ws.send(JSON.stringify({ ...message, t, audioMs, lagMs, ...latency }));
    };

    return {
      onOpen: (_event, ws) => {
        console.log(`${new Date().toISOString().slice(11,23)} [audio ${id}] open (concurrent=${++openConnections})`);
        if (!DEEPGRAM_API_KEY) {
          toBrowser(ws, { type: "stt_error", reason: "DEEPGRAM_API_KEY が設定されていない" });
          return;
        }

        const pipeline = createPipeline({
          translate: (japanese, context) =>
            translate(GEMINI_API_KEY!, GEMINI_MODEL, japanese, context),
          speak: (english) => speak(DEEPGRAM_API_KEY!, DEEPGRAM_TTS_MODEL, english),
          // pipeline は自分の drain の中からこれを呼ぶ。ここで投げると drain が止まり、
          // この文以降の seq が全部失われたまま二度と進まなくなる（pipeline.ts 参照）。
          // ws は接続が切れた後でも呼ばれ得るので、送信の失敗はここで握りつぶす
          onEvent: (event) => {
            try {
              if (event.type !== "speech") return toBrowser(ws, { ...event });
              // JSON を先に送り、直後のバイナリがその mp3 だという契約にする
              toBrowser(ws, { type: "speech", seq: event.seq, bytes: event.mp3.byteLength, speakMs: event.speakMs, queuedMs: event.queuedMs });
              // mp3 の型は Uint8Array<ArrayBufferLike>（speak.ts の宣言）だが、
              // 中身は fetch の arrayBuffer() 由来で常に ArrayBuffer。ws.send の型が
              // 求める Uint8Array<ArrayBuffer> と実体は一致するので、コピーせずキャストする
              ws.send(event.mp3 as Uint8Array<ArrayBuffer>);
            } catch (e) {
              console.error(`[pipeline] onEvent 送信失敗: ${e instanceof Error ? e.message : String(e)}`);
            }
          },
        });

        assembler = createAssembler((sentence) => {
          toBrowser(ws, { type: "sentence", ...sentence });
          // 鍵が無ければ pipeline に投げても必ず失敗するだけなので、ここで打ち切る
          if (!GEMINI_API_KEY) return toBrowser(ws, { type: "translate_error", seq: sentence.seq, reason: "GEMINI_API_KEY が設定されていない" });
          pipeline.submit(sentence);
        });

        stt = connectStt(DEEPGRAM_API_KEY, {
          onPartial: (text, startMs, endMs) => toBrowser(ws, { type: "partial", text, startMs, endMs }),
          onFinal: (text, speechFinal, startMs, endMs) => {
            toBrowser(ws, { type: "final", text, speechFinal, startMs, endMs });
            assembler?.pushFinal(text, speechFinal, startMs, endMs);
          },
          onSpeechStarted: () => toBrowser(ws, { type: "speech_started" }),
          onUtteranceEnd: () => {
            toBrowser(ws, { type: "utterance_end" });
            assembler?.pushUtteranceEnd();
          },
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
        firstFrameAt ??= now;
        if (lastArrival !== undefined) intervals.push(now - lastArrival);
        lastArrival = now;
        const pcm = event.data as ArrayBuffer;
        chunks.push(Buffer.from(pcm));
        forwardedBytes += pcm.byteLength;
        stt?.send(pcm);
      },
      onClose: (event) => {
        openConnections--;
        // 切断時点で文が溜まったまま止まっていることがある。stt を閉じる前に吐かせる
        assembler?.flush();
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
