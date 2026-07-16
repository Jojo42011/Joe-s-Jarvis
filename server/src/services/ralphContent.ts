// ─── Paulie — lead-generating content engine ────────────────────────────────────
// Paulie is Aquatic Pool & Spa's content manager AND social strategist. His job is
// not "make pool pictures" — it's to produce professional, scroll-stopping content
// that turns strangers into booked design consultations for Arthur.
//
// The playbook (grounded in what actually drives leads for high-ticket local home
// services on Instagram, 2025):
//   • BUILD-JOURNEY REELS (dirt → gunite → plaster, narrated) outperform finished-
//     pool photos ~8:1 on saves/shares/DMs.
//   • FIRST-FILL / REVEAL REELS with real faces + reactions are the highest-DM posts
//     — they collapse the trust gap in seconds.
//   • EDUCATIONAL / COST-BREAKDOWN CAROUSELS (8–10 slides) are the highest-SAVED
//     format and build the authority a $40k–$1M buyer needs before they inquire.
//   • Every post ends with a specific KEYWORD DM CTA ("Comment DESIGN…") — those
//     convert 5–15% vs ~1–3% for "link in bio."
// Paulie outputs the finished caption + hashtags + CTA, a shoot-ready reel script or
// slide-by-slide carousel plan, and purpose-built AI imagery. Everything lands as a
// draft in the Approvals queue for Arthur's sign-off.

import {
  createRalphContent, getRalphContent, setRalphPublished, setRalphPublishError, RalphItem,
} from '../db/ralph';
import { getDb } from '../db/schema';
import { geminiSeoGenerate, hasGeminiKey, stripMarkdownFences } from './geminiSeo';
import { generateSocialImage, attachImagesToContent, getImageBytes, getContentImageIds } from './seo/images';
import { renderReelVideo } from './seo/reelVideo';
import { saveRalphVideo, getRalphVideoBytes } from '../db/ralph';
import { getBusinessProfile, contactPageUrl } from './seo/businessProfile';
import { publishToZernio, isZernioChannel, hasZernio } from './zernio';

const GEN_CHANNELS = ['instagram', 'facebook', 'gbp', 'blog', 'email'] as const;
type GenChannel = (typeof GEN_CHANNELS)[number];

export type PostFormat = 'single' | 'carousel' | 'reel' | 'before_after' | 'offer';

// ── The content strategy: proven, lead-driving "plays" ─────────────────────────
// goal: 'lead' (drives DMs/inquiries), 'trust' (authority/saves), 'reach' (top of
// funnel). The batch planner weights toward lead + trust and the money formats
// (reels + carousels).
// Tone mode for plays where a specific emotional register should dominate.
// Unset = the baseline trustworthy/expert voice (education, process, local plays).
type ToneMode = 'luxury' | 'family' | 'urgency';
const TONE_MODES: Record<ToneMode, string> = {
  luxury: 'LUXURY / PREMIUM tone: elevated, aspirational, confident — sell the transformation and the status of a backyard built right. Polished, not corporate.',
  family: 'FAMILY-FOCUSED tone: warm, safe, real — sell the memories (kids learning to swim, summer nights, the backyard everyone gathers in). Safety and togetherness over spec sheets.',
  urgency: 'URGENCY-DRIVEN tone: direct and time-aware — sell the cost of waiting (shrinking build slots, swimming sooner vs. later). Real urgency only, never fabricated deadlines or fake scarcity.',
};

interface Play {
  key: string;
  format: PostFormat;
  goal: 'lead' | 'trust' | 'reach';
  tone?: ToneMode;
  brief: string;
}
const PLAYS: Play[] = [
  { key: 'build_journey', format: 'reel', goal: 'lead',
    brief: 'A build-journey reel: one backyard going from dirt to gunite to sparkling water. Narrate ONE specific problem you solved. Hook like "Day 1 of a $90,000 backyard — swipe to day 60." This is the single best-performing format — make it feel like a story the buyer can follow.' },
  { key: 'first_fill_reveal', format: 'reel', goal: 'lead', tone: 'family',
    brief: 'A reveal reel: the first fill / first swim, real reactions, the wow moment. The trust-collapsing "here it is" payoff. Cinematic, emotional, aspirational — this is the family\'s first summer in their own backyard.' },
  { key: 'cost_breakdown', format: 'carousel', goal: 'lead',
    brief: 'A transparent cost-breakdown carousel: what actually drives the price of a custom pool (excavation, steel, gunite, tile/finish, decking, water features) and where the ranges land. Transparency on a high-ticket buy builds massive trust. Use real ranges, never invented exact prices.' },
  { key: 'five_things', format: 'carousel', goal: 'trust',
    brief: 'An educational carousel: "5 things to know before you build a pool in Arizona" (or similar). Genuinely useful, objection-handling, expert. The highest-saved kind of post.' },
  { key: 'myth_buster', format: 'carousel', goal: 'trust',
    brief: 'A myth-buster carousel: bust 3–5 common misconceptions homeowners have about building/remodeling a pool (cost, timeline, maintenance, "all builders are the same"). Authority + reassurance.' },
  { key: 'before_after', format: 'before_after', goal: 'lead', tone: 'luxury',
    brief: 'A before/after transformation: a tired old backyard/pool → a clean, modern remodel. The dramatic change is the hook. Speak to homeowners sitting on an outdated pool.' },
  { key: 'process_step', format: 'reel', goal: 'trust',
    brief: 'A satisfying process reel on ONE milestone (rebar, shotcrete/gunite pour, tile set, the 3D design reveal) and why that step is where quality is won or lost. Shows craftsmanship + expertise.' },
  { key: 'client_story', format: 'single', goal: 'lead', tone: 'family',
    brief: 'A social-proof post: a short client story/testimonial-style narrative — what they wanted, the worry, the result, how it feels now. Real, warm, specific. Moves fence-sitters.' },
  { key: 'design_trend', format: 'single', goal: 'reach', tone: 'luxury',
    brief: 'A design-inspiration post: one striking feature (tanning ledge, glass tile, infinity edge, fire+water, spa spillway, travertine decking) and why people love it. Aspirational eye-candy that still teaches.' },
  { key: 'faq', format: 'single', goal: 'trust',
    brief: 'Answer ONE real question buyers ask (how long does a build take, do you handle permits, can you remodel a 20-year-old pool, what does a basic pool start at). Clear, confident, helpful.' },
  { key: 'free_consult_offer', format: 'offer', goal: 'lead', tone: 'luxury',
    brief: 'A bold, advertising-style promo graphic for the FREE consultation — an on-site meeting / estimate where Arthur walks the customer\'s own backyard and scopes the project. Big benefit-driven headline, one supporting line, a badge. This is the flagship lead offer — punchy like a real pool-company ad, but honest: the CONSULTATION/ESTIMATE/ON-SITE MEETING is free; the photorealistic 3D rendering is a paid design step later in the process, NEVER call the 3D design itself free.' },
  { key: 'financing_offer', format: 'offer', goal: 'lead', tone: 'family',
    brief: 'A bold, advertising-style promo for financing — "your backyard, built now, paid monthly." Make owning a custom pool feel attainable for a normal family. Punchy ad copy; only say financing is available (true), never invent specific rates, dollar amounts, or promotional deadlines.' },
  { key: 'seasonal_booking', format: 'offer', goal: 'lead', tone: 'urgency',
    brief: 'A bold, advertising-style seasonal-urgency promo — "Now booking [current season] builds — beat the summer rush." Real, honest urgency tied to the build calendar (pools take weeks to build, so booking early means swimming sooner). No fabricated discounts or countdowns.' },
  { key: 'local_spotlight', format: 'single', goal: 'reach',
    brief: 'A local-pride post tied to a specific affluent Phoenix Valley city (Scottsdale, Paradise Valley, Arcadia, Chandler) — what a modern, well-built backyard means there. Signals "we build in YOUR neighborhood."' },
];

