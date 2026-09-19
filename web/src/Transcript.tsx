import { useEffect, useRef } from "react";

export type Line = { text: string; lagMs: number; startMs: number };

type Props = {
  lines: Line[];
  partial: string;
  // 録音があるときだけ行をクリックできる。録音はセッション終了後にサーバが書き出す
  onSeek?: (startMs: number) => void;
};

export function Transcript({ lines, partial, onSeek }: Props) {
  const bottom = useRef<HTMLDivElement>(null);

  // 新しい行が増えたら最下部へ追従する
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [lines.length, partial]);

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
          className={`line ${onSeek ? "seekable" : ""}`}
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
