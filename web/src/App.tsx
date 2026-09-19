import { useRef } from "react";
import { Transcript } from "./Transcript";
import { useSpeechSession } from "./useSpeechSession";

export function App() {
  const { state, start, stop, setPlayhead } = useSpeechSession();
  const player = useRef<HTMLAudioElement>(null);
  const { connection, meter } = state;

  const seek = (startMs: number) => {
    const audio = player.current;
    if (!audio) return;
    const jump = () => {
      // 単語の開始ちょうどだと頭が欠けて聞こえるので、少し手前から再生する
      audio.currentTime = Math.max(0, startMs - 300) / 1000;
      void audio.play();
    };
    // メタデータが未読込だと currentTime の代入が無視される
    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) jump();
    else audio.addEventListener("loadedmetadata", jump, { once: true });
  };

  const active = connection.status === "connecting" || connection.status === "ready";
  const recordingSrc = connection.status === "idle" ? connection.recordingSrc : null;

  return (
    <main>
      <h1>Speech AI Playground</h1>

      <section className="row">
        <span className={`badge ${connection.status}`} data-testid="status">
          {connection.status}
        </span>
        {active ? <button onClick={stop}>Stop</button> : <button onClick={start}>Start</button>}
        {/* Deepgram が発話中と判断している区間 */}
        <span className={`vad ${state.speaking ? "on" : ""}`} title="speech_started / utterance_end">
          {state.speaking ? "● speaking" : "○ silent"}
        </span>
      </section>

      {connection.status === "failed" && <p className="error">{connection.reason}</p>}
      {/* STT だけの失敗。録音は続くので接続の状態とは別に出す */}
      {state.sttError && <p className="warn">STT 停止: {state.sttError}</p>}

      <section>
        <div className="meter">
          <div className="meter-fill" style={{ width: `${Math.round(meter.peak * 100)}%` }} />
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
          lines={state.lines}
          partial={state.partial}
          onSeek={recordingSrc ? seek : undefined}
          playheadMs={state.playheadMs}
        />
      </section>

      {recordingSrc && (
        <section>
          <p>直近の録音。行をクリックするとその発話の頭から再生する</p>
          <audio
            ref={player}
            controls
            preload="metadata"
            src={recordingSrc}
            onTimeUpdate={(e) => setPlayhead(e.currentTarget.currentTime * 1000)}
            onPause={() => setPlayhead(null)}
            onEnded={() => setPlayhead(null)}
          />
        </section>
      )}
    </main>
  );
}
