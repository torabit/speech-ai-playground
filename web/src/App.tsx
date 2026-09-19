import { useEffect, useReducer, useRef, useState } from "react";
import { startSession, type Session } from "./session";
import { Transcript, type Line } from "./Transcript";

// 接続の状態。録音があるかは idle のときだけ意味を持つので、その状態の中に持たせる
type State =
  | { status: "idle"; hasRecording: boolean }
  | { status: "connecting" }
  | { status: "ready" }
  | { status: "failed"; reason: string };

type Event =
  | { type: "start" }
  | { type: "ready" }
  | { type: "failed"; reason: string }
  | { type: "stopped" };

// ありえない遷移は現在の状態を返して無視する
function reducer(state: State, event: Event): State {
  switch (event.type) {
    case "start":
      return state.status === "idle" || state.status === "failed"
        ? { status: "connecting" }
        : state;
    case "ready":
      return state.status === "connecting" ? { status: "ready" } : state;
    case "failed":
      return state.status === "connecting" || state.status === "ready"
        ? { status: "failed", reason: event.reason }
        : state;
    case "stopped":
      // ready まで進んでいれば録音が残っている
      return { status: "idle", hasRecording: state.status === "ready" };
  }
}

type Meter = { frames: number; peak: number };
const EMPTY_METER: Meter = { frames: 0, peak: 0 };

export function App() {
  const [state, dispatch] = useReducer(reducer, {
    status: "idle",
    hasRecording: false,
  });
  const [meter, setMeter] = useState(EMPTY_METER);
  // 認識結果は接続の状態遷移とは別の軸なので、別に持つ
  const [lines, setLines] = useState<Line[]>([]);
  const [partial, setPartial] = useState("");
  const [speaking, setSpeaking] = useState(false);
  // STT だけが落ちた状態。音声の送信は続くので接続の状態は変えない
  const [sttError, setSttError] = useState<string | null>(null);
  const session = useRef<Session | null>(null);
  const player = useRef<HTMLAudioElement>(null);
  // 20ms ごとに setState すると画面全体が毎秒 50 回再描画される。
  // 溜めておいて 100ms ごとに反映する
  const pending = useRef({ frames: 0, peak: 0, lastFlush: 0 });

  // タブを閉じるときにマイクを掴んだままにしない
  useEffect(() => () => void session.current?.stop(), []);

  const start = () => {
    dispatch({ type: "start" });
    setMeter(EMPTY_METER);
    pending.current = { frames: 0, peak: 0, lastFlush: 0 };
    setLines([]);
    setPartial("");
    setSttError(null);
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
        setMeter({ frames: p.frames, peak: p.peak });
        p.peak = 0;
      },
      onMessage: (m) => {
        switch (m.type) {
          case "partial":
            return setPartial(m.text);
          case "final":
            // 確定したら部分結果を消して行に積む
            setPartial("");
            return setLines((prev) => [...prev, { text: m.text, lagMs: m.lagMs, startMs: m.startMs }]);
          case "speech_started":
            return setSpeaking(true);
          case "utterance_end":
            return setSpeaking(false);
          case "stt_error":
            return setSttError(m.reason);
        }
      },
    });
  };

  const seek = (startMs: number) => {
    const audio = player.current;
    if (!audio) return;
    audio.currentTime = startMs / 1000;
    void audio.play();
  };

  const stop = () => {
    void session.current?.stop();
    session.current = null;
    dispatch({ type: "stopped" });
  };

  const active = state.status === "connecting" || state.status === "ready";

  return (
    <main>
      <h1>Speech AI Playground</h1>

      <section className="row">
        <span className={`badge ${state.status}`} data-testid="status">
          {state.status}
        </span>
        {active ? (
          <button onClick={stop}>Stop</button>
        ) : (
          <button onClick={start}>Start</button>
        )}
        {/* Deepgram が発話中と判断している区間 */}
        <span className={`vad ${speaking ? "on" : ""}`} title="speech_started / utterance_end">
          {speaking ? "● speaking" : "○ silent"}
        </span>
      </section>

      {state.status === "failed" && <p className="error">{state.reason}</p>}
      {/* STT だけの失敗。録音は続くので接続の状態とは別に出す */}
      {sttError && <p className="warn">STT 停止: {sttError}</p>}

      <section>
        <div className="meter">
          <div
            className="meter-fill"
            style={{ width: `${Math.round(meter.peak * 100)}%` }}
          />
        </div>
        <dl>
          <dt>frames sent</dt>
          <dd data-testid="frames">{meter.frames}</dd>
          <dt>audio sent</dt>
          <dd>{(meter.frames * 0.02).toFixed(1)}s</dd>
        </dl>
      </section>

      <section>
        <h2>認識結果</h2>
        <Transcript
          lines={lines}
          partial={partial}
          onSeek={state.status === "idle" && state.hasRecording ? seek : undefined}
        />
      </section>

      {state.status === "idle" && state.hasRecording && (
        <section>
          <p>直近の録音。行をクリックするとその発話の頭から再生する</p>
          <audio
            ref={player}
            controls
            preload="metadata"
            src={`/api/recordings/latest?t=${Date.now()}`}
          />
        </section>
      )}
    </main>
  );
}
