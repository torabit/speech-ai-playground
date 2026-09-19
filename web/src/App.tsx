// TODO(Phase 0): セッションの状態遷移と UI
//
// やること
// - 状態を設計する。最低限 idle / connecting / ready / failed を区別する
// - ありえない遷移をどう扱うか決める（例: Stop 後に遅れて届いた「接続完了」）
// - Start / Stop ボタン、状態表示、失敗理由、入力レベルメーター、送信フレーム数を表示する
// - Stop 後に直近の録音を再生できるようにする（GET /api/recordings/latest が wav を返す）
//
// 考えておくこと
// - 20ms ごとに変わる値（レベル、フレーム数）を状態遷移と同じ場所に持つべきか
//
// scripts/verify-phase0.mjs が以下を前提にしている
// - ボタンのテキストが "Start" / "Stop"
// - data-testid="status" の要素に状態名（idle / connecting / ready / failed）が入る
// - data-testid="frames" の要素に送信フレーム数が入る
// - class="error" の要素に失敗理由が入る
//
// index.css に .badge / .badge.<状態名> / .error / .meter / .meter-fill を用意してある

import { startMic } from "./mic";

// Step 3 の観察用。状態遷移を作るときに消す。
// コンポーネントの外に置くのは、再描画のたびに初期化されないようにするため
let count = 0;
let peakInWindow = 0;
let lastLogAt = performance.now();

export function App() {
  const getFrame = (_pcm: ArrayBuffer, peak: number) => {
    count++;
    peakInWindow = Math.max(peakInWindow, peak);

    const now = performance.now();
    if (now - lastLogAt >= 1000) {
      console.log(`${count} frames/sec, peak=${peakInWindow.toFixed(3)}`);
      count = 0;
      peakInWindow = 0;
      lastLogAt = now;
    }
  };

  const onClick = () => {
    startMic(getFrame);
  };
  return (
    <main>
      <h1>Speech AI Playground</h1>
      <button onClick={onClick}>call mice</button>
    </main>
  );
}
