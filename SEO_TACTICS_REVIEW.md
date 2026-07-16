# SEO Tactics Review — Lauren vs. Current (2026) Best Practices

> Calibration pass: read `services/seo/audit.ts`, `services/seo/enrich.ts`, `services/seo/schema.ts`,
> `services/seo/meta.ts`, and the generation prompts in `services/seoAgent.ts`, then checked them
> against current guidance on helpful-content/E-E-A-T, local-SEO doorway-page risk, structured
> data, GEO/AEO (AI-search optimization), and title/description length norms. Sources at bottom.
>
> **Scope of changes made alongside this report:** one low-risk generation-prompt change (city-page
> differentiation instructions, both the primary and fallback prompt paths in `seoAgent.ts`). No
> scoring-weight changes were applied — those are proposals below for human review, since they
> change what "passing" means for pages already in the pipeline.

---

## (a) What the audit already gets right

- **Meta length scoring is well-calibrated.** `meta.ts` scores title 30–60 chars / description
  120–160 chars as the sweet spot. Current guidance still centers on ~50–60 chars (≈600px) for
  titles and ~155–160 chars (≈920px) for descriptions — Lauren's range is a reasonable superset
  of that and already avoids truncation in the vast majority of cases. No change needed.
- **JSON-LD only, never microdata/RDFa.** `schema.ts` emits pure JSON-LD, which is Google's only
  recommended format — correct.
- **Schema type selection matches what actually earns rich results in 2026.** LocalBusiness (+
  GeneralContractor), Service, BreadcrumbList, BlogPosting (with `datePublished`), and FAQPage when
  real Q&A exists — this covers the schema types current guidance flags as the ones that move the
  needle for a local-service business. `businessNode()` also includes `geo` coordinates and
  `sameAs`, which current guidance calls out as strengthening LocalBusiness specifically.
- **Orphan-page prevention exists.** The internal-links dimension zeroes out and flags an error for
  0 internal links, and rewards 3+. Isolated pages with no internal linking are one of the two
  technical fingerprints of a doorway page per current guidance (the other is near-duplicate
  content — see gap below) — Lauren already guards the one that's cheap to check.
- **GEO/AEO is already being scored, not just SEO.** The "AI search (GEO)" dimension rewards
  self-contained Q&A-style H2/H3 passages. This is directly aligned with what research on AI-search
  citation behavior calls "content extractability" — clear, quotable, self-contained passages are
  one of the strongest levers for getting cited by ChatGPT/Perplexity/AI Overviews. Most SEO tools
  haven't caught up to scoring this yet; Lauren already does.
- **E-E-A-T is modeled as four sub-signals, not a vague bucket.** `experience`/`expertise`/
  `authority`/`trust` booleans map cleanly onto the four letters, which keeps the score legible and
  debuggable (see proposal below on reweighting them, though).

## (b) Concrete gaps, with proposed scoring changes (proposals only — not applied)

