import Anthropic from "@anthropic-ai/sdk";
import { db } from "./db";
import { getSecret } from "./connections";
import { PREMIUM } from "./vendors/anthropic";
import { getBrandKit } from "./studio";
import { recordTokens } from "./usage";

// THE DAILY INTELLIGENCE RUN — shared engine for The Journalist and The Strategist.
//
// Both roles do the same first job: go and find what CHANGED, and work out whether it matters to this client.
// They differ in what they do with it. The Journalist looks for material a CEO could build a defensible public
// argument on. The Strategist looks for things that should change what we ADVISE.
//
// TWO HARD RULES, and they are the whole design:
//
// 1. IT PROPOSES, IT NEVER ASSERTS. Findings land in a review queue for a human to accept or bin. Nothing is
//    written into the client brain automatically. If a bad source could quietly become "fact", every future
//    article and strategy would silently inherit it - so the human gate is not friction, it is the product.
//
// 2. RINGFENCED BY THE BRAIN. Gary: "I do not want to contaminate MoMo." The brain IS the ringfence: select a
//    brain and both the DATA (its doctrine and findings, keyed by client_id) and the INSTRUCTIONS (its scope
//    lock and role briefs, in `intel_briefs`) come from that brain alone. A brain with no brief REFUSES to
//    run - there is no default and no fallback, because a fallback would hand it another brain's scope.

export type Intel = {
  id: string;
  role: string;
  // Only the Researcher sets this: which of its five sections the finding belongs under.
  section?: string | null;
  // Only the Researcher sets this: the machine-verification verdict on the cited source - "verified" (page
  // reached and it supports the claim), "partial" (reached, support not graded), "unverified" (page could not
  // be fetched, e.g. bot-blocked). A "refuted" finding is never stored; it is dropped at file time.
  verification?: string | null;
  headline: string;
  why_it_matters: string;
  detail: string | null;
  source_url: string | null;
  source_name: string | null;
  sources: { name: string; url: string }[];
  published_at: string | null;
  period: string | null;
  confidence: string;
  material: boolean;
  // INTERNAL assessment - never part of the CEO's public voice. See the brief in ASSESSMENT below.
  impact_risk: string | null;
  campaign_response: string | null;
  // The CEO newsletter drafted off this finding, kept so it survives a logout.
  newsletter: string | null;
  newsletter_art: string | null;
  newsletter_options: string[];
  status: string;
  found_at: string;
};

const STYLE = `HOW TO WRITE THIS (it is read by busy marketers and by the client's own team, not by analysts):
- Plain, direct English. Short sentences. Everyday words. Say the thing itself, not the jargon for it.
- SIMPLER LANGUAGE, SAME SUBSTANCE. Do NOT dilute or generalise to sound readable: keep every number, name,
  date, caveat and honest uncertainty exactly as it is. If a term of art is unavoidable (FAIS, FSP, e-money),
  use it and explain it in a few words the first time.
- No consultant register: avoid "two-sided", "doctrine", "materially", "leverage", "signals", "posture",
  "vectors". Write as if telling a colleague what happened and what we should do about it.
- Lead with the point. The first sentence says what happened or what to do, not the build-up.
- UK British spelling, ALWAYS. NEVER use an em dash or an en dash: use a comma, a full stop, or a plain hyphen.
- BANNED PHRASE: never write "the uncomfortable truth" or any variant of it. State the point plainly instead.`;

// THE MARKETING LENS (Gary: "we are a marketing agency"). Both intelligence desks - the weekly Strategist and
// the on-demand Researcher - must think like the best marketing mind in the room, not a generic analyst. Every
// fact is read for what it means for how this brand is POSITIONED, what it SAYS, what it MAKES and where it
// SPENDS. Shared by both engines so the standard is identical.
export const MARKETING_LENS = `YOUR LENS - you are a top 1% MARKETING strategist and researcher, the calibre a leading agency puts in the room. Read EVERYTHING through a marketing lens first: brand positioning and perception, category and competitor share of voice, messaging and narrative, creative and campaign craft, the media and channel mix, the funnel from awareness to conversion, price and value perception, and the consumer psychology and behaviour underneath it all. Regulation, product and market facts matter for what they mean for the MARKETING - how the brand should be positioned, what it should say, what it should make, and where it should spend. Every finding must ultimately answer: what does this change about our marketing, and what is the move?`;

