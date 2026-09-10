import Anthropic from "@anthropic-ai/sdk";
import { getSecret } from "./connections";
import { getBrandKit } from "./studio";
import { loadIntelBrief } from "./intel";
import { PREMIUM } from "./vendors/anthropic";
import { meterClaude } from "./usage";

// THE CEO NEWSLETTER WRITER (shared). Turns a finding OR a Researcher fact into the CEO's LinkedIn piece, in that
// brain's voice and inside its scope + compliance. Reused by the Journalist desk, the intel newsletter route, and
// the Researcher fact-base "CEO Newsletter" tag - one writer, so the piece is identical wherever it is triggered.
// The image is a SECOND, short request (the creative) so this call stays fast; this returns the art direction.

// The writer also art-directs, so the image illustrates the exact piece it sits beside, bound by the same rules.
export const NEWSLETTER_PIECE = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", description: "The newsletter title. Short, plain and substantive - what the piece is actually about. No colon-subtitle cliche, no story hook, no question. No '#' marker." },
    body: { type: "string", description: "The piece: a DETAILED LinkedIn newsletter of 800 to 1500 words (a 4 to 7 minute read), professional executive register, substance-led. Structure it for a mobile reader: an opening that frames why this matters NOW, then 3 to 5 short SECTION HEADINGS, each on its OWN line prefixed with '## ' (markdown h2), with 2 to 4 SHORT paragraphs under each, and a closing takeaway paragraph. Every section must say something the reader did not know. Do NOT force a statistic into every section; most need none, and any figure used must be highly credible and attributable. Use NO markdown other than the '## ' heading marker (no bold, bullets or links inline). Separate every block by a blank line." },
    image_subject: { type: "string", description: "ART DIRECTION for the LinkedIn image that runs beside a CEO's market note. A real, specific South African person or scene that carries the post's POINT with DIGNITY and CONFIDENCE - a capable adult, a working business, a moment of competence. NOT anxious, worried, struggling, pitiable or a narrated hardship scene: this sits under an executive's name, and a worried face reads as pity, not value. No products, no phones held up like an advert, no logos, no text described." },
    image_callout: { type: "string", description: "ONE short line for the image, max ~24 characters. It must carry the post's central POINT or VALUE in a professional register - not a story line, not a narrated moment, not a question, not an offer or price. Think a confident statement a CEO would stand behind, e.g. 'Money that reaches everyone'. No competitor, no product pitch." },
  },
  required: ["title", "body", "image_subject", "image_callout"],
} as unknown as Anthropic.Tool["input_schema"];

export type NewsletterMaterial = {
  headline: string;
  why_it_matters?: string | null;
  detail?: string | null;
  sources?: { name: string; url: string }[];
  published_at?: string | null;
};
export type NewsletterResult =
  | { ok: true; post: string; art: { subject: string; callout: string } }
  | { ok: false; error: string; status: number };

const noDash = (t: unknown) => String(t ?? "").replace(/(\d)\s*[—–]\s*(\d)/g, "$1-$2").replace(/\s*[—–]\s*/g, " - ").trim();

// REGISTER + COMPLIANCE BACKSTOP, brain-aware. The specific voice is the brain's ceoRules; this only makes sure
// the piece lands in the register a business of this size and category would actually publish, and stays inside
// its regulatory position.
const REGISTER = `TONE AND COMPLIANCE (on top of the CEO rules above, never overriding them):
- Write in the register a serious business of THIS size and category would publish under its CEO's name:
  corporate and credible, but genuinely engaging and easy to understand - never stiff, jargon-heavy or dull,
  and never flippant or salesy.
- For a licensed financial services client (a life insurer, a bank, a fintech) NOTHING may read as financial
  advice, a promise or guarantee of an outcome, or a claim that cannot be substantiated. Anything the piece
  says must survive that client's regulatory regime (for SA life cover: FSCA, FAIS, PPR). When in doubt, make
  the point about what the company stands for and what it makes possible, not about a product, a price or a
  benefit you cannot prove.
- UK British spelling. Never an em dash or an en dash.`;

