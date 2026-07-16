/**
 * Integration catalog — the "hands" library for Jarvis.
 *
 * This is the map of every service the Intelligence can plug into. Status is
 * resolved live from the environment: a tool with all its env keys present reports
 * `connected`; `available` means it's wired and ready to switch on; `planned` is on
 * the roadmap (the path forward). The Integrations dashboard renders this catalog.
 *
 * Adding a new hand = one entry here. Keep it the single source of truth.
 */

import { anyGoogleAccountConnected, accountHasScope } from '../db/google';
import { GOOGLE_ACCOUNTS } from './google';

/** The mailbox that authorizes Search Console access (owns Full permission on the property). */
const SEARCH_CONSOLE_ACCOUNT = GOOGLE_ACCOUNTS[0]?.email ?? 'totallyoutdoors@gmail.com';

export type IntegrationStatus = 'connected' | 'available' | 'planned';

export interface IntegrationDef {
  id: string;
  name: string;
  category: string;
  description: string;
  /** Env keys that, when all present, mark this integration connected. */
  envKeys?: string[];
  /** Status when env keys are absent (or when there are none to check). */
  fallback: IntegrationStatus;
}

export interface IntegrationView extends Omit<IntegrationDef, 'envKeys' | 'fallback'> {
  status: IntegrationStatus;
  configured: boolean;
}

export const CATEGORY_ORDER = [
  'Google Workspace',
  'Voice & Telephony',
  'AI & Reasoning',
  'Search & Web',
  'Leads & CRM',
  'Payments & Finance',
  'Website & SEO',
  'Social Media',
  'Messaging',
];

