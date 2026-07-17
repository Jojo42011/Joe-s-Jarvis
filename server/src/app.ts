import express from 'express';

import cors from 'cors';

import dotenv from 'dotenv';

import path from 'path';

import http from 'http';

import { handleDeepgramUpgrade } from './ws/deepgramProxy';

import { WebSocketServer } from 'ws';

import { initDb } from './db/schema';

import healthRouter from './routes/health';

import brainRouter from './routes/brain';

import voiceRouter from './routes/voice';

import memoryRouter from './routes/memory';

import leadsRouter from './routes/leads';

import callsRouter from './routes/calls';

import vapiWebhookRouter from './routes/vapiWebhook';

import seoRouter from './routes/seo';

import integrationsRouter from './routes/integrations';

import googleRouter from './routes/google';

import ralphRouter from './routes/ralph';

import stripeWebhookRouter from './routes/stripeWebhook';

import authRouter from './routes/auth';

import { apiAuthGuard, pageAuthGuard, seedDefaultOwner, userFromRequest } from './services/auth';

import { registerClient, startHeartbeat } from './ws/hub';

import { scheduleDailyDecay, scheduleWeeklySynthesis, scheduleSeoAgent, scheduleSeoPublish, scheduleSeoLiveCheck, scheduleReflection, scheduleInboxSync, scheduleSearchConsole, scheduleRalphContent, scheduleRalphPublish } from './services/crons';

import { recoverStuckSeoRunsOnStartup } from './services/seoAgent';

import { dedupeLeads } from './services/leadDedupe';

import { scheduleLeadFollowUps } from './services/leadFollowUp';

import { scheduleJunkCleanup } from './services/crmCleanup';

import { scheduleVapiSync } from './services/vapiSync';

import { scheduleIndexingSweep } from './services/seo/indexStatus';

import { seedFounderMemory } from './seed/founderSeed';

import { backfillEmbeddings } from './services/embeddings';

import { ELEVENLABS_API_KEY, ELEVENLABS_STT_MODEL, ELEVENLABS_MODEL_ID } from './config/voice';
import { ANTHROPIC_MODEL, ANTHROPIC_FAST_MODEL } from './config/models';



dotenv.config();

// Safety net: a single unhandled rejection/exception was killing the whole
// process (exit code 1 → Fly restart → ~10s of dead air mid-conversation).
// Log the full error loudly and keep serving instead of dying — for a
// single-instance app taking live calls, staying up beats crash-restarting.
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL-CAUGHT] Unhandled promise rejection (process kept alive):', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL-CAUGHT] Uncaught exception (process kept alive):', err.stack || err);
});

initDb();

seedFounderMemory();

// Non-blocking: vectorize any facts still missing an embedding.
backfillEmbeddings().catch((err) => console.error('[Memory] backfill error:', err));

recoverStuckSeoRunsOnStartup();

// CRM hygiene: fold any duplicate-phone leads into one row per person.
try { dedupeLeads(); } catch (err) { console.error('[CRM] startup dedupe failed:', err); }

// Auth: make sure Joe can log in on a fresh database.
try { seedDefaultOwner(); } catch (err) { console.error('[Auth] owner seed failed:', err); }



const app = express();

const server = http.createServer(app);



app.use(cors());

app.use('/api/webhooks', vapiWebhookRouter);

app.use('/api/webhooks', stripeWebhookRouter);

// 10mb: CRM vault photo uploads arrive as base64 JSON (~6MB file cap + overhead).
app.use(express.json({ limit: '10mb' }));

// Auth wall: webhooks above stay open; everything below requires a session
// (with a small public allowlist — health, the lead form, Zernio media).
app.use(apiAuthGuard);
app.use(pageAuthGuard);

app.use('/api', authRouter);

app.use('/api/health', healthRouter);

app.use('/api/brain', brainRouter);

app.use('/api/voice', voiceRouter);

app.use('/api/memory', memoryRouter);

app.use('/api', leadsRouter);

app.use('/api', callsRouter);

app.use('/api', seoRouter);

app.use('/api', integrationsRouter);

app.use('/api', googleRouter);

app.use('/api', ralphRouter);



const clientPath = path.join(__dirname, '../../client');

app.use(express.static(clientPath, { index: false }));

