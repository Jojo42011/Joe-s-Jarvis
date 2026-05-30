import { Router } from "express";
import {
  formatTranscriptForSpeech,
  saveTranscript,
  searchTranscriptsByMessage,
  summarizeTranscript
} from "../db/transcriptQueries";

export const transcriptsRouter = Router();

transcriptsRouter.post("/transcripts/summarize", async (req, res, next) => {
  try {
    const rawTranscript = String(req.body?.rawTranscript || "").trim();
    const durationSeconds = Number(req.body?.durationSeconds || 0);
    const date = String(req.body?.date || new Date().toISOString().slice(0, 10));

    if (!rawTranscript) {
      res.status(400).json({ error: "rawTranscript is required" });
      return;
    }

    const summaryResult = await summarizeTranscript(rawTranscript);
    const row = saveTranscript({
      title: summaryResult?.title || "Job site recording",
      date,
      durationSeconds: Math.max(0, durationSeconds),
      rawTranscript,
      summary: summaryResult?.summary || null,
      actionItems: summaryResult?.actionItems || null
    });

    const mins = Math.max(1, Math.round(durationSeconds / 60));
    const brief = summaryResult?.summary?.split(/[.!?]/)[0]?.trim() || "Summary saved.";
    const speech = `Stored sir. ${mins} minute recording summarized. ${brief}.`;

    res.json({
      transcriptId: row.id,
      title: row.title,
      summary: row.summary,
      actionItems: row.actionItems,
      speech
    });
  } catch (error) {
    const rawTranscript = String(req.body?.rawTranscript || "").trim();
    if (rawTranscript) {
      try {
        const row = saveTranscript({
          date: String(req.body?.date || new Date().toISOString().slice(0, 10)),
          durationSeconds: Number(req.body?.durationSeconds || 0),
          rawTranscript,
          summary: null,
          actionItems: null
        });
        res.json({
          transcriptId: row.id,
          summary: null,
          speech: "Stored sir. Summary unavailable but the raw transcript is saved."
        });
        return;
      } catch (inner) {
        next(inner);
        return;
      }
    }
    next(error);
  }
});

transcriptsRouter.get("/transcripts/search", (req, res) => {
  const q = String(req.query?.q || "").trim();
  const rows = searchTranscriptsByMessage(q || "recent", 8);
  res.json({
    transcripts: rows.map((r) => ({
      id: r.id,
      title: r.title,
      date: r.date,
      durationSeconds: r.durationSeconds,
      summary: r.summary,
      actionItems: r.actionItems,
      when: formatTranscriptForSpeech(r)
    }))
  });
});