// RESEARCH ANY CRAWLED BRAIN, no hand-written brief needed (Gary: crawled 100 pages into a brain, Researcher
// said "nothing configured"). A brain that has KNOWLEDGE is researchable: we derive a scope lock and a marketing
// remit from the brain's OWN name and crawled material. This does NOT break the ringfence - the derived scope
// is strictly this-client-only and uses only this brain's own data, so no other brain's scope is ever borrowed.
// Explicit intel_briefs still win where they exist; this is only the fallback.
export async function deriveResearchBrief(clientId: string): Promise<{ clientName: string; scope: string; remit: string; doctrine: string } | null> {
  const cr = (await db().query(`select name from clients where id = $1`, [clientId])) as { name: string }[];
  const name = cr[0]?.name;
  if (!name) return null;
  const chunks = (await db().query(
    `select content from knowledge_chunks where client_id = $1 order by created_at desc limit 40`,
    [clientId],
  )) as { content: string }[];
  const doctrine = chunks.map((c) => c.content).join("\n\n").slice(0, 7000);
  const website = await clientWebsite(clientId);
  const scope = `SCOPE LOCK. You are researching ${name}, and ONLY ${name}. ${name} is the SUBJECT of every finding; ` +
    `any other company may appear only as its competitor, partner or market context, never as the subject. Everything ` +
    `you report must be about ${name}, its category, its market and its competitive set. Do not drift onto another brand.` +
    siteAnchor(name, website);
  const remit = `Do a world-class marketing deep dive on ${name}: establish where ${name} stands and what it should do, ` +
    `across the five sections. Ground it in ${name}'s own material below${website ? ` (its site is ${website})` : ""} and in ` +
    `current, verifiable web research about ${name} and its market.`;
  return { clientName: name, scope, remit, doctrine };
}

// Which brains the Researcher can run: any with an explicit researcher remit, OR any that has crawled knowledge
// (so a freshly-crawled brain is immediately researchable via the derived brief above).
export async function researchableClientIds(): Promise<string[]> {
  const rows = (await db().query(
    `select distinct c.id from clients c
     where c.website is not null and c.website <> ''
        or exists (select 1 from intel_briefs b where b.client_id = c.id and b.researcher is not null)
        or exists (select 1 from knowledge_chunks k where k.client_id = c.id)`,
  )) as { id: string }[];
  return rows.map((r) => String(r.id));
}

// AGENTS WORKING TOGETHER (Gary). Recent findings a HUMAN accepted into the brain from the OTHER desk, so the
// Strategist watches what the Researcher established and the Researcher builds on what the Strategist has seen.
// Accepted only - the validated signal - and recent, capped, headline + why so it stays cheap to carry.
export async function loadDeskContext(clientId: string, ofRole: "researcher" | "strategist", limit = 20): Promise<{ headline: string; why: string }[]> {
  const rows = (await db().query(
    `select headline, why_it_matters from studio_intel
     where client_id = $1 and role = $2 and status = 'accepted' and found_at > now() - interval '120 days'
     order by found_at desc limit $3`,
    [clientId, ofRole, limit],
  )) as { headline: string; why_it_matters: string }[];
  return rows.map((r) => ({ headline: String(r.headline || ""), why: String(r.why_it_matters || "") }));
}

const HONESTY = (windowDays: number, answerMode = false) => `HONESTY RULES:
- Every finding must carry a REAL source URL you actually read. If you cannot source it, do not report it.
- Grade confidence honestly: high (primary source - regulator, company results, statute), medium (credible secondary - law firm, trade press, fact-checker), low (single source, thin, or inferred).
- Mark material=true ONLY if this would actually change what we say or do. Most news is not material. A quiet day with nothing material is a CORRECT result - say so rather than padding.
${answerMode
  ? `- RECENCY: the team asked a direct question, so ANSWER it. Lead with the newest developments (ideally the last ${windowDays} days), but you MAY include essential background and your own sourced assessment even when it is older than that - context that answers the question is welcome, it does not all have to be breaking news. Date every source and clearly flag anything older than the window. Never present old material as if it broke today.`
  : `- RECENCY IS A HARD GATE. This is a DAILY intelligence run: you report WHAT CHANGED. Only report things published or announced in the LAST ${windowDays} DAYS. Older material - however good - is BACKGROUND, not news, and it already lives in our doctrine. Do not report it. A stale finding presented as current is worse than no finding.`}
- HYPER-FOCUS ON THE NEWEST. Inside the window, newer beats older every time: something from the last few days is worth far more to us than something from three weeks ago, even if the older item is more interesting. Search for the most recent developments FIRST and report the freshest material you can stand up. Order your findings newest first.
- DATE EVERY FINDING. Give published_at as the date the SOURCE was published or the event happened - NOT today. If you cannot establish the date, leave it empty rather than guessing - but know that an undated finding will be REJECTED, because we cannot claim it is current.
- Also give 'period' when the data covers a span that differs from the publication date (e.g. a report published this month describing FY2025). Recency of PUBLICATION is not recency of DATA.`;

