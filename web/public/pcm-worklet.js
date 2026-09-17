// TODO(Phase 0): マイク入力をサーバへ送れる形に変換する AudioWorkletProcessor
//
// やること
// - 入力（Float32、-1.0〜1.0）を PCM16（Int16）に変換する
// - 20ms 分（16kHz なら 320 サンプル）ずつまとめてメインスレッドへ渡す
// - 入力レベルメーター用に、フレームごとのピーク値も渡す
//
// processor 名は mic.ts から参照する名前と揃えること

class PcmWorklet extends AudioWorkletProcessor {
  process(inputs) {
    return true;
  }
}

registerProcessor("pcm-worklet", PcmWorklet);
