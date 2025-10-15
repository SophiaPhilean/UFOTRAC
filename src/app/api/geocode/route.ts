// src/app/api/geocode/route.ts
export const dynamic = 'force-dynamic';

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';

function urlWithParams(path: string, params: Record<string, string>) {
  const u = new URL(NOMINATIM_BASE + path);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  return u.toString();
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('mode'); // 'search' or 'reverse'

  try {
    let target = '';
    if (mode === 'search') {
      const q = searchParams.get('q') || '';
      target = urlWithParams('/search', {
        q,
        format: 'jsonv2',
        addressdetails: '1',
        limit: '5',
      });
    } else if (mode === 'reverse') {
      const lat = searchParams.get('lat') || '';
      const lon = searchParams.get('lon') || '';
      target = urlWithParams('/reverse', {
        lat,
        lon,
        format: 'jsonv2',
        addressdetails: '1',
      });
    } else {
      return new Response(JSON.stringify({ error: 'invalid mode' }), { status: 400 });
    }

    const res = await fetch(target, {
      headers: {
        // Identify your app politely per Nominatim policy:
        'User-Agent': 'UFO-Tracker/1.0 (contact: your-email@example.com)',
        'Accept': 'application/json',
      },
      // They’re OK with GET from server; respect rate limits
      cache: 'no-store',
    });

    const data = await res.json();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || 'failed' }), { status: 500 });
  }
}
