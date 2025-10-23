import { NextRequest } from 'next/server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function j(status: number, body: unknown) {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { 'content-type': 'application/json' },
  });
}

export async function GET(_req: NextRequest) {
  const names = [
    'SUPABASE_URL',
    'SUPABASE_SECRET_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  ];
  const env: Record<string, { present: boolean; length?: number }> = {};
  for (const n of names) {
    const v = process.env[n];
    env[n] = { present: !!v, length: v ? v.length : undefined };
  }
  return j(200, { ok: true, env });
}
