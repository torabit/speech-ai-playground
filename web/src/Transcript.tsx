import { useEffect, useRef } from "react";

export type Line = { text: string; lagMs: number; startMs: number; endMs: number };

type Props = {
  lines: Line[];
  partial: string;
  // 録音があるときだけ行をクリックできる。録音はセッション終了後にサーバが書き出す
  onSeek?: (startMs: number) => void;
  // 再生位置（ms）。再生していないときは null
  playheadMs?: number | null;
};

// 再生位置がどの行に当たるか。行の範囲は次の行が始まるまで
function activeIndexAt(lines: Line[], playheadMs: number | null | undefined): number {
  if (playheadMs == null) return -1;
  return lines.findLastIndex((line) => line.startMs <= playheadMs);
}

export function Transcript({ lines, partial, onSeek, playheadMs }: Props) {
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
          key={i}
          ref={i === activeIndex ? active : undefined}
          className={`line ${onSeek ? "seekable" : ""} ${i === activeIndex ? "active" : ""}`}
          onClick={onSeek ? () => onSeek(line.startMs) : undefined}
          title={onSeek ? `${(line.startMs / 1000).toFixed(1)}s から再生` : "録音は停止後に再生できる"}
        >
          <span className="text">{line.text}</span>
          <span className="lag">{line.lagMs}ms</span>
        </div>
      ))}
      {/* 確定前。まだ書き換わることを色で示す */}
      {partial && <div className="line partial">{partial}</div>}
      <div ref={bottom} />
    </div>
  );
}