export const INTEGRATIONS: IntegrationDef[] = [
  // ── Google Workspace (the immediate path forward) ──
  { id: 'google_calendar', name: 'Google Calendar', category: 'Google Workspace', description: 'Book on-site inspections, protect Joe\'s time, and reschedule around the build calendar.', envKeys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], fallback: 'planned'},
  { id: 'gmail', name: 'Gmail', category: 'Google Workspace', description: 'Read, draft, and send email in Joe\'s voice; flag what needs him and handle the rest.', envKeys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], fallback: 'planned'},
  { id: 'google_contacts', name: 'Google Contacts', category: 'Google Workspace', description: 'Keep every client, sub, and vendor in sync with the memory graph.', envKeys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], fallback: 'planned'},
  { id: 'google_drive', name: 'Google Drive', category: 'Google Workspace', description: 'Store and retrieve designs, contracts, permits, and 3D renderings.', envKeys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], fallback: 'planned'},
  { id: 'google_sheets', name: 'Google Sheets', category: 'Google Workspace', description: 'Read and update job trackers, pricing sheets, and the lead pipeline.', envKeys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], fallback: 'planned'},

  // ── Voice & Telephony (already live) ──
  { id: 'vapi', name: 'Vapi', category: 'Voice & Telephony', description: 'Sofia — inbound receptionist and outbound sales calls with automatic lead capture.', envKeys: ['VAPI_API_KEY'], fallback: 'available' },
  { id: 'elevenlabs', name: 'ElevenLabs', category: 'Voice & Telephony', description: 'Jarvis\'s realtime voice — Scribe speech-to-text and low-latency TTS.', envKeys: ['ELEVENLABS_API_KEY'], fallback: 'available' },
  { id: 'sms_gate', name: 'SMS Gateway (sms-gate.app)', category: 'Messaging', description: 'Live outbound texting from Joe\'s own Android device — manual, operator-sent texts from the CRM (automated texting to leads is off).', fallback: 'available' },
  { id: 'twilio_sms', name: 'Twilio SMS', category: 'Messaging', description: 'Two-way texting on a dedicated business number — inbound texts trigger Jarvis, outbound reminders and confirmations.', envKeys: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'], fallback: 'planned' },

  // ── AI & Reasoning ──
  { id: 'openai', name: 'OpenAI', category: 'AI & Reasoning', description: 'Jarvis\'s conversational brain and the embeddings behind semantic memory recall.', envKeys: ['OPENAI_API_KEY'], fallback: 'available' },
  { id: 'anthropic', name: 'Anthropic Claude', category: 'AI & Reasoning', description: 'Memory extraction, reflection, weekly synthesis, and briefings.', envKeys: ['ANTHROPIC_API_KEY'], fallback: 'available' },
  { id: 'gemini', name: 'Google Gemini', category: 'AI & Reasoning', description: 'Lauren\'s SEO research (Google-grounded) and AI image generation for pages.', envKeys: ['GEMINI_API_KEY'], fallback: 'available' },

  // ── Search & Web ──
  { id: 'brave', name: 'Brave Search', category: 'Search & Web', description: 'Real-time web search for pricing, competitors, and current information.', envKeys: ['BRAVE_API_KEY'], fallback: 'available' },

  // ── Website & SEO (already live) ──
  { id: 'github', name: 'GitHub', category: 'Website & SEO', description: 'Lauren publishes SEO pages by committing straight to the live website repo.', envKeys: ['GITHUB_TOKEN'], fallback: 'available' },
  { id: 'google_search_console', name: 'Google Search Console', category: 'Website & SEO', description: 'Real search rankings, impressions, and clicks for totallyoutdoorsllc.com feeding Lauren\'s SEO work.', envKeys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], fallback: 'planned' },

  // ── Social Media (already live) — real Paulie analytics + publishing via Zernio ──
  { id: 'zernio', name: 'Zernio (Instagram + Facebook)', category: 'Social Media', description: 'Real followers, engagement, reach, and per-post stats for Paulie\'s dashboard, plus one-tap publishing to the connected Instagram and Facebook accounts.', envKeys: ['ZERNIO_API_KEY'], fallback: 'planned' },

  // ── Leads & CRM (live) ──
  { id: 'crm', name: 'CRM / Pipeline', category: 'Leads & CRM', description: 'Full lead pipeline — every source counted, automated email confirmation on intake (texting stays manual), payments, and activity timeline.', fallback: 'available' },
  { id: 'google_business', name: 'Google Business Profile', category: 'Leads & CRM', description: 'Reviews, calls, and map visibility feeding the lead loop.', fallback: 'planned' },

  // ── Payments & Finance ──
  { id: 'stripe', name: 'Stripe', category: 'Payments & Finance', description: 'Real hosted Checkout payment links for deposits and design fees, generated straight from a lead\'s Payments tab; a webhook marks it paid automatically.', envKeys: ['STRIPE_SECRET_KEY'], fallback: 'planned' },
  { id: 'quickbooks', name: 'QuickBooks', category: 'Payments & Finance', description: 'Invoices, cash flow, and margins surfaced into the morning brief.', fallback: 'planned' },
];

const GOOGLE_IDS = new Set(['google_calendar', 'gmail', 'google_contacts', 'google_drive', 'google_sheets']);

function isConfigured(def: IntegrationDef): boolean {
  // Google tools count as connected only once a mailbox has actually authorized.
  if (GOOGLE_IDS.has(def.id)) {
    return def.envKeys!.every((k) => !!process.env[k]) && anyGoogleAccountConnected();
  }
  // Search Console needs the specific mailbox re-authed with the webmasters scope,
  // not just any mailbox connected — the scope was added after the original grants.
  if (def.id === 'google_search_console') {
    return def.envKeys!.every((k) => !!process.env[k]) && accountHasScope(SEARCH_CONSOLE_ACCOUNT, 'webmasters');
  }
  if (!def.envKeys || def.envKeys.length === 0) return false;
  return def.envKeys.every((k) => !!process.env[k]);
}

/** Resolve the catalog against the current environment. */
export function resolveIntegrations(): IntegrationView[] {
  return INTEGRATIONS.map((def) => {
    const configured = isConfigured(def);
    const status: IntegrationStatus = configured ? 'connected' : def.fallback;
    return {
      id: def.id,
      name: def.name,
      category: def.category,
      description: def.description,
      status,
      configured,
    };
  });
}

export function integrationCounts(views: IntegrationView[]) {
  return {
    total: views.length,
    connected: views.filter((v) => v.status === 'connected').length,
    available: views.filter((v) => v.status === 'available').length,
    planned: views.filter((v) => v.status === 'planned').length,
  };
}
