/**
 * Address geocoding for the CRM map — OpenStreetMap Nominatim (no API key).
 * Results are cached on the lead row (lat/lng + the address they were computed
 * from), so each address geocodes once. Nominatim asks for ≤1 req/sec and a
 * descriptive User-Agent; the map endpoint geocodes at most a few missing
 * addresses per call, sequentially, to stay well inside that.
 */

import { getDb } from '../db/schema';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const UA = 'AquaticOS-CRM/1.0 (aquaticpoolaz.com)';
const MAX_PER_SWEEP = 3;

interface GeoRow { id: number; address: string | null; lat: number | null; lng: number | null; geocoded_addr: string | null }

async function geocodeAddress(address: string): Promise<{ lat: number; lng: number } | null> {
  const q = address.trim();
  if (!q) return null;
  // Bias to Arizona — every job is in the Phoenix metro area.
  const url = `${NOMINATIM}?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(/\baz\b|arizona/i.test(q) ? q : `${q}, Arizona`)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const data = await res.json() as { lat?: string; lon?: string }[];
  const hit = data?.[0];
  if (!hit?.lat || !hit?.lon) return null;
  return { lat: parseFloat(hit.lat), lng: parseFloat(hit.lon) };
}

/** Geocode up to MAX_PER_SWEEP leads whose address is new/changed. Never throws. */
export async function geocodeMissing(rows: GeoRow[]): Promise<number> {
  const db = getDb();
  let done = 0;
  for (const r of rows) {
    if (done >= MAX_PER_SWEEP) break;
    const addr = (r.address || '').trim();
    if (!addr || /not provided|unknown/i.test(addr)) continue;
    if (r.lat != null && r.lng != null && r.geocoded_addr === addr) continue;
    try {
      const hit = await geocodeAddress(addr);
      if (hit) {
        db.prepare('UPDATE leads SET lat = ?, lng = ?, geocoded_addr = ? WHERE id = ?').run(hit.lat, hit.lng, addr, r.id);
      } else {
        // Cache the miss so we don't hammer Nominatim with the same bad address.
        db.prepare('UPDATE leads SET lat = NULL, lng = NULL, geocoded_addr = ? WHERE id = ?').run(addr, r.id);
      }
      done++;
      await new Promise((resolve) => setTimeout(resolve, 1100)); // ≤1 req/sec
    } catch (err) {
      console.warn('[CRM map] geocode failed for lead', r.id, err instanceof Error ? err.message : err);
      done++;
    }
  }
  return done;
}