// Batch composition — a real weekly-style mix, Instagram-first, money formats first.
// (channel, playKey preference). The planner fills a batch from this rotation.
const PLAN_ROTATION: { channel: GenChannel; play: string }[] = [
  { channel: 'instagram', play: 'build_journey' },
  { channel: 'instagram', play: 'cost_breakdown' },
  { channel: 'instagram', play: 'first_fill_reveal' },
  { channel: 'instagram', play: 'five_things' },
  { channel: 'instagram', play: 'before_after' },
  { channel: 'facebook', play: 'client_story' },
  { channel: 'instagram', play: 'process_step' },
  { channel: 'instagram', play: 'myth_buster' },
  { channel: 'facebook', play: 'design_trend' },
  { channel: 'instagram', play: 'local_spotlight' },
  { channel: 'instagram', play: 'faq' },
  { channel: 'instagram', play: 'design_trend' },
];

const LEAD_KEYWORDS = ['DESIGN', 'POOL', 'QUOTE', 'BACKYARD', 'DREAM'];

export interface GeneratedPost {
  id: number;
  title: string;
  channel: string;
  format: PostFormat;
  status: string;
  body: string;
  imageUrl: string | null;
  imageCount: number;
}

interface Slide { headline: string; text: string; imagePrompt: string }
interface Scene { timecode: string; visual: string; onScreenText: string; voiceover: string }
interface PostDraft {
  title: string;
  hook: string;
  caption: string;
  captionAlt?: string;
  hashtags: string[];
  cta: string;
  imagePrompt?: string;   // single / before_after AFTER shot / reel cover
  beforePrompt?: string;  // before_after: the dated BEFORE shot (same yard)
  coverPrompt?: string;   // carousel / reel cover
  slides?: Slide[];       // carousel
  reel?: { durationSec?: number; audioSuggestion?: string; scenes?: Scene[] };
  // offer posts: bold ad copy baked onto the single image.
  overlayEyebrow?: string;
  overlayHeadline?: string;
  overlaySub?: string;
  overlayBullets?: string[];
  overlayBadge?: string;
}

