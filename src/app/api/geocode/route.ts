// src/app/api/geocode/route.ts
import { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------- Types ----------
type Near = { lat: number; lng: number } | null;
type PreciseHit = {
  provider: string;
  address_text: string;
  lat: number;
  lng: number;
  meta?: any;
};
type Candidate = {
  provider: string;
  label: string;
  lat: number;
  lng: number;
  city?: string;
  state?: string;
  state_code?: string;
  country_code?: string;
  score?: number;
};

// ---------- Small helpers ----------
function ok(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function err(message: string, status = 400) {
  return ok({ error: message }, status);
}
function norm(s?: string | null) {
  return (s || '').toLowerCase().replace(/[\s,.'-]+/g, ' ').trim();
}

// US states (code ↔ name)
const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DC: 'District of Columbia', DE: 'Delaware',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', IA: 'Iowa', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  MA: 'Massachusetts', MD: 'Maryland', ME: 'Maine', MI: 'Michigan',
  MN: 'Minnesota', MO: 'Missouri', MS: 'Mississippi', MT: 'Montana',
  NC: 'North Carolina', ND: 'North Dakota', NE: 'Nebraska', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NV: 'Nevada', NY: 'New York',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VA: 'Virginia', VT: 'Vermont', WA: 'Washington',
  WI: 'Wisconsin', WV: 'West Virginia', WY: 'Wyoming',
};
const STATE_NAMES_TO_CODE = Object.fromEntries(
  Object.entries(US_STATES).map(([k, v]) => [v.toLowerCase(), k])
);

// Matching helpers
function inUS(code?: string | null) {
  const c = (code || '').toLowerCase();
  return c === 'us' || c === 'usa';
}
function sameState(foundName?: string | null, foundCode?: string | null, expect?: string | null) {
  if (!expect) return true;
  const e = expect.toUpperCase();
  const eName = US_STATES[e] || expect;
  const eNormName = norm(eName);
  const fCode = (foundCode || '').toUpperCase();
  const fName = norm(foundName);
  if (fCode && e.length === 2 && fCode === e) return true;
  if (fName && fName === eNormName) return true;
  return false;
}
function cityTokensMatch(foundCity?: string | null, expect?: string | null) {
  if (!expect) return true; // if not provided, don’t constrain by city
  const f = norm(foundCity);
  const e = norm(expect);
  if (!f || !e) return false;
  const need = e.split(' ').filter(Boolean);
  return need.every((w) => f.includes(w));
}
function acceptHit(
  meta: { city?: string | null; state?: string | null; state_code?: string | null; country_code?: string | null },
  expectCity?: string | null,
  expectState?: string | null
) {
  if (expectState && !inUS(meta.country_code)) return false;
  if (!sameState(meta.state, meta.state_code, expectState || null)) return false;
  if (!cityTokensMatch(meta.city, expectCity || null)) return false;
  return true;
}

// Precision checks per provider
function isPreciseGeoapify(f: any): boolean {
  const t = f?.properties?.result_type || '';
  const rank = f?.properties?.rank || {};
  return (
    ['amenity', 'building', 'house', 'street'].includes(t) ||
    !!rank?.house_number || !!rank?.street
  );
}
function labelGeoapify(f: any): string {
  return (
    f?.properties?.formatted ||
    [f?.properties?.name, f?.properties?.street, f?.properties?.city, f?.properties?.state].filter(Boolean).join(', ')
  );
}
function isPreciseMapbox(f: any): boolean {
  const types: string[] = f?.place_type || [];
  return types.includes('poi') || types.includes('address') || types.includes('street');
}
function labelMapbox(f: any): string {
  return f?.place_name || '';
}
function isPreciseGoogle(r: any): boolean {
  const types: string[] = r?.types || [];
  return (
    types?.includes('establishment') ||
    types?.includes('point_of_interest') ||
    types?.includes('street_address') ||
    types?.includes('route') ||
    types?.includes('premise')
  );
}
function labelGoogle(r: any): string {
  return r?.formatted_address || r?.name || '';
}
function isPreciseNominatim(f: any): boolean {
  const cls = f?.class, t = f?.type, addrt = f?.addresstype;
  return (
    cls === 'amenity' ||
    addrt === 'house' || addrt === 'building' || addrt === 'road' ||
    t === 'house' || t === 'building' || t === 'restaurant' ||
    t === 'fuel' || t === 'pub' || t === 'convenience'
  );
}
function labelNominatim(f: any): string {
  return f?.display_name || '';
}

// ---------- POST handler ----------
export async function POST(req: NextRequest) {
  try {
    const { q, near, expectCity, expectState, candidates } = (await req.json()) as {
      q?: string;
      near?: Near;
      expectCity?: string;
      expectState?: string;
      candidates?: boolean; // if true, return list of options
    };
    if (!q || !q.trim()) return err('Missing q', 400);

    const text = q.trim();
    const bias = near && Number.isFinite(near.lat) && Number.isFinite(near.lng) ? near : null;

    if (candidates) {
      const list = await gatherCandidates(text, bias, expectCity, expectState);
      if (!list.length) return err('No candidates', 404);
      return ok({ candidates: list.slice(0, 8) });
    }

    // Strict: first precise + acceptable hit wins
    const hit =
      (await fromGoogleFindPlace(text, bias, expectCity, expectState)) ||
      (await fromGeoapify(text, bias, expectCity, expectState)) ||
      (await fromMapbox(text, bias, expectCity, expectState)) ||
      (await fromGoogleText(text, bias, expectCity, expectState)) ||
      (await fromNominatim(text, bias, expectCity, expectState));

    if (!hit) return err('No precise match found in specified city/state', 404);
    return ok(hit);
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

// ---------- Candidate aggregator ----------
async function gatherCandidates(q: string, near: Near, expectCity?: string, expectState?: string): Promise<Candidate[]> {
  const buckets: Candidate[][] = await Promise.all([
    candidatesGoogleFindPlace(q, near),
    candidatesGeoapify(q, near),
    candidatesMapbox(q, near),
    candidatesGoogleText(q, near),
    candidatesNominatim(q, near),
  ]);

  // flatten
  let all: Candidate[] = buckets.flat().map((c, i) => ({ ...c, score: 100 - i })); // keep rough ordering

  // Only keep US if a state is expected
  if (expectState) all = all.filter((c) => inUS(c.country_code));

  // Prefer matches that satisfy state & city
  const cityWanted = norm(expectCity);
  const stateWanted = (expectState || '').toUpperCase();
  all.forEach((c) => {
    let s = c.score || 0;
    if (c.state_code && stateWanted && c.state_code.toUpperCase() === stateWanted) s += 30;
    if (c.state && stateWanted && norm(c.state) === norm(US_STATES[stateWanted] || c.state)) s += 20;
    if (c.city && cityWanted && norm(c.city).includes(cityWanted)) s += 20;
    c.score = s;
  });

  // Dedupe by (label, lat/lng rounded)
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of all.sort((a, b) => (b.score || 0) - (a.score || 0))) {
    const key = `${norm(c.label)}|${Math.round(c.lat * 1e4)}|${Math.round(c.lng * 1e4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// ---------- Providers (strict + candidates) ----------

// Google Places — Find Place (best for businesses)
async function fromGoogleFindPlace(q: string, near: Near, expectCity?: string, expectState?: string): Promise<PreciseHit | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;
  const base = 'https://maps.googleapis.com/maps/api/place/findplacefromtext/json';
  const params = new URLSearchParams({
    input: q,
    inputtype: 'textquery',
    fields: 'name,formatted_address,geometry,types,plus_code',
    region: 'us',
    key,
  });
  if (near) params.set('locationbias', `circle:25000@${near.lat},${near.lng}`); // 25km bias

  const r = await fetch(`${base}?${params.toString()}`);
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const c = j?.candidates?.[0];
  if (!c || !isPreciseGoogle(c)) return null;

  const addr = parseGoogleFormattedAddress(c?.formatted_address);
  const meta = { city: addr.city, state: addr.state, state_code: addr.state_code, country_code: addr.country_code };
  if (!acceptHit(meta, expectCity, expectState)) return null;

  return {
    provider: 'google_findplace',
    address_text: c?.formatted_address || c?.name || q,
    lat: c?.geometry?.location?.lat,
    lng: c?.geometry?.location?.lng,
    meta,
  };
}
async function candidatesGoogleFindPlace(q: string, near: Near): Promise<Candidate[]> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return [];
  const base = 'https://maps.googleapis.com/maps/api/place/findplacefromtext/json';
  const params = new URLSearchParams({
    input: q,
    inputtype: 'textquery',
    fields: 'name,formatted_address,geometry,types,plus_code',
    region: 'us',
    key,
  });
  if (near) params.set('locationbias', `circle:25000@${near.lat},${near.lng}`);

  const r = await fetch(`${base}?${params.toString()}`);
  if (!r.ok) return [];
  const j = await r.json().catch(() => null);
  const list: any[] = j?.candidates || [];
  return list.slice(0, 5).map((c) => {
    const addr = parseGoogleFormattedAddress(c?.formatted_address);
    return {
      provider: 'google_findplace',
      label: c?.formatted_address || c?.name || '',
      lat: c?.geometry?.location?.lat,
      lng: c?.geometry?.location?.lng,
      city: addr.city,
      state: addr.state,
      state_code: addr.state_code,
      country_code: addr.country_code,
    };
  });
}

// Google — Text Search (fallback)
async function fromGoogleText(q: string, near: Near, expectCity?: string, expectState?: string): Promise<PreciseHit | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;
  const base = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
  const params = new URLSearchParams({ query: q, region: 'us', key, language: 'en' });
  if (near) params.set('location', `${near.lat},${near.lng}`);

  const r = await fetch(`${base}?${params.toString()}`);
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const best = (j?.results || []).find(isPreciseGoogle);
  if (!best) return null;

  const addr = parseGoogleFormattedAddress(best?.formatted_address);
  const meta = { city: addr.city, state: addr.state, state_code: addr.state_code, country_code: addr.country_code };
  if (!acceptHit(meta, expectCity, expectState)) return null;

  return {
    provider: 'google_text',
    address_text: labelGoogle(best),
    lat: best?.geometry?.location?.lat,
    lng: best?.geometry?.location?.lng,
    meta,
  };
}
async function candidatesGoogleText(q: string, near: Near): Promise<Candidate[]> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return [];
  const base = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
  const params = new URLSearchParams({ query: q, region: 'us', key, language: 'en' });
  if (near) params.set('location', `${near.lat},${near.lng}`);

  const r = await fetch(`${base}?${params.toString()}`);
  if (!r.ok) return [];
  const j = await r.json().catch(() => null);
  return (j?.results || []).slice(0, 5).map((it: any) => {
    const addr = parseGoogleFormattedAddress(it?.formatted_address);
    return {
      provider: 'google_text',
      label: it?.formatted_address || it?.name || '',
      lat: it?.geometry?.location?.lat,
      lng: it?.geometry?.location?.lng,
      city: addr.city,
      state: addr.state,
      state_code: addr.state_code,
      country_code: addr.country_code,
    };
  });
}

// Geoapify
async function fromGeoapify(q: string, near: Near, expectCity?: string, expectState?: string): Promise<PreciseHit | null> {
  const key = process.env.GEOAPIFY_API_KEY;
  if (!key) return null;
  const base = 'https://api.geoapify.com/v1/geocode/search';
  const params = new URLSearchParams({ text: q, lang: 'en', limit: '5', apiKey: key });
  if (near) params.set('bias', `proximity:${near.lng},${near.lat}`);

  const r = await fetch(`${base}?${params.toString()}`);
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const best = (j?.features || []).find(isPreciseGeoapify);
  if (!best) return null;

  const meta = {
    city: best?.properties?.city || best?.properties?.town || best?.properties?.village || best?.properties?.suburb,
    state: best?.properties?.state,
    state_code: best?.properties?.state_code,
    country_code: best?.properties?.country_code,
  };
  if (!acceptHit(meta, expectCity, expectState)) return null;

  return {
    provider: 'geoapify',
    address_text: labelGeoapify(best),
    lat: best?.properties?.lat,
    lng: best?.properties?.lon,
    meta,
  };
}
async function candidatesGeoapify(q: string, near: Near): Promise<Candidate[]> {
  const key = process.env.GEOAPIFY_API_KEY;
  if (!key) return [];
  const base = 'https://api.geoapify.com/v1/geocode/search';
  const params = new URLSearchParams({ text: q, lang: 'en', limit: '8', apiKey: key });
  if (near) params.set('bias', `proximity:${near.lng},${near.lat}`);

  const r = await fetch(`${base}?${params.toString()}`);
  if (!r.ok) return [];
  const j = await r.json().catch(() => null);
  return (j?.features || [])
    .filter((f: any) => isPreciseGeoapify(f))
    .map((f: any) => ({
      provider: 'geoapify',
      label: labelGeoapify(f),
      lat: f?.properties?.lat,
      lng: f?.properties?.lon,
      city: f?.properties?.city || f?.properties?.town || f?.properties?.village || f?.properties?.suburb,
      state: f?.properties?.state,
      state_code: f?.properties?.state_code,
      country_code: f?.properties?.country_code,
    }));
}

// Mapbox
async function fromMapbox(q: string, near: Near, expectCity?: string, expectState?: string): Promise<PreciseHit | null> {
  const key = process.env.MAPBOX_TOKEN;
  if (!key) return null;
  const enc = encodeURIComponent(q);
  const base = `https://api.mapbox.com/geocoding/v5/mapbox.places/${enc}.json`;
  const params = new URLSearchParams({ access_token: key, language: 'en', limit: '5' });
  if (near) params.set('proximity', `${near.lng},${near.lat}`);

  const r = await fetch(`${base}?${params.toString()}`);
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const best = (j?.features || []).find(isPreciseMapbox);
  if (!best) return null;

  let city: string | undefined, state: string | undefined, state_code: string | undefined, country_code: string | undefined;
  const ctx: any[] = best?.context || [];
  for (const c of ctx) {
    const id: string = c?.id || '';
    if (id.startsWith('place')) city = c?.text;
    if (id.startsWith('region')) {
      state = c?.text;
      state_code = c?.short_code?.split('-')[1]?.toUpperCase();
    }
    if (id.startsWith('country')) country_code = (c?.short_code || '').toLowerCase();
  }

  const meta = { city, state, state_code, country_code };
  if (!acceptHit(meta, expectCity, expectState)) return null;

  const [lng, lat] = best?.center || [];
  return {
    provider: 'mapbox',
    address_text: labelMapbox(best),
    lat,
    lng,
    meta,
  };
}
async function candidatesMapbox(q: string, near: Near): Promise<Candidate[]> {
  const key = process.env.MAPBOX_TOKEN;
  if (!key) return [];
  const enc = encodeURIComponent(q);
  const base = `https://api.mapbox.com/geocoding/v5/mapbox.places/${enc}.json`;
  const params = new URLSearchParams({ access_token: key, language: 'en', limit: '8' });
  if (near) params.set('proximity', `${near.lng},${near.lat}`);

  const r = await fetch(`${base}?${params.toString()}`);
  if (!r.ok) return [];
  const j = await r.json().catch(() => null);

  return (j?.features || [])
    .filter((f: any) => isPreciseMapbox(f))
    .map((f: any) => {
      let city: string | undefined, state: string | undefined, state_code: string | undefined, country_code: string | undefined;
      const ctx: any[] = f?.context || [];
      for (const c of ctx) {
        const id: string = c?.id || '';
        if (id.startsWith('place')) city = c?.text;
        if (id.startsWith('region')) {
          state = c?.text;
          state_code = c?.short_code?.split('-')[1]?.toUpperCase();
        }
        if (id.startsWith('country')) country_code = (c?.short_code || '').toLowerCase();
      }
      const [lng, lat] = f?.center || [];
      return {
        provider: 'mapbox',
        label: labelMapbox(f),
        lat,
        lng,
        city,
        state,
        state_code,
        country_code,
      };
    });
}

// Nominatim
async function fromNominatim(q: string, near: Near, expectCity?: string, expectState?: string): Promise<PreciseHit | null> {
  const base = 'https://nominatim.openstreetmap.org/search';
  const params = new URLSearchParams({
    q,
    format: 'jsonv2',
    addressdetails: '1',
    limit: '5',
    'accept-language': 'en',
  });
  if (near) {
    const pad = 0.3;
    params.set('viewbox', `${near.lng - pad},${near.lat + pad},${near.lng + pad},${near.lat - pad}`);
    params.set('bounded', '0');
  }
  const r = await fetch(`${base}?${params.toString()}`, {
    headers: { 'User-Agent': 'ufo-tracker (contact: owner@example.com)' },
  });
  if (!r.ok) return null;
  const j: any[] = await r.json().catch(() => []);
  const best = j.find(isPreciseNominatim);
  if (!best) return null;

  const addr = best?.address || {};
  const meta = {
    city: addr.city || addr.town || addr.village || addr.hamlet || addr.suburb,
    state: addr.state,
    state_code: STATE_NAMES_TO_CODE[(addr.state || '').toLowerCase()] || undefined,
    country_code: (addr.country_code || '').toLowerCase(),
  };
  if (!acceptHit(meta, expectCity, expectState)) return null;

  return {
    provider: 'nominatim',
    address_text: labelNominatim(best),
    lat: Number(best?.lat),
    lng: Number(best?.lon),
    meta,
  };
}
async function candidatesNominatim(q: string, near: Near): Promise<Candidate[]> {
  const base = 'https://nominatim.openstreetmap.org/search';
  const params = new URLSearchParams({
    q,
    format: 'jsonv2',
    addressdetails: '1',
    limit: '8',
    'accept-language': 'en',
  });
  if (near) {
    const pad = 0.3;
    params.set('viewbox', `${near.lng - pad},${near.lat + pad},${near.lng + pad},${near.lat - pad}`);
    params.set('bounded', '0');
  }
  const r = await fetch(`${base}?${params.toString()}`, {
    headers: { 'User-Agent': 'ufo-tracker (contact: owner@example.com)' },
  });
  if (!r.ok) return [];
  const j: any[] = await r.json().catch(() => []);
  return j
    .filter((f: any) => isPreciseNominatim(f))
    .map((f: any) => {
      const addr = f?.address || {};
      return {
        provider: 'nominatim',
        label: labelNominatim(f),
        lat: Number(f?.lat),
        lng: Number(f?.lon),
        city: addr.city || addr.town || addr.village || addr.hamlet || addr.suburb,
        state: addr.state,
        state_code: STATE_NAMES_TO_CODE[(addr.state || '').toLowerCase()] || undefined,
        country_code: (addr.country_code || '').toLowerCase(),
      };
    });
}

// Parse a simple city/state/country from Google formatted_address
function parseGoogleFormattedAddress(addr?: string | null): {
  city?: string; state?: string; state_code?: string; country_code?: string;
} {
  if (!addr) return {};
  // e.g., "Tre Sorelle, 37 X St, Orillia, ON L3V, Canada"  or  "81 Forest Ave, Glen Cove, NY 11542, USA"
  const parts = addr.split(',').map((s) => s.trim());
  let city: string | undefined;
  let state: string | undefined;
  let state_code: string | undefined;
  let country_code: string | undefined;

  const last = parts[parts.length - 1]?.toLowerCase();
  if (last?.includes('usa') || last === 'us' || last === 'united states') country_code = 'us';
  if (last === 'canada') country_code = 'ca';
  // crude parse
  if (parts.length >= 2) {
    const maybeCity = parts[parts.length - 3] || parts[parts.length - 2];
    const region = parts[parts.length - 2] || '';
    const m = region.match(/\b([A-Z]{2})\b/);
    city = maybeCity;
    if (m) {
      state_code = m[1];
      state = US_STATES[state_code] || state_code;
    }
  }
  return { city, state, state_code, country_code };
}
