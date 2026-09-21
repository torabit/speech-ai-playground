// Gemini で日本語 1 文を英語 1 文にする。
//
// モデルの既定を 2.5 系にするのは thinking を切れるため。3.1 と 3.5 の flash-lite は
// thinking_level の下限が minimal で、完全には切れない。
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
  const text = readTranslation(await response.json());
  if (!text) throw new Error("gemini: 訳文が読めない");
  return text;
}
