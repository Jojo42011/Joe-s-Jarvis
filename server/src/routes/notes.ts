import { Router } from "express";
import { getRecentNotes, searchNotes } from "../db/queries";
import { createNoteFromInput } from "../services/notes";

export const notesRouter = Router();

notesRouter.post("/notes", async (req, res, next) => {
  try {
    const content = String(req.body?.content || "").trim();
    const sourceRaw = String(req.body?.source || "manual");
    const source = sourceRaw === "voice" ? "voice" : "manual";

    if (!content) {
      res.status(400).json({ error: "content is required" });
      return;
    }

    const { note, entities, entityAnnotations } = await createNoteFromInput(content, source);

    res.json({
      success: true,
      note,
      entities,
      entityAnnotations
    });
  } catch (error) {
    next(error);
  }
});

notesRouter.get("/notes", (req, res, next) => {
  try {
    const limit = Number(req.query.limit || 20);
    const notes = getRecentNotes(Number.isFinite(limit) ? limit : 20);
    res.json({ notes });
  } catch (error) {
    next(error);
  }
});

notesRouter.get("/notes/search", (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) {
      res.status(400).json({ error: "q is required" });
      return;
    }
    const notes = searchNotes(q);
    res.json({ notes });
  } catch (error) {
    next(error);
  }
});
