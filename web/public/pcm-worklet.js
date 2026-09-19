// TODO(Phase 0): マイク入力をサーバへ送れる形に変換する AudioWorkletProcessor
//
// やること
// - 入力（Float32、-1.0〜1.0）を PCM16（Int16）に変換する
// - 20ms 分（16kHz なら 320 サンプル）ずつまとめてメインスレッドへ渡す
// - 入力レベルメーター用に、フレームごとのピーク値も渡す
//
// processor 名は mic.ts から参照する名前と揃えること

class PcmWorklet extends AudioWorkletProcessor {
  // クラスフィールド。呼び出しをまたいで値が残るので constructor は要らない
  logged = 0;
  buffer = new Int16Array(320);
  bufferIndex = 0;
  peak = 0; // このフレーム内の振幅の最大値（0〜1）

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true; // 入力がまだ来ていない

    channel.forEach((c) => {
      const sample = Math.max(-1, Math.min(1, c));
      const int16 = sample < 0 ? sample * 32768 : sample * 32767;

      this.buffer[this.bufferIndex++] = int16;
      this.peak = Math.max(this.peak, Math.abs(sample));

      if (this.bufferIndex === 320) {
        // 第 2 引数は転送リスト。コピーせず所有権を渡す。
        // 渡した後の this.buffer は使えなくなるので、新しい入れ物に差し替える
        this.port.postMessage({ pcm: this.buffer.buffer, peak: this.peak }, [
          this.buffer.buffer,
        ]);
        this.buffer = new Int16Array(320);
        this.bufferIndex = 0;
        this.peak = 0;
      }
    });

    return true;
  }
}

registerProcessor("pcm-worklet", PcmWorklet);
