import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { cronAuthed } from "@/lib/cron";
import { sendEmail, emailConfigured } from "@/lib/email";
import { runIntel, loadIntelBrief, brainsWithIntel, type Intel } from "@/lib/intel";
import { writeCeoNewsletter } from "@/lib/ceo-newsletter";
import { emailShell } from "@/lib/email-shell";
import { db } from "@/lib/db";

// THE DAILY INTELLIGENCE RUN. The Journalist and The Strategist each go and find what changed, decide whether
// it is MATERIAL, and file it into the "Worth reviewing" queue. Only the material findings are emailed.
//
// They PROPOSE, they never assert: nothing is written into the client brain automatically. A human accepts or
// bins each finding on the platform. That gate is the product, not friction - without it a bad source quietly
// becomes "fact" and every future article and strategy inherits it.
//
// Scheduled in vercel.json. Also manually triggerable by a super-admin (these calls cost money).
export const maxDuration = 800;
export const dynamic = "force-dynamic";

// WHO GETS THE DIGEST. The intel digest has its own recipient list, separate from the cost email - the people
// who need to read the Strategist every morning are not the same people who watch spend.
//   INTEL_EMAIL_TO  - comma-separated, overrides everything (set it in Vercel to change the list, no deploy).
//   otherwise       - the cost recipient (or Gary) PLUS sam@ (Gary asked for Sam on the strategist findings).
// Deduped and trimmed, because nodemailer will happily mail the same person twice.
function intelRecipients(): string {
  if (process.env.INTEL_EMAIL_TO?.trim()) return process.env.INTEL_EMAIL_TO.trim();
  const base = (process.env.COST_EMAIL_TO || "gary@gasmarketing.co.za").split(",");
  const list = [...base, "sam@gasmarketing.co.za"].map((e) => e.trim().toLowerCase()).filter(Boolean);
  return [...new Set(list)].join(",");
}

// Escapes for BOTH text and attribute context. The quote escapes are load-bearing: source URLs (LLM/crawl
// output, not trusted) are interpolated into href="..." , so a bare " would break out of the attribute and
// inject others. Insert-time filtering already restricts sources to http(s), which blocks javascript: hrefs;
// this closes the attribute-injection gap on top of that.
function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// THE DECISION, not just the news (Gary). Every finding carries an INTERNAL read of what it could do to MoMo SA
// and the campaign move it argues for. Set apart visually so nobody mistakes it for the sourced reporting above
// it - and, for the Journalist, so nobody mistakes GAS's commercial thinking for the CEO's public voice.
function assessmentHtml(i: Intel, client: string): string {
  const risk = String(i.impact_risk || "").trim();
  const move = String(i.campaign_response || "").trim();
  if (!risk && !move) return "";
  const defensive = /\bdefensive\b/i.test(move);
  const proactive = /\bproactive\b/i.test(move);
  const tag = defensive && proactive ? "defensive + proactive" : defensive ? "defensive" : proactive ? "proactive" : "";
  // The two roles assess different things, so label them honestly. The Strategist guides our activations and the
  // positioning we take to MoMo's teams; the Journalist is about the CEO's public narrative.
  const isStrat = i.role === "strategist";
  const riskLabel = isStrat ? `Commercial impact / risk to ${client}` : `Narrative impact / risk for ${client}`;
  const moveLabel = isStrat ? "Activation + positioning call" : "Narrative move";
  return `<div style="margin:0 0 8px;padding:10px 12px;background:#f8fafc;border-left:3px solid #6366f1;border-radius:0 6px 6px 0">
    <p style="margin:0 0 4px;font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#6366f1">Internal${tag ? ` · ${tag}` : ""}</p>
    ${risk ? `<p style="margin:0 0 6px;font-size:13px;line-height:1.55;color:#334155"><b>${riskLabel}:</b> ${esc(risk.slice(0, 900))}</p>` : ""}
    ${move ? `<p style="margin:0;font-size:13px;line-height:1.55;color:#334155"><b>${moveLabel}:</b> ${esc(move.slice(0, 900))}</p>` : ""}
  </div>`;
}



// UK date, the way we write it: "17th July 2026". Not the US default, and not an ISO string in a briefing that
// goes to EXCO.
function ukDate(d: Date | string): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return "";
  const day = dt.getUTCDate();
  const th = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  const month = dt.toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
  return `${day}${th} ${month} ${dt.getUTCFullYear()}`;
}