// ── The strategist system prompt: brand voice + what actually gets leads ────────
function brandVoiceSystem(): string {
  const p = getBusinessProfile();
  const cities = p.serviceAreas.map((a) => a.city).slice(0, 12).join(', ');
  return [
    `You are Paulie: an expert growth marketer and elite copywriter acting as the social-media strategist and content manager for ${p.name}, a high-end custom swimming pool builder in the Phoenix Valley, Arizona. Your ONE job: write high-converting, punchy, emotionally resonant advertising copy that turns strangers into booked design consultations for Arthur. Every post is a lead-generation asset, not decoration.`,
    ``,
    `COPYWRITING RULES (non-negotiable):`,
    `- FOCUS ON THE EXPERIENCE, not the materials: don't sell "concrete, plumbing, and water" — sell backyard vacations, making memories with the kids, escaping the summer heat, the boost to property value, hosting friends. The pool is the vehicle; the feeling is the product.`,
    `- No generic AI fluff or overused buzzwords: never write "delve," "revolutionize," "testament," "unlock," "elevate," "game-changer," "unleash," "seamless," "ultimate," "in today's world," "look no further," or "resort-style oasis" / "dream backyard paradise."`,
    `- Exclamation points: at most ONE per caption, and only when it's truly earned — most captions should have zero.`,
    `- Adapt tone to the format and play (a per-play tone mode may be specified below — follow it). Never generic — always sound like a specific person said this, not a template.`,
    `- Use AIDA (Attention→Interest→Desire→Action) or PAS (Problem→Agitate→Solve) as the underlying structure where it fits — pick whichever serves the play, and don't force it where a story or listicle format works better.`,
    `- Hooks are SHORT and benefit-focused, never feature-focused: sell the outcome (the feeling of the finished backyard, the relief of a transparent quote, the confidence of hiring right) — not "we use gunite construction."`,
    `- LOCAL & TRUSTWORTHY baseline: every post should carry a thread of reliability, professional craftsmanship, and real local expertise (the Phoenix Valley, not "your area") — this is the credibility floor under whatever tone is on top.`,
    `- EVERY caption ends with a CLEAR, CONCRETE next step, not just a vague ask — name the actual thing they get (e.g. "Comment DESIGN to book your free consultation," "DM QUOTE for a free on-site estimate"), wrapped in the keyword-DM mechanic below.`,
    ``,
    `THE BUSINESS: ${p.tagline}. ${p.yearsExperience}+ years in the trade, ${p.poolsBuilt} pools built. Custom pools, spas, remodels, water features, hardscape + landscape. New builds ~$35k–$1M; remodels ~$5k–$100k; a basic pool starts around ${p.minProject}. The paid photorealistic 3D design is the main closing tool.`,
    `THE FOUNDER: Arthur Garcia learned pools from the ground up — service and repair before builds — so the work is mechanically right, not just pretty. Family legacy, not a paycheck. Signature line, used sparingly: "If you can dream it, we can build it."`,
    `SERVICE AREA: ${cities}. Never claim areas outside the Phoenix Valley.`,
    `AUDIENCE: everyday-to-affluent AZ homeowners considering a $35k–$150k backyard (some go higher, but most are normal upper-middle-class families). They are skeptical, doing research, and terrified of hiring the wrong builder. Content must reduce that fear and prove expertise.`,
    `AESTHETIC & TONE: keep it GROUNDED and ATTAINABLE. Show and describe clean, modern, realistic backyards a normal homeowner can picture themselves affording — aspirational but believable, not billionaire desert-resort fantasy. Favor "modern / clean / attainable" over "luxury / resort / lavish." Specificity beats hype.`,
    ``,
    `WHAT ACTUALLY DRIVES LEADS (obey this):`,
    `- HOOK IN THE FIRST LINE / FIRST 1.7 SECONDS. Stop the scroll or nothing else matters. Lead with intrigue, a number, a transformation, a cost, or a mistake to avoid — never with the brand name or a greeting.`,
    `- Optimize for SAVES, SHARES, and DMs — not likes. Saves come from genuinely useful/educational content; DMs come from a clear next step.`,
    `- TRANSPARENCY sells high-ticket. Talk real numbers, real timelines, real process. Handle objections head-on.`,
    `- END WITH A KEYWORD DM CTA. Ask people to comment or DM a specific keyword (e.g. "Comment DESIGN and we'll book your free consultation", "DM QUOTE for a free estimate", "Send a photo of your backyard and we'll tell you what fits"). Specific keywords beat "link in bio." Vary the keyword and the ask.`,
    `- THE OFFER BEHIND THE CTA — GET THIS EXACTLY RIGHT: the free thing is a CONSULTATION / ESTIMATE / ON-SITE MEETING (Arthur or the team walks their yard and scopes the project) — NEVER call the design, the 3D rendering, or the 3D preview "free." The photorealistic 3D design is a PAID service later in the process and is the star of what they'll get once they book — lean on wanting to see it ("book your free consultation — the first step toward seeing your backyard in 3D"), but the word "free" attaches ONLY to consultation/estimate/on-site meeting, never to "design" or "3D."`,
    ``,
    `HOOK PATTERNS to draw from (vary every time): "Day 1 of a $X backyard →", "What a $X pool actually gets you in Arizona", "3 mistakes homeowners make before building a pool", "POV: your backyard finally looks like this", "Everyone gets this wrong about pool costs", "Watch this plain yard become a modern backyard", "The one thing that ruins most pool remodels", "Before you sign with ANY pool builder, know this".`,
    `CAPTION FRAMEWORKS (pick what fits): AIDA (Attention→Interest→Desire→Action); PAS (Problem→Agitate→Solve→CTA); Story (they wanted / the worry / the result); Listicle; Myth→Truth.`,
    ``,
    `LINKS: the ONLY website link that ever appears in a post is the Contact Us page: ${contactPageUrl()}. Never link the homepage, a blog page, or any other URL — if a link belongs in the copy, it is exactly that contact link.`,
    ``,
    `VOICE: a sharp, confident human who loves this trade — proud, warm, a little bold. Specific and vivid about pools (finishes, water, light, materials, the feeling). Never corporate, never desperate, no fake scarcity, no clickbait you can't back up. You may reference the phone ${p.phone}. Never invent exact prices beyond the ranges above. Tasteful emojis on IG/FB (0–4), never a string of them. Never say "Absolutely," "Certainly," "Great question," or that you are an AI.`,
  ].join('\n');
}

