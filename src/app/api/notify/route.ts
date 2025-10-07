import { NextResponse } from "next/server";
import { Resend } from "resend";
import { createClient } from "@supabase/supabase-js";

const resend = new Resend(process.env.RESEND_API_KEY!);

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { title, notes, room_id } = body;

    if (!room_id || !title) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    // ✅ Connect to Supabase
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY! // needs to be service role, not anon key
    );

    // ✅ Get all member emails for this room
    const { data: members, error } = await supabase
      .from("members")
      .select("email")
      .eq("room_id", room_id);

    if (error) throw error;
    if (!members || members.length === 0) {
      return NextResponse.json({ ok: true, message: "No members to notify" });
    }

    // ✅ Send email
    const to = members.map(m => m.email).filter(Boolean);
    await resend.emails.send({
      from: "UFO Tracker <onboarding@resend.dev>", // change later to your domain
      to,
      subject: `🚨 New Sighting Reported: ${title}`,
      html: `
        <h2>New Sighting Reported</h2>
        <p><strong>Title:</strong> ${title}</p>
        <p><strong>Notes:</strong> ${notes || "No details provided."}</p>
        <p><a href="https://ufotrac.vercel.app">View in app</a></p>
      `,
    });

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("Email notify error:", e);
    return NextResponse.json({ error: e.message || "Internal Server Error" }, { status: 500 });
  }
}
