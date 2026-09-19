import { useRef, useState, type SyntheticEvent } from "react";

// セッション終了後に残る録音の再生。再生位置はセッションの状態とは別の関心事なので分ける
export function useRecordingPlayer() {
  const ref = useRef<HTMLAudioElement>(null);
  // 再生していないときは null
  const [playheadMs, setPlayheadMs] = useState<number | null>(null);

  const seek = (startMs: number) => {
    const audio = ref.current;
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

  return {
    ref,
    seek,
    playheadMs,
    onTimeUpdate: (e: SyntheticEvent<HTMLAudioElement>) => setPlayheadMs(e.currentTarget.currentTime * 1000),
    onStop: () => setPlayheadMs(null),
  };
}
