// Gemini で日本語 1 文を英語 1 文にする。
//
// thinkingConfig は付けない。それでモデルの既定を 2.5 系にしているのは、2.5 系がその既定で
// thinking が off だから。3.1 と 3.5 の flash-lite は thinking_level の下限が minimal で、
// 指定しても off にはできない。この差の実測（TTFT 等）は verify:phase2 で GEMINI_MODEL を
// 差し替えて測る側の仕事で、ここで thinkingConfig を足して制御することはしない。
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
  const response = await fetch(`${ENDPOINT}/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify(buildTranslateRequest(japanese, context)),
    signal: AbortSignal.timeout(timeoutMs),
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
