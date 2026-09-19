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

function applyServerMessage(state: State, m: ServerMessage): State {
  switch (m.type) {
    case "partial":
      return { ...state, partial: m.text };
    case "final":
      // 確定したら部分結果を消して行に積む
      return {
        ...state,
        partial: "",
        lines: [...state.lines, { text: m.text, lagMs: m.lagMs, startMs: m.startMs, endMs: m.endMs }],
      };
    case "speech_started":
      return { ...state, speaking: true };
    case "utterance_end":
      return { ...state, speaking: false };
    case "stt_error":
      return { ...state, sttError: m.reason };
  }
}

export function useSpeechSession() {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const session = useRef<Session | null>(null);
  // 20ms ごとに dispatch すると画面全体が毎秒 50 回再描画される。溜めて 100ms ごとに反映する
  const pending = useRef({ frames: 0, peak: 0, lastFlush: 0 });

  // タブを閉じるときにマイクを掴んだままにしない
  useEffect(() => () => void session.current?.stop(), []);

  const start = () => {
    dispatch({ type: "start" });
    pending.current = { frames: 0, peak: 0, lastFlush: 0 };
    session.current = startSession({
      onReady: () => dispatch({ type: "ready" }),
      onFailed: (reason) => {
        session.current = null;
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
