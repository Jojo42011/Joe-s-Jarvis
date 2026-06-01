import type { BriefingData } from "../../brain/communication";

const spokenThisSession = new Map<string, Set<string>>();

const TOPIC_STOP_WORDS = new Set([
  "sir",
  "the",
  "and",
  "for",
  "you",
  "your",
  "that",
  "this",
  "with",
  "have",
  "from",
  "what",
  "need",
  "items",
  "item",
  "email",
  "emails",
  "clear",
  "standing",
  "jarvis"
]);

function getOrCreateSet(sessionId: string): Set<string> {
  let set = spokenThisSession.get(sessionId);
  if (!set) {
    set = new Set<string>();
    spokenThisSession.set(sessionId, set);
  }
  return set;
}

export function clearSpokenSession(sessionId: string) {
  spokenThisSession.delete(sessionId);
}

export function getSpokenThisSession(sessionId: string): Set<string> {
  return new Set(getOrCreateSet(sessionId));
}

export function getSpokenListForPrompt(sessionId: string): string[] {
  return [...getOrCreateSet(sessionId)].slice(0, 40);
}

export function isAlreadySpoken(sessionId: string | undefined, key: string): boolean {
  if (!sessionId || !key) return false;
  return getOrCreateSet(sessionId).has(key);
}

export function recordSpokenKeys(sessionId: string, keys: Iterable<string>) {
  const set = getOrCreateSet(sessionId);
  for (const key of keys) {
    const k = key.trim();
    if (k) set.add(k);
  }
}

export function queueSpokenKey(id: number): string {
  return `queue:${id}`;
}

export function callSpokenKey(id: number): string {
  return `call:${id}`;
}

export function emailSpokenKey(id: string): string {
  const bare = id.replace(/^gmail:/i, "");
  return `email:${bare}`;
}

export function worldIntelSpokenKey(query: string): string {
  return `world:${query.trim().toLowerCase().slice(0, 120)}`;
}

export function memorySpokenKey(key: string): string {
  return `memory:${key.trim().toLowerCase()}`;
}

export function topicSpokenKey(topic: string): string {
  return `topic:${topic.trim().toLowerCase().slice(0, 80)}`;
}

/** Extract trackable keys from outbound speech + optional UI payload. */
export function extractSpokenKeysFromResponse(input: {
  speech: string;
  intent?: string;
  uiData?: unknown;
}): string[] {
  const keys = new Set<string>();
  const speech = input.speech || "";

  for (const m of speech.matchAll(/\b(?:gmail:|email:)?([a-f0-9]{12,})\b/gi)) {
    if (m[1]) keys.add(emailSpokenKey(m[1]));
  }

  for (const m of speech.matchAll(/\bqueue(?:\s+item)?\s*#?\s*(\d+)\b/gi)) {
    keys.add(queueSpokenKey(Number(m[1])));
  }

  for (const m of speech.matchAll(/\bcall[:\s]+#?(\d+)\b/gi)) {
    keys.add(callSpokenKey(Number(m[1])));
  }

  const topicMatches = speech.match(
    /\b(weather|queue|inbox|email|appointment|calendar|crew|vendor|lead|estimate|payment|intel|rundown|briefing)\b/gi
  );
  if (topicMatches) {
    for (const t of topicMatches) {
      const norm = t.toLowerCase();
      if (!TOPIC_STOP_WORDS.has(norm)) keys.add(topicSpokenKey(norm));
    }
  }

  if (input.intent) {
    keys.add(topicSpokenKey(input.intent.replace(/\./g, "_")));
  }

  const ui = input.uiData;
  if (Array.isArray(ui)) {
    for (const block of ui) {
      if (!block || typeof block !== "object") continue;
      const obj = block as Record<string, unknown>;
      if (Array.isArray(obj.queueItems)) {
        for (const q of obj.queueItems) {
          if (q && typeof q === "object" && "id" in q) {
            keys.add(queueSpokenKey(Number((q as { id: number }).id)));
          }
        }
      }
      if (typeof obj.queueOpenCount === "number" && obj.queueOpenCount > 0) {
        keys.add(topicSpokenKey("queue"));
      }
    }
  }

  return [...keys];
}

export function recordSpokenFromResponse(
  sessionId: string,
  input: { speech: string; intent?: string; uiData?: unknown }
) {
  recordSpokenKeys(sessionId, extractSpokenKeysFromResponse(input));
}

export function filterBriefingDataForSession(
  data: BriefingData,
  sessionId: string | undefined
): { data: BriefingData; includedKeys: string[] } {
  if (!sessionId) return { data, includedKeys: [] };

  const spoken = getOrCreateSet(sessionId);
  const includedKeys: string[] = [];

  const queueItems = data.queueItems.filter((q) => {
    const key = queueSpokenKey(q.id);
    if (spoken.has(key)) return false;
    includedKeys.push(key);
    return true;
  });

  const priorityCalls = data.priorityCalls.filter((c) => {
    const key = c.id != null ? callSpokenKey(c.id) : topicSpokenKey(`${c.from}:${c.reason}`);
    if (spoken.has(key)) return false;
    includedKeys.push(key);
    return true;
  });

  const worldIntel = data.worldIntel.filter((w) => {
    const key = worldIntelSpokenKey(w.query);
    if (spoken.has(key)) return false;
    includedKeys.push(key);
    return true;
  });

  const memoryPromotions = data.memoryPromotions.filter((m) => {
    const key = memorySpokenKey(m.key);
    if (spoken.has(key)) return false;
    includedKeys.push(key);
    return true;
  });

  let weather = data.weather;
  if (weather) {
    const key = topicSpokenKey("weather");
    if (spoken.has(key)) {
      weather = null;
    } else {
      includedKeys.push(key);
    }
  }

  if (data.emailsAutoHandled > 0) {
    const key = topicSpokenKey("emails_handled");
    if (spoken.has(key)) {
      // suppress email count in speech via zeroing for this brief
    } else {
      includedKeys.push(key);
    }
  }

  const emailsAutoHandled = spoken.has(topicSpokenKey("emails_handled"))
    ? 0
    : data.emailsAutoHandled;

  const filtered: BriefingData = {
    ...data,
    queueItems,
    queueCount: queueItems.length,
    emailsQueued: queueItems.length,
    priorityCalls,
    worldIntel,
    worldIntelCount: worldIntel.length,
    memoryPromotions,
    weather,
    emailsAutoHandled,
    isEmpty:
      data.emailsReceived === 0 &&
      emailsAutoHandled === 0 &&
      data.emailsArchived === 0 &&
      queueItems.length === 0 &&
      priorityCalls.length === 0 &&
      worldIntel.length === 0 &&
      !weather &&
      memoryPromotions.length === 0 &&
      data.recentNotes.length === 0
  };

  return { data: filtered, includedKeys };
}

export function recordBriefingKeys(sessionId: string, keys: string[]) {
  recordSpokenKeys(sessionId, keys);
}
