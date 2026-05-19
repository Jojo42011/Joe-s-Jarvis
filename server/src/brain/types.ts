export type TimeOfDay = "morning" | "afternoon" | "evening" | "night";

export type PerceptionEmail = {
  id: string;
  threadId?: string;
  from: string;
  subject: string;
  snippet: string;
  priority: string;
  time: string;
  internalDate: number;
};

export type PerceptionCall = {
  id: number;
  from: string;
  reason: string;
  outcome: string;
  transcript?: string | null;
  priorityLevel?: string | null;
  duration?: string | null;
  time: string;
};

export type PerceptionText = {
  id: number;
  from: string;
  preview: string;
  time: string;
};

export type PerceptionPayload = {
  newEmails: PerceptionEmail[];
  newCalls: PerceptionCall[];
  newTexts: PerceptionText[];
  timeOfDay: TimeOfDay;
  dayOfWeek: string;
  joeLastActive: Date | null;
  joeActiveToday: boolean;
  itemsHandledToday: number;
  lastBriefingTime: Date | null;
  currentQueueSize: number;
  criticalAlertActive: boolean;
};

export type JudgmentAction = "execute_now" | "queue" | "ignore";
export type NotifyUrgency = "now" | "next_briefing" | "never";

export type JudgmentDecision = {
  itemId: string;
  itemType: "email" | "call" | "text";
  action: JudgmentAction;
  notify: boolean;
  notifyUrgency: NotifyUrgency;
  reason: string;
  executionPlan: { tool: string; args: Record<string, unknown> } | null;
  summary: string;
  urgency?: "NOW" | "TODAY" | "THIS_WEEK" | "NONE";
};

export type ExecutionResult = {
  success: boolean;
  summary: string;
  itemId: string;
  itemType: string;
  action: string;
  notifyJoe: boolean;
  notifyUrgency: NotifyUrgency;
};

export type CommunicationTrigger = "cycle" | "joe_activated" | "critical";

export type CommunicationDecision = {
  shouldSpeak: boolean;
  message: string | null;
  uiPanel: string | null;
  uiData: unknown[] | null;
  briefedItemIds: string[];
  /** Set when a 24-hour operational brief is delivered on activation */
  intent?: string | null;
};