// THE STRATEGIST BRIEFING. Gary: "we will just get the daily strategist email - no need for the Journalist to
// send a daily email. Make it clear what this email is all about for Sam and Gary... make the look and feel more
// professional with a GAS look and feel as this is going to the EXCO and MTN MoMo internal team."
//
// So it now uses the shared GAS shell (dark, orb, Sami's signature) like our other emails, instead of the
// off-brand light layout it had. The Journalist still runs and still files to the review queue - it is the tool
// for drafting the CEO's LinkedIn voice, not a daily bulletin, so it no longer pushes an inbox.
export function buildEmail(client: string, strategist: Intel[], today: string, intro: string, cadence: "daily" | "weekly" = "weekly"): string {
  // ONE SOURCE OF TRUTH for how the email describes itself. Everything below reads from these two so the
  // heading, strapline and footer can never disagree (they used to: a "Weekly Intelligence" strapline over a
  // "Daily Intelligence" heading in the same email).
  const label = cadence === "weekly" ? "Weekly Intelligence" : "Daily Intelligence";
  const footerCadence = cadence === "weekly" ? "WEEKLY INTELLIGENCE, MONDAY 08:30 SAST" : "DAILY INTELLIGENCE, WEEKDAYS 08:30 SAST";
  // GREEN / AMBER / RED, the way we always grade (Gary). Tuned for the dark shell.
  const badge = (c: string) => {
    const [bg, fg, label] =
      c === "high" ? ["rgba(74,222,128,0.14)", "#4ade80", "HIGH"]
        : c === "low" ? ["rgba(248,113,113,0.14)", "#f87171", "LOW"]
          : ["rgba(251,191,36,0.14)", "#fbbf24", "MED"];
    return `<span style="background:${bg};color:${fg};border-radius:10px;padding:2px 8px;font-size:10px;font-weight:800;letter-spacing:1px;">${label}</span>`;
  };

  // LEAD WITH THE MOST RECENT (Gary). Newest publication first; anything undated sinks to the bottom, because
  // we cannot claim it is current.
  const items = [...strategist].sort((a, b) => {
    const av = a.published_at ? new Date(a.published_at).getTime() : -Infinity;
    const bv = b.published_at ? new Date(b.published_at).getTime() : -Infinity;
    return bv - av;
  });

  const cards = items.map((i) => {
    const srcs = (Array.isArray(i.sources) && i.sources.length)
      ? i.sources
      : i.source_url ? [{ name: i.source_name || i.source_url, url: i.source_url }] : [];
    // Every source carries the date the content was posted, right next to the link (Gary), so nobody has to open
    // it to know how current it is.
    const posted = i.published_at ? ukDate(i.published_at) : "date not established";
    const sourceHtml = srcs.length
      ? `<div style="margin-top:12px;padding-top:10px;border-top:1px solid #1f2630;">
           <div style="font-size:12px;letter-spacing:2px;color:#98a0ad;">SOURCES</div>
           <ol style="margin:6px 0 0;padding-left:18px;color:#8a8f98;">${srcs.map((s) =>
             `<li class="small" style="font-size:13px;line-height:1.8;"><a href="${esc(s.url)}" style="color:#7dd3fc;text-decoration:underline;">${esc(s.name || s.url)}</a> <span style="color:#98a0ad;">· posted ${esc(posted)}</span></li>`).join("")}</ol>
         </div>`
      : `<div style="margin-top:12px;padding-top:10px;border-top:1px solid #1f2630;font-size:12px;font-weight:700;color:#f87171;">No source. Do not treat this as verified.</div>`;

    // BOTH DATES, under the headline (Gary): when it was published, and when we found it. Conflating them is how
    // old news reads as this morning's intelligence.
    const age = i.published_at ? Math.floor((Date.now() - new Date(i.published_at).getTime()) / 86_400_000) : null;
    const stale = age !== null && age > 30;
    const tag = (text: string, colour: string, border: string) =>
      `<span class="tag" style="display:inline-block;border:1px solid ${border};color:${colour};border-radius:5px;padding:3px 9px;font-size:12px;font-weight:600;margin-right:5px;margin-bottom:4px;">${text}</span>`;
    const publishedTag = i.published_at
      ? tag(`Published ${esc(ukDate(i.published_at))}${stale ? ` · ${age} days old` : ""}`, stale ? "#fbbf24" : "#c9ced6", stale ? "rgba(251,191,36,0.4)" : "#2b3440")
      : tag("Published date not established", "#f87171", "rgba(248,113,113,0.4)");
    const foundTag = tag(`Found ${esc(ukDate(i.found_at || today))}`, "#98a0ad", "#2b3440");
    const periodTag = i.period ? tag(`Data covers ${esc(i.period)}`, "#c9ced6", "#2b3440") : "";

    const risk = String(i.impact_risk || "").trim();
    const move = String(i.campaign_response || "").trim();
    const def = /\bdefensive\b/i.test(move), pro = /\bproactive\b/i.test(move);
    const stance = def && pro ? "DEFENSIVE + PROACTIVE" : def ? "DEFENSIVE" : pro ? "PROACTIVE" : "";
    const assessment = (risk || move)
      ? `<div class="card" style="margin-top:12px;padding:11px 12px;background:rgba(249,98,3,0.06);border-left:2px solid #f96203;border-radius:0 8px 8px 0;">
           <div style="font-size:10px;letter-spacing:2px;font-weight:800;color:#f96203;">OUR READ${stance ? ` · ${stance}` : ""}</div>
           ${risk ? `<p class="p" style="margin:9px 0 0;font-size:14px;line-height:1.75;color:#e6e9ee;"><b style="color:#fff;">What it could do to ${esc(client)}:</b> ${esc(risk)}</p>` : ""}
           ${move ? `<p class="p" style="margin:9px 0 0;font-size:14px;line-height:1.75;color:#e6e9ee;"><b style="color:#fff;">What we should do:</b> ${esc(move)}</p>` : ""}
         </div>`
      : "";

    return `
    <div class="card" style="border:1px solid #1f2630;border-radius:12px;padding:13px 14px;margin-bottom:12px;background:#0d1117;">
      <div class="h2" style="font-size:16px;font-weight:800;color:#ffffff;line-height:1.45;letter-spacing:0.2px;">${esc(i.headline)} ${badge(i.confidence)}</div>
      <div style="margin-top:8px;">${publishedTag}${foundTag}${periodTag}</div>
      <p class="p" style="margin:12px 0 0;font-size:14px;line-height:1.7;color:#e6e9ee;"><b style="color:#fff;">Why it matters:</b> ${esc(i.why_it_matters)}</p>
      ${i.detail ? `<p class="p" style="margin:9px 0 0;font-size:14px;line-height:1.75;color:#c9ced6;">${esc(String(i.detail).slice(0, 900))}</p>` : ""}
      ${assessment}
      ${sourceHtml}
    </div>`;
  }).join("");

  const body = `
    <div class="h1" style="font-size:20px;font-weight:800;color:#ffffff;letter-spacing:.2px;line-height:1.25;">${esc(client)} · ${label}</div>
    <div style="margin-top:4px;font-size:14px;color:#8a8f98;">${esc(ukDate(today))}</div>

    <div class="card" style="margin-top:14px;padding:13px 14px;background:#0d1117;border:1px solid #1f2630;border-radius:12px;">
      <p class="p" style="margin:0;font-size:14px;line-height:1.7;color:#e6e9ee;">${esc(intro)}</p>
    </div>

    <div style="margin-top:22px;font-size:12px;letter-spacing:2px;color:#98a0ad;">MATERIAL FINDINGS</div>
    <div style="margin-top:10px;">${cards}</div>`;
  // No "Review and accept on the platform" CTA (Gary): this digest can go to the CLIENT, who has no platform
  // login, so a button into the internal tool has nothing to open. Acceptance happens on the Strategist page by
  // the GAS team, not from the email.

  return emailShell({
    strapline: label.toUpperCase(),
    dateLabel: `${client} · ${ukDate(today)}`,
    body,
    cadence: footerCadence,
    wordmark: "STRATEGIST",
    // Signed by the ROLE, carrying the client's name, not by an internal person (Gary): this digest can land in
    // the client's inbox, where "AI Research Strategist MTN MoMo" is who it is from - not "Sami".
    role: `AI Research Strategist ${client}`,
    department: "GAS Marketing Automation",
    signName: null,
  });
}

