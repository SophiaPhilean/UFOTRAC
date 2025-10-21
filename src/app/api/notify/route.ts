// src/app/api/notify/route.ts
import { NextRequest } from "next/server";
import { Resend } from "resend";
import twilio from "twilio";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function res(status: number, body: unknown) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export async function POST(req: NextRequest) {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL;
    const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
    const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
    const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;

    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
      return res(500, { ok: false, where: "env", error: "Missing SUPABASE_URL or SUPABASE_SECRET_KEY" });
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

    const body = (await req.json()) as {
      title?: string; notes?: string; room_id?: string;
      address_text?: string | null; lat?: number | null; lng?: number | null; when_iso?: string | null;
    };
    if (!body?.room_id || !body?.title) {
      return res(400, { ok: false, where: "validation", error: "Missing room_id or title", received: body });
    }

    const { data: members, error: qerr } = await admin
      .from("members")
      .select("email, phone_e164, approved, email_enabled, sms_enabled")
      .eq("room_id", body.room_id)
      .eq("approved", true);

    if (qerr) return res(500, { ok: false, where: "select members", error: qerr.message });

    const emails = (members || []).filter((m:any)=> (m.email_enabled ?? true) && m.email).map((m:any)=> m.email as string);
    const phones = (members || []).filter((m:any)=> (m.sms_enabled ?? false) && m.phone_e164).map((m:any)=> m.phone_e164 as string);

    const lines = [
      `New sighting reported in room ${body.room_id}`,
      `Title: ${body.title}`,
      body.notes ? `Notes: ${body.notes}` : null,
      body.address_text ? `Address: ${body.address_text}` : null,
      body.lat != null && body.lng != null ? `Coords: ${body.lat.toFixed(5)}, ${body.lng.toFixed(5)}` : null,
      body.when_iso ? `When: ${new Date(body.when_iso).toLocaleString()}` : null,
      "",
      "Open the app to view details.",
    ].filter(Boolean) as string[];

    const textBody = lines.join("\n");
    const htmlBody =
      `<div style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.45">
        <p>New sighting reported in room <b>${body.room_id}</b></p>
        <p><b>Title:</b> ${escapeHtml(body.title)}</p>
        ${body.notes ? `<p><b>Notes:</b> ${escapeHtml(body.notes)}</p>` : ""}
        ${body.address_text ? `<p><b>Address:</b> ${escapeHtml(body.address_text)}</p>` : ""}
        ${body.lat != null && body.lng != null ? `<p><b>Coords:</b> ${body.lat.toFixed(5)}, ${body.lng.toFixed(5)}` : ""}
        ${body.when_iso ? `<p><b>When:</b> ${escapeHtml(new Date(body.when_iso).toLocaleString())}</p>` : ""}
        <p><a href="/">Open app</a></p>
      </div>`;

    // EMAIL
    let emailCount = 0; let emailErr: string | null = null;
    if (RESEND_API_KEY && RESEND_FROM_EMAIL && emails.length) {
      try {
        const resend = new Resend(RESEND_API_KEY);
        const results = await Promise.allSettled(
          emails.map((to)=> resend.emails.send({ from: RESEND_FROM_EMAIL!, to, subject: `New sighting: ${body.title}`, html: htmlBody, text: textBody }))
        );
        emailCount = results.filter(r=> r.status==='fulfilled').length;
        const failures = results.filter((r):r is PromiseRejectedResult=> r.status==='rejected').map(r=> r.reason?.message || r.reason);
        if (failures.length) emailErr = failures.slice(0,3).join(" | ");
      } catch (e:any) { emailErr = e?.message || String(e); }
    }

    // SMS — capture SID + initial status
    let smsCount = 0; let smsErr: string | null = null;
    const smsDetails: { to: string; sid?: string; status?: string; error?: string }[] = [];
    if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER && phones.length) {
      try {
        const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
        const results = await Promise.allSettled(
          phones.map(async (to) => {
            const msg = await client.messages.create({ to, from: TWILIO_FROM_NUMBER!, body: textBody.slice(0, 1500) });
            // msg.status is usually 'queued' initially
            return { to, sid: msg.sid, status: msg.status };
          })
        );
        results.forEach((r) => {
          if (r.status === "fulfilled") { smsCount++; smsDetails.push(r.value); }
          else smsDetails.push({ to: "unknown", error: (r as PromiseRejectedResult).reason?.message || (r as any).reason });
        });
      } catch (e:any) { smsErr = e?.message || String(e); }
    }

    return res(200, {
      ok: true,
      counts: { email: emailCount, sms: smsCount },
      notes: {
        emailConfigured: !!(RESEND_API_KEY && RESEND_FROM_EMAIL),
        smsConfigured: !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER),
        recipients: { emails, phones },
        emailErr, smsErr,
        smsDetails, // <-- look up these SIDs in Twilio console
      },
    });
  } catch (e:any) {
    return res(500, { ok: false, where: "catch", error: e?.message || String(e) });
  }
}