// THE SCOPE LOCK AND THE ROLE BRIEFS NOW LIVE ON THE BRAIN, not in this file.
//
// They used to be constants hardcoded to MTN MoMo ("You are researching MTN MoMo..."), which meant a second
// brain would have been researched under MoMo's scope lock. Gary's model is the right one: the BRAIN is the
// ringfence - select the GAS brain and the context is GAS's own loaded data, select MoMo and it is MoMo's. The
// brain already scoped the DATA (doctrine and findings are client_id keyed); it did not scope the INSTRUCTIONS.
// Now it does: each brain carries its own scope lock and role briefs in `intel_briefs`, and a brain with no
// brief REFUSES to run rather than borrowing another brain's scope. See db/schema.sql.
export type IntelBrief = {
  clientId: string;
  clientName: string;
  scope: string;
  journalist: string | null;
  strategist: string | null;
  // The Researcher's remit for this brain. On-demand only, and it does NOT use windowDays - structural research
  // is not gated on recency the way the daily watch is.
  researcher: string | null;
  windowDays: number;
  emailIntro: string | null;
  // THE CEO'S VOICE, PER BRAIN. These were hardcoded to MTN MoMo in the newsletter route and in the creative:
  // the writing rules named a fintech and applied FAIS advertising law, and the nameplate defaulted to Kagiso
  // Mothibi. Pointed at a second brain, that would have published GAS thought leadership under fintech rules
  // with another company's CEO on it. No MoMo FACT would have leaked - the data was always client_id scoped -
  // but the VOICE would have, which is its own kind of contamination and just as unpublishable.
  ceoRules: string | null;
  ceoName: string | null;
  ceoTitle: string | null;
  // The client's OWN official website - the ground truth the desks must stay inside (Gary). Both desks anchor
  // to it so they can never research a same-named but different business.
  website: string | null;
  // RETIRED PRODUCTS the client no longer sells but has not yet scrubbed from its own site (Gary: GAS still lists
  // Appitude / ROC / INGAiGE). Ground truth from the team: NEVER present these as current, never reference them.
  deprecatedProducts: string[];
  // THE STRATEGIST EMAIL CADENCE for this brain: 'off' | 'daily' (weekdays) | 'weekly' (Monday). A cost dial -
  // the automated run only spends on this brain when its cadence says fire today.
  emailSchedule: "off" | "daily" | "weekly";
  // The brain's own digest recipient list. Empty means fall back to the platform default.
  emailRecipients: string[];
};

// Normalises a stored schedule to the three we allow, defaulting to 'weekly' for any legacy/blank value.
function normSchedule(v: unknown): "off" | "daily" | "weekly" {
  const s = String(v || "").trim().toLowerCase();
  return s === "off" || s === "daily" ? s : "weekly";
}

