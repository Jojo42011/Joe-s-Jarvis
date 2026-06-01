export type JarvisUiPayload = {
  panel: "emails" | "texts" | "calls" | "rundown" | "photo" | "weather" | "notes" | "calendar" | null;
  data: unknown[];
  action?: "open" | "close" | "update" | "keep_open" | "show" | "flash" | null;
};

export type WeatherPanelData = {
  location: string;
  temperature: string;
  conditions: string;
  wind: string;
  crew_impact: "GO" | "CAUTION" | "NO-GO";
  crew_note: string;
};

export type SearchDecision = {
  needs_search: boolean;
  search_type: "weather" | "news" | "web";
  query: string;
  reasoning: string;
};

export type ReactPromotionContext = {
  query: string;
  searchType: string;
  searchPayload: unknown;
  answer: string;
};

export type ReactLiveDataResult = {
  response: IntentResponse;
  promote?: ReactPromotionContext;
};

export type ToolPayload = {
  name: string | null;
  args: Record<string, unknown>;
};

export type IntentResponse = {
  speech: string;
  intent: string;
  entities: Record<string, unknown>;
  ui: JarvisUiPayload;
  tool: ToolPayload;
};

export type EmailStateItem = {
  id?: string;
  threadId?: string;
  from?: string;
  subject?: string;
  snippet?: string;
  time?: string;
  priority?: string;
  action?: string;
};
