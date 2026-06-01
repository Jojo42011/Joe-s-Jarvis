import type { Request } from "express";
import {
  addConversationMessage,
  getState,
  setState,
  recordJoeActivity,
  type ConversationState
} from "../../db/queries";
import { extractAndSaveMemory, scheduleEpisodicMemoryWrite } from "../../services/memory";
import {
  handleJoeActivation,
  buildActivationContext,
  shouldSilenceActivationBriefing,
  isActivationNetNewEmpty,
  ALL_CLEAR
} from "../../brain/activationBriefing";
import { claudeCircuit } from "../../services/circuitBreaker";
import { logServiceError } from "../../utils/logError";
import {
  tryImageGenerationRoute,
  tryUploadFollowUpRoute
} from "./uploadOrchestrator";
import { getSessionUploads } from "../../services/uploadSession";
import { enforceTruthfulSpeech } from "./truthGuard";
import { memoryOutcomeLabel, shouldExtractMemories } from "./memoryOrchestrator";
import { logSpeechBuilt, routeLog, reqLog } from "../../utils/requestLog";
import { stateForResponse } from "./tools";
import { ACTIVATION_MESSAGE, getSessionId, sanitizeSpeechForClient } from "./utils";
import type { JarvisUiPayload } from "./types";
import { clearSpokenSession, recordSpokenFromResponse } from "./spokenSessionTracker";
import { buildSmartContext } from "../../chat/context";
import { runChatLoop } from "../../chat/runChatLoop";
import { scheduleMemoryExtraction } from "../../memory/extractionEngine";

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

function clientSpeech(raw: string, fallback = "Standing by, sir."): string {
  const trimmed = raw.trim();
  const out = sanitizeSpeechForClient(trimmed, fallback);
  logSpeechBuilt(out, out !== trimmed);
  return out;
}

function trackSpokenResponse(
  sessionId: string,
  speech: string,
  intent?: string,
  uiData?: unknown
) {
  recordSpokenFromResponse(sessionId, { speech, intent, uiData });
}

function schedulePostChatMemoryIfNeeded(message: string, speech: string, intent: string) {
  if (!shouldExtractMemories(intent)) return;
  if (intent === "save_note" || intent.startsWith("chat.")) return;
  setImmediate(() => {
    void extractAndSaveMemory({
      userMessage: message,
      jarvisResponse: speech,
      intent,
      outcome: memoryOutcomeLabel(intent)
    });
  });
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
      const ctx = buildActivationContext();

      if (shouldSilenceActivationBriefing(ctx) || isActivationNetNewEmpty(ctx)) {
        clearSpokenSession(sessionId);
        recordJoeActivity();
        const speech = clientSpeech(ALL_CLEAR);
        const nextState = setState(sessionId, {
          activePanel: null,
          activeItems: [],
          selectedItem: null,
          lastIntent: "activation.clear"
        });
        addConversationMessage("assistant", speech, sessionId);
        trackSpokenResponse(sessionId, speech, "activation.clear");
        return {
          ok: true,
          payload: {
            speech,
            ui: { panel: null, action: null, data: [] },
            intent: "activation.clear",
            state: stateForResponse(nextState),
            status: "complete"
          }
        };
      }

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
      trackSpokenResponse(sessionId, speech, activation.intent, activation.uiData);

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

    if (getSessionUploads(sessionId).length) {
      const uploadFollowUp = await tryUploadFollowUpRoute(message, sessionId);
      if (uploadFollowUp) {
        const nextState = setState(sessionId, { lastIntent: uploadFollowUp.intent });
        addConversationMessage("user", message, sessionId);
        addConversationMessage("assistant", uploadFollowUp.speech, sessionId);
        schedulePostChatMemoryIfNeeded(message, uploadFollowUp.speech, uploadFollowUp.intent);
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
        schedulePostChatMemoryIfNeeded(message, imageGenRoute.speech, imageGenRoute.intent);
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
    }

    routeLog("enter: Claude tool loop");
    reqLog("brain: chat_tool_loop");

    const tPromptStart = Date.now();
    const smartContext = await buildSmartContext(message, sessionId);
    const tPromptBuilt = Date.now();

    let loopResult;
    try {
      loopResult = await claudeCircuit.execute("chat_tool_loop", () =>
        runChatLoop(message, sessionId, smartContext)
      );
    } catch (error) {
      logServiceError("chat", "runChatLoop", error);
      loopResult = {
        speech: claudeCircuit.graceMessage(),
        intent: "chat.error",
        ui: { panel: null, data: [], action: null } as JarvisUiPayload,
        tool: "",
        sentEmail: false,
        toolsCalled: [] as string[]
      };
    }

    const tClaude = Date.now();
    const speech = clientSpeech(loopResult.speech);
    const nextState = setState(sessionId, {
      lastIntent: loopResult.intent,
      activePanel: (loopResult.ui.panel as ConversationState["activePanel"]) || null,
      activeItems: loopResult.ui.data || []
    });

    addConversationMessage("user", message, sessionId);
    addConversationMessage("assistant", speech, sessionId);
    trackSpokenResponse(sessionId, speech, loopResult.intent, loopResult.ui.data);

    schedulePostChatMemoryIfNeeded(message, speech, loopResult.intent);
    scheduleMemoryExtraction(message, speech, sessionId);
    scheduleEpisodicMemoryWrite(sessionId, loopResult.intent, loopResult.tool || null);

    const tDone = Date.now();

    return {
      ok: true,
      payload: {
        speech,
        ui: loopResult.ui,
        intent: loopResult.intent,
        state: stateForResponse(nextState),
        status: "complete",
        timings: {
          promptBuildMs: tPromptBuilt - tPromptStart,
          claudeMs: tClaude - tPromptBuilt,
          toolsMs: tDone - tClaude,
          totalMs: tDone - t0
        }
      }
    };
  } catch (error) {
    logServiceError("chat", "/api/chat", error);
    const state = getState(sessionId);
    return {
      ok: true,
      payload: {
        speech: "I'm here, sir. I hit a backend fault, but the operator is still online.",
        ui: { panel: null, data: [], action: null },
        intent: "error.recovery",
        state: stateForResponse(state),
        status: "complete"
      }
    };
  }
}