// ── Format-aware output contract ───────────────────────────────────────────────
function formatInstructions(format: PostFormat, channel: GenChannel): string {
  const kw = LEAD_KEYWORDS[Math.floor(Date.now() / 3600000) % LEAD_KEYWORDS.length];
  const common = `Write for ${channel}. The "hook" is the first line / first 1.7s and must stop the scroll. The "cta" must be a specific keyword DM ask (suggested keyword: "${kw}", but choose what fits). "hashtags": 8–15 for Instagram (mix broad + local + niche: #ArizonaPools #ScottsdalePools #PoolBuilder #BackyardGoals #PoolRemodel), 3–6 for Facebook.
QUALITY BAR: Vary the hook pattern and caption structure every time — never reuse the same opening formula. Sound like a real, specific person: name real materials, steps, timelines, and numbers instead of generic hype (banned filler and buzzwords per the copywriting rules above). Keep it grounded and attainable, not lavish. Emojis: 0–3 max, never in the hook, never stacked. At most one exclamation point in the whole caption — most captions should have none.
ALSO include a top-level "captionAlt" key: a SECOND, distinctly different caption for this same post — a different hook and angle (e.g. if the main caption leads with cost, the alt leads with a story or a mistake-to-avoid), same rules and CTA. Arthur picks whichever lands better.`;
  switch (format) {
    case 'reel':
      return `${common}
This is a REEL (short vertical video, 15–30s) — the highest-reach, highest-DM format. Produce a SHOOT-READY script Arthur (or an editor) can film on a phone. Return these keys:
{
 "title": "internal title",
 "hook": "the on-screen hook text for the first 1.7s",
 "caption": "the full IG caption (hook line + 2–4 vivid sentences)",
 "hashtags": ["#Tag"],
 "cta": "keyword DM call to action",
 "coverPrompt": "vivid photo description for the reel COVER frame (a real Arizona backyard scene; a person/real reaction is allowed and encouraged for reveals)",
 "reel": {
   "durationSec": 20,
   "audioSuggestion": "type of trending/uplifting audio or 'real job-site sound + voiceover'",
   "scenes": [ { "timecode": "0-3s", "visual": "what's on screen", "onScreenText": "big caption text", "voiceover": "what's said" } ]
 }
}
Give 4–7 scenes that tell a clear before→after / problem→payoff story.`;
    case 'carousel':
      return `${common}
This is a CAROUSEL (swipeable) — the highest-SAVED format, built to teach and build authority. Return these keys:
{
 "title": "internal title",
 "hook": "slide-1 headline that makes people swipe",
 "caption": "the IG caption that runs under the carousel (hook + context + CTA)",
 "hashtags": ["#Tag"],
 "cta": "keyword DM call to action",
 "coverPrompt": "vivid photo description for the cover slide (a real, modern, attainable AZ backyard — grounded, not a resort)",
 "slides": [ { "headline": "big slide title", "text": "1–2 tight sentences", "imagePrompt": "photo description for this slide (no text in the image)" } ]
}
Give 6–9 slides: slide 1 = the hook, middle slides = the value/teaching, last slide = the CTA. Make it genuinely useful and objection-handling.`;
    case 'offer':
      return `${common}
This is an OFFER / PROMO post — a single BOLD advertising graphic, the kind a real pool company runs (think a loud, high-energy promo flyer). The image carries LARGE benefit-driven copy baked on top: a punchy attention line, a HUGE headline, a supporting line, and a few ✓ benefit bullets. Go big and confident. Return these keys:
{
 "title": "internal title",
 "hook": "the scroll-stopping first line of the caption",
 "caption": "the full IG caption — punchy, energetic ad copy (hook + 2–4 short benefit-driven sentences + a TRUE reason to act now)",
 "hashtags": ["#Tag"],
 "cta": "keyword DM call to action",
 "overlayEyebrow": "a short ALL-CAPS attention line, 2–4 words, high energy (e.g. 'LIMITED SPRING SLOTS', 'YOUR YEAR TO BUILD', 'DON'T WAIT FOR SUMMER', 'FREE CONSULTATION')",
 "overlayHeadline": "the HUGE headline — 2–5 words, maximum punch (e.g. 'YOUR DREAM BACKYARD', 'BUILD NOW, SWIM SOONER', 'LET'S WALK YOUR YARD')",
 "overlaySub": "one supporting line under the headline (≤9 words)",
 "overlayBullets": ["3 short ✓ benefit phrases, ≤5 words each (e.g. 'Free on-site consultation', 'Financing available', 'Booking now for this season')"],
 "overlayBadge": "a tiny corner tag, 1–2 words (e.g. 'FREE CONSULT', 'FREE ESTIMATE', 'FINANCING', 'NOW BOOKING')",
 "imagePrompt": "vivid photo description of a modern, attainable AZ backyard behind the copy — keep the LEFT and BOTTOM two-thirds calm/open so the big overlaid text is readable"
}
Honesty rules: be LOUD but TRUE. Only promote what is genuinely real — a free consultation / estimate / on-site meeting (NEVER call the design or the 3D rendering "free" — that's a paid step later in the process), that financing is available, and real seasonal timing (pools take weeks to build, so booking early means swimming sooner). NEVER invent dollar discounts, cash-back amounts, percentage-off deals, giveaways, sweepstakes, or fake countdown deadlines.`;
    case 'before_after':
      return `${common}
This is a BEFORE/AFTER transformation post — a 2-image swipe (the dated/tired BEFORE first to set up the story, then swipe to the jaw-dropping AFTER for the payoff). Return:
{
 "title": "internal title",
 "hook": "first line that sells the transformation",
 "caption": "vivid 2–4 sentence caption speaking to owners of a tired/outdated backyard",
 "hashtags": ["#Tag"],
 "cta": "keyword DM call to action",
 "imagePrompt": "photo description of the AFTER — a clean, modern, believable remodeled backyard (attainable, not a resort)",
 "beforePrompt": "photo description of the SAME backyard BEFORE — dated, tired, worn (same layout and camera angle as the after, so the swipe reads as one transformation)"
}`;
    default:
      return `${common}
This is a single-image post — but the image is NOT a bare photo. Bold, professional
copy is baked onto the photo (like Shasta/Presidential/Unique's posts): a small
ALL-CAPS category tag, a big headline, and one supporting line, over a dark scrim.
So write SHORT, punchy overlay copy that reads great AT A GLANCE on the image, plus
the longer caption that runs below it. Return:
{
 "title": "internal title",
 "hook": "scroll-stopping first line of the caption",
 "caption": "vivid 2–4 sentence caption",
 "hashtags": ["#Tag"],
 "cta": "keyword DM call to action",
 "overlayEyebrow": "a 1–3 word ALL-CAPS category tag for the top of the image (e.g. 'DESIGN TIP', 'CLIENT STORY', 'ASK THE BUILDER', 'SCOTTSDALE BUILD', 'FEATURE SPOTLIGHT') — match it to the post's angle",
 "overlayHeadline": "the BIG headline baked on the image — 3–6 words, maximum punch, no period (e.g. 'Your Backyard, Reimagined', 'The Tanning Ledge Everyone Wants', 'Built Right the First Time')",
 "overlaySub": "one short supporting line under the headline, ≤9 words",
 "imagePrompt": "vivid photo description — a real, modern, attainable Arizona backyard scene that matches the post. Keep the LEFT and BOTTOM open/calm so the overlaid text is readable."
}`;
  }
}

function num(v: unknown, d: number): number { const n = Number(v); return Number.isFinite(n) ? n : d; }

