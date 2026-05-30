import type { Request } from "express";
import {
  addConversationMessage,
  getRecentConversation,
  getState,
  setState,
  getActiveAlertPayload,
  recordJoeActivity,
  type ConversationMessage,
  type ConversationState
} from "../../db/queries";
import { generateFastJarvisResponse, generateJarvisIntentResponse } from "../../services/claude";
import { extractAndSaveMemory, scheduleEpisodicMemoryWrite } from "../../services/memory";
import { communication } from "../../brain/cycle";
import { handleJoeActivation } from "../../brain/activationBriefing";
import { braveCircuit, claudeCircuit } from "../../services/circuitBreaker";
import { logServiceError } from "../../utils/logError";
import { tryDocumentChatRoute } from "./documentOrchestrator";
import {
  tryImageGenerationRoute,
  tryTranscriptQueryRoute,
  tryUploadFollowUpRoute
} from "./uploadOrchestrator";
import {
  messageNeedsLiveDataSearch,
  runReactLiveDataRoute,
  scheduleReActMemoryPromotion,
  stripCheckingLanguage
} from "./liveData";
import {
  applyMemoryFeedbackToSpeech,
  buildChatStateForClaude,
  memoryOutcomeLabel,
  shouldExtractMemories
} from "./memoryOrchestrator";
import {
  tryEmailConnectionRoute,
  tryFetchEmailsRoute,
  tryOperatorStatusRoute,
  tryOpenEndedBriefingRoute,
  enforceTruthfulSpeech
} from "./truthGuard";
import { isOperationalBriefQuery, tryOperationalBriefRoute } from "./operationalBrief";
import { buildFallbackBriefingSpeech, compileBriefingData } from "../../brain/communication";
import { logSpeechBuilt, routeLog, reqLog } from "../../utils/requestLog";
import { executeTool, normalizeStatePatch, stateForResponse } from "./tools";
import {
  ACTIVATION_MESSAGE,
  getSessionId,
  normalizeJarvisResponse,
  sanitizeSpeechForClient
} from "./utils";
import type { JarvisUiPayload } from "./types";

const BUSINESS_HISTORY_PATTERN =
  /\b(emails?|inbox|gmail|email|call|client|customer|crew|job|send|sent|schedule|estimate|payment|vendor|quote|invoice|lead|rundown|weather|document|contract|memory|autonomous|capabilities?)\b/i;

const BUSINESS_INTENT_PATTERN =
  /\b(autonomous|capabilities?|capability|check|inbox|emails?|gmail|working|connected|operational|email|call|client|customer|crew|job|send|reply|schedule|estimate|payment|vendor|quote|invoice|lead|rundown|weather|document|contract|memory|search|find|what did|did you|handle|handled|archive|text|world|news|price|cost|material|pull up|pull|brain|monitor|always)\b/i;

const SIMPLE_CHAT_PATTERN =
  /\b(hello|hey|hi|thanks|thank you|nice|cool|okay|ok|bet|yes|no|goodbye|bye|appreciate)\b/i;

export type ChatApiPayload = {
  speech: string;
  ui: JarvisUiPayload;
  intent: string;
  state: ReturnType<typeof stateForResponse>;
  status: string;
  timings?: {
    promptBuildMs: number;
    claudeMs: number;
    toolsMs: number;
    totalMs: number;
  };
};

export type ProcessChatResult =
  | { ok: true; payload: ChatApiPayload }
  | { ok: false; status: number; error: string; speech?: string };

function selectSmartHistory(history: ConversationMessage[]): ConversationMessage[] {
  const recent = history.slice(-8);
  const older = history
    .slice(-20, Math.max(history.length - 8, 0))
    .filter((entry) => BUSINESS_HISTORY_PATTERN.test(entry.content));
  return [...older, ...recent];
}

function clientSpeech(raw: string, fallback = "Standing by, sir."): string {
  const trimmed = raw.trim();
  const out = sanitizeSpeechForClient(trimmed, fallback);
  logSpeechBuilt(out, out !== trimmed);
  return out;
}

function schedulePostChatMemory(message: string, speech: string, intent: string) {
  if (!shouldExtractMemories(intent)) return;
  setImmediate(() => {
    void extractAndSaveMemory({
      userMessage: message,
      jarvisResponse: speech,
      intent,
      outcome: memoryOutcomeLabel(intent)
    });
  });
}

function isFastPathMessage(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > 72) return false;
  if (BUSINESS_INTENT_PATTERN.test(trimmed)) return false;
  if (messageNeedsLiveDataSearch(trimmed)) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length > 5) return false;
  return SIMPLE_CHAT_PATTERN.test(trimmed);
}

