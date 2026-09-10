import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { runIntel } from "@/lib/intel";

// ASK THE MARKET A QUESTION (Gary): the dashboard free-text box. Runs the Strategist desk on demand for one brain,
// seeded with the team's question, and returns the sourced findings + the internal read (what it could do, and
// the DEFENSIVE/PROACTIVE move). Same engine as the daily email, just triggered by a question instead of a
// schedule - so it never leaves the brain's scope lock and never invents a source. It does NOT email; the
// findings also land in the /strategist review queue like any other, so nothing is lost.
export const maxDuration = 800;
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { clientId?: string; question?: string; mode?: string };
  const clientId = String(b.clientId || "").trim();
  const question = String(b.question || "").trim().slice(0, 600);
  // TWO RECENCY MODES (Gary): a specific "ask" question looks back up to ~90 days; a proactive "discover" sweep for
  // new relevant topics (no question needed) only looks ~14 days, so it surfaces what is genuinely NEW.
  const mode = b.mode === "discover" ? "discover" : "question";
  const windowDays = mode === "discover" ? 14 : 90;
  if (!clientId) return NextResponse.json({ error: "Pick the brain first." }, { status: 400 });
  if (mode === "question" && !question) return NextResponse.json({ error: "Type a market question to ask." }, { status: 400 });

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Johannesburg" }); // YYYY-MM-DD, SAST
  try {
    const findings = await runIntel(clientId, "strategist", today, session.user?.email ?? null, mode === "discover" ? null : question, windowDays);
    return NextResponse.json({
      ok: true,
      mode,
      findings: findings.map((f) => ({
        id: f.id,
        headline: f.headline,
        why_it_matters: f.why_it_matters,
        detail: f.detail,
        impact_risk: f.impact_risk,
        campaign_response: f.campaign_response,
        material: f.material,
        sources: Array.isArray(f.sources) ? f.sources : [],
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e).slice(0, 300) }, { status: 400 });
  }
}