// Render a drafted CEO article to HTML: "## " lines become section headings, blank lines split paragraphs. Shared
// shape with the on-demand send so a draft reads the same whether it was automated or hand-sent.
export function renderArticleBody(post: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return post.split(/\n{2,}/).map((blk) => blk.trim()).filter(Boolean).map((blk) => {
    const h = blk.match(/^#{1,3}\s+(.*)$/);
    if (h) return `<h3 style="font-size:17px;line-height:1.3;color:#1a1030;margin:22px 0 8px;">${esc(h[1])}</h3>`;
    return `<p style="margin:0 0 14px;font-size:15px;line-height:1.7;color:#1a1030;">${esc(blk)}</p>`;
  }).join("");
}

// The CEO-article DRAFT email to the internal team: a review banner (who it is for, and that it is NOT yet sent to
// the CEO), the piece, the image idea, and the finding it was drawn from.
function ceoDraftEmail(client: string, ceoName: string, post: string, art: string, ceoRecipients: string[], src: Intel): string {
  const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = post.split(/\n{2,}/);
  const title = (lines[0] || "").replace(/^#{1,3}\s+/, "").trim();
  const rest = lines.slice(1).join("\n\n");
  const intended = ceoRecipients.length ? ceoRecipients.join(", ") : "(no CEO email saved yet on this brain)";
  return `<div style="max-width:640px;margin:0 auto;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:24px;">`
    + `<div style="background:#f5f2fb;border:1px solid #e6def5;border-radius:12px;padding:14px 18px;margin-bottom:20px;">`
    +   `<div style="font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#7c3aed;font-weight:700;">CEO article draft for review</div>`
    +   `<div style="font-size:13px;line-height:1.6;color:#1a1030;margin-top:6px;">A drafted LinkedIn thought-leadership piece for <b>${esc(ceoName || client + "'s CEO")}</b>. This has <b>not</b> been sent to the CEO. Review it, edit if needed, then forward it on to ${esc(intended)}.</div></div>`
    + `<h1 style="font-size:22px;line-height:1.25;color:#1a1030;margin:0 0 16px;">${esc(title)}</h1>`
    + renderArticleBody(rest)
    + `<div style="margin-top:22px;padding-top:14px;border-top:1px solid #eee;font-size:12px;color:#8a8496;">`
    +   (art ? `<div><b style="color:#6b6580;">Image idea:</b> ${esc(art)}</div>` : "")
    +   `<div style="margin-top:6px;"><b style="color:#6b6580;">Drawn from:</b> ${esc(src.headline)}</div></div></div>`;
}

export async function GET(req: Request) {
  const session = await auth();
  if (!cronAuthed(req) && session?.user?.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 401 }); // these calls spend money
  }

  const url = new URL(req.url);
  const only = url.searchParams.get("clientId") || "";
  const today = new Date().toISOString().slice(0, 10);
  // The cron fires 06:30 UTC = 08:30 SAST, the same calendar day, so the UTC weekday IS the SAST weekday.
  // Monday = 1. 'weekly' brains only fire on a Monday; 'daily' brains fire every weekday the cron runs.
  const isMonday = new Date().getUTCDay() === 1;

  // WHICH BRAINS RUN. Any brain with an intel brief - adding the brief is what switches a brain's research on,
  // so there is no hardcoded client list here to fall out of step (it used to match /momo/i, which would have
  // silently skipped GAS's own brain).
  const configured = await brainsWithIntel().catch(() => []);
  // A MANUAL single-client run (a super-admin hitting ?clientId=) is an explicit human request, so it overrides
  // the schedule and even an 'off' switch - you asked for this brain, you get it. The AUTOMATED sweep instead
  // honours each brain's cadence: 'off' is skipped entirely (no research spend), 'weekly' waits for Monday,
  // 'daily' runs every weekday. That gate is the cost dial Gary asked for - not every brain billing five days a
  // week by default.
  const manual = !!only;
  // The CEO-article automation (Gary) rides the same cron: 'daily' every weekday, 'weekly' on Monday, 'monthly' on
  // the FIRST Monday of the month (a day the weekday cron is guaranteed to run, so it fires once and never on a
  // weekend it would miss). A manual single-brain run does both, like the digest.
  const firstMonday = isMonday && new Date().getUTCDate() <= 7;
  const emailFires = (s: string) => s === "daily" || (s === "weekly" && isMonday);
  const newsFires = (s: string) => s === "daily" || (s === "weekly" && isMonday) || (s === "monthly" && firstMonday);
  const clients = configured
    .filter((c) => (only ? c.clientId === only : true))
    .map((c) => ({
      id: c.clientId, name: c.clientName, schedule: c.emailSchedule, recipients: c.emailRecipients,
      emailFires: manual || emailFires(c.emailSchedule),
      newsletterFires: manual || newsFires(c.newsletterSchedule),
      ceoRules: c.ceoRules, ceoName: c.ceoName, ceoRecipients: c.ceoRecipients,
    }))
    .filter((c) => c.emailFires || c.newsletterFires);
  if (!clients.length) return NextResponse.json({ ok: true, skipped: manual ? "no brain has an intel brief" : "no brain is scheduled to run today" });

  const out: Record<string, unknown>[] = [];
  for (const c of clients) {
    try {
      // STRATEGIST ONLY on the daily cron (Gary). The Journalist role was retired with its tile, but the cron
      // kept running it too - a second Opus 4.8 + web-search pass PER BRAIN, EVERY DAY, filing to a queue no
      // screen shows and no email sends. That was the bulk of the "~$30/day Anthropic on light usage" (July
      // 2026): pure automated spend for output nobody read. CEO articles are now drafted on demand from the
      // Researcher desk, so nothing needs the daily Journalist. If it is ever wanted back, gate it behind a flag
      // rather than running it unconditionally.
      // runIntel now meters its own real token cost (tagged 'daily-intel'), so there is no flat proxy here. A
      // manual run (a super-admin pressing "Run research now") is attributed to that user; the true cron passes
      // no session, so its spend lands under Super Admin.
      const errors: string[] = [];
      const strategist = await runIntel(c.id, "strategist", today, session?.user?.email ?? null)
        .catch((e) => { errors.push(`strategist: ${String((e as Error)?.message || e).slice(0, 140)}`); return [] as Intel[]; });

      // Only MATERIAL findings are worth an inbox. The rest wait in the queue.
      const sm = strategist.filter((i) => i.material);

      // THE EMAIL IS THE STRATEGIST ONLY (Gary). A day with no material strategist finding sends nothing rather
      // than mailing the team something to ignore.
      // The intro belongs to the brain: MoMo's briefing is about the SA fintech market, GAS's is about our own
      // agency growth, and one description cannot honestly cover both.
      // THE CADENCE DRIVES THE COPY. A manual one-off is written as a daily bulletin. Everything the email says
      // about itself - the "Daily/Weekly Intelligence" heading, the strapline, the footer cadence and the intro
      // fallback - now comes from this one value, so a weekly brain can never send a mail branded "Daily".
      const cadence: "daily" | "weekly" = c.schedule === "weekly" ? "weekly" : "daily";
      const cfg = await loadIntelBrief(c.id).catch(() => null);
      const period = cadence === "weekly" ? "Weekly" : "Daily";
      const intro = cfg?.emailIntro
        || `${period} intelligence for ${c.name}. Only findings that should change something reach this email, and each one carries what it could do and what I think we should do about it. Every claim is sourced, so please check the links before repeating anything.`;

      // PER-BRAIN RECIPIENTS (Gary): each brain's own list, edited on the Strategist page. Empty falls back to
      // the platform default so a brain that has never been given a list still reaches someone.
      const to = c.recipients.length ? c.recipients.join(",") : intelRecipients();

      let emailed = false;
      if (c.emailFires && sm.length && emailConfigured()) {
        await sendEmail({
          to,
          subject: `The Strategist · ${c.name} · ${sm.length} material finding${sm.length === 1 ? "" : "s"} · ${today}`,
          html: buildEmail(c.name, sm, today, intro, cadence),
          fromName: "Strategist on GAS", // it lands with EXCO and MoMo's team: say what it is (Gary)
        }).catch(() => {});
        emailed = true;
      }

      // CEO ARTICLE AUTOMATION (Gary): on the newsletter cadence, draft the CEO's LinkedIn piece from the strongest
      // finding and email the DRAFT to the internal team to review and forward on - NEVER to the CEO. Skipped if the
      // brain has no CEO voice rules, or nothing worth writing about came back.
      let ceoDrafted = false;
      if (c.newsletterFires && c.ceoRules) {
        const top = sm[0] || strategist[0];
        if (top && emailConfigured()) {
          const draft = await writeCeoNewsletter(c.id, {
            headline: top.headline, why_it_matters: top.why_it_matters, detail: top.detail,
            sources: top.sources, published_at: top.published_at,
          }, { userEmail: null }).catch(() => null);
          if (draft && draft.ok) {
            await db().query(`update studio_intel set newsletter = $2, newsletter_art = $3 where id = $1`,
              [top.id, draft.post, draft.art?.subject || null]).catch(() => {});
            await sendEmail({
              to,
              subject: `CEO article draft for review · ${c.name} · ${today}`,
              html: ceoDraftEmail(c.name, c.ceoName, draft.post, draft.art?.subject || "", c.ceoRecipients, top),
              fromName: "GAS Marketing Automation",
            }).catch(() => {});
            ceoDrafted = true;
          }
        }
      }
      out.push({ client: c.name, cadence, strategist: strategist.length, material: sm.length, emailed, ceoDrafted, errors: errors.length ? errors : undefined });
    } catch (e) {
      out.push({ client: c.name, error: String((e as Error)?.message || e).slice(0, 160) });
    }
  }

  return NextResponse.json({ ok: true, today, ran: out });
}
