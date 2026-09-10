import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";

// THE STRATEGIST EMAIL CONTROL, PER CLIENT (Gary: "I should have the ability to switch a client on/off on the
// daily or weekly strategist email... and specify the email addresses this goes to and be able to add/remove").
//
// A paid Opus + web-search pass runs for a brain EVERY time its digest fires, so this is a cost dial as much as
// a delivery preference: 'off' skips the brain on the automated run entirely; 'daily' runs weekdays; 'weekly'
// runs Monday only. The recipient list is per brain - empty falls back to the platform default. The cron
// (app/api/cron/daily-intel) reads both; this route is just the switch.
export const dynamic = "force-dynamic";

// A pragmatic address check: something@something.tld, no spaces. We are not policing deliverability, only
// stopping obvious typos from becoming a silently-undelivered recipient.
function cleanEmails(input: unknown): string[] {
  const raw = Array.isArray(input)
    ? input
    : String(input || "").split(/[,\s;]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of raw) {
    const v = String(e || "").trim().toLowerCase();
    if (!v || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const clientId = new URL(req.url).searchParams.get("clientId") || "";
  if (!clientId) return NextResponse.json({ error: "Pick the client first." }, { status: 400 });
  const rows = (await db().query(
    `select email_schedule, email_recipients, newsletter_schedule from intel_briefs where client_id = $1`,
    [clientId],
  )) as { email_schedule: string | null; email_recipients: string[] | null; newsletter_schedule: string | null }[];
  const r = rows[0];
  // No brief means this brain has no Strategist at all, so there is nothing to schedule. Report it plainly so
  // the control can explain rather than pretend it saved.
  if (!r) return NextResponse.json({ briefed: false, schedule: "off", recipients: [], newsletterSchedule: "off" });
  const s = String(r.email_schedule || "").trim().toLowerCase();
  const ns = String(r.newsletter_schedule || "").trim().toLowerCase();
  return NextResponse.json({
    briefed: true,
    schedule: s === "off" || s === "daily" ? s : "weekly",
    recipients: Array.isArray(r.email_recipients) ? r.email_recipients.filter((x) => typeof x === "string" && x.trim()) : [],
    newsletterSchedule: ["off", "daily", "weekly", "monthly"].includes(ns) ? ns : "off",
  });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { clientId?: string; schedule?: string; recipients?: unknown; newsletterSchedule?: string };
  const clientId = String(b.clientId || "").trim();
  if (!clientId) return NextResponse.json({ error: "Pick the client first." }, { status: 400 });
  const schedule = String(b.schedule || "").trim().toLowerCase();
  if (!["off", "daily", "weekly"].includes(schedule)) {
    return NextResponse.json({ error: "Schedule must be off, daily or weekly." }, { status: 400 });
  }
  // The CEO-article automation cadence rides alongside the digest cadence (both saved together by the control).
  // It also accepts 'monthly'. Only overwritten when provided, so a caller can update just the digest schedule.
  const ns = b.newsletterSchedule === undefined ? null : String(b.newsletterSchedule || "").trim().toLowerCase();
  if (ns !== null && !["off", "daily", "weekly", "monthly"].includes(ns)) {
    return NextResponse.json({ error: "CEO article cadence must be off, daily, weekly or monthly." }, { status: 400 });
  }
  const recipients = cleanEmails(b.recipients);
  const rows = (await db().query(
    `update intel_briefs set email_schedule = $1, email_recipients = $2::jsonb,
       newsletter_schedule = coalesce($4, newsletter_schedule), updated_at = now()
     where client_id = $3
     returning email_schedule, email_recipients, newsletter_schedule`,
    [schedule, JSON.stringify(recipients), clientId, ns],
  )) as { email_schedule: string; email_recipients: string[]; newsletter_schedule: string }[];
  // Only a briefed brain has a row to update. A brain with no Strategist brief cannot be scheduled - say so
  // rather than reporting a save that never happened.
  if (!rows[0]) return NextResponse.json({ error: "This brain has no Strategist brief yet, so there is nothing to schedule for it." }, { status: 404 });
  return NextResponse.json({ ok: true, schedule: rows[0].email_schedule, recipients, newsletterSchedule: rows[0].newsletter_schedule });
}
