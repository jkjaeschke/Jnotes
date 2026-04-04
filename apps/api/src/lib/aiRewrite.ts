import { config } from "../config.js";

export type RewritePreset = "concise" | "meeting" | "checklist";

const PRESET_INSTRUCTIONS: Record<RewritePreset, string> = {
  concise:
    "Rewrite the following HTML note to be shorter and clearer. Preserve meaning and keep useful structure (headings, lists). Output valid HTML fragments only (no markdown, no preamble).",
  meeting:
    "Rewrite as polished meeting notes: decisions, action items, and key discussion points. Use headings and bullet lists where helpful. Output valid HTML fragments only.",
  checklist:
    "Rewrite as a clear checklist: use task lists or bullet points where appropriate. Output valid HTML fragments only.",
};

export async function rewriteNoteHtml(
  html: string,
  preset: RewritePreset
): Promise<string> {
  const key = config.openaiApiKey;
  if (!key) {
    throw new Error("Rewrite is not configured (missing OPENAI_API_KEY)");
  }
  const model = config.openaiModel;
  const url = `${config.openaiApiBase}/chat/completions`;
  const system = PRESET_INSTRUCTIONS[preset];
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      max_tokens: 4096,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: `Here is the note HTML to rewrite:\n\n${html.slice(0, 120_000)}`,
        },
      ],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(t.slice(0, 200) || `Model error (${res.status})`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) throw new Error("Empty model response");
  const cleaned = text
    .replace(/^```html\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return cleaned || "<p></p>";
}
