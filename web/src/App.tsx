import { Transcript } from "./Transcript";
import { useRecordingPlayer } from "./useRecordingPlayer";
import { useSpeechQueue } from "./useSpeechQueue";
import { useSpeechSession } from "./useSpeechSession";

export function App() {
  const queue = useSpeechQueue();
  const { state, start, stop } = useSpeechSession(queue.push, queue.reset);
  const player = useRecordingPlayer();
  const { connection, meter } = state;

  const active = connection.status === "connecting" || connection.status === "ready";
  const recordingSrc = connection.status === "idle" ? connection.recordingSrc : null;

  return (
    <main>
      <h1>Speech AI Playground</h1>

      <section className="row">
        <span className={`badge ${connection.status}`} data-testid="status">
          {connection.status}
        </span>
        {active ? (
          <button
            onClick={() => {
              stop();
              queue.reset(); // 再生中の英語音声とキューを止める。放っておくと Stop 後も鳴り続ける
            }}
          >
            Stop
          </button>
        ) : (
          <button onClick={start}>Start</button>
        )}
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
          onSeek={recordingSrc ? player.seek : undefined}
          playheadMs={player.playheadMs}
          playingSeq={queue.playingSeq}
        />
      </section>

      {/* 英語音声の再生専用。画面には出さず、キューが順に src を差し替える */}
      <audio ref={queue.ref} onEnded={queue.onEnded} onError={queue.onError} hidden />

      {recordingSrc && (
        <section>
          <p>直近の録音。行をクリックするとその発話の頭から再生する</p>
          <audio
            ref={player.ref}
            controls
            preload="metadata"
            src={recordingSrc}
            onTimeUpdate={player.onTimeUpdate}
            onPause={player.onStop}
            onEnded={player.onStop}
          />
        </section>
      )}
    </main>
  );
}