1. **No cross-page duplicate-content / doorway-pattern check — the single biggest real risk.**
   `auditPage()` scores every page in isolation. It has no mechanism to detect that two city pages
   are, say, 90% identical outside the city name — which is explicitly the fastest way to trigger a
   thin-content/doorway penalty per current guidance ("if you can place two city pages side by side
   and 90% of the content is identical, that is a red flag"). Since Lauren is specifically producing
   a growing set of near-identical-purpose city pages, this is the gap most worth closing.
   - **Proposal:** add a "differentiation" dimension. Strip city/state tokens from the body text of
     a new page, fingerprint it (a cheap n-gram shingle hash is enough — no need for a real
     similarity-search library), and compare against the fingerprints of existing `city_page` rows.
     Penalize heavily (or fail the audit outright) above some similarity threshold (~60–70% is a
     reasonable starting point per the "90% identical" red-flag guidance). This needs a new column
     on `seo_content` to store the fingerprint and a decision on where the threshold sits — that's a
     product/scoring decision, not just an engineering one, so it's a proposal rather than an
     applied change.
2. **The local-signal check rewards exactly the shallow pattern that causes doorway risk.**
   `hasCity` currently just checks whether the city name appears anywhere in the body — trivially
   satisfied by a template with the city name swapped in once. Current guidance is explicit that
   genuine city pages need "location-specific details like landmarks, neighborhoods served, and
   local context" — mere city-name presence is not differentiation.
   - **Proposal:** raise the bar for local-signal credit — require either (a) the city name
     appearing in 3+ distinct sentences/contexts (not just the H1), or (b) at least one
     neighborhood/landmark term from a per-city reference list. This pairs naturally with the
     generation-prompt change already applied (below) — the prompt now asks for this content, so
     the audit should verify it actually showed up rather than just trusting the model complied.
3. **E-E-A-T sub-signals are equally weighted; current findings say they shouldn't be.** The March
   2026 core update pattern found Trust and first-hand Experience now outweigh Expertise —
   "content that demonstrates genuine first-hand experience... outranks comprehensive but impersonal
   information." Lauren's `eeatScore` currently splits credit 25/25/25/25 across
   experience/expertise/authority/trust.
   - **Proposal:** reweight toward experience + trust, e.g. 30% experience / 30% trust / 25%
     expertise / 15% authority. This is a scoring-weight change with a real trade-off (it changes
     which existing pages would newly pass or fail the 75-point threshold), so it's a proposal for
     human review rather than an applied change.
4. **No "information gain" / factual-density signal.** Current findings show sites publishing
   proprietary data (specific stats, specific outcomes) rather than generic claims saw a real
   visibility lift ("Information Gain" was one of the concrete March-2026 update mechanisms), and
   the same "factual density" property shows up independently in the GEO/AI-citation research as one
   of the stronger levers for getting quoted by AI search.
   - **Proposal:** add a small bonus (2–4 pts) for the presence of specific, non-generic numbers in
     body copy beyond the boilerplate "18 years / 400+ pools" proof points already injected by the
     prompt — e.g., a permit-timeline figure, a specific project count for that city, a specific
     price range tied to a real local factor. Mechanically cheap (a regex for standalone numbers
     outside the known boilerplate phrases), but deciding the exact bonus size is a scoring call —
     proposal, not applied.
5. **`dateModified` isn't tracked on BlogPosting/Article schema.** `schema.ts` sets `datePublished`
   correctly but never sets `dateModified`. Low priority (pages are generated once and rarely
   edited after publish today), but worth a placeholder if Lauren ever gains an "update this page"
   path — Article/BlogPosting freshness is one of the signals current guidance still calls out.
   Not scored as a gap in `audit.ts` since it isn't user-facing yet; noting it here so it isn't
   forgotten if editing support is added later.

## (c) Generation-prompt changes — implemented (low-risk, applied in this pass)

**City-page differentiation instructions**, in both prompt paths in `seoAgent.ts`
(`buildMainContentPrompt`'s `pageTypeRules` — the primary path when real site chrome is available —
and `buildDesignTokenPrompt`'s identical fallback branch, used when the primary path fails or site
chrome isn't available). Both now instruct the model to:
- Name at least one real neighborhood, landmark, or geographic detail specific to that city, instead
  of writing a generic page with only the city name changed.
- Mention a city-specific permitting/HOA consideration when the model has one to offer.
- Explicitly frames this as a doorway-page risk ("Google treats near-identical city pages as
  thin/doorway content") so the instruction carries its own rationale rather than reading as an
  arbitrary style rule.

This directly targets the single largest real risk identified above (gap #1) at the cheapest
possible layer — it's a prompt-only change with no schema/scoring risk, though it depends on the
model actually complying without a verification step. Proposal #1 (the fingerprint-based
differentiation *audit* dimension) is the verification half of this fix and is intentionally left
as a proposal, not applied, since it requires a schema decision (new column) and a similarity
threshold someone should sign off on rather than picking unilaterally.

---

## Sources

- [Content Quality Signals That Core Updates Reward in 2026](https://www.digitalapplied.com/blog/content-quality-signals-core-updates-reward-2026)
- [E-E-A-T in March 2026: Google Experience Content Guide](https://www.digitalapplied.com/blog/e-e-a-t-march-2026-google-rewards-experience-content-guide)
- [Google E-E-A-T Guidelines: an Overview (2026 Playbook)](https://keywordseverywhere.com/blog/google-e-e-a-t-guidelines-an-overview/)
- [Doorway Pages Vs Landing Pages: Hidden SEO Risks In 2026](https://www.bigredseo.com/doorway-pages-vs-landing-pages/)
- [Location Pages: What Crosses the Line to Doorway Abuse & Spammy Content?](https://ricketyroo.com/blog/location-page-spam/)
- [Local SEO Landing Pages: Complete Guide for 2026](https://arc4.com/resources/local-seo-landing-pages/)
- [Structured Data SEO 2026: Rich Results Guide](https://www.digitalapplied.com/blog/structured-data-seo-2026-rich-results-guide)
- [Local Business (LocalBusiness) Structured Data — Google Search Central](https://developers.google.com/search/docs/appearance/structured-data/local-business)
- [Generative Engine Optimization (GEO) 2026: Princeton-Backed Playbook for AI Search](https://aithinkerlab.com/generative-engine-optimization-2026/)
- [Generative Engine Optimization (GEO): The Complete 2026 Guide](https://www.enrichlabs.ai/blog/generative-engine-optimization-geo-complete-guide-2026)
- [Meta Title Length Best Practices, 2026](https://www.scalenut.com/blogs/meta-title-length-best-practices-2026)
- [Meta Description Length 2026: SEO Best Practices & Character Guidelines](https://lettercounter.org/blog/meta-description-length-seo-guide/)
