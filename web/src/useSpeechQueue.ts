import { useRef, useState } from "react";

// 英語音声を話した順に鳴らす。<audio> を 1 つ使い回し、ended で次へ進める。
// Blob URL は鳴らし終えたら revoke する。放っておくとタブが掴んだままになる
export function useSpeechQueue() {
  const ref = useRef<HTMLAudioElement>(null);
  const queue = useRef<{ seq: number; url: string }[]>([]);
  const current = useRef<{ seq: number; url: string } | null>(null);
  const [playingSeq, setPlayingSeq] = useState<number | null>(null);

  const playNext = () => {
    const audio = ref.current;
    if (!audio || current.current) return;
    const next = queue.current.shift();
    if (!next) return;
    current.current = next;
    setPlayingSeq(next.seq);
    audio.src = next.url;
    // Start のクリックで得た sticky activation に乗るので、通常は許可される
    audio.play().catch((e: DOMException) => console.error("playback failed", e));
  };

  const finish = () => {
    if (current.current) URL.revokeObjectURL(current.current.url);
    current.current = null;
    setPlayingSeq(null);
    playNext();
  };

  return {
    ref,
    push: (seq: number, mp3: ArrayBuffer) => {
      queue.current.push({ seq, url: URL.createObjectURL(new Blob([mp3], { type: "audio/mpeg" })) });
      playNext();
    },
    playingSeq,
    onEnded: finish,
    reset: () => {
      // Stop で止めたのに英語が鳴り続けないよう、まず再生を止める
      ref.current?.pause();
      queue.current.forEach((q) => URL.revokeObjectURL(q.url));
      queue.current = [];
      finish();
    },
  };
}