function safeJson(text: string): PostDraft | null {
  const cleaned = stripMarkdownFences(text).trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const raw = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    if (!raw.title || !(raw.caption || raw.hook)) return null;
    const hashtags = Array.isArray(raw.hashtags)
      ? raw.hashtags.map((h) => String(h).replace(/^#*/, '#').replace(/\s+/g, '')).filter((h) => h.length > 1).slice(0, 15)
      : [];
    const slides = Array.isArray(raw.slides)
      ? (raw.slides as Record<string, unknown>[]).slice(0, 10).map((s) => ({
          headline: String(s.headline || '').trim(),
          text: String(s.text || '').trim(),
          imagePrompt: String(s.imagePrompt || s.headline || '').trim(),
        })).filter((s) => s.headline || s.text)
      : undefined;
    const reelRaw = raw.reel as Record<string, unknown> | undefined;
    const reel = reelRaw ? {
      durationSec: num(reelRaw.durationSec, 20),
      audioSuggestion: String(reelRaw.audioSuggestion || '').trim(),
      scenes: Array.isArray(reelRaw.scenes)
        ? (reelRaw.scenes as Record<string, unknown>[]).slice(0, 10).map((s) => ({
            timecode: String(s.timecode || '').trim(),
            visual: String(s.visual || '').trim(),
            onScreenText: String(s.onScreenText || '').trim(),
            voiceover: String(s.voiceover || '').trim(),
          }))
        : [],
    } : undefined;
    return {
      title: String(raw.title).trim().slice(0, 140),
      hook: String(raw.hook || '').trim(),
      caption: String(raw.caption || raw.hook || '').trim(),
      captionAlt: raw.captionAlt ? String(raw.captionAlt).trim() : undefined,
      hashtags,
      cta: String(raw.cta || '').trim(),
      imagePrompt: raw.imagePrompt ? String(raw.imagePrompt).trim() : undefined,
      beforePrompt: raw.beforePrompt ? String(raw.beforePrompt).trim() : undefined,
      coverPrompt: raw.coverPrompt ? String(raw.coverPrompt).trim() : undefined,
      slides,
      reel,
      overlayEyebrow: raw.overlayEyebrow ? String(raw.overlayEyebrow).trim() : undefined,
      overlayHeadline: raw.overlayHeadline ? String(raw.overlayHeadline).trim() : undefined,
      overlaySub: raw.overlaySub ? String(raw.overlaySub).trim() : undefined,
      overlayBullets: Array.isArray(raw.overlayBullets)
        ? (raw.overlayBullets as unknown[]).map((b) => String(b).trim()).filter(Boolean).slice(0, 3)
        : undefined,
      overlayBadge: raw.overlayBadge ? String(raw.overlayBadge).trim() : undefined,
    };
  } catch {
    return null;
  }
}

// ── Image prompt: modern, believable, varied (Paulie controls the aesthetic) ──
// The aesthetic is deliberately GROUNDED — clean modern residential pools a normal
// upper-middle-class homeowner could picture affording, not desert-resort fantasy.
// A per-image `variant` rotates lighting / angle / pool style / setting so the feed
// looks like a real portfolio, not the same photo over and over.
const IMG_LIGHTING = [
  'soft natural daylight', 'bright clear midday light', 'warm late-afternoon light',
  'calm overcast, evenly diffused light', 'early blue-hour dusk with subtle built-in pool lighting',
];
const IMG_ANGLE = [
  'a natural eye-level wide shot', 'a slightly elevated three-quarter view',
  'a low angle looking across the water', 'a clean, straight-on symmetrical composition',
];
const IMG_POOL = [
  'a clean modern rectangular pool', 'a simple contemporary L-shaped pool',
  'a modern pool with a raised spa and a smooth spillway', 'a modern freeform pool with restrained, clean lines',
  'a compact modern plunge pool', 'a modern pool with a small tanning ledge',
];
const IMG_SETTING = [
  'a tidy modern suburban backyard with a small lawn and simple planters',
  'a contemporary backyard with large-format concrete pavers and low, modern planting',
  'a modern backyard with warm wood-look decking and a few potted plants',
  'a clean modern patio with simple pavers, neat greenery, and a covered seating area',
];
function pick<T>(arr: T[], n: number): T { return arr[Math.abs(Math.floor(n)) % arr.length]; }

function buildSocialImagePrompt(scene: string, opts: { format: PostFormat; people?: boolean; before?: boolean; variant?: number }): string {
  const subject = (scene || '').trim() || 'a clean modern backyard swimming pool';
  const v = opts.variant ?? 0;

  // The BEFORE shot of a transformation: honest and dated, not aspirational.
  if (opts.before) {
    return [
      `Realistic, honest photograph of a dated, tired suburban backyard BEFORE a remodel. Subject: ${subject}.`,
      `Details: aging plain concrete or worn cool-deck, faded or stained pool plaster (or a plain empty yard), sparse tired landscaping, flat mid-day light. Believable, like a real contractor's "before" photo — ordinary and a little dull, but sharp and well-framed from a standing eye-level angle.`,
      `Photorealistic, natural color, no AI/CGI look (no warped tile, no melted edges). No people. No text, words, watermark, logos, or signage. Keep the lower-right corner visually calm.`,
    ].join(' ');
  }

  const people = opts.people
    ? 'A real person or two enjoying the space is welcome and adds authenticity — natural, candid, everyday, not stock-posed.'
    : 'No people.';
  const afterLine = opts.format === 'before_after'
    ? 'Show the finished remodel (the "after") — a clean, modern, genuinely nicer upgrade that still looks realistic and attainable, NOT a fantasy resort. '
    : '';
  return [
    `Realistic, natural photograph for a modern residential pool builder. Subject: ${subject}.`,
    `${afterLine}Scene: ${pick(IMG_POOL, v)} in ${pick(IMG_SETTING, v + 1)}. Contemporary, tasteful and believable — an attainable backyard of a nice everyday home, NOT an over-the-top mansion, resort, or desert showpiece. Clean modern lines, simple honest materials, realistic scale, clear natural-blue water. Keep it grounded, not flashy — minimal fire features, no infinity edges unless subtle. Exactly ONE pool and, if a spa is shown, exactly ONE spa — a real residential backyard never has two spas or two spillways, so never duplicate the spa, the raised spillway, or any other single backyard feature.`,
    `Light & framing: ${pick(IMG_LIGHTING, v)}, ${pick(IMG_ANGLE, v)}. Photorealistic, sharp, true-to-life color (not over-saturated), natural depth of field. ${people}`,
    `Avoid an AI/CGI look: no warped or melting tile or coping, no impossible reflections, no duplicated or distorted steps and railings, no plastic sheen, no fantasy over-styling, no duplicated pools or spas.`,
    // The real brand logo is composited onto the bottom-right AFTER generation —
    // the AI must not draw text/logos itself, and should keep that corner calm.
    `No text, no words, no watermark, no logos, no signage. Keep the lower-right corner of the frame visually calm and uncluttered (open water, sky, or decking — no busy detail there).`,
  ].join(' ');
}

// ── Compose the readable Approvals body (what Arthur reviews / posts) ───────────
// captionOverride swaps in the alternate caption while keeping the reel shot list /
// carousel slide plan intact (used to build the stored alt_body version).
function composeBody(d: PostDraft, format: PostFormat, channel: GenChannel, captionOverride?: string): string {
  const parts: string[] = [];
  const wantTags = channel === 'instagram' || channel === 'facebook' || channel === 'gbp';
  const caption = captionOverride ?? d.caption;

  if (format === 'reel') {
    parts.push('📱 REEL — shoot-ready script');
    if (d.hook) parts.push(`HOOK (first 1.7s): ${d.hook}`);
    if (d.reel) {
      const meta = [d.reel.durationSec ? `~${d.reel.durationSec}s` : '', d.reel.audioSuggestion ? `Audio: ${d.reel.audioSuggestion}` : ''].filter(Boolean).join(' · ');
      if (meta) parts.push(meta);
      if (d.reel.scenes?.length) {
        parts.push('SHOT LIST:\n' + d.reel.scenes.map((s, i) =>
          `${i + 1}. [${s.timecode || ''}] ${s.visual}${s.onScreenText ? `\n   ⤷ on-screen: "${s.onScreenText}"` : ''}${s.voiceover ? `\n   ⤷ say: "${s.voiceover}"` : ''}`
        ).join('\n'));
      }
    }
    parts.push('— CAPTION —');
    parts.push(caption);
  } else if (format === 'carousel') {
    parts.push(`🎠 CAROUSEL — ${d.slides?.length || 0} slides`);
    if (d.slides?.length) {
      parts.push('SLIDES:\n' + d.slides.map((s, i) =>
        `${i + 1}. ${s.headline}${s.text ? ` — ${s.text}` : ''}`
      ).join('\n'));
    }
    parts.push('— CAPTION —');
    parts.push(caption);
  } else {
    if (d.hook && !caption.startsWith(d.hook)) parts.push(d.hook);
    parts.push(caption);
  }

  if (d.cta) parts.push(`👉 ${d.cta}`);
  if (d.hashtags.length && wantTags) parts.push(d.hashtags.join(' '));
  return parts.filter(Boolean).join('\n\n');
}

// Generate images for a draft based on its format — a REAL Instagram-ready set:
// carousels get one image per slide with the slide's copy baked on (like Shasta/
// Presidential-style educational carousels), before/afters get both shots with
// BEFORE/AFTER badges, reels get a cover carrying the hook. Image gen is
// throttled (~12s each), so a full carousel takes a couple of minutes — worth it.
async function generateImagesFor(
  d: PostDraft, format: PostFormat, channel: GenChannel, id: number,
): Promise<number[]> {
  const aspect = channel === 'instagram'
    ? (format === 'reel' ? '9:16' : '4:5')
    : channel === 'blog' ? '16:9' : '4:5';
  const ids: number[] = [];
  const gen = async (
    scene: string, people: boolean, idx: number,
    text?: { eyebrow?: string; headline?: string; body?: string; bullets?: string[]; badge?: string; big?: boolean },
    before?: boolean,
  ): Promise<void> => {
    try {
      // variant rotates the look per image (id spreads across posts, idx across
      // a post's own images) so nothing repeats the same framing/lighting.
      const img = await generateSocialImage(buildSocialImagePrompt(scene, { format, people, before, variant: id * 3 + idx }), {
        slug: `${channel}-${id}-${idx}`, aspect, raw: true, brand: true, text,
      });
      if (img) ids.push(img.id);
    } catch (err) {
      console.warn('[Paulie] image gen failed (kept going):', err instanceof Error ? err.message : err);
    }
  };

  if (format === 'carousel') {
    // Cover = the hook, big. Then EVERY slide gets its own image with its copy
    // baked on, so the whole thing swipes like a finished IG carousel.
    const slides = (d.slides || []).filter((s) => s.headline || s.text).slice(0, 9);
    const cover = d.coverPrompt || slides[0]?.imagePrompt || d.title;
    await gen(cover, false, 0, { headline: d.hook || d.title });
    for (let i = 0; i < slides.length; i++) {
      const s = slides[i];
      await gen(s.imagePrompt || s.headline || cover, false, i + 1, {
        headline: s.headline, body: s.text, badge: `${i + 1}/${slides.length}`,
      });
    }
  } else if (format === 'before_after') {
    // Two-image swipe: BEFORE leads (the dated/tired starting point), AFTER
    // follows as the payoff reveal on swipe. BEFORE carries a prompt line so it
    // reads as designed (not a bare photo); AFTER gets the eyebrow + hook headline.
    const beforeScene = d.beforePrompt || `the same backyard before the remodel: ${d.imagePrompt || d.title}`;
    await gen(beforeScene, false, 0, { badge: 'BEFORE', eyebrow: 'The Starting Point', body: 'Swipe to see the transformation →' }, true);
    await gen(d.imagePrompt || d.title, false, 1, { badge: 'AFTER', eyebrow: d.overlayEyebrow || 'The Transformation', headline: d.overlayHeadline || d.hook, body: d.overlaySub });
  } else if (format === 'reel') {
    // A playable animatic: the cover carries the hook, then one frame PER scene
    // with that scene's on-screen text baked in. The UI steps through these
    // frames on a timer so the reel actually "plays" as a motion preview before
    // Arthur films the real thing.
    const revealRe = /reveal|first_fill|reaction|swim|family|kids/i;
    await gen(d.coverPrompt || d.imagePrompt || d.title, revealRe.test(d.title), 0, { headline: d.hook });
    const scenes = (d.reel?.scenes || []).filter((s) => s.visual || s.onScreenText).slice(0, 4);
    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i];
      await gen(s.visual || d.coverPrompt || d.title, revealRe.test(s.visual + ' ' + s.onScreenText), i + 1, { headline: s.onScreenText });
    }
  } else if (format === 'offer') {
    // A single BIG promo graphic with loud ad copy baked on (eyebrow + huge
    // headline + sub + ✓ bullets + badge).
    await gen(d.imagePrompt || d.title, false, 0, {
      big: true,
      eyebrow: d.overlayEyebrow,
      headline: d.overlayHeadline || d.hook,
      body: d.overlaySub,
      bullets: d.overlayBullets,
      badge: d.overlayBadge,
    });
  } else {
    // Single post — no longer a bare photo. Bake the designed text treatment on:
    // a small ALL-CAPS category eyebrow, the big headline, and one supporting line
    // (falling back to the caption hook if the model didn't return overlay copy).
    const people = format === 'single' && /lifestyle|family|kids|entertain|reaction|story/i.test(d.title);
    await gen(d.imagePrompt || d.title, people, 0, {
      eyebrow: d.overlayEyebrow,
      headline: d.overlayHeadline || d.hook || d.title,
      body: d.overlaySub,
    });
  }
  if (ids.length) attachImagesToContent(id, ids);

  // Reels: encode the frames into a real MP4 so the post actually plays as video
  // (Ken-Burns motion + crossfades). Best-effort — if ffmpeg/encoding fails, the
  // frames remain and the UI plays them as a story-style animatic instead.
  if (format === 'reel' && ids.length >= 2) {
    try {
      const buffers = ids.map((i) => getImageBytes(i)?.buffer).filter((b): b is Buffer => !!b);
      const mp4 = await renderReelVideo(buffers);
      if (mp4) { saveRalphVideo(id, mp4.toString('base64')); console.log(`[Paulie] reel #${id} rendered to video`); }
    } catch (err) {
      console.warn('[Paulie] reel video render skipped:', err instanceof Error ? err.message : err);
    }
  }
  return ids;
}

