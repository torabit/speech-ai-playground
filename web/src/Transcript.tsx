import { useEffect, useRef } from "react";

// 行は文単位（sentence の seq）。翻訳と音声合成は非同期に届くので、null のまま表示することがある
export type Line = {
  seq: number;
  text: string;
  english: string | null;
  error: string | null;
  startMs: number;
  endMs: number;
  translateMs: number | null;
  speakMs: number | null;
};

type Props = {
  lines: Line[];
  partial: string;
  // 録音があるときだけ行をクリックできる。録音はセッション終了後にサーバが書き出す
  onSeek?: (startMs: number) => void;
  // 再生位置（ms）。再生していないときは null
  playheadMs?: number | null;
  // 英語音声を再生中の行の seq。再生していないときは null
  playingSeq?: number | null;
};

// 再生位置がどの行に当たるか。行の範囲は次の行が始まるまで
function activeIndexAt(lines: Line[], playheadMs: number | null | undefined): number {
  if (playheadMs == null) return -1;
  return lines.findLastIndex((line) => line.startMs <= playheadMs);
}

export function Transcript({ lines, partial, onSeek, playheadMs, playingSeq }: Props) {
  const bottom = useRef<HTMLDivElement>(null);
  const active = useRef<HTMLDivElement>(null);
  const activeIndex = activeIndexAt(lines, playheadMs);

  // 録音中は最新の行へ、再生中は再生位置の行へ追従する
  useEffect(() => {
    if (activeIndex >= 0) active.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    else bottom.current?.scrollIntoView({ block: "end" });
  }, [lines.length, partial, activeIndex]);

  if (lines.length === 0 && !partial) {
    return (
      <div className="transcript empty">
        <p>話すとここに認識結果が出る</p>
      </div>
    );
  }

  return (
    <div className="transcript">
      {lines.map((line, i) => (
        <div
          key={line.seq}
          ref={i === activeIndex ? active : undefined}
          // active: 録音の再生位置がこの行にある。speaking: この行の英語音声を再生中。
          // 由来が異なるので同時に立つこともある（二重再生ではなく、単に見比べているだけ）
          className={`line ${onSeek ? "seekable" : ""} ${i === activeIndex ? "active" : ""} ${playingSeq === line.seq ? "speaking" : ""}`}
          onClick={onSeek ? () => onSeek(line.startMs) : undefined}
          title={onSeek ? `${(line.startMs / 1000).toFixed(1)}s から再生` : "録音は停止後に再生できる"}
        >
          <span className="text">{line.text}</span>
          {/* 翻訳・合成が届くまでは "…"。失敗したら理由を出す */}
          <span className="english">
            {line.error ? `翻訳失敗: ${line.error}` : (line.english ?? "…")}
            {(line.translateMs !== null || line.speakMs !== null) && (
              <span className="lag" title="翻訳・音声合成にかかった時間">
                {[line.translateMs, line.speakMs].filter((v): v is number => v !== null).map((v) => `${v}ms`).join(" / ")}
              </span>
            )}
          </span>
        </div>
      ))}
      {/* 確定前。まだ書き換わることを色で示す */}
      {partial && <div className="line partial">{partial}</div>}
      <div ref={bottom} />
    </div>
  );
}