/**
 * Write the CEO's LinkedIn newsletter piece from a finding/claim, inside this brain's voice + scope. `notes` folds
 * in a rewrite instruction ("make it warmer", "lead with the number"). Returns the piece text + the art brief.
 */
export async function writeCeoNewsletter(clientId: string, m: NewsletterMaterial, opts: { userEmail?: string | null; notes?: string | null } = {}): Promise<NewsletterResult> {
  const key = await getSecret("anthropic");
  if (!key) return { ok: false, error: "Claude isn't connected", status: 503 };
  // The brain is the ringfence: the scope lock, the CEO voice and the doctrine all come from THIS client.
  const cfg = await loadIntelBrief(clientId);
  if (!cfg) return { ok: false, error: "This brain has no brief, so its scope is unknown.", status: 400 };
  // A brain with explicit CEO voice rules uses them. A brain WITHOUT them (e.g. GAS's own) still drafts, in a
  // sensible default executive register grounded in THIS brain's own scope and doctrine below (never borrowing
  // another brain's voice). It is a draft a human reviews before sending, and adding ceo_rules later sharpens the
  // voice. Refusing outright just to protect a voice that was never set stops the team drafting at all (Gary).
  const voice = cfg.ceoRules?.trim()
    || `You are writing in the voice of ${cfg.clientName}'s CEO for a LinkedIn thought-leadership newsletter. No bespoke voice rules are on file for this brain yet, so write in a credible, warm, plain-spoken executive register appropriate to ${cfg.clientName}'s size and category: first person where it reads naturally, confident but never boastful or salesy, substance first. Ground everything in ${cfg.clientName}'s own scope and doctrine below, and never invent facts about the business.`;
  const kit = await getBrandKit(clientId).catch(() => null);

  const srcs = m.sources || [];
  const material =
    `THE FINDING\n${String(m.headline || "")}\n\n` +
    `WHY IT MATTERS\n${String(m.why_it_matters || "")}\n\n` +
    `THE SUBSTANCE\n${String(m.detail || "")}\n\n` +
    `SOURCES: ${srcs.map((s) => `${s.name} (${s.url})`).join(" · ") || "none recorded"}\n` +
    `PUBLISHED: ${String(m.published_at || "date not established")}\n\n` +
    `WHAT WE KNOW ABOUT ${cfg.clientName} (their own ground truth - use it, do not contradict it):\n` +
    `${(kit?.tone_notes || "(no doctrine loaded)").slice(0, 7000)}`;
  const rewrite = opts.notes?.trim() ? `\n\nREWRITE THIS PIECE, applying precisely: ${opts.notes.trim().slice(0, 600)}` : "";

  const client = new Anthropic({ apiKey: key });
  const res = await client.messages.create({
    model: PREMIUM,
    max_tokens: 4000,
    system: `${cfg.scope}\n\n${voice}\n\n${REGISTER}`,
    tools: [{ name: "piece", description: "The CEO's newsletter piece and the art direction for its image.", input_schema: NEWSLETTER_PIECE }],
    tool_choice: { type: "tool", name: "piece" },
    messages: [{ role: "user", content: `Write the CEO's newsletter piece from the material below, and art-direct the LinkedIn image that runs with it.${rewrite}\n\n${material}` }],
  });
  await meterClaude(res, { clientId, userEmail: opts.userEmail ?? null, model: PREMIUM, action: "ceo-newsletter" }).catch(() => {});
  const block = res.content.find((x) => x.type === "tool_use");
  if (!block || block.type !== "tool_use") return { ok: false, error: "Nothing came back. Try again.", status: 500 };
  const out = block.input as { title?: string; body?: string; image_subject?: string; image_callout?: string };
  const title = noDash(out.title);
  const body = noDash(out.body);
  if (!body) return { ok: false, error: "Nothing came back. Try again.", status: 500 };
  return { ok: true, post: title ? `${title}\n\n${body}` : body, art: { subject: noDash(out.image_subject), callout: noDash(out.image_callout) } };
}
