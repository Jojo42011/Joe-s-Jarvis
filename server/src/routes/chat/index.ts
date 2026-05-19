import { Router } from "express";
import {
  addConversationMessage,
  clearState,
  getRecentConversation,
  getState,
  setState,
  getActiveAlertPayload,
  recordJoeActivity,
  type ConversationMessage,
  type ConversationState
} from "../../db/queries";
import { generateFastJarvisResponse, generateJarvisIntentResponse } from "../../services/claude";
import { extractAndSaveMemory } from "../../services/memory";
import { communication, perception } from "../../brain/cycle";
import { braveCircuit } from "../../services/circuitBreaker";
import { claudeCircuit } from "../../services/circuitBreaker";
import { logServiceError } from "../../utils/logError";
import { tryDocumentChatRoute } from "./documentOrchestrator";
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
  tryOperatorStatusRoute,
  tryOpenEndedBriefingRoute,
  enforceTruthfulSpeech
} from "./truthGuard";
import { executeTool, normalizeStatePatch, stateForResponse } from "./tools";
import {
  ACTIVATION_MESSAGE,
  getSessionId,
  normalizeJarvisResponse,
  sanitizeSpeechForClient
} from "./utils";
import type { JarvisUiPayload } from "./types";

export const chatRouter = Router();

const BUSINESS_HISTORY_PATTERN =
  /\b(email|call|client|customer|crew|job|send|sent|schedule|estimate|payment|vendor|quote|invoice|lead|rundown|weather|document|contract|memory)\b/i;

const BUSINESS_INTENT_PATTERN =
  /\b(email|call|client|customer|crew|job|send|reply|schedule|estimate|payment|vendor|quote|invoice|lead|rundown|weather|document|contract|memory|search|find|what did|did you|handle|handled|archive|text|world|news|price|cost|material)\b/i;

const SIMPLE_CHAT_PATTERN =
  /\b(hello|hey|hi|thanks|thank you|nice|cool|okay|ok|bet|yes|no|ready|operational|capabilities|confident|anything more|goodbye|bye|appreciate)\b/i;

function selectSmartHistory(history: ConversationMessage[]): ConversationMessage[] {
  const recent = history.slice(-8);
  const older = history
    .slice(-20, Math.max(history.length - 8, 0))
    .filter((entry) => BUSINESS_HISTORY_PATTERN.test(entry.content));
  return [...older, ...recent];
}

function isFastPathMessage(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > 240) return false;
  if (BUSINESS_INTENT_PATTERN.test(trimmed)) return false;
  if (messageNeedsLiveDataSearch(trimmed)) return false;
  return SIMPLE_CHAT_PATTERN.test(trimmed) || /^[\s\w'",.!?/-]{1,120}$/.test(trimmed);
}

