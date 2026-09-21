// Deepgram Aura-2 で英語 1 文を mp3 にする。
//
// REST を使う。WebSocket（/v1/speak）では mp3 が出せず生 PCM になり、
// ブラウザ側で再生スケジューリングを書くことになる。割り込みが要る Phase 3 で比べる。
// 1 文を複数リクエストに分けない。抑揚の連続性が崩れる（ドキュメントの明記）。
//
// 実測（65 文字、aura-2-thalia-en）: TTFB 563ms、全体 2.09s、21KB、24kHz mono 48kbps

export function buildSpeakUrl(model: string): string {
  const url = new URL("https://api.deepgram.com/v1/speak");
  url.search = new URLSearchParams({ model, encoding: "mp3" }).toString();
  return url.toString();
}

// mp3 の先頭がフレーム同期（0xFF 0xEx 以上）になっているかを見る。JSON のエラー応答や
// ID3v2 タグ付きの応答（先頭が "ID3"）を音声として流さないための最後の砦。
// 実測の応答は常にこれを満たす（先頭が ff f3）ので、まだ一度もここで落ちたことがない
export function isMp3FrameSync(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
}

export async function speak(
  apiKey: string,
  model: string,
  english: string,
  timeoutMs = 5000,
): Promise<Uint8Array> {
  const response = await fetch(buildSpeakUrl(model), {
    method: "POST",
    headers: { authorization: `Token ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ text: english }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`deepgram tts: ${response.status} ${(await response.text()).slice(0, 200)}`);
  const mp3 = new Uint8Array(await response.arrayBuffer());
  if (!isMp3FrameSync(mp3)) {
    // 実際に何が来たかが分かるよう、先頭 4 バイトと content-type を添える。
    // ID3v2 なら先頭が "49 44 33"、JSON エラーなら "7b"（"{"）になり見分けが付く
    const head = Array.from(mp3.slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join(" ") || "(empty)";
    throw new Error(`deepgram tts: mp3 ではない応答 (head=${head} content-type=${response.headers.get("content-type")})`);
  }
  return mp3;
}
