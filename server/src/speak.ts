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
  // 先頭はフレーム同期（0xFF 0xEx 以上）。JSON のエラーを音声として流さない
  if (mp3.length < 2 || mp3[0] !== 0xff || (mp3[1]! & 0xe0) !== 0xe0) throw new Error("deepgram tts: mp3 ではない応答");
  return mp3;
}
