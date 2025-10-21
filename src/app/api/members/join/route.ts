// src/app/api/members/join/route.ts
import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function res(status: number, body: unknown) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function POST(req: NextRequest) {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
      return res(500, {
        ok: false,
        where: "env",
        error: "Missing SUPABASE_URL or SUPABASE_SECRET_KEY in server env",
      });
    }

    const { room_id, email, phone_e164 } =
      (await req.json()) as { room_id?: string; email?: string; phone_e164?: string };

    if (!room_id || (!email && !phone_e164)) {
      return res(400, {
        ok: false,
        where: "validation",
        error: "room_id and at least one of email or phone_e164 are required",
        received: { room_id, email, phone_e164 },
      });
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: { persistSession: false },
    });

    // If a row exists for this room & email/phone, just update flags/phone
    const { data: row, error: qerr } = await admin
      .from("members")
      .select("*")
      .eq("room_id", room_id)
      .or(
        [
          email ? `email.eq.${email}` : undefined,
          phone_e164 ? `phone_e164.eq.${phone_e164}` : undefined,
        ]
          .filter(Boolean)!
          .join(",")
      )
      .maybeSingle();

    if (qerr && qerr.code !== "PGRST116") {
      return res(500, { ok: false, where: "select members", error: qerr.message });
    }

    if (row) {
      const { error: uerr } = await admin
        .from("members")
        .update({
          email: row.email ?? email ?? null,
          phone_e164: row.phone_e164 ?? phone_e164 ?? null,
          approved: true,
          email_enabled: (row.email_enabled ?? !!(row.email || email)),
          sms_enabled: (row.sms_enabled ?? !!(row.phone_e164 || phone_e164)),
        })
        .eq("id", row.id);
      if (uerr) return res(500, { ok: false, where: "update members", error: uerr.message });
      return res(200, { ok: true, updated: true });
    }

    // Insert fresh
    const { error: ierr } = await admin.from("members").insert({
      room_id,
      email: email ?? null,
      phone_e164: phone_e164 ?? null,
      approved: true,
      email_enabled: !!email,
      sms_enabled: !!phone_e164,
    });
    if (ierr) return res(500, { ok: false, where: "insert members", error: ierr.message });

    return res(200, { ok: true, created: true });
  } catch (e: any) {
    return res(500, { ok: false, where: "catch", error: e?.message || String(e) });
  }
}