/** Generate one lead-driving post for a play on a channel, create its imagery, and
 *  store it as a draft in the Approvals queue. Returns the post, or null on failure. */
export async function generateOnePost(channel: GenChannel, playKey?: string): Promise<GeneratedPost | null> {
  if (!hasGeminiKey()) throw new Error('GEMINI_API_KEY not configured');
  const play = PLAYS.find((p) => p.key === playKey) || PLAYS[Math.floor(Date.now() / 1000) % PLAYS.length];
  // Non-visual channels (blog/email/gbp) always use the simple single format.
  const format: PostFormat = (channel === 'instagram' || channel === 'facebook') ? play.format : 'single';

  // Anti-repetition: show Paulie the most recent post titles so a fresh batch
  // explores new angles instead of converging on the same hooks and topics.
  const recentTitles = (getDb().prepare(
    'SELECT title FROM ralph_content ORDER BY id DESC LIMIT 15',
  ).all() as { title: string }[]).map((r) => r.title).filter(Boolean);

  const prompt = [
    `Create ONE high-performing ${channel} post using this proven play:`,
    `PLAY (${play.goal.toUpperCase()}): ${play.brief}`,
    play.tone ? `TONE MODE: ${TONE_MODES[play.tone]}` : `TONE MODE: baseline trustworthy/expert voice — no luxury, family, or urgency lean required here.`,
    ``,
    formatInstructions(format, channel),
    recentTitles.length
      ? `\nALREADY POSTED RECENTLY (do NOT repeat these angles, hooks, or topics — bring a genuinely different idea):\n${recentTitles.map((t) => `- ${t}`).join('\n')}`
      : '',
    ``,
    `Return ONLY the JSON object — no prose, no code fences.`,
  ].join('\n');

  let draft: PostDraft | null = null;
  try {
    const res = await geminiSeoGenerate(prompt, { system: brandVoiceSystem(), maxTokens: 3200 });
    draft = safeJson(res.text);
  } catch (err) {
    console.error('[Paulie] text generation failed:', err instanceof Error ? err.message : err);
    return null;
  }
  if (!draft) { console.warn('[Paulie] could not parse a post — skipping'); return null; }

  const body = composeBody(draft, format, channel);
  const altBody = draft.captionAlt ? composeBody(draft, format, channel, draft.captionAlt) : undefined;
  const tags = draft.hashtags.join(' ') || undefined;
  const id = createRalphContent({ title: draft.title, channel, body, status: 'draft', tags, format, alt_body: altBody });

  const imageIds = await generateImagesFor(draft, format, channel, id);
  const imageUrl = imageIds.length ? `/api/seo/img/${imageIds[0]}.png` : null;

  console.log(`[Paulie] drafted ${format} for ${channel} #${id} "${draft.title}" (${imageIds.length} img)`);
  return { id, title: draft.title, channel, format, status: 'draft', body, imageUrl, imageCount: imageIds.length };
}

