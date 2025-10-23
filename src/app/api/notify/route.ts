// src/app/api/notify/route.ts
import { NextRequest } from 'next/server';
import { Resend } from 'resend';
import twilio from 'twilio';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Small helper
function j(status: number, body: unknown) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Simple sanitizer for HTML
function escapeHtml(s: string) {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

type Member = {
  id: string;
  room_id: string;
  email: string | null;
  phone_e164: string | null;
  approved: boolean | null;
  email_enabled: boolean | null;
  sms_enabled: boolean | null;
};

// GET /api/notify?ping=1 — quick env/status check
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  if (url.searchParams.get('ping') !== '1') {
    return j(404, { ok: false, error: 'Use POST to send notifications. For health check use ?ping=1' });
  }

  // Read envs inside the request
  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL;
  const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
  const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;

  return j(200, {
    ok: true,
    env: {
      hasSupabaseUrl: !!SUPABASE_URL,
      hasSupabaseSecret: !!SUPABASE_SECRET_KEY,
      emailConfigured: !!(RESEND_API_KEY && RESEND_FROM_EMAIL),
      smsConfigured: !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER),
    },
  });
}

export async function POST(req: NextRequest) {
  // Read envs inside the handler (avoids build-time issues)
  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL;
  const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
  const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;

  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    return j(500, { ok: false, where: 'env', error: 'Missing SUPABASE_URL or SUPABASE_SECRET_KEY' });
  }

  try {
    const {
      title,
      notes,
      room_id,
      address_text,
      lat,
      lng,
      when_iso,
    } = (await req.json()) as {
      title?: string;
      notes?: string;
      room_id?: string;
      address_text?: string | null;
      lat?: number | null;
      lng?: number | null;
      when_iso?: string | null;
    };

    if (!room_id || !title) {
      return j(400, { ok: false, error: 'Missing required fields: room_id, title' });
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

    const { data: members, error: mErr } = await admin
      .from('members')
      .select('email, phone_e164, approved, email_enabled, sms_enabled')
      .eq('room_id', room_id)
      .eq('approved', true);

    if (mErr) return j(500, { ok: false, where: 'select members', error: mErr.message });

    const list = (members || []) as Member[];
    const emails = list
      .filter(m => (m.email_enabled ?? true) && m.email)
      .map(m => m.email!) as string[];

    const phones = list
      .filter(m => (m.sms_enabled ?? false) && m.phone_e164)
      .map(m => m.phone_e164!) as string[];

    const textBody =
      [
        `New sighting reported in room ${room_id}`,
        `Title: ${title}`,
        notes ? `Notes: ${notes}` : null,
        address_text ? `Address: ${address_text}` : null,
        (lat != null && lng != null) ? `Coords: ${lat?.toFixed(5)}, ${lng?.toFixed(5)}` : null,
        when_iso ? `When: ${new Date(when_iso!).toLocaleString()}` : null,
        '',
        'Open the app to view details.',
      ].filter(Boolean).join('\n');

    const htmlBody =
      `<div style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.45">
         <p>New sighting reported in room <b>${room_id}</b></p>
         <p><b>Title:</b> ${escapeHtml(title)}</p>
         ${notes ? `<p><b>Notes:</b> ${escapeHtml(notes)}</p>` : ''}
         ${address_text ? `<p><b>Address:</b> ${escapeHtml(address_text)}</p>` : ''}
         ${(lat != null && lng != null) ? `<p><b>Coords:</b> ${lat?.toFixed(5)}, ${lng?.toFixed(5)}</p>` : ''}
         ${when_iso ? `<p><b>When:</b> ${escapeHtml(new Date(when_iso!).toLocaleString())}</p>` : ''}
         <p><a href="${process.env.NEXT_PUBLIC_SITE_URL || '/'}">Open app</a></p>
       </div>`;

    // Email
    let emailCount = 0;
    let emailErr: string | null = null;
    if (RESEND_API_KEY && RESEND_FROM_EMAIL && emails.length) {
      try {
        const resend = new Resend(RESEND_API_KEY);
        const results = await Promise.allSettled(
          emails.map(to => resend.emails.send({ from: RESEND_FROM_EMAIL, to, subject: `New sighting: ${title}`, html: htmlBody, text: textBody }))
        );
        emailCount = results.filter(r => r.status === 'fulfilled').length;
        const fails = results
          .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
          .map(r => r.reason?.message || String(r.reason));
        if (fails.length) emailErr = fails.slice(0, 3).join('; ');
      } catch (e: any) {
        emailErr = e?.message || String(e);
      }
    }

    // SMS
    let smsCount = 0;
    let smsErr: string | null = null;
    if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER && phones.length) {
      try {
        const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
        const results = await Promise.allSettled(
          phones.map(to => client.messages.create({ to, from: TWILIO_FROM_NUMBER, body: textBody.slice(0, 1500) }))
        );
        smsCount = results.filter(r => r.status === 'fulfilled').length;
        const fails = results
          .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
          .map(r => r.reason?.message || String(r.reason));
        if (fails.length) smsErr = fails.slice(0, 3).join('; ');
      } catch (e: any) {
        smsErr = e?.message || String(e);
      }
    }

    return j(200, {
      ok: true,
      counts: { email: emailCount, sms: smsCount },
      notes: {
        emailConfigured: !!(RESEND_API_KEY && RESEND_FROM_EMAIL),
        smsConfigured: !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER),
        recipients: { emails, phones },
        emailErr,
        smsErr,
      },
    });
  } catch (e: any) {
    return j(500, { ok: false, where: 'fatal', error: e?.message || String(e) });
  }
}
