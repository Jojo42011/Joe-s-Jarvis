/**
 * Outbound message style: Joe wants no dashes in anything the system sends —
 * em dashes read as obviously AI-written. Applied at the two choke points every
 * outbound email and SMS flows through (services/sms.ts and google/gmail.ts),
 * so every sender — CRM composes, confirmations, sub schedule texts, Jarvis's
 * notifications, inbox replies — is covered without per-caller changes.
 *
 * Rules:
 *  - em/en dashes and "--" used as punctuation become a comma (or nothing when
 *    something already punctuates the spot)
 *  - a spaced hyphen used as punctuation ("call me - thanks") becomes a comma
 *  - hyphens inside words become a space ("on-site" -> "on site")
 *  - hyphens between digits are KEPT: stripping them would garble phone
 *    numbers ("623-225-0537") and addresses, which reads far worse than a
 *    hyphen ever could
 */

export function stripDashes(text: string): string {
  return text
    .replace(/\s*[—–]\s*/g, ', ')            // em/en dash punctuation
    .replace(/\s+--+\s+/g, ', ')             // "--" punctuation
    .replace(/([a-zA-Z])\s+-\s+([a-zA-Z0-9])/g, '$1, $2') // spaced hyphen between words
    .replace(/([a-zA-Z])-(?=[a-zA-Z])/g, '$1 ')           // in-word hyphen -> space
    .replace(/,\s*([,.!?;:])/g, '$1')        // ", ." / ",," artifacts
    .replace(/([,.!?;:])\s*,/g, '$1')        // ". ," artifacts
    .replace(/ {2,}/g, ' ')
    .trim();
}
