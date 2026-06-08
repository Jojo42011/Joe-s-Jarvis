import { MEMORY_CATEGORIES, MEMORY_NEVER_DECAY } from "../config/memoryCategories";

export { MEMORY_NEVER_DECAY };

export const MEMORY_HIGH_IMPORTANCE_PATTERNS = [
  /\$[\d,]+(?:\.\d{2})?/,
  /\b(?:problem|issue|owes|overdue|dispute)\b/i,
  /\b(?:fired|quit|unreliable|no-show|walked off)\b/i
];

export const MEMORY_LOW_IMPORTANCE_PATTERNS = [
  /\b(?:weather pattern|forecast|temperature trend)\b/i,
  /\b(?:industry average|national trend)\b/i
];

export const MEMORY_NEVER_SAVE_PATTERNS = [
  /^(hi|hello|hey|thanks|thank you|good morning|good night|ok|okay|yes|no|sure)\b/i,
  /\b(?:what is|what's|how do i|can you|will you)\s.+\?$/i
];

export const SYNTHESIS_CATEGORIES = [
  MEMORY_CATEGORIES.BUSINESS_CONTEXT,
  MEMORY_CATEGORIES.CLIENT_RELATIONS,
  MEMORY_CATEGORIES.OPERATOR_PREFERENCES,
  MEMORY_CATEGORIES.CREW_LABOR,
  MEMORY_CATEGORIES.VENDOR_SUPPLIER,
  MEMORY_CATEGORIES.FINANCIAL_OPERATIONS,
  MEMORY_CATEGORIES.INDUSTRY,
  MEMORY_CATEGORIES.DRONE_FAA,
  MEMORY_CATEGORIES.WORLD_INTEL
] as const;

export function applyImportanceHeuristics(input: {
  category: string;
  key: string;
  value: string;
  importance: number;
  source?: string | null;
}): number {
  let importance = input.importance;

  const amountMatch = input.value.match(/\$([\d,]+(?:\.\d{2})?)/);
  if (amountMatch) {
    const amount = Number(amountMatch[1].replace(/,/g, ""));
    if (Number.isFinite(amount) && amount > 500) {
      importance = Math.max(importance, 0.8);
    }
  }

  if (
    input.category === MEMORY_CATEGORIES.CLIENT_RELATIONS &&
    /\b(problem|issue|owes|overdue|dispute)\b/i.test(input.value)
  ) {
    importance = Math.max(importance, 0.8);
  }

  if (
    input.category === MEMORY_CATEGORIES.CREW_LABOR &&
    /\b(fired|quit|unreliable|no-show|walked off)\b/i.test(input.value)
  ) {
    importance = Math.max(importance, 0.8);
  }

  if (input.category === MEMORY_CATEGORIES.OPERATOR_PREFERENCES) {
    importance = Math.max(importance, 0.8);
  }

  if (input.source === "joe_note" || input.source === "joe_explicit") {
    importance = Math.max(importance, 0.8);
  }

  if (MEMORY_LOW_IMPORTANCE_PATTERNS.some((re) => re.test(input.value))) {
    importance = Math.min(importance, 0.3);
  }

  return Math.min(1, Math.max(0, importance));
}

export function shouldSkipExtraction(userMessage: string, jarvisResponse: string): boolean {
  const user = userMessage.trim();
  if (!user || user.length < 4) return true;
  if (MEMORY_NEVER_SAVE_PATTERNS.some((re) => re.test(user))) return true;
  if (/^__JARVIS_ACTIVATE__$/i.test(user)) return true;
  if (!jarvisResponse.trim()) return true;
  return false;
}