// Play keys by format, used to build a guaranteed batch mix.
const REEL_PLAYS = ['build_journey', 'first_fill_reveal', 'process_step'];
const CAROUSEL_PLAYS = ['cost_breakdown', 'five_things', 'myth_buster'];
const OFFER_PLAYS = ['free_consult_offer', 'financing_offer', 'seasonal_booking'];

/** Generate a strategic batch — a real content mix built to bring leads, not
 *  just fill the calendar. Every full batch is GUARANTEED to lead with 2 reels
 *  (the highest-reach, highest-DM format), a full educational carousel, and a
 *  before/after transformation — the exact mix the winning AZ pool-builder
 *  accounts run — then rounds out with the rotation. */
export async function generateBatch(count = 5, channel?: GenChannel): Promise<GeneratedPost[]> {
  const n = Math.max(1, Math.min(count, 12));
  const seed = Math.floor(Date.now() / 60000);
  const ch = channel || 'instagram';

  // The money slots, in priority order: 2 reels → carousel → before/after → offer.
  const plan: { channel: GenChannel; play: string }[] = [
    { channel: ch, play: REEL_PLAYS[seed % REEL_PLAYS.length] },
    { channel: ch, play: REEL_PLAYS[(seed + 1) % REEL_PLAYS.length] },
    { channel: ch, play: CAROUSEL_PLAYS[seed % CAROUSEL_PLAYS.length] },
    { channel: ch, play: 'before_after' },
    { channel: ch, play: OFFER_PLAYS[seed % OFFER_PLAYS.length] },
  ];
  // Fill the rest from the rotation, skipping plays the batch already has.
  const used = new Set(plan.map((p) => p.play));
  const offset = seed % PLAN_ROTATION.length;
  for (let i = 0; plan.length < n && i < PLAN_ROTATION.length * 2; i++) {
    const slot = PLAN_ROTATION[(offset + i) % PLAN_ROTATION.length];
    if (used.has(slot.play) && i < PLAN_ROTATION.length) continue; // allow repeats only if exhausted
    used.add(slot.play);
    plan.push({ channel: channel || slot.channel, play: slot.play });
  }

  const out: GeneratedPost[] = [];
  for (const slot of plan.slice(0, n)) {
    const post = await generateOnePost(slot.channel, slot.play);
    if (post) out.push(post);
  }
  return out;
}

