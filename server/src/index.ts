import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { createServer } from "node:http";
import { healthRouter } from "./routes/health";
import { chatRouter } from "./routes/chat";
import { rundownRouter } from "./routes/rundown";
import { voiceRouter } from "./routes/voice";
import { authRouter } from "./routes/auth";
import { emailsRouter } from "./routes/emails";
import { deepgramRouter } from "./routes/deepgram";
import { callsRouter } from "./routes/calls";
import { intelligenceRouter } from "./routes/intelligence";
import { documentsRouter } from "./routes/documents";
import { memoryRouter } from "./routes/memory";
import { transcriptsRouter } from "./routes/transcripts";
import { notesRouter } from "./routes/notes";
import { attachDeepgramSttProxy } from "./services/deepgramSttProxy";
import { brainCycle } from "./brain/cycle";
import { startDailySynthesisScheduler } from "./memory/synthesisEngine";
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
app.use("/api", voiceRouter);
app.use("/api", authRouter);
app.use("/api", emailsRouter);
app.use("/api", deepgramRouter);
app.use("/api", callsRouter);
app.use("/api", intelligenceRouter);
app.use("/api", documentsRouter);
app.use("/api", memoryRouter);
app.use("/api", transcriptsRouter);
app.use("/api", notesRouter);

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

const server = createServer(app);
attachDeepgramSttProxy(server);

server.listen(port, "0.0.0.0", () => {
  console.log(`JARVIS core online at http://localhost:${port}`);
  console.log(`LAN access: use http://<this-machine-ip>:${port} from your phone`);
  void brainCycle();
  startDailySynthesisScheduler();
  setInterval(() => {
    void brainCycle();
  }, 5 * 60 * 1000);
});