export async function loadIntelBrief(clientId: string): Promise<IntelBrief | null> {
  const rows = (await db().query(
    `select b.client_id, c.name as client_name, c.website, b.scope, b.journalist, b.strategist, b.researcher, b.window_days,
            b.email_intro, b.ceo_rules, b.ceo_name, b.ceo_title, b.deprecated_products, b.email_schedule, b.email_recipients
     from intel_briefs b join clients c on c.id = b.client_id
     where b.client_id = $1`,
    [clientId],
  )) as Record<string, unknown>[];
  const r = rows[0];
  if (!r) return null;
  return {
    clientId: String(r.client_id),
    clientName: String(r.client_name),
    scope: String(r.scope),
    journalist: (r.journalist as string) || null,
    strategist: (r.strategist as string) || null,
    researcher: (r.researcher as string) || null,
    windowDays: Number(r.window_days) || 30,
    emailIntro: (r.email_intro as string) || null,
    ceoRules: (r.ceo_rules as string) || null,
    ceoName: (r.ceo_name as string) || null,
    ceoTitle: (r.ceo_title as string) || null,
    website: (r.website as string) || null,
    deprecatedProducts: Array.isArray(r.deprecated_products) ? (r.deprecated_products as string[]).filter((s) => typeof s === "string" && s.trim()) : [],
    emailSchedule: normSchedule(r.email_schedule),
    emailRecipients: Array.isArray(r.email_recipients) ? (r.email_recipients as string[]).filter((s) => typeof s === "string" && s.trim()) : [],
  };
}

// THE GROUND-TRUTH ANCHOR (Gary, material): the desks kept drifting to a same-named but different business
// ("theamberroom.co.za" instead of the client's "the-amber-room.co.za"). This block, injected into every intel
// scope, forces the research to validate every source against the client's OWN website and reject look-alikes.
export function siteAnchor(name: string, website: string | null | undefined): string {
  if (!website) return "";
  return `\n\nGROUND-TRUTH ANCHOR (non-negotiable). The client is ${name}, the organisation at its OWN official website ${website}. This anchor fixes WHICH organisation you research - it does NOT restrict you to their own website. In fact, RANGE WIDELY and actively seek INDEPENDENT coverage of this organisation: news and press/media releases, trade and industry publications, the relevant regulator's records, partner and award announcements, interviews and podcasts, business directories, and review platforms. Their own site establishes who they are; the independent record is where much of the story lives, so do not lean only on their site. THE RULE IS ABOUT THE ENTITY, NOT THE SOURCE: use any credible source, provided it is genuinely about the ${name} at ${website} and not a same-named but different business. A business that merely SHARES the name is a different entity, never research or cite it. If you genuinely cannot tell which entity a source is about, treat it as unverified or low-confidence rather than as fact, do not silently drop useful coverage. If ${name} publishes an official regulatory or registration number (for example an FSP number or a company registration number, usually in the site footer), that number is the DEFINITIVE identity check: use it to confirm you have the right entity and to pull the regulator's own record.`;
}

// The client's canonical website: the explicit one they set, else the domain their crawled knowledge came from.
export async function clientWebsite(clientId: string): Promise<string | null> {
  const c = (await db().query(`select website from clients where id = $1`, [clientId])) as { website: string | null }[];
  if (c[0]?.website) return c[0].website;
  const dom = (await db().query(
    `select substring(metadata->>'url' from '^https?://[^/]+') as host, count(*)::int as n
     from knowledge_chunks where client_id = $1 and metadata->>'url' is not null
     group by 1 order by n desc limit 1`, [clientId],
  )) as { host: string | null; n: number }[];
  return dom[0]?.host ? `${dom[0].host}/` : null;
}

// ALL of a client's official sites (Gary: some clients have several). The primary `website` first, then any
// extras from `websites`, deduped. Falls back to the crawl domain if none is set.
export async function clientWebsites(clientId: string): Promise<string[]> {
  const c = (await db().query(`select website, websites from clients where id = $1`, [clientId])) as { website: string | null; websites: string[] | null }[];
  const extra = Array.isArray(c[0]?.websites) ? c[0]!.websites! : [];
  const all = [...(c[0]?.website ? [c[0].website] : []), ...extra].map((u) => String(u || "").trim()).filter(Boolean);
  const dedup = [...new Set(all.map((u) => u.replace(/\/+$/, "").toLowerCase()))].map((low) => all.find((u) => u.replace(/\/+$/, "").toLowerCase() === low)!);
  if (dedup.length) return dedup;
  const w = await clientWebsite(clientId);
  return w ? [w] : [];
}