// Public origin the platforms fetch Paulie's image from. Zernio requires a public
// HTTPS URL returning raw bytes — /api/seo/img/<id>.png does exactly that.
export function publicBaseFrom(reqOrigin?: string): string {
  const env = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (env) return env;
  if (reqOrigin) return reqOrigin.replace(/\/+$/, '');
  return 'https://arthur-arlo.fly.dev';
}

// ── Publish-time caption prep ───────────────────────────────────────────────────
// Stored bodies are Arthur-facing working documents (shot lists, slide plans,
// "— CAPTION —" markers). What actually posts is only the caption section, and
// every website link in it is forced to the Contact Us page — the one link the
// business sends people to. Deterministic here, whatever the model wrote.
const SITE_LINK_RE = /https?:\/\/(?:www\.)?aquaticpoolaz\.com[^\s)\]"']*|(?<![\w@.])(?:www\.)?aquaticpoolaz\.com(?:\/[^\s)\]"']*)?/gi;

export function prepareCaptionForPublish(body: string): string {
  let text = body;
  // Keep only what follows the caption marker (reels/carousels store production
  // notes above it — those must never post as the public caption).
  const marker = text.lastIndexOf('— CAPTION —');
  if (marker !== -1) text = text.slice(marker + '— CAPTION —'.length);
  text = text.trim();

  const contact = contactPageUrl();
  // Any site link the copy contains becomes the contact page (but leave email
  // addresses like info@aquaticpoolaz.com alone — the regex excludes @/word
  // characters right before the bare domain).
  text = text.replace(SITE_LINK_RE, contact);
  // No link at all → add the contact line so every post leads somewhere.
  if (!text.includes(contact)) {
    // Insert before the hashtag block when there is one, so tags stay last.
    const lines = text.split('\n');
    let tagStart = lines.length;
    while (tagStart > 0 && (lines[tagStart - 1].trim() === '' || /^\s*#[\w#\s]*$/.test(lines[tagStart - 1]))) tagStart--;
    lines.splice(tagStart, 0, '', `Book your free consultation: ${contact}`);
    text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  return text;
}

export interface PublishOutcome {
  ok: boolean;
  id: number;
  channel: string;
  url?: string;
  error?: string;
}

/** Ensure a reel has a rendered MP4 stored, rendering it on demand from the
 *  reel's frames if it's missing. Returns true when a video is available. */
async function ensureReelVideo(id: number): Promise<boolean> {
  if (getRalphVideoBytes(id)) return true;
  const imgIds = getContentImageIds(id);
  if (imgIds.length < 2) return false;
  const buffers = imgIds.map((i) => getImageBytes(i)?.buffer).filter((b): b is Buffer => !!b);
  const mp4 = await renderReelVideo(buffers);
  if (!mp4) return false;
  saveRalphVideo(id, mp4.toString('base64'));
  console.log(`[Paulie] reel #${id} rendered to video on demand`);
  return true;
}

/** Publish a stored Paulie post to its real platform via Zernio. Carousels send all
 *  their images; reels publish the rendered Ken-Burns MP4 as a real video/reel. */
export async function publishRalphPost(id: number, reqOrigin?: string): Promise<PublishOutcome> {
  const row = getRalphContent(id);
  if (!row) return { ok: false, id, channel: '', error: 'Post not found' };
  if (!hasZernio()) return { ok: false, id, channel: row.channel, error: 'ZERNIO_API_KEY not configured' };
  if (!isZernioChannel(row.channel)) {
    return { ok: false, id, channel: row.channel, error: `${row.channel} is not a connected publishing channel (Instagram/Facebook only)` };
  }
  const content = prepareCaptionForPublish((row.body || row.title || '').trim());
  if (!content) return { ok: false, id, channel: row.channel, error: 'Post has no content' };

  const base = publicBaseFrom(reqOrigin);

  // Reels publish as a single video (the rendered Ken-Burns MP4). Render it now
  // if it wasn't produced at generation time; if there's genuinely no video
  // (too few frames / ffmpeg unavailable), fail clearly rather than posting a
  // still as a "reel".
  if (row.format === 'reel') {
    const hasVideo = await ensureReelVideo(id);
    if (!hasVideo) {
      return { ok: false, id, channel: row.channel, error: 'Reel has no rendered video yet (needs at least 2 frames; ffmpeg must be available).' };
    }
    const result = await publishToZernio({
      platform: row.channel, content,
      videoUrl: `${base}/api/ralph/video/${id}.mp4`,
      publishNow: true,
    });
    if (!result.ok) {
      setRalphPublishError(id, result.error || 'publish failed');
      return { ok: false, id, channel: row.channel, error: result.error };
    }
    setRalphPublished(id, { postId: result.postId, url: result.url });
    console.log(`[Paulie] published reel #${id} to ${row.channel}${result.url ? ' — ' + result.url : ''}`);
    return { ok: true, id, channel: row.channel, url: result.url };
  }

  const urls = (row.image_urls && row.image_urls.length ? row.image_urls : (row.image_url ? [row.image_url] : []))
    .map((u) => `${base}${u}`);
  const result = await publishToZernio({
    platform: row.channel, content,
    imageUrl: urls[0] || null,
    imageUrls: urls,
    publishNow: true,
  });

  if (!result.ok) {
    setRalphPublishError(id, result.error || 'publish failed');
    return { ok: false, id, channel: row.channel, error: result.error };
  }
  setRalphPublished(id, { postId: result.postId, url: result.url });
  console.log(`[Paulie] published #${id} to ${row.channel}${result.url ? ' — ' + result.url : ''}`);
  return { ok: true, id, channel: row.channel, url: result.url };
}

/** How many drafts are currently awaiting Arthur's approval. */
export function pendingDraftCount(): number {
  return (getDb().prepare("SELECT COUNT(*) c FROM ralph_content WHERE status = 'draft'").get() as { c: number }).c;
}

export type { RalphItem };
