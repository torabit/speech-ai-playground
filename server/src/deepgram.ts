// Deepgram のストリーミング STT に繋ぐ。
// 認証はサブプロトコル（["token", <key>]）で行う。Node の WebSocket はヘッダを足せないため。
//
// パラメータの意味
// - interim_results: 確定前の途中経過も返す。Realtime UI の本題
// - endpointing: 無音が続いたら発話の区切りとみなす時間（ms）。短いほど速いが切れやすい
// - utterance_end_ms: 区切りの判定をもう一段遅らせて UtteranceEnd を送る
// - vad_events: 発話の開始を SpeechStarted として通知する

export type SttEvents = {
  // interim にも単語時刻が入るので、確定前の結果でも遅延を測れる
  onPartial: (text: string, startMs: number, endMs: number) => void;
  // start と end はストリーム開始からの位置（ms）。Deepgram が結果ごとに返す
  onFinal: (text: string, speechFinal: boolean, startMs: number, endMs: number) => void;
  onSpeechStarted: () => void;
  onUtteranceEnd: () => void;
  onError: (reason: string) => void;
};

export type SttConnection = {
  send: (pcm: ArrayBuffer) => void;
  close: () => void;
};

export function connectStt(apiKey: string, events: SttEvents): SttConnection {
  // .env の読み込みより後に評価されるよう、関数の中で読む
  const url = new URL("wss://api.deepgram.com/v1/listen");
  url.search = new URLSearchParams({
    model: process.env.DEEPGRAM_MODEL ?? "nova-3",
    language: process.env.DEEPGRAM_LANGUAGE ?? "ja",
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    interim_results: "true",
    punctuate: "true",
    vad_events: "true",
    endpointing: "300",
    utterance_end_ms: "1000",
  }).toString();

  const ws = new WebSocket(url, ["token", apiKey]);
  // 接続が開く前に届いた音声を捨てない。開いたらまとめて送る
  const pending: ArrayBuffer[] = [];
  let closed = false;

  ws.addEventListener("open", () => {
    for (const pcm of pending) ws.send(pcm);
    pending.length = 0;
  });

  ws.addEventListener("message", (e) => {
    if (typeof e.data !== "string") return;
    let msg: DeepgramMessage;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }

    switch (msg.type) {
      case "Results": {
        const alt = msg.channel?.alternatives?.[0];
        const text = alt?.transcript ?? "";
        if (!text) return; // 無音区間では空文字が届く
        // 単語の時刻を使う。msg.start は認識区間の先頭で、前の無音も含む
        const words = alt?.words ?? [];
        const segmentStart = msg.start ?? 0;
        const startMs = Math.round((words[0]?.start ?? segmentStart) * 1000);
        const endMs = Math.round((words.at(-1)?.end ?? segmentStart + (msg.duration ?? 0)) * 1000);
        if (msg.is_final) events.onFinal(text, msg.speech_final === true, startMs, endMs);
        else events.onPartial(text, startMs, endMs);
        return;
      }
      case "SpeechStarted":
        return events.onSpeechStarted();
      case "UtteranceEnd":
        return events.onUtteranceEnd();
      case "Metadata":
        return;
      default:
        // エラーは type を持たない JSON で来ることがある
        if (msg.error || msg.err_msg) events.onError(String(msg.err_msg ?? msg.error));
    }
  });

  ws.addEventListener("error", () => events.onError("deepgram: connection error"));
  ws.addEventListener("close", (e) => {
    if (!closed && e.code !== 1000) events.onError(`deepgram: closed (code ${e.code}${e.reason ? `, ${e.reason}` : ""})`);
  });

  return {
    send: (pcm) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(pcm);
      else if (ws.readyState === WebSocket.CONNECTING) pending.push(pcm);
    },
    close: () => {
      closed = true;
      if (ws.readyState === WebSocket.OPEN) {
        // 残りの結果を返してから閉じてもらう
        ws.send(JSON.stringify({ type: "CloseStream" }));
        ws.close(1000);
      } else if (ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000);
      }
    },
  };
}

type DeepgramMessage = {
  type?: string;
  start?: number;
  duration?: number;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: { transcript?: string; words?: { start?: number; end?: number }[] }[] };
  error?: unknown;
  err_msg?: unknown;
};
