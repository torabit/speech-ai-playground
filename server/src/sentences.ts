// STT の final を文に組み直す。
//
// Deepgram の final は文ではない。endpointing が無音で切った区間なので、
// 読点や語の途中で切れる。文の手がかりは punctuate が置く句点だけ。
// 句点で切り、句点が来ない発話（体言止め、言い直し）は無音の信号で打ち切る。

export type SentenceReason = "punctuation" | "silence" | "length";

export type Sentence = {
  seq: number;
  text: string;
  startMs: number;
  endMs: number;
  reason: SentenceReason;
};

export type Assembler = {
  pushFinal: (text: string, speechFinal: boolean, startMs: number, endMs: number) => void;
  pushUtteranceEnd: () => void;
  flush: () => void;
};

const ENDINGS = ["。", "？", "！"];

export function createAssembler(onSentence: (s: Sentence) => void, maxChars = 100): Assembler {
  let pending = "";
  // 溜め始めた断片の開始位置。文の startMs になる
  let pendingStartMs = 0;
  let lastEndMs = 0;
  let seq = 0;

  const emit = (text: string, reason: SentenceReason) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSentence({ seq: ++seq, text: trimmed, startMs: pendingStartMs, endMs: lastEndMs, reason });
  };

  // 句点までを 1 文として切り出す。残りは次の文として持つ
  const cutAtEndings = () => {
    for (;;) {
      const at = ENDINGS.map((e) => pending.indexOf(e)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
      if (at === undefined) return;
      const sentence = pending.slice(0, at + 1);
      pending = pending.slice(at + 1);
      emit(sentence, "punctuation");
      // 次の文は同じ断片の中から始まる。時刻は分けられないので断片の開始を使う
      pendingStartMs = lastEndMs;
    }
  };

  return {
    pushFinal: (text, speechFinal, startMs, endMs) => {
      if (text.trim()) {
        if (!pending) pendingStartMs = startMs;
        pending += text;
        lastEndMs = endMs;
        cutAtEndings();
        if (pending.length > maxChars) {
          emit(pending, "length");
          pending = "";
        }
      }
      if (speechFinal && pending) {
        emit(pending, "silence");
        pending = "";
      }
    },
    pushUtteranceEnd: () => {
      if (!pending) return;
      emit(pending, "silence");
      pending = "";
    },
    flush: () => {
      if (!pending) return;
      emit(pending, "silence");
      pending = "";
    },
  };
}
