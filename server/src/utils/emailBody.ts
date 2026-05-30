/** Patterns that indicate JARVIS is talking to Joe, not writing the outbound email. */
const OPERATOR_LINE_START =
  /^(here'?s\b|here is\b|want me to send|shall i send|should i send|ready to send\b|let me know if\b|short and clean\b|this (reply |keeps |email )|i('ve| have) drafted|draft (for|to)\b|^(a )?clean,?\s*professional\b|strategy:|coaching:|note to joe:|for joe only:|i can send|go ahead and send|reply below:|email below:)/i;

const OPERATOR_ANYWHERE =
  /want me to send|shall i send|here'?s a clean|here is a clean|professional reply to\b|keeps the relationship warm without committing/i;

const SEPARATOR_LINE = /^[-_*=]{3,}\s*$/;

function collapseBlankLines(lines: string[]) {
  const out: string[] = [];
  for (const line of lines) {
    if (line === "" && out[out.length - 1] === "") continue;
    out.push(line);
  }
  while (out[0] === "") out.shift();
  while (out[out.length - 1] === "") out.pop();
  return out;
}

/** True when text clearly mixes operator coaching with a recipient-facing draft. */
export function emailBodyHasOperatorContamination(text: string) {
  return OPERATOR_ANYWHERE.test(text);
}

/**
 * Strip operator commentary from an email body before Gmail send.
 * Returns empty string if nothing recipient-safe remains (caller should regenerate).
 */
export function sanitizeEmailBody(raw: string): string {
  if (!raw?.trim()) return "";

  let text = raw.replace(/\r\n/g, "\n").trim();
  text = text.replace(/```[\s\S]*?```/g, "\n");

  const lines = text.split("\n");
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      kept.push("");
      continue;
    }
    if (SEPARATOR_LINE.test(trimmed)) continue;
    if (OPERATOR_LINE_START.test(trimmed)) continue;
    if (/want me to send/i.test(trimmed)) continue;
    kept.push(line.trimEnd());
  }

  let result = collapseBlankLines(kept).join("\n").trim();
  result = result
    .replace(/^[-_*=]{3,}\s*\n/gm, "")
    .replace(/\n[-_*=]{3,}\s*$/gm, "")
    .trim();

  if (!result || emailBodyHasOperatorContamination(result)) return "";
  if (result.length < 12) return "";

  return result;
}

/** Prefer sanitized hint; regenerate when hint is operator commentary or unusable after strip. */
export async function resolveOutboundEmailBody(
  bodyHint: string,
  generate: () => Promise<string>
): Promise<string> {
  const hint = bodyHint.trim();

  if (!hint) {
    const generated = await generate();
    return sanitizeEmailBody(generated) || generated.trim();
  }

  if (emailBodyHasOperatorContamination(hint)) {
    const generated = await generate();
    const clean = sanitizeEmailBody(generated);
    return clean || generated.trim();
  }

  const sanitized = sanitizeEmailBody(hint);
  if (sanitized.length >= 20) return sanitized;

  const generated = await generate();
  const cleanGenerated = sanitizeEmailBody(generated);
  return cleanGenerated || generated.trim();
}
