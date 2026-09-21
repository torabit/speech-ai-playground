// Gemini で日本語 1 文を英語 1 文にする。
//
// 既定モデルは gemini-3.1-flash-lite。gemini-2.5-flash-lite はこの鍵に対して HTTP 404
// （"no longer available to new users"、案内先は gemini-3.5-flash-lite）。だが 3.5-flash-lite は
// 実測時点で HTTP 503（"currently experiencing high demand"）が続き、5 秒のタイムアウトより
// 503 が返ってくるまでの時間の方が長いので、この鍵からは事実上応答が返らない。3.1-flash-lite は
// 応答する。GEMINI_MODEL で切り替えられるので、3.5 の状況が変わればそちらへ動かせる。
// generationConfig.thinking_level は HTTP 400 Unknown name で存在しない（v1beta）。thinkingConfig
// は付けない。1 文の翻訳では 3.x 系のレスポンスにも thoughtsTokenCount が出ないので、
// この負荷では thinking の差は現れない。
// ストリーミング（streamGenerateContent）は使わない。出力が数十トークンなので利得が小さい。

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

const SYSTEM = [
  "You are a simultaneous interpreter.",
  "Translate the Japanese input into natural spoken English.",
  "Output only the translation. No notes, no romaji, no quotation marks.",
].join(" ");

export type TranslationContext = { japanese: string; english: string };

export function buildTranslateRequest(japanese: string, context?: TranslationContext): unknown {
  // 直前の 1 文を往復として前に置く。代名詞と語順の一貫性のため
  const contents = context
    ? [
        { role: "user", parts: [{ text: context.japanese }] },
        { role: "model", parts: [{ text: context.english }] },
        { role: "user", parts: [{ text: japanese }] },
      ]
    : [{ role: "user", parts: [{ text: japanese }] }];

  return {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents,
    generationConfig: { temperature: 0.2, maxOutputTokens: 256, candidateCount: 1 },
  };
}

export function readTranslation(json: unknown): string | null {
  const text = (json as { candidates?: { content?: { parts?: { text?: string }[] } }[] })
    ?.candidates?.[0]?.content?.parts?.[0]?.text;
  const trimmed = text?.trim();
  return trimmed ? trimmed : null;
}

// readTranslation が null を返した理由の手がかり。MAX_TOKENS（予算切れ）、SAFETY（安全性で
// 打ち切り）、プロンプト単位の blockReason（candidates 自体が無い）はそれぞれ別の原因で、
// 束ねて「訳文が読めない」とだけ返すと初回の実測で全滅した時に何も分からない。
// プロンプト本文や鍵は含めない
export function readDiagnostic(json: unknown): string | null {
  const j = json as { candidates?: { finishReason?: string }[]; promptFeedback?: { blockReason?: string } };
  const finishReason = j?.candidates?.[0]?.finishReason;
  const blockReason = j?.promptFeedback?.blockReason;
  const parts = [finishReason && `finishReason=${finishReason}`, blockReason && `blockReason=${blockReason}`].filter(
    (v): v is string => Boolean(v),
  );
  return parts.length > 0 ? parts.join(" ") : null;
}

export async function translate(
  apiKey: string,
  model: string,
  japanese: string,
  context?: TranslationContext,
  timeoutMs = 5000,
): Promise<string> {
  // AbortSignal.timeout の中断は "The operation was aborted due to timeout" としか言わない。
  // 上流が 503 を返している場合もここに出る（503 の到着が timeoutMs より遅いと中断が先に起きる）
  const response = await fetch(`${ENDPOINT}/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify(buildTranslateRequest(japanese, context)),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((e) => {
    throw e instanceof Error && e.name === "TimeoutError"
      ? new Error(`gemini: ${timeoutMs}ms で打ち切り（上流が 503 を返している場合もここに出る）`)
      : e;
  });
  if (!response.ok) throw new Error(`gemini: ${response.status} ${(await response.text()).slice(0, 200)}`);
  const json = await response.json();
  const text = readTranslation(json);
  if (!text) {
    const diagnostic = readDiagnostic(json);
    throw new Error(`gemini: 訳文が読めない${diagnostic ? `（${diagnostic}）` : ""}`);
  }
  return text;
}
