// TODO(Phase 0): マイクを開始し、20ms ごとの PCM16 フレームを受け取れるようにする
//
// やること
// - マイクの音声を取得する
// - 16kHz mono にする
// - public/pcm-worklet.js を読み込み、フレームを onFrame に渡す
// - stop() でマイク、音声処理、関連リソースをすべて解放する
// - 途中で失敗したとき、確保済みのリソースを漏らさない
//
// 下のシグネチャは一案。変えてよい

export type Mic = { stop: () => Promise<void> };

export async function startMic(onFrame: (pcm: ArrayBuffer, peak: number) => void): Promise<Mic> {
  throw new Error("not implemented");
}