app.get('/', (_req, res) => {

  res.sendFile(path.join(clientPath, 'shell.html'));

});

app.get('/deck', (_req, res) => {

  res.sendFile(path.join(clientPath, 'dashboard.html'));

});

app.get('/arlo', (_req, res) => {

  res.sendFile(path.join(clientPath, 'index.html'));

});

app.get('/chat', (_req, res) => {

  res.sendFile(path.join(clientPath, 'chat.html'));

});

app.get('/calls', (_req, res) => {

  res.sendFile(path.join(clientPath, 'calls.html'));

});

app.get('/memory', (_req, res) => {

  res.sendFile(path.join(clientPath, 'memory.html'));

});

app.get('/crm', (_req, res) => {

  res.sendFile(path.join(clientPath, 'crm.html'));

});

app.get('/login', (_req, res) => {

  res.sendFile(path.join(clientPath, 'login.html'));

});

app.get('/integrations', (_req, res) => {

  res.sendFile(path.join(clientPath, 'integrations.html'));

});

app.get('/inbox', (_req, res) => {

  res.sendFile(path.join(clientPath, 'inbox.html'));

});




// Manual WebSocket upgrade routing (hub + Scribe STT proxy)

const hubWss = new WebSocketServer({ noServer: true });

hubWss.on('connection', (ws, req) => {

  console.log('[HubWS] client connected', req.socket.remoteAddress || 'unknown');

  registerClient(ws);

});



server.on('upgrade', (req, socket, head) => {

  const host = req.headers.host || 'localhost';

  let pathname = '';

  try {

    pathname = new URL(req.url || '/', `http://${host}`).pathname;

  } catch {

    pathname = req.url?.split('?')[0] || '';

  }



  console.log('[Upgrade]', pathname, {

    origin: req.headers.origin || '(none)',

    remote: req.socket.remoteAddress || 'unknown',

  });

  // WS auth: the STT proxy streams paid ElevenLabs transcription and the hub
  // broadcasts internal state — both owner-session only.
  const wsUser = userFromRequest(req as unknown as express.Request);
  if (!wsUser || wsUser.role !== 'owner') {
    console.warn('[Upgrade] rejected unauthenticated WS:', pathname);
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  if (handleDeepgramUpgrade(req, socket, head)) return;



  if (pathname === '/ws') {

    hubWss.handleUpgrade(req, socket, head, (ws) => {

      hubWss.emit('connection', ws, req);

    });

    return;

  }



  console.warn('[Upgrade] no handler for path — destroying socket:', pathname);

  socket.destroy();

});



startHeartbeat();

scheduleDailyDecay();

scheduleWeeklySynthesis();

// SEO (Lauren) and social content (Paulie) removed from Joe's build — their
// autonomous schedulers are disabled so nothing publishes/generates in the
// background. Re-enable if those agents ever come back.
// scheduleSeoAgent();
// scheduleSeoPublish();
// scheduleSeoLiveCheck();
// scheduleSearchConsole();
// scheduleRalphContent();
// scheduleRalphPublish();
// scheduleIndexingSweep();

scheduleReflection();

scheduleInboxSync();

scheduleLeadFollowUps();

scheduleJunkCleanup();

// Sofia (phone) stays — keep the Vapi call sync running.
scheduleVapiSync();



const PORT = process.env.PORT || 3000;



server.listen(PORT, () => {

  console.log(`[Jarvis] System online. Port ${PORT}.`);

  console.log('[Jarvis] Pipeline: ElevenLabs Scribe → Claude → ElevenLabs TTS');

  console.log('[Brain] ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? `set (${process.env.ANTHROPIC_API_KEY.length} chars)` : 'MISSING — brain will be unavailable');

  console.log('[Brain] Models:', ANTHROPIC_MODEL, '(main)', '|', ANTHROPIC_FAST_MODEL, '(fast)');

  console.log('[Voice] STT path: /api/voice/deepgram/listen');

  console.log('[Voice] ELEVENLABS_API_KEY:', ELEVENLABS_API_KEY ? `set (${ELEVENLABS_API_KEY.length} chars)` : 'MISSING');

  console.log('[Voice] STT model:', ELEVENLABS_STT_MODEL, '| TTS model:', ELEVENLABS_MODEL_ID);

});


