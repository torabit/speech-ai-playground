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

export type SessionHandlers = {
  onReady: () => void;
  onFailed: (reason: string) => void;
  onFrame: (peak: number) => void;
};

export type Session = { stop: () => void };

export function startSession(handlers: SessionHandlers): Session {
  throw new Error("not implemented");
}
