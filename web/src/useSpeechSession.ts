import { useEffect, useReducer, useRef } from "react";
import { startSession, type ServerMessage, type Session } from "./session";
import type { Line } from "./Transcript";

// 接続の状態。reason と recordingSrc はそれぞれの状態でしか意味を持たない
export type Connection =
  | { status: "idle"; recordingSrc: string | null }
  | { status: "connecting" }
  | { status: "ready" }
  | { status: "failed"; reason: string };

export type State = {
  connection: Connection;
  lines: Line[];
  partial: string;
  // Deepgram が発話中と判断している区間
  speaking: boolean;
  // STT だけが落ちた状態。音声の送信は続くので connection は変えない
  sttError: string | null;
  meter: { frames: number; peak: number };
};

type Action =
  | { type: "start" }
  | { type: "ready" }
  | { type: "failed"; reason: string }
  | { type: "stopped"; recordingSrc: string | null }
  | { type: "server"; message: ServerMessage }
  | { type: "meter"; frames: number; peak: number };

const INITIAL: State = {
  connection: { status: "idle", recordingSrc: null },
  lines: [],
  partial: "",
  speaking: false,
  sttError: null,
  meter: { frames: 0, peak: 0 },
};

// ありえない遷移は現在の状態を返して無視する。
// 例: Stop の後に遅れて届いた ready で、止めたはずのセッションが ready に戻らないようにする
function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "start":
      if (state.connection.status !== "idle" && state.connection.status !== "failed") return state;
      return { ...INITIAL, connection: { status: "connecting" } };
    case "ready":
      if (state.connection.status !== "connecting") return state;
      return { ...state, connection: { status: "ready" } };
    case "failed":
      if (state.connection.status !== "connecting" && state.connection.status !== "ready") return state;
      return { ...state, connection: { status: "failed", reason: action.reason } };
    case "stopped":
      return { ...state, connection: { status: "idle", recordingSrc: action.recordingSrc }, partial: "", speaking: false };
    case "server":
      return applyServerMessage(state, action.message);
    case "meter":
      return { ...state, meter: { frames: action.frames, peak: action.peak } };
  }
}

// 該当 seq の行だけを差し替える。sentence より前に translation 等が届くことはない（サーバは
// 文の確定を待ってから pipeline に投げる）ので、該当行が無いことはない想定だが、
// 万一無ければ何もしない（配列を素通りさせる）だけで安全に倒れる
function patch(lines: Line[], seq: number, fields: Partial<Line>): Line[] {
  return lines.map((l) => (l.seq === seq ? { ...l, ...fields } : l));
}

function applyServerMessage(state: State, m: ServerMessage): State {
  switch (m.type) {
    case "partial":
      return { ...state, partial: m.text };
    case "final":
      // 行は文単位（sentence）に積む。final は部分結果の表示にだけ使い、消すのは sentence に任せる
      return { ...state, partial: "" };
    case "speech_started":
      return { ...state, speaking: true };
    case "utterance_end":
      return { ...state, speaking: false };
    case "stt_error":
      return { ...state, sttError: m.reason };
    case "sentence":
      return {
        ...state,
        lines: [
          ...state.lines,
          { seq: m.seq, text: m.text, english: null, translateError: null, speakError: null, startMs: m.startMs, endMs: m.endMs, sttMs: m.latencyMs, translateMs: null, speakMs: null },
        ],
      };
    case "translation":
      return { ...state, lines: patch(state.lines, m.seq, { english: m.text, translateMs: m.translateMs }) };
    case "speech":
      return { ...state, lines: patch(state.lines, m.seq, { speakMs: m.speakMs }) };
    case "translate_error":
      return { ...state, lines: patch(state.lines, m.seq, { translateError: m.reason }) };
    case "speak_error":
      // 翻訳は届いている（else 分岐なら english も入っている）。合成だけの失敗として別に持つ
      return { ...state, lines: patch(state.lines, m.seq, { speakError: m.reason }) };
  }
}

// onSpeech: 英語音声（mp3）が届いたときの通知。再生キューへ渡すのは呼び出し側の責務にして、
// このフックは接続の状態管理に専念する。
// resetQueue: セッションの境界（開始時・失敗時）でキューを空にするためのコールバック。
// Stop ボタンからだけ呼ぶと、切断で failed に落ちた場合に前のセッションの mp3 がキューに
// 残り続け、次のセッションが seq=1 から再開したときに古い音声が新しい行で鳴ってしまう
export function useSpeechSession(onSpeech: (seq: number, mp3: ArrayBuffer) => void, resetQueue: () => void) {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const session = useRef<Session | null>(null);
  // 20ms ごとに dispatch すると画面全体が毎秒 50 回再描画される。溜めて 100ms ごとに反映する
  const pending = useRef({ frames: 0, peak: 0, lastFlush: 0 });

  // タブを閉じるときにマイクを掴んだままにしない。stop は reject しない
  useEffect(() => () => void session.current?.stop(), []);

  const start = () => {
    dispatch({ type: "start" });
    resetQueue();
    pending.current = { frames: 0, peak: 0, lastFlush: 0 };
    session.current = startSession({
      onReady: () => dispatch({ type: "ready" }),
      onFailed: (reason) => {
        session.current = null;
        resetQueue();
        dispatch({ type: "failed", reason });
      },
      onFrame: (peak) => {
        const p = pending.current;
        p.frames++;
        p.peak = Math.max(p.peak, peak);
        const now = performance.now();
        if (now - p.lastFlush < 100) return;
        p.lastFlush = now;
        dispatch({ type: "meter", frames: p.frames, peak: p.peak });
        p.peak = 0;
      },
      onMessage: (message) => dispatch({ type: "server", message }),
      onSpeech,
    });
  };

  const stop = () => {
    void session.current?.stop();
    session.current = null;
    // 録音があるのは ready まで進んだときだけ。
    // URL は毎レンダー作ると音声要素が読み込み直されるので、ここで 1 度だけ決める
    const recordingSrc =
      state.connection.status === "ready" ? `/api/recordings/latest?t=${Date.now()}` : null;
    dispatch({ type: "stopped", recordingSrc });
  };

  return { state, start, stop };
}