chatRouter.post("/chat", async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim();
    const sessionId = getSessionId(req);

    if (!message) {
      res.status(400).json({ error: "message is required" });
      return;
    }

    if (message === ACTIVATION_MESSAGE) {
      const payload = await perception.sense();
      const comm = await communication.decide([], payload, "joe_activated");
      recordJoeActivity();
      const speech = comm.message || "All clear sir. What do you need?";

      if (comm.briefedItemIds.length) {
        communication.recordBriefing(comm.briefedItemIds);
      }

      const activationIntent = comm.intent || "activation.briefing";

      const nextState = setState(sessionId, {
        activePanel: (comm.uiPanel as ConversationState["activePanel"]) || null,
        activeItems: comm.uiData || [],
        selectedItem: null,
        lastIntent: activationIntent
      });

      addConversationMessage("assistant", speech, sessionId);

      res.json({
        speech,
        ui: {
          panel: comm.uiPanel as JarvisUiPayload["panel"],
          action: comm.uiPanel ? "open" : null,
          data: comm.uiData || []
        },
        intent: activationIntent,
        state: stateForResponse(nextState),
        status: "complete"
      });
      return;
    }

    recordJoeActivity();

    const t0 = Date.now();
    const state = getState(sessionId);
    const alertPayload = getActiveAlertPayload();

    const statusRoute = await tryOperatorStatusRoute(message, state);
    if (statusRoute) {
      const nextState = setState(sessionId, {
        activePanel: "emails",
        activeItems: state.activeItems,
        lastIntent: statusRoute.intent
      });
      addConversationMessage("user", message, sessionId);
      addConversationMessage("assistant", statusRoute.speech, sessionId);
      res.json({
        speech: statusRoute.speech,
        ui: statusRoute.ui,
        intent: statusRoute.intent,
        state: stateForResponse(nextState),
        status: "complete"
      });
      return;
    }

    const openEndedRoute = tryOpenEndedBriefingRoute(message, state, alertPayload);
    if (openEndedRoute) {
      const nextState = setState(sessionId, {
        lastIntent: openEndedRoute.intent,
        activePanel: (openEndedRoute.ui.panel as ConversationState["activePanel"]) || null,
        activeItems: openEndedRoute.ui.data || []
      });
      addConversationMessage("user", message, sessionId);
      addConversationMessage("assistant", openEndedRoute.speech, sessionId);
      res.json({
        speech: openEndedRoute.speech,
        ui: openEndedRoute.ui,
        intent: openEndedRoute.intent,
        state: stateForResponse(nextState),
        status: "complete"
      });
      return;
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
      res.json({
        speech: documentResult.speech,
        ui: documentResult.ui,
        intent: documentResult.intent,
        state: stateForResponse(nextState),
        status: "complete"
      });
      return;
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
      const liveSpeech = sanitizeSpeechForClient(liveDataResponse.speech);
      addConversationMessage("assistant", liveSpeech, sessionId);
      res.json({
        speech: liveSpeech,
        ui: liveDataResponse.ui,
        intent: liveDataResponse.intent,
        state: stateForResponse(nextState),
        status: "complete"
      });
      if (liveDataResult.promote) {
        scheduleReActMemoryPromotion(liveDataResult.promote);
      }
      return;
    }

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
      response = JSON.stringify({
        speech: braveCircuit.isOpen()
          ? braveCircuit.graceMessage()
          : claudeCircuit.graceMessage(),
        intent: "general.chat",
        entities: {},
        ui: { panel: null, data: [], action: null },
        tool: { name: null, args: {} }
      });
    }

    const tClaude = Date.now();
    let normalized = normalizeJarvisResponse(response);

    const speechLooksLikeJson =
      normalized.speech.trim().startsWith("{") && normalized.speech.includes('"speech"');

    if (messageNeedsLiveDataSearch(message)) {
      const retryLiveResult = await runReactLiveDataRoute(message, state, alertPayload);
      if (retryLiveResult) {
        const retryLive = retryLiveResult.response;
        const nextState = setState(sessionId, {
          lastIntent: retryLive.intent,
          activePanel: (retryLive.ui.panel as ConversationState["activePanel"]) || null,
          activeItems: retryLive.ui.data || []
        });
        addConversationMessage("user", message, sessionId);
        const retrySpeech = sanitizeSpeechForClient(retryLive.speech);
        addConversationMessage("assistant", retrySpeech, sessionId);
        res.json({
          speech: retrySpeech,
          ui: retryLive.ui,
          intent: retryLive.intent,
          state: stateForResponse(nextState),
          status: "complete"
        });
        if (retryLiveResult.promote) {
          scheduleReActMemoryPromotion(retryLiveResult.promote);
        }
        return;
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
    adjustedSpeech = sanitizeSpeechForClient(
      adjustedSpeech,
      speechLooksLikeJson
        ? "Standing by, sir. Say the word if you want weather, email, or a rundown."
        : "Standing by, sir."
    );
    const finalResponse = { ...toolResult.response, speech: adjustedSpeech };

    addConversationMessage("user", message, sessionId);
    addConversationMessage("assistant", adjustedSpeech, sessionId);

    res.json({
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
    });

    if (shouldExtractMemories(finalResponse.intent)) {
      setImmediate(() => {
        void extractAndSaveMemory({
          userMessage: message,
          jarvisResponse: adjustedSpeech,
          intent: finalResponse.intent,
          outcome: memoryOutcomeLabel(finalResponse.intent)
        });
      });
    }
  } catch (error) {
    logServiceError("chat", "/api/chat", error);
    const state = getState(getSessionId(req));
    res.json({
      speech: "I'm here, sir. I hit a backend fault, but the operator is still online.",
      ui: {
        panel: state.activePanel as JarvisUiPayload["panel"],
        action: "keep_open",
        data: state.activeItems
      },
      intent: "general.chat",
      state: stateForResponse(state),
      status: "recovered"
    });
  }
});

chatRouter.post("/chat/state/clear", (req, res) => {
  const sessionId = getSessionId(req);
  const state = clearState(sessionId);
  res.json({ status: "cleared", state });
});
