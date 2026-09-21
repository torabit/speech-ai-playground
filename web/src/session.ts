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
);

export type SessionHandlers = {
  onReady: () => void;
  onFailed: (reason: string) => void;
  onFrame: (peak: number) => void;
  onMessage: (message: ServerMessage) => void;
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
  ws.onmessage = (e) => {
    if (typeof e.data !== "string") return;
    try {
      handlers.onMessage(JSON.parse(e.data) as ServerMessage);
    } catch {
      // 壊れた JSON は無視する。セッション自体は続ける
    }
  };
  ws.onclose = (e) => fail(`websocket closed (code ${e.code})`);

  return { stop };
}
