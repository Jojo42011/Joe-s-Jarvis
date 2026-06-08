import "dotenv/config";

import express from "express";

import cors from "cors";

import path from "node:path";

import { healthRouter } from "./routes/health";

import { chatRouter } from "./routes/chat";

import { rundownRouter } from "./routes/rundown";

import { authRouter } from "./routes/auth";

import { emailsRouter } from "./routes/emails";

import { callsRouter } from "./routes/calls";

import { intelligenceRouter } from "./routes/intelligence";

import { documentsRouter } from "./routes/documents";

import { memoryRouter } from "./routes/memory";

import { transcriptsRouter } from "./routes/transcripts";

import { notesRouter } from "./routes/notes";

import { queueRouter } from "./routes/queue";

import { geminiLiveRouter } from "./routes/geminiLive";

import { isGeminiConfigured } from "./config/gemini";

import { brainCycle } from "./brain/cycle";

import { startDailySynthesisScheduler } from "./memory/synthesisEngine";

import { runDueDomainResearch } from "./brain/domainResearch";

import { requestContextMiddleware } from "./middleware/requestContext";

import "./db";



const app = express();

const port = Number(process.env.PORT || 3000);

const clientPath = path.resolve(__dirname, "../../client");



app.use(cors());

app.use(express.json({ limit: "2mb" }));

app.use(express.static(clientPath));

app.use("/api", requestContextMiddleware);



app.use("/api", healthRouter);

app.use("/api", chatRouter);

app.use("/api", rundownRouter);

app.use("/api", authRouter);

app.use("/api", emailsRouter);

app.use("/api", callsRouter);

app.use("/api", intelligenceRouter);

app.use("/api", documentsRouter);

app.use("/api", memoryRouter);

app.use("/api", transcriptsRouter);

app.use("/api", notesRouter);

app.use("/api", queueRouter);

app.use("/api", geminiLiveRouter);



app.get("*", (_req, res) => {

  res.sendFile(path.join(clientPath, "index.html"));

});



app.use(

  (

    error: unknown,

    _req: express.Request,

    res: express.Response,

    _next: express.NextFunction

  ) => {

    console.error(error);

    res.status(500).json({

      error: "JARVIS core fault",

      detail: error instanceof Error ? error.message : "Unknown server error"

    });

  }

);



app.listen(port, "0.0.0.0", () => {

  console.log(`JARVIS core online at http://localhost:${port}`);

  console.log(

    `[gemini-live] startup — key ${isGeminiConfigured() ? "present" : "MISSING"}, model ${process.env.GEMINI_LIVE_MODEL || "models/gemini-3.1-flash-live-preview"}`

  );

  console.log(`LAN access: use http://<this-machine-ip>:${port} from your phone`);

  void brainCycle();

  startDailySynthesisScheduler();



  // Domain research — every 30 minutes; each domain has its own interval in researchDomains.ts

  setInterval(() => {

    void runDueDomainResearch().catch((err) => {

      console.error("[domain-research]", err);

    });

  }, 30 * 60 * 1000);



  setTimeout(() => {

    void runDueDomainResearch().catch((err) => {

      console.error("[domain-research-startup]", err);

    });

  }, 120_000);



  setInterval(() => {

    void brainCycle();

  }, 5 * 60 * 1000);

});


