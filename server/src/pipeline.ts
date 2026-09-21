// 文ごとに翻訳と合成を回し、連番順にイベントを出す。
//
// 文をまたいで並行に走らせる。直列にすると、後の文の翻訳時間に前の文の合成時間が
// 混ざって段ごとの数字が読めなくなる。順序を待った時間は queuedMs として別に出す。
// 失敗した文も seq の位置を占め、通過したら次へ進む。1 文の失敗で後続を止めない。

import type { Sentence } from "./sentences.ts";
import type { TranslationContext } from "./translate.ts";

export type PipelineEvent =
  | { type: "translation"; seq: number; text: string; translateMs: number }
  | { type: "speech"; seq: number; mp3: Uint8Array; speakMs: number; queuedMs: number }
  | { type: "translate_error"; seq: number; reason: string }
  | { type: "speak_error"; seq: number; reason: string };

export type PipelineDeps = {
  translate: (japanese: string, context?: TranslationContext) => Promise<string>;
  speak: (english: string) => Promise<Uint8Array>;
  onEvent: (event: PipelineEvent) => void;
  now?: () => number;
};

export function createPipeline({ translate, speak, onEvent, now = () => performance.now() }: PipelineDeps) {
  // seq ごとの結果と、揃った時刻。揃った順ではなく seq 順に取り出す
  const done = new Map<number, { events: PipelineEvent[]; readyAt: number }>();
  let nextToSend = 1;
  // 直前に送り終えた文。次の文の文脈に渡す
  let context: TranslationContext | undefined;

  const drain = () => {
    for (;;) {
      const entry = done.get(nextToSend);
      if (!entry) return;
      done.delete(nextToSend);
      nextToSend++;
      // 自分の処理が終わってから順番が来るまで待った時間。送る時点で決まる
      const queuedMs = Math.round(now() - entry.readyAt);
      for (const event of entry.events) onEvent(event.type === "speech" ? { ...event, queuedMs } : event);
    }
  };

  const run = async (sentence: Sentence) => {
    const events: PipelineEvent[] = [];
    const startedAt = now();
    let english: string | undefined;
    try {
      // 文脈は投入時点で直前の文の訳が出ていれば使う。待たない
      english = await translate(sentence.text, context);
      events.push({ type: "translation", seq: sentence.seq, text: english, translateMs: Math.round(now() - startedAt) });
    } catch (e) {
      events.push({ type: "translate_error", seq: sentence.seq, reason: reasonOf(e) });
    }

    if (english !== undefined) {
      const spokenAt = now();
      try {
        const mp3 = await speak(english);
        const readyAt = now();
        // queuedMs は送る時点で drain が入れ直す
        events.push({ type: "speech", seq: sentence.seq, mp3, speakMs: Math.round(readyAt - spokenAt), queuedMs: 0 });
      } catch (e) {
        events.push({ type: "speak_error", seq: sentence.seq, reason: reasonOf(e) });
      }
      context = { japanese: sentence.text, english };
    }

    done.set(sentence.seq, { events, readyAt: now() });
    drain();
  };

  return {
    submit: (sentence: Sentence) => {
      // 失敗は run の中で拾うので、ここで待たない
      void run(sentence);
    },
  };
}

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
