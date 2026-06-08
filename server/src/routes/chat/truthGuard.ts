import { getExecutionLogToday } from "../../db/queries";
import { humanizeLogSummary, isOperatorFacingLog } from "../../utils/executionSummary";

export function enforceTruthfulSpeech(
  speech: string,
  intent: string,
  toolConfirmedSend: boolean
) {
  const claimsAction = /\b(sent|replied|handled.*send|fired off|shoot.*over)\b/i.test(speech);
  const sendIntent = intent === "gmail.send_reply" || intent === "execute.send";

  if (claimsAction && !sendIntent && !toolConfirmedSend) {
    const logs = getExecutionLogToday(5).filter(
      (l) => l.result === "success" && isOperatorFacingLog(l)
    );
    if (logs.length) {
      return `Checking the log, sir. ${humanizeLogSummary(logs[0].summary)}`;
    }
    return "I have not confirmed that send in my execution log yet, sir. Say the word and I will send it now.";
  }

  return speech;
}
