const MEMORY_EXTRACTION_SKIP_INTENTS = new Set([
  "activation.briefing",
  "morning_brief",
  "unclear",
  "execute.cancel",
  "fetch.emails"
]);

export function shouldExtractMemories(intent: string) {
  return !MEMORY_EXTRACTION_SKIP_INTENTS.has(intent);
}

export function memoryOutcomeLabel(intent: string) {
  if (intent === "execute.send") return "send_confirmed";
  if (intent === "intelligence.handled") return "item_handled";
  if (intent === "execute.edit" || intent === "email.reply.edit") return "draft_updated";
  return intent;
}
