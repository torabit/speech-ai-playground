// サーバとの接続とマイクを、ひとまとまりのセッションとして扱う。
// 接続を先に開き、開いてからマイクを取る。マイクの許可を待つ間に届く音声を捨てないため

import { startMic, type Mic } from "./mic";

// サーバから届く JSON。音声はバイナリで送り、結果はテキストで返る。
// t は最初のフレームが届いてからの経過、audioMs は送った音声の長さ。
// lagMs = t - audioMs で、送信が実時間から遅れていないかを見る。認識の遅れではない
export type ServerMessage = { t: number; audioMs: number; lagMs: number } & (
  // startMs と endMs はその結果が対応する音声の位置。
  // latencyMs = t - endMs で、最後の単語を話し終えてから結果が届くまでの遅れ
  | { type: "partial"; text: string; startMs: number; endMs: number; latencyMs: number }
  | { type: "final"; text: string; speechFinal: boolean; startMs: number; endMs: number; latencyMs: number }
  | { type: "speech_started" }
  | { type: "utterance_end" }
  | { type: "stt_error"; reason: string }
  // latencyMs は endMs を持つメッセージなら toBrowser が必ず付ける（server/src/index.ts）。
  // 文が確定してから届くまでの STT 側の遅れで、翻訳・合成とは別の段として画面に出す
  | { type: "sentence"; seq: number; text: string; startMs: number; endMs: number; reason: "punctuation" | "silence" | "length"; latencyMs: number }
  | { type: "translation"; seq: number; text: string; translateMs: number }
  | { type: "speech"; seq: number; bytes: number; speakMs: number; queuedMs: number }
  | { type: "translate_error"; seq: number; reason: string }
  | { type: "speak_error"; seq: number; reason: string }
);

export type SessionHandlers = {
  onReady: () => void;
  onFailed: (reason: string) => void;
  onFrame: (peak: number) => void;
  onMessage: (message: ServerMessage) => void;
  onSpeech: (seq: number, mp3: ArrayBuffer) => void;
};

export type Session = { stop: () => Promise<void> };

export function startSession(handlers: SessionHandlers): Session {
  const ws = new WebSocket("/audio");
  let mic: Mic | undefined;
  let stopped = false;

  const micCallback = (pcm: ArrayBuffer, peak: number) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(pcm);
    handlers.onFrame(peak);
  };

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    const started = mic;
    mic = undefined;
    if (started) await started.stop();
    if (
      ws.readyState === WebSocket.CONNECTING ||
      ws.readyState === WebSocket.OPEN
    )
      ws.close(1000);
  };

  const fail = (reason: string) => {
    if (stopped) return;
    void stop(); // stop は reject しない
    handlers.onFailed(reason);
  };

  ws.onopen = async () => {
    try {
      const started = await startMic(micCallback);
      if (stopped) {
        await started.stop();
        return;
      }
      mic = started;
      handlers.onReady();
    } catch (error) {
      fail(
        `microphone: ${error instanceof Error ? error.name : String(error)}`,
      );
    }
  };
  ws.binaryType = "arraybuffer";
  // speech の JSON とその直後のバイナリ（mp3）は対で届く契約（server/src/index.ts 参照）。
  // JSON で seq を覚えておき、次のバイナリフレームをその seq の mp3 として渡す
  let awaitingSpeech: number | null = null;
  ws.onmessage = (e) => {
    // Stop 後に届くメッセージは、もう存在しないセッションのもの。サーバは切断時に溜まっている
    // 文を flush するので、Stop 直後にもう 1 通ぐらい届くことがある。ハンドラを一切呼ばず捨てる
    if (stopped) return;
    if (typeof e.data !== "string") {
      if (awaitingSpeech === null) return; // 説明のない音声は捨てる
      handlers.onSpeech(awaitingSpeech, e.data as ArrayBuffer);
      awaitingSpeech = null;
      return;
    }
    try {
      const message = JSON.parse(e.data) as ServerMessage;
      if (message.type === "speech") awaitingSpeech = message.seq;
      handlers.onMessage(message);
    } catch {
      // 壊れた JSON は無視する。セッション自体は続ける
    }
  };
  ws.onclose = (e) => fail(`websocket closed (code ${e.code})`);

  return { stop };
}
