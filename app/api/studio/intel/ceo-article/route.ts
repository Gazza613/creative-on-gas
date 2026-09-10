import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { writeCeoNewsletter } from "@/lib/ceo-newsletter";
import { sendEmail, emailConfigured } from "@/lib/email";

// THE CEO THOUGHT-LEADERSHIP ARTICLE (Gary). From a Daily Intelligence finding: DRAFT the client CEO's LinkedIn
// piece (in their brain's voice + compliance, from the public-safe substance only, never the internal "move"),
// then SEND it to the CEO's own email(s). Manual, human-in-the-loop: the team drafts, reviews, adds the
// recipient(s) and sends. The recipient list is saved per brain (intel_briefs.ceo_recipients) so it prefills.
export const maxDuration = 120;
export const dynamic = "force-dynamic";

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

// GET the saved CEO recipients + the CEO's name/title, to prefill the send box.
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const clientId = new URL(req.url).searchParams.get("clientId") || "";
  if (!clientId) return NextResponse.json({ recipients: [], ceoName: "", ceoTitle: "" });
  const rows = (await db().query(
    `select ceo_recipients, ceo_name, ceo_title from intel_briefs where client_id = $1`, [clientId],
  ).catch(() => [])) as { ceo_recipients: string[] | null; ceo_name: string | null; ceo_title: string | null }[];
  const r = rows[0];
  return NextResponse.json({
    recipients: Array.isArray(r?.ceo_recipients) ? r!.ceo_recipients! : [],
    ceoName: r?.ceo_name || "", ceoTitle: r?.ceo_title || "",
  });
}

// Render the article as a clean, plain email (title as heading, blank-line paragraphs). No branding chrome: it
// is the CEO's own words, ready to paste into LinkedIn or read as-is.
function articleHtml(post: string, ceoName: string): string {
  const lines = post.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const title = lines.shift() || "";
  const paras = lines.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.7;color:#1a1030;">${esc(p)}</p>`).join("");
  return `<div style="max-width:600px;margin:0 auto;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:24px;">`
    + `<div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#7c3aed;font-weight:700;margin-bottom:14px;">Thought-leadership draft${ceoName ? ` for ${esc(ceoName)}` : ""}</div>`
    + `<h1 style="font-size:22px;line-height:1.25;color:#1a1030;margin:0 0 16px;">${esc(title)}</h1>`
    + paras
    + `<div style="margin-top:22px;padding-top:14px;border-top:1px solid #eee;font-size:11px;color:#8a8496;">Drafted by GAS Marketing Automation, The Agency of NOW. Please review before publishing.</div></div>`;
}
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as {
    action?: string; clientId?: string; id?: string; notes?: string;
    recipients?: unknown; post?: string; subject?: string;
  };
  const action = String(b.action || "").trim();
  const clientId = String(b.clientId || "").trim();
  const id = String(b.id || "").trim();
  if (!clientId || !id) return NextResponse.json({ error: "Missing the brain or the finding." }, { status: 400 });

  // Load the finding on THIS brain. Any role is eligible for the tick path: we pass only the PUBLIC-SAFE substance
  // (headline, why, detail, sources) to the writer, never the internal campaign_response, so a blunt Strategist
  // finding still becomes a clean, compliant CEO piece.
  const rows = (await db().query(
    `select headline, why_it_matters, detail, sources, published_at from studio_intel where id = $1 and client_id = $2`,
    [id, clientId],
  )) as Record<string, unknown>[];
  const f = rows[0];
  if (!f) return NextResponse.json({ error: "That finding is not on this brain." }, { status: 404 });

  if (action === "draft") {
    const result = await writeCeoNewsletter(clientId, {
      headline: String(f.headline || ""),
      why_it_matters: String(f.why_it_matters || ""),
      detail: String(f.detail || ""),
      sources: (Array.isArray(f.sources) ? f.sources : []) as { name: string; url: string }[],
      published_at: f.published_at ? String(f.published_at) : null,
    }, { userEmail: session.user?.email ?? null, notes: b.notes || null });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    // Keep the draft on the finding so it survives a reload.
    await db().query(`update studio_intel set newsletter = $2, newsletter_art = $3 where id = $1`,
      [id, result.post, result.art?.subject || null]).catch(() => {});
    return NextResponse.json({ ok: true, post: result.post, art: result.art });
  }

  if (action === "send") {
    if (!emailConfigured()) return NextResponse.json({ error: "Email is not configured on this deploy (SMTP env vars missing)." }, { status: 400 });
    const recipients = (Array.isArray(b.recipients) ? b.recipients : []).map((x) => String(x).trim()).filter(Boolean);
    const bad = recipients.filter((r) => !isEmail(r));
    if (!recipients.length) return NextResponse.json({ error: "Add at least one recipient email." }, { status: 400 });
    if (bad.length) return NextResponse.json({ error: `Not a valid email: ${bad.join(", ")}` }, { status: 400 });
    const post = String(b.post || String(f.headline || "")).trim();
    if (!post) return NextResponse.json({ error: "There is no article to send. Draft it first." }, { status: 400 });

    const brief = (await db().query(`select ceo_name from intel_briefs where client_id = $1`, [clientId]).catch(() => [])) as { ceo_name: string | null }[];
    const ceoName = brief[0]?.ceo_name || "";
    const title = post.split(/\n{2,}/)[0]?.trim() || "A note on the market";
    const subject = String(b.subject || "").trim() || title.slice(0, 150);

    const r = await sendEmail({
      to: recipients.join(", "),
      bcc: session.user?.email || undefined,
      subject, html: articleHtml(post, ceoName), fromName: "GAS Marketing Automation",
    }).catch((e) => ({ sent: false, error: String((e as Error)?.message || e) }));
    if (!(r as { sent?: boolean }).sent) return NextResponse.json({ error: `Could not send: ${(r as { error?: string }).error || "unknown"}`.slice(0, 200) }, { status: 400 });

    // Remember the recipients on the brain (so next time prefills) and keep the sent copy on the finding.
    await db().query(`update intel_briefs set ceo_recipients = $2::jsonb where client_id = $1`,
      [clientId, JSON.stringify(recipients)]).catch(() => {});
    await db().query(`update studio_intel set newsletter = $2 where id = $1`, [id, post]).catch(() => {});
    return NextResponse.json({ ok: true, sent: recipients.length });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
