// src/app/api/notify/route.ts
import { NextRequest } from "next/server";
import { Resend } from "resend";
import twilio from "twilio";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Member = {
  id: string;
  room_id: string;
  email: string | null;
  phone_e164: string | null;
  approved: boolean | null;
  email_enabled: boolean | null;
  sms_enabled: boolean | null;
};

function j(status: number, body: unknown) {
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
  const SUPABASE_URL = process.env.SUPABASE_URL;              // server-only
  const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY; // server-only
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL;
  const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
  const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;

  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    return new Response(null, { status: 204 }); // quietly no-op if not configured
  }

  try {
    const payload = (await req.json()) as {
      title?: string;
      notes?: string;
      room_id?: string;
      address_text?: string;
      lat?: number;
      lng?: number;
      when_iso?: string;
    };

    const { title, notes, room_id, address_text, lat, lng, when_iso } = payload || {};
    if (!room_id || !title) {
      return j(400, { error: "Missing required fields: room_id, title" });
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: { persistSession: false },
    });

    const { data: members, error } = await admin
      .from("members")
      .select(
        "id, room_id, email, phone_e164, approved, email_enabled, sms_enabled"
      )
      .eq("room_id", room_id)
      .eq("approved", true);

    if (error) {
      console.error("[/api/notify] members query error:", error);
      return j(500, { error: "Failed to load members", details: error.message });
    }

    const list = (members || []) as Member[];
    if (!list.length) {
      return j(200, { ok: true, message: "No approved members to notify", counts: { email: 0, sms: 0 } });
    }

    const lines = [
      `New sighting reported in room ${room_id}`,
      `Title: ${title}`,
      notes ? `Notes: ${notes}` : null,
      address_text ? `Address: ${address_text}` : null,
      lat != null && lng != null ? `Coords: ${lat.toFixed(5)}, ${lng.toFixed(5)}` : null,
      when_iso ? `When: ${new Date(when_iso).toLocaleString()}` : null,
      "",
      "Open the app to view details.",
    ].filter(Boolean) as string[];

    const textBody = lines.join("\n");
    const htmlBody =
      `<div style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.45">
        <p>New sighting reported in room <b>${room_id}</b></p>
        <p><b>Title:</b> ${escapeHtml(title)}</p>
        ${notes ? `<p><b>Notes:</b> ${escapeHtml(notes)}</p>` : ""}
        ${address_text ? `<p><b>Address:</b> ${escapeHtml(address_text)}</p>` : ""}
        ${lat != null && lng != null ? `<p><b>Coords:</b> ${lat.toFixed(5)}, ${lng.toFixed(5)}</p>` : ""}
        ${when_iso ? `<p><b>When:</b> ${escapeHtml(new Date(when_iso).toLocaleString())}</p>` : ""}
        <p><a href="/">Open app</a></p>
      </div>`;

    let emailCount = 0;
    if (RESEND_API_KEY && RESEND_FROM_EMAIL) {
      const resend = new Resend(RESEND_API_KEY);
      const emailTargets = list
        .filter((m) => (m.email_enabled ?? true) && m.email)
        .map((m) => m.email!) as string[];

      if (emailTargets.length) {
        const results = await Promise.allSettled(
          emailTargets.map((to) =>
            resend.emails.send({
              from: RESEND_FROM_EMAIL,
              to,
              subject: `New sighting: ${title}`,
              html: htmlBody,
              text: textBody,
            })
          )
        );
        emailCount = results.filter((r) => r.status === "fulfilled").length;
        const failures = results
          .filter((r): r is PromiseRejectedResult => r.status === "rejected")
          .map((r) => r.reason?.message || r.reason);
        if (failures.length) console.warn("[/api/notify] email failures:", failures.slice(0, 5));
      }
    }

    let smsCount = 0;
    if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER) {
      const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
      const smsTargets = list
        .filter((m) => (m.sms_enabled ?? false) && m.phone_e164)
        .map((m) => m.phone_e164!) as string[];

      if (smsTargets.length) {
        const results = await Promise.allSettled(
          smsTargets.map((to) =>
            client.messages.create({
              to,
              from: TWILIO_FROM_NUMBER,
              body: textBody.slice(0, 1500),
            })
          )
        );
        smsCount = results.filter((r) => r.status === "fulfilled").length;
        const failures = results
          .filter((r): r is PromiseRejectedResult => r.status === "rejected")
          .map((r) => r.reason?.message || r.reason);
        if (failures.length) console.warn("[/api/notify] sms failures:", failures.slice(0, 5));
      }
    }

    return j(200, { ok: true, counts: { email: emailCount, sms: smsCount } });
  } catch (e: any) {
    console.error("[/api/notify] fatal:", e);
    return j(500, { error: "notify failed", details: e?.message || String(e) });
  }
}
