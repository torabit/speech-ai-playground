import { useEffect, useReducer, useRef, useState } from "react";
import { startSession, type Session } from "./session";

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
  const session = useRef<Session | null>(null);

  // タブを閉じるときにマイクを掴んだままにしない
  useEffect(() => () => void session.current?.stop(), []);

  const start = () => {
    dispatch({ type: "start" });
    setMeter(EMPTY_METER);
    session.current = startSession({
      onReady: () => dispatch({ type: "ready" }),
      onFailed: (reason) => {
        session.current = null;
        dispatch({ type: "failed", reason });
      },
      onFrame: (peak) => setMeter((m) => ({ frames: m.frames + 1, peak })),
    });
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
      </section>

      {state.status === "failed" && <p className="error">{state.reason}</p>}

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

      {state.status === "idle" && state.hasRecording && (
        <section>
          <p>直近の録音（サーバが保存した wav）</p>
          <audio
            controls
            preload="none"
            src={`/api/recordings/latest?t=${Date.now()}`}
          />
        </section>
      )}
    </main>
  );
}
