// TODO(Phase 0): サーバとの接続とマイクをひとまとまりのセッションとして扱う
//
// やること
// - `/audio` に WebSocket で接続する（Vite の proxy 経由で server の :8787 に届く）
// - マイクのフレームをバイナリで送る
// - 失敗を UI に伝える。対象は、接続できない、マイク許可が拒否された、途中で切断された、の 3 つ
// - ユーザーが止めたときの切断を失敗として扱わない
//
// 考えておくこと
// - 接続とマイク開始のどちらを先にするか。それはなぜか
// - マイク許可ダイアログを待っている間に Stop されたらどうなるか
//
// 下のシグネチャは一案。変えてよい

import { startMic, type Mic } from "./mic";

// サーバから届く JSON。音声はバイナリで送り、結果はテキストで返る
export type ServerMessage = { t: number; audioMs: number; lagMs: number } & (
  | { type: "partial"; text: string }
  | { type: "final"; text: string; speechFinal: boolean; startMs: number }
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
    stop().catch(console.error);
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