// Which brains have research configured at all. The daily run iterates THESE, so adding a brain's brief is what
// switches its research on - there is no hardcoded client list to keep in step.
export async function brainsWithIntel(): Promise<{ clientId: string; clientName: string; journalist: boolean; strategist: boolean; researcher: boolean; ceoRules: boolean; emailSchedule: "off" | "daily" | "weekly"; emailRecipients: string[]; newsletterSchedule: "off" | "daily" | "weekly" | "monthly"; ceoName: string; ceoRecipients: string[] }[]> {
  const rows = (await db().query(
    `select b.client_id, c.name as client_name,
            (b.journalist is not null) as journalist, (b.strategist is not null) as strategist,
            (b.researcher is not null) as researcher,
            (b.ceo_rules is not null and length(trim(b.ceo_rules)) > 0) as ceo_rules,
            b.email_schedule, b.email_recipients, b.newsletter_schedule, b.ceo_name, b.ceo_recipients
     from intel_briefs b join clients c on c.id = b.client_id
     order by c.name`,
    [],
  )) as Record<string, unknown>[];
  const normNews = (v: unknown): "off" | "daily" | "weekly" | "monthly" => {
    const s = String(v || "").trim().toLowerCase();
    return s === "daily" || s === "weekly" || s === "monthly" ? s : "off";
  };
  return rows.map((r) => ({
    clientId: String(r.client_id),
    clientName: String(r.client_name),
    journalist: r.journalist === true,
    strategist: r.strategist === true,
    researcher: r.researcher === true,
    emailSchedule: normSchedule(r.email_schedule),
    emailRecipients: Array.isArray(r.email_recipients) ? (r.email_recipients as string[]).filter((s) => typeof s === "string" && s.trim()) : [],
    // Whether this brain can publish a CEO article at all - it needs a CEO voice to write in. Used to gate the
    // "Publish as CEO article" button so a brain without rules never shows it, rather than erroring on click.
    ceoRules: r.ceo_rules === true,
    // The CEO-article automation cadence, plus the CEO's name and saved recipient(s), for the cron's draft-and-mail.
    newsletterSchedule: normNews(r.newsletter_schedule),
    ceoName: String(r.ceo_name || ""),
    ceoRecipients: Array.isArray(r.ceo_recipients) ? (r.ceo_recipients as string[]).filter((s) => typeof s === "string" && s.trim()) : [],
  }));
}

