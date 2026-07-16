/**
 * Brave Web Search — the brain's live-web tool. Used by Jarvis's agent loop when
 * Joe asks about current prices, a supplier, a lead's business, permit rules, etc.
 * Requires BRAVE_API_KEY (or BRAVE_SEARCH_API_KEY). Degrades to a clear note if
 * unset so the model can tell Joe rather than silently failing.
 */

export interface WebResult {
  title: string;
  url: string;
  description: string;
}

export interface WebSearchOutcome {
  query: string;
  results: WebResult[];
  note?: string;
}

export async function braveWebSearch(query: string, count = 5): Promise<WebSearchOutcome> {
  const q = (query || '').trim();
  if (!q) return { query: '', results: [], note: 'empty query' };

  const braveKey = process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY;
  if (!braveKey) {
    return { query: q, results: [], note: 'web search unavailable — BRAVE_API_KEY not configured' };
  }

  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${count}`;
    const res = await fetch(url, {
      headers: { 'X-Subscription-Token': braveKey, Accept: 'application/json' },
    });
    if (!res.ok) {
      return { query: q, results: [], note: `web search failed (${res.status})` };
    }
    const data = (await res.json()) as {
      web?: { results?: { title?: string; url?: string; description?: string }[] };
    };
    const results = (data.web?.results ?? []).slice(0, count).map((r) => ({
      title: r.title || '',
      url: r.url || '',
      description: r.description || '',
    }));
    return { query: q, results };
  } catch (err) {
    return { query: q, results: [], note: `web search error: ${err instanceof Error ? err.message : 'unknown'}` };
  }
}