/** Shared brain pipeline for POST /api/chat. */
export async function processChatRequest(req: Request): Promise<ProcessChatResult> {
  const message = String(req.body?.message || "").trim();
  const sessionId = getSessionId(req);

  if (!message) {
    return { ok: false, status: 400, error: "message is required" };
  }

  try {
    if (message === ACTIVATION_MESSAGE) {
      routeLog("hit: __JARVIS_ACTIVATE__");
      const activation = await handleJoeActivation();
      recordJoeActivity();
      const speech = clientSpeech(activation.speech);

      const nextState = setState(sessionId, {
        activePanel: (activation.uiPanel as ConversationState["activePanel"]) || null,
        activeItems: activation.uiData || [],
        selectedItem: null,
        lastIntent: activation.intent
      });

      addConversationMessage("assistant", speech, sessionId);

      return {
        ok: true,
        payload: {
          speech,
          ui: {
            panel: activation.uiPanel as JarvisUiPayload["panel"],
            action: activation.uiPanel ? "open" : null,
            data: activation.uiData || []
          },
          intent: activation.intent,
          state: stateForResponse(nextState),
          status: "complete"
        }
      };
    }

    recordJoeActivity();

    const t0 = Date.now();
    const state = getState(sessionId);
    const alertPayload = getActiveAlertPayload();

    const fetchEmailsRoute = await tryFetchEmailsRoute(message, state);
    if (fetchEmailsRoute) {
      const nextState = setState(sessionId, {
        activePanel: (fetchEmailsRoute.ui.panel as ConversationState["activePanel"]) || null,
        activeItems: fetchEmailsRoute.ui.data || [],
        lastIntent: fetchEmailsRoute.intent
      });
      addConversationMessage("user", message, sessionId);
      addConversationMessage("assistant", fetchEmailsRoute.speech, sessionId);
      return {
        ok: true,
        payload: {
          speech: fetchEmailsRoute.speech,
          ui: fetchEmailsRoute.ui,
          intent: fetchEmailsRoute.intent,
          state: stateForResponse(nextState),
          status: "complete"
        }
      };
    }

    const emailConnectionRoute = await tryEmailConnectionRoute(message, state);
    if (emailConnectionRoute) {
      const nextState = setState(sessionId, {
        activePanel: (emailConnectionRoute.ui.panel as ConversationState["activePanel"]) || null,
        activeItems: emailConnectionRoute.ui.data || [],
        lastIntent: emailConnectionRoute.intent
      });
      addConversationMessage("user", message, sessionId);
      addConversationMessage("assistant", emailConnectionRoute.speech, sessionId);
      schedulePostChatMemory(message, emailConnectionRoute.speech, emailConnectionRoute.intent);
      return {
        ok: true,
        payload: {
          speech: emailConnectionRoute.speech,
          ui: emailConnectionRoute.ui,
          intent: emailConnectionRoute.intent,
          state: stateForResponse(nextState),
          status: "complete"
        }
      };
    }

    const operationalBrief = tryOperationalBriefRoute(message, state);
    if (operationalBrief) {
      const nextState = setState(sessionId, {
        lastIntent: operationalBrief.intent,
        activePanel: (operationalBrief.ui.panel as ConversationState["activePanel"]) || null,
        activeItems: operationalBrief.ui.data || []
      });
      addConversationMessage("user", message, sessionId);
      addConversationMessage("assistant", operationalBrief.speech, sessionId);
      return {
        ok: true,
        payload: {
          speech: operationalBrief.speech,
          ui: operationalBrief.ui,
          intent: operationalBrief.intent,
          state: stateForResponse(nextState),
          status: "complete"
        }
      };
    }
    const statusRoute = await tryOperatorStatusRoute(message, state, sessionId);
    if (statusRoute) {
      const nextState = setState(sessionId, {
        activePanel: "emails",
        activeItems: state.activeItems,
        lastIntent: statusRoute.intent
      });
      addConversationMessage("user", message, sessionId);
      const statusSpeech = clientSpeech(statusRoute.speech);
      addConversationMessage("assistant", statusSpeech, sessionId);
      schedulePostChatMemory(message, statusSpeech, statusRoute.intent);
      return {
        ok: true,
        payload: {
          speech: statusSpeech,
          ui: statusRoute.ui,
          intent: statusRoute.intent,
          state: stateForResponse(nextState),
          status: "complete"
        }
      };
    }

    const openEndedRoute = tryOpenEndedBriefingRoute(message, state, alertPayload);
    if (openEndedRoute) {
      routeLog("hit: tryOpenEndedBriefingRoute");
      const nextState = setState(sessionId, {
        lastIntent: openEndedRoute.intent,
        activePanel: (openEndedRoute.ui.panel as ConversationState["activePanel"]) || null,
        activeItems: openEndedRoute.ui.data || []
      });
      addConversationMessage("user", message, sessionId);
      addConversationMessage("assistant", openEndedRoute.speech, sessionId);
      schedulePostChatMemory(message, openEndedRoute.speech, openEndedRoute.intent);
      return {
        ok: true,
        payload: {
          speech: openEndedRoute.speech,
          ui: openEndedRoute.ui,
          intent: openEndedRoute.intent,
          state: stateForResponse(nextState),
          status: "complete"
        }
      };
    }
    const transcriptRoute = await tryTranscriptQueryRoute(message);
    if (transcriptRoute) {
      const nextState = setState(sessionId, { lastIntent: transcriptRoute.intent });
      addConversationMessage("user", message, sessionId);
      addConversationMessage("assistant", transcriptRoute.speech, sessionId);
      schedulePostChatMemory(message, transcriptRoute.speech, transcriptRoute.intent);
      return {
        ok: true,
        payload: {
          speech: transcriptRoute.speech,
          ui: transcriptRoute.ui,
          intent: transcriptRoute.intent,
          state: stateForResponse(nextState),
          status: "complete"
        }
      };
    }

    const uploadFollowUp = await tryUploadFollowUpRoute(message, sessionId);
    if (uploadFollowUp) {
      const nextState = setState(sessionId, { lastIntent: uploadFollowUp.intent });
      addConversationMessage("user", message, sessionId);
      addConversationMessage("assistant", uploadFollowUp.speech, sessionId);
      schedulePostChatMemory(message, uploadFollowUp.speech, uploadFollowUp.intent);
      return {
        ok: true,
        payload: {
          speech: uploadFollowUp.speech,
          ui: uploadFollowUp.ui,
          intent: uploadFollowUp.intent,
          state: stateForResponse(nextState),
          status: "complete"
        }
      };
    }

    const imageGenRoute = await tryImageGenerationRoute(message, sessionId);
    if (imageGenRoute) {
      const nextState = setState(sessionId, { lastIntent: imageGenRoute.intent });
      addConversationMessage("user", message, sessionId);
      addConversationMessage("assistant", imageGenRoute.speech, sessionId);
      schedulePostChatMemory(message, imageGenRoute.speech, imageGenRoute.intent);
      return {
        ok: true,
        payload: {
          speech: imageGenRoute.speech,
          ui: imageGenRoute.ui,
          intent: imageGenRoute.intent,
          state: stateForResponse(nextState),
          status: "complete"
        }
      };
    }

    const documentResult = await tryDocumentChatRoute(message);
    if (documentResult) {
      const nextState = setState(sessionId, {
        lastIntent: documentResult.intent,
        activePanel: null,
        activeItems: []
      });
      addConversationMessage("user", message, sessionId);
      addConversationMessage("assistant", documentResult.speech, sessionId);
      schedulePostChatMemory(message, documentResult.speech, documentResult.intent);
      return {
        ok: true,
        payload: {
          speech: documentResult.speech,
          ui: documentResult.ui,
          intent: documentResult.intent,
          state: stateForResponse(nextState),
          status: "complete"
        }
      };
    }

    const liveDataResult = await runReactLiveDataRoute(message, state, alertPayload);
    if (liveDataResult) {
      const liveDataResponse = liveDataResult.response;
      const nextState = setState(sessionId, {
        lastIntent: liveDataResponse.intent,
        activePanel: (liveDataResponse.ui.panel as ConversationState["activePanel"]) || null,
        activeItems: liveDataResponse.ui.data || []
      });
      addConversationMessage("user", message, sessionId);
      const liveSpeech = clientSpeech(liveDataResponse.speech);
      addConversationMessage("assistant", liveSpeech, sessionId);
      if (liveDataResult.promote) {
        scheduleReActMemoryPromotion(liveDataResult.promote);
      }
      schedulePostChatMemory(message, liveSpeech, liveDataResponse.intent);
      return {
        ok: true,
        payload: {
          speech: liveSpeech,
          ui: liveDataResponse.ui,
          intent: liveDataResponse.intent,
          state: stateForResponse(nextState),
          status: "complete"
        }
      };
    }

    routeLog("enter: Claude intent path");
    reqLog("brain: intent_chat | building operator state");

    const tPromptStart = Date.now();
    const history = selectSmartHistory(getRecentConversation(sessionId, 20));
    const chatState = buildChatStateForClaude(state, alertPayload);
    const tPromptBuilt = Date.now();
    let response: string;
    try {
      response = isFastPathMessage(message)
        ? await claudeCircuit.execute("fast_chat", () => generateFastJarvisResponse(message))
        : await claudeCircuit.execute("intent_chat", () =>
            generateJarvisIntentResponse({
              message,
              history,
              state: chatState
            })
          );
    } catch {
      const fallbackSpeech = isOperationalBriefQuery(message)
        ? buildFallbackBriefingSpeech(compileBriefingData())
        : braveCircuit.isOpen()
          ? braveCircuit.graceMessage()
          : claudeCircuit.graceMessage();
      routeLog(
        isOperationalBriefQuery(message)
          ? "claude circuit fallback — compileBriefingData"
          : "claude circuit fallback — grace message"
      );
      response = JSON.stringify({
        speech: fallbackSpeech,
        intent: isOperationalBriefQuery(message) ? "morning_brief" : "general.chat",
        entities: {},
        ui: { panel: null, data: [], action: null },
        tool: { name: null, args: {} }
      });
    }

    const tClaude = Date.now();
    let normalized = normalizeJarvisResponse(response);

    const speechLooksLikeJson =
      normalized.speech.trim().startsWith("{") && normalized.speech.includes('"speech"');

    if (messageNeedsLiveDataSearch(message) && !isOperationalBriefQuery(message)) {
      routeLog("retry: runReactLiveDataRoute after intent");
      const retryLiveResult = await runReactLiveDataRoute(message, state, alertPayload);
      if (retryLiveResult) {
        const retryLive = retryLiveResult.response;
        const nextState = setState(sessionId, {
          lastIntent: retryLive.intent,
          activePanel: (retryLive.ui.panel as ConversationState["activePanel"]) || null,
          activeItems: retryLive.ui.data || []
        });
        addConversationMessage("user", message, sessionId);
        const retrySpeech = clientSpeech(retryLive.speech);
        addConversationMessage("assistant", retrySpeech, sessionId);
        if (retryLiveResult.promote) {
          scheduleReActMemoryPromotion(retryLiveResult.promote);
        }
        schedulePostChatMemory(message, retrySpeech, retryLive.intent);
        return {
          ok: true,
          payload: {
            speech: retrySpeech,
            ui: retryLive.ui,
            intent: retryLive.intent,
            state: stateForResponse(nextState),
            status: "complete"
          }
        };
      }
    }

    const toolResult = await executeTool(normalized, state, message, sessionId);
    const tTool = Date.now();
    console.log(
      `[Chat] prompt_build: ${tPromptBuilt - tPromptStart}ms | claude: ${tClaude - tPromptBuilt}ms | tools: ${tTool - tClaude}ms | total: ${tTool - t0}ms`
    );
    const nextState = setState(sessionId, normalizeStatePatch(state, toolResult.statePatch));

    let adjustedSpeech = stripCheckingLanguage(
      applyMemoryFeedbackToSpeech(message, toolResult.response.speech)
    );
    adjustedSpeech = enforceTruthfulSpeech(
      adjustedSpeech,
      toolResult.response.intent,
      Boolean(toolResult.sentEmail)
    );
    adjustedSpeech = clientSpeech(
      adjustedSpeech,
      speechLooksLikeJson
        ? "Standing by, sir. Say the word if you want weather, email, or a rundown."
        : "Standing by, sir."
    );
    const finalResponse = { ...toolResult.response, speech: adjustedSpeech };

    addConversationMessage("user", message, sessionId);
    addConversationMessage("assistant", adjustedSpeech, sessionId);

    const payload: ChatApiPayload = {
      speech: adjustedSpeech,
      ui: finalResponse.ui,
      intent: finalResponse.intent,
      state: stateForResponse(nextState),
      status: "complete",
      timings: {
        promptBuildMs: tPromptBuilt - tPromptStart,
        claudeMs: tClaude - tPromptBuilt,
        toolsMs: tTool - tClaude,
        totalMs: tTool - t0
      }
    };

    schedulePostChatMemory(message, adjustedSpeech, finalResponse.intent);

    // Episodic summary after 3 turns (6 messages) on general.chat without tools
    scheduleEpisodicMemoryWrite(
      sessionId,
      finalResponse.intent,
      normalized.tool?.name ?? null
    );

    return { ok: true, payload };
  } catch (error) {
    logServiceError("chat", "/api/chat", error);
    const state = getState(sessionId);
    return {
      ok: true,
      payload: {
        speech: "I'm here, sir. I hit a backend fault, but the operator is still online.",
        ui: {
          panel: state.activePanel as JarvisUiPayload["panel"],
          action: "keep_open",
          data: state.activeItems
        },
        intent: "general.chat",
        state: stateForResponse(state),
        status: "recovered"
      }
    };
  }
}