// UNIVERSAL assessment shape. WHAT is being assessed, and how to frame it, comes from the brain's own role
// brief - so the Strategist assessing GAS's growth and the Strategist assessing MoMo's market use the same
// structure without one leaking into the other.
const ASSESSMENT = `ASSESS EVERY FINDING, THEN RECOMMEND. Both fields are INTERNAL and are never published.
- impact_risk: what this could ACTUALLY do, framed exactly as your role brief defines it. Give the mechanism
  (how it actually reaches us), who it touches, rough SIZE, how FAST and how LIKELY. Name the downside even when
  the news looks good, and the upside even when it looks bad. If the honest answer is "little to no real
  impact", SAY SO - a manufactured risk is worse than none, because it spends the team's attention. Separate
  what you sourced from what you are inferring, and say which is which.
- campaign_response: what we should DO about it, framed exactly as your role brief defines it. Say whether it is
  DEFENSIVE (protect a position, correct a misread, get ahead of a problem) or PROACTIVE (take an opening), then
  be concrete enough to act on. "No move needed" is a valid and useful answer - a recommendation invented for its
  own sake wastes the team's time and makes our comms less efficient, not more.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          headline: { type: "string", description: "One line. What changed." },
          why_it_matters: { type: "string", description: "The SO WHAT for the client in your scope lock, specifically. Be concrete." },
          detail: { type: "string", description: "The substance, with the real numbers." },
          sources: {
            type: "array",
            description: "EVERY source you actually read for this finding. A real URL each - never invent one.",
            items: {
              type: "object", additionalProperties: false,
              properties: { name: { type: "string" }, url: { type: "string" } },
              required: ["name", "url"],
            },
          },
          published_at: { type: "string", description: "The date the SOURCE was published, or the event happened, as YYYY-MM-DD. NOT today's date. If you genuinely cannot establish it, return an empty string - never guess." },
          period: { type: "string", description: "What the DATA actually covers, if different from the publication date (e.g. 'FY2025', 'calendar 2024', 'Q1 2026'). A report published this month can describe a year that is already old. Empty if not applicable." },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          material: { type: "boolean", description: "Would this actually change what we say or do? Most things are not." },
          // Deliberately role-NEUTRAL: the Strategist and the Journalist assess different things (commercial vs
          // narrative), and their own ASSESSMENT brief defines the lane. Restating one role's job here would
          // hand it to the other - which is exactly how the two agents start duplicating each other.
          impact_risk: { type: "string", description: "INTERNAL, never published. Your assessment of what this could actually do, framed exactly as your role brief defines it. Be honest about size, including 'little to none'." },
          campaign_response: { type: "string", description: "INTERNAL, never published. Your recommended move, as your assessment brief defines it for your role. State whether it is DEFENSIVE or PROACTIVE. 'No move needed' is a valid answer." },
        },
        required: ["headline", "why_it_matters", "detail", "sources", "published_at", "period", "confidence", "material", "impact_risk", "campaign_response"],
      },
    },
    quiet_day: { type: "boolean", description: "True if nothing material was found. That is a correct result, not a failure." },
  },
  required: ["findings", "quiet_day"],
} as unknown as Anthropic.Tool["input_schema"];

// THE RECENCY WINDOW LIVES ON THE BRAIN (intel_briefs.window_days, 30 by default - Gary's maximum).
// It used to be a pair of env-tunable constants here, but the window is a property of what a brain is FOR,
// not of the engine, and two sources of truth for the same setting is how they drift apart.

// Run one role's daily research. Returns the findings it PROPOSES (already stored, status 'new').
export async function runIntel(clientId: string, role: "journalist" | "strategist", today: string, userEmail?: string | null, focus?: string | null, windowOverride?: number | null): Promise<Intel[]> {
  const key = await getSecret("anthropic");
  if (!key) throw new Error("Claude isn't connected");

  // THE BRAIN IS THE RINGFENCE. Everything client-specific - the scope lock and the role brief - comes from THIS
  // brain, alongside its own doctrine. No brief means we REFUSE to run: silently falling back to another brain's
  // scope is precisely the contamination this design exists to prevent.
  const cfg = await loadIntelBrief(clientId);
  if (!cfg) throw new Error("This brain has no intel brief, so its scope lock is unknown. Refusing to research it rather than borrow another brain's scope. Add a row to intel_briefs.");
  const roleBrief = role === "journalist" ? cfg.journalist : cfg.strategist;
  if (!roleBrief) return []; // this brain deliberately does not run this role

  const client = new Anthropic({ apiKey: key });
  const kit = await getBrandKit(clientId).catch(() => null);
  // The recency window defaults to the brain's own window_days, but an ON-DEMAND call may override it (Gary): a
  // specific "ask the market" question looks back up to ~90 days, a proactive "find what's new" sweep only ~14.
  // Clamped to a sane [1, 120] so an override can never mine ancient material as if it were news.
  const windowDays = windowOverride && windowOverride > 0 ? Math.min(120, Math.max(1, Math.round(windowOverride))) : cfg.windowDays;

  // WORK WITH THE RESEARCHER (Gary). The Strategist watches for what CHANGES the positions the Researcher's deep
  // dives have established, so it reads them first and reports movement against them rather than in a vacuum.
  const priorResearch = role === "strategist" ? await loadDeskContext(clientId, "researcher").catch(() => []) : [];
  const researchContext = priorResearch.length
    ? `\n\nSTANDING RESEARCH ON FILE (deep dives the Researcher desk established for ${cfg.clientName}) - report what has CHANGED, been CONFIRMED or been CHALLENGED against these, and build on them; do not restate them:\n${priorResearch.map((r) => `- ${r.headline}${r.why ? `: ${r.why}` : ""}`).join("\n").slice(0, 4000)}\n`
    : "";

  // TWO STEPS, deliberately.
  //
  // Step 1 researches with web search. Step 2 files the report with the schema FORCED.
  // Doing both in one call means giving the model web_search AND report under tool_choice:auto - and it can
  // then simply finish after searching without ever filing. That is exactly what happened on the first live
  // run: the Strategist filed 6 findings, the Journalist filed NOTHING, silently. Forcing the report tool in
  // its own call makes a missing report impossible rather than merely unlikely.
  // A FREE-TEXT QUESTION from the team (the dashboard "Ask the market" box). It steers this run to answer that
  // question directly, with sourced findings, while still surfacing anything else genuinely material. It never
  // loosens the scope lock or the no-fabrication rule.
  const answerMode = !!focus?.trim();
  const focusLine = answerMode
    ? `\n\nTHE TEAM HAS A SPECIFIC QUESTION FOR THIS RUN - answering it is the PRIORITY: "${focus!.trim().slice(0, 600)}"\nSearch specifically to answer it and file sourced findings that address it directly, then flag anything else genuinely material. If the EXACT subject is not a direct player in ${cfg.clientName}'s market (wrong country, different sector, a name mix-up), DO NOT just return nothing: file one finding that says so plainly and pivots to the nearest relevant read (for example the local equivalent, or the closest real competitor), so the team always gets a useful answer. Only return empty if there is genuinely nothing sourced to say at all.`
    : "";
  const opening = answerMode
    ? `Today is ${today}. The team has asked a specific question. Give a genuine, sourced market read that ANSWERS it, strictly inside your scope lock.${focusLine}`
    : `Today is ${today}. Research what has changed that matters to ${cfg.clientName}, strictly inside your scope lock.${focusLine}`;
  const knowLine = answerMode
    ? `WHAT WE ALREADY KNOW (use this as context to ground your answer; build on it, do not merely restate it):`
    : `WHAT WE ALREADY KNOW (do NOT report these back as new - only report what ADDS to or CONTRADICTS this):`;
  const closing = answerMode
    ? `Search the web now and answer the question with real sources.`
    : `Search the web now. Then set out what is genuinely new and worth our attention, with the real source for each.`;
  const brief = `${opening}\n\n${knowLine}\n${(kit?.tone_notes || "(no doctrine loaded)").slice(0, 6000)}${researchContext}\n\n${closing}`;

  const research = await client.messages.create({
    model: PREMIUM,
    max_tokens: 6000,
    system: `${cfg.scope}${siteAnchor(cfg.clientName, cfg.website)}\n\n${roleBrief}\n\n${MARKETING_LENS}\n\n${ASSESSMENT}\n\n${HONESTY(windowDays, answerMode)}\n\n${STYLE}`,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 10 } as unknown as Anthropic.Tool],
    messages: [{ role: "user", content: brief }],
  });
  // TOKEN-ACCURATE metering (Gary): the WEEKLY Strategist runs on Opus 4.8 + web search - now that it is once a
  // week (not daily), the premium model is worth it for the analysis quality, and the cost is contained. The
  // search step's cost is dominated by the search RESULTS fed back as input tokens, so a flat per-request proxy
  // badly understated it. Meter the real usage of both steps here, tagged 'daily-intel'.
  const su = research.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; server_tool_use?: { web_search_requests?: number } } | undefined;
  await recordTokens({
    clientId, userEmail, model: PREMIUM, action: "daily-intel",
    inputTokens: su?.input_tokens || 0, outputTokens: su?.output_tokens || 0,
    cacheReadTokens: su?.cache_read_input_tokens || 0, cacheCreationTokens: su?.cache_creation_input_tokens || 0,
    webSearches: su?.server_tool_use?.web_search_requests || 0,
  }).catch(() => {});

  const notes = research.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim();
  if (!notes) return [];

  const res = await client.messages.create({
    model: PREMIUM,
    // The assessment adds two reasoned fields per finding, so the filing step needs the room to think.
    max_tokens: 6000,
    // STYLE belongs here most of all: this is the step that writes the words the team actually reads, and it
    // never carried the UK-spelling / no-em-dash rule at all, which is how em dashes kept reaching the inbox.
    system: `${cfg.scope}${siteAnchor(cfg.clientName, cfg.website)}\n\n${MARKETING_LENS}\n\n${HONESTY(windowDays, answerMode)}\n\n${ASSESSMENT}\n\n${STYLE}\n\nFile the research below as structured findings. Carry the REAL source URLs through - never invent one. If the research found nothing genuinely new, return an empty findings list and quiet_day=true. A quiet day is a correct answer, not a failure.`,
    tools: [{ name: "report", description: "The day's findings, each with a real source.", input_schema: SCHEMA }],
    tool_choice: { type: "tool", name: "report" }, // FORCED - a report always comes back
    messages: [{ role: "user", content: `Research notes from today's run:\n\n${notes.slice(0, 20000)}` }],
  });

  const fu = res.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
  await recordTokens({
    clientId, userEmail, model: PREMIUM, action: "daily-intel",
    inputTokens: fu?.input_tokens || 0, outputTokens: fu?.output_tokens || 0,
    cacheReadTokens: fu?.cache_read_input_tokens || 0, cacheCreationTokens: fu?.cache_creation_input_tokens || 0,
  }).catch(() => {});

  const block = res.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") return [];
  const out = block.input as { findings?: Record<string, unknown>[]; quiet_day?: boolean };
  const findings = Array.isArray(out.findings) ? out.findings : [];
  if (!findings.length) return [];

  // THE GATE. Reject anything we cannot prove is current, before it is ever stored.
  const cutoff = Date.now() - windowDays * 86_400_000;
  const dropped: string[] = [];
  const fresh = findings.filter((f) => {
    const d = String(f.published_at || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { dropped.push(`${String(f.headline || "?").slice(0, 60)} — undated`); return false; }
    const t = new Date(d).getTime();
    if (!Number.isFinite(t) || t < cutoff) {
      dropped.push(`${String(f.headline || "?").slice(0, 60)} — ${d}, older than ${windowDays} days`);
      return false;
    }
    return true;
  });
  if (dropped.length) console.warn(`[intel:${role}] dropped ${dropped.length} stale/undated finding(s): ${dropped.join(" | ")}`);

  // NO EM DASHES, EVER (Gary). The prompt asks, but a prompt is not a guarantee and this is a house rule, so we
  // enforce it on the way into the database: every em dash and en dash becomes a plain hyphen. Once stored clean,
  // the email, the platform queue and anything downstream inherit it - there is no second place to remember.
  // A numeric range is handled FIRST and tightly ("12-18 months"), because the generic prose rule would turn it
  // into "12 - 18 months", which is not how anyone writes a range.
  const noDash = (s: unknown) => String(s ?? "")
    .replace(/(\d)\s*[—–]\s*(\d)/g, "$1-$2")
    .replace(/\s*[—–]\s*/g, " - ")
    .trim();

  const saved: Intel[] = [];
  for (const f of fresh) {
    const srcs = (Array.isArray(f.sources) ? f.sources : [])
      .filter((s): s is { name: string; url: string } => !!s && typeof (s as { url?: string }).url === "string" && /^https?:\/\//i.test((s as { url: string }).url))
      .slice(0, 8);
    const rows = (await db().query(
      `insert into studio_intel (client_id, role, headline, why_it_matters, detail, sources, source_url, source_name, published_at, period, confidence, material, impact_risk, campaign_response)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       returning id, role, headline, why_it_matters, detail, sources, source_url, source_name, published_at, period, confidence, material, impact_risk, campaign_response, status, found_at`,
      [clientId, role, noDash(f.headline).slice(0, 300), noDash(f.why_it_matters).slice(0, 1200),
       noDash(f.detail).slice(0, 4000), JSON.stringify(srcs),
       srcs[0]?.url ?? null, srcs.map((s) => s.name).join(" · ").slice(0, 200) || null,
       /^\d{4}-\d{2}-\d{2}$/.test(String(f.published_at || "")) ? f.published_at : null,
       String(f.period || "").slice(0, 60) || null,
       ["high", "medium", "low"].includes(String(f.confidence)) ? f.confidence : "medium", f.material === true,
       noDash(f.impact_risk).slice(0, 3000) || null,
       noDash(f.campaign_response).slice(0, 3000) || null],
    )) as Intel[];
    saved.push(rows[0]);
  }
  return saved;
}

export async function listIntel(clientId: string, status = "new"): Promise<Intel[]> {
  return (await db().query(
    `select id, role, headline, why_it_matters, detail, sources, source_url, source_name, published_at, period, confidence, material, impact_risk, campaign_response, newsletter, newsletter_art, newsletter_options, status, found_at
     from studio_intel where client_id = $1 and status = $2 order by material desc, found_at desc limit 80`,
    [clientId, status],
  )) as Intel[];
}

export async function setIntelStatus(clientId: string, id: string, status: "accepted" | "binned"): Promise<void> {
  await db().query(`update studio_intel set status = $1 where id = $2 and client_id = $3`, [status, id, clientId]);
}
