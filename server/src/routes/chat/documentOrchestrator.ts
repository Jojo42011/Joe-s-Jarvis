import { searchAndAnswerDocuments } from "../../services/documentIntelligence";
import { isSendCommand, isSendVerification } from "./utils";
import type { IntentResponse } from "./types";

export function messageNeedsDocumentSearch(message: string): boolean {
  if (isSendCommand(message) || isSendVerification(message)) return false;
  const q = message.toLowerCase();
  return (
    /\b(in the contract|in the estimate|in the doc|in the document|in the agreement|in my docs?)\b/i.test(
      q
    ) ||
    /\bwhat did we charge\b/i.test(q) ||
    /\bwhat does it say\b/i.test(q) ||
    /\baccording to\b/i.test(q) ||
    /\bwhat were the terms\b/i.test(q) ||
    /\bwhat was quoted\b/i.test(q) ||
    /\b(find in documents?|check the documents?|look in my docs?)\b/i.test(q) ||
    /\bwhat'?s in the\b/i.test(q) ||
    /\b(payment terms|scope of work|contract says)\b/i.test(q) ||
    /\b(henderson|property).*(charge|quote|contract|estimate)/i.test(q)
  );
}

export async function tryDocumentChatRoute(message: string): Promise<IntentResponse | null> {
  if (!messageNeedsDocumentSearch(message)) return null;

  const result = await searchAndAnswerDocuments(message);
  if (!result) return null;

  return {
    speech: result.answer,
    intent: "document.search",
    entities: { citations: result.citations, query: message },
    ui: { panel: null, data: [], action: null },
    tool: { name: null, args: {} }
  };
}
