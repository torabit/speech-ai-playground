# speech-ai-playground

ブラウザで日本語を話すと、英語に逐次通訳して音声で返す学習用プレイグラウンド。

リアルタイム音声 AI を自分で実装し、次の 3 点を実測に基づいて説明できるようになることが目的。

- 遅延がどこで発生するか
- Realtime UI の状態をどう設計するか
- 部分的な失敗にどう備えるか

STT、LLM、TTS を直列につないだ pipeline 構成と、End-to-End の speech-to-speech を同じ UI で比べる。

## 構成（予定）

| 層 | 選択 |
| --- | --- |
| フロントエンド | Vite + React + TypeScript |
| サーバ | Node.js 24（`ws`） |
| STT | Deepgram Nova-3 |
| 翻訳 | Gemini Flash-Lite |
| TTS | Deepgram Aura-2 |
| End-to-End の比較対象 | Gemini Live API |

## 起動

```sh
npm install
npm run dev:server   # :8787
npm run dev:web      # :5173
```

`http://localhost:5173` を Chrome で開く。マイクは安全なコンテキストでしか使えない。リモートのマシンで動かす場合は `ssh -L 5173:localhost:5173 <host>` で転送する。

API キーは `server/.env` に書く（`.env.example` を参照、gitignore 済み）。

## 検証

```sh
npm run dev:web
npm run verify:phase0   # dev:server は止めておく
```

## 進捗

- [ ] Phase 0: マイク音声を PCM16 16kHz でサーバへ送る
- [ ] Phase 1: ストリーミング STT
- [ ] Phase 2: 翻訳と TTS
- [ ] Phase 3: 割り込み、障害注入、縮退、再接続
- [ ] Phase 4: End-to-End との比較
- [ ] Phase 5: docs
