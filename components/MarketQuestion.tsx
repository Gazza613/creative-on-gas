"use client";
import { useState } from "react";
import Working from "@/components/Working";

// ASK THE MARKET A QUESTION (Gary). The Strategist desk, on demand: type a market question about a client and get
// the same sourced assessment the daily email gives - what changed, what it could do, and the DEFENSIVE/PROACTIVE
// move - without waiting for the schedule. Runs the real desk (scope-locked, never invents), so the answer is
// trustworthy and its findings also land in the /strategist review queue.

type Client = { id: string; name: string };
type Finding = {
  id?: string;
  headline: string; why_it_matters: string; detail: string | null;
  impact_risk: string | null; campaign_response: string | null; material: boolean;
  sources: { name: string; url: string }[];
};

const WORKING_MARKET = [
  "Scanning the market right now…",
  "Reading what the rivals just did…",
  "Weighing what it means for the client…",
  "Grading the move: defensive or proactive…",
  "Writing it up with the sources…",
];

export default function MarketQuestion({ clients }: { clients: Client[] }) {
  const [clientId, setClientId] = useState(clients[0]?.id || "");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [err, setErr] = useState("");
  // The CEO thought-leadership draft flow (one open at a time).
  const [draftFor, setDraftFor] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [art, setArt] = useState("");
  const [recips, setRecips] = useState("");
  const [ceoName, setCeoName] = useState("");
  const [sending, setSending] = useState(false);
  const [sentFor, setSentFor] = useState("");
  const [draftErr, setDraftErr] = useState("");

  const CEO_API = "/api/studio/intel/ceo-article";

  // Draft the CEO's article from a finding, and prefill the saved recipient(s) for this brain.
  async function draftArticle(f: Finding) {
    if (!f.id || drafting) return;
    setDraftFor(f.id); setDrafting(true); setDraftErr(""); setDraftText(""); setSentFor("");
    const [d, rec] = await Promise.all([
      fetch(CEO_API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "draft", clientId, id: f.id }) }).then((r) => r.json()).catch(() => null),
      fetch(`${CEO_API}?clientId=${encodeURIComponent(clientId)}`).then((r) => r.json()).catch(() => null),
    ]);
    setDrafting(false);
    if (!d?.ok) { setDraftErr(d?.error || "Couldn't draft that."); return; }
    setDraftText(d.post || ""); setArt(d.art?.subject || "");
    if (rec?.ceoName) setCeoName(rec.ceoName);
    if (Array.isArray(rec?.recipients) && rec.recipients.length && !recips) setRecips(rec.recipients.join(", "));
  }

  // Send the (edited) article to the CEO's email(s); bcc's the sender.
  async function sendArticle(f: Finding) {
    if (!f.id || sending) return;
    const recipients = recips.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
    if (!recipients.length) { setDraftErr("Add at least one recipient email."); return; }
    setSending(true); setDraftErr("");
    const d = await fetch(CEO_API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "send", clientId, id: f.id, recipients, post: draftText }) }).then((r) => r.json()).catch(() => null);
    setSending(false);
    if (!d?.ok) { setDraftErr(d?.error || "Couldn't send."); return; }
    setSentFor(f.id); setDraftFor(null);
  }

  // TWO MODES (Gary): "question" answers a specific ask (looks back ~90 days); "discover" proactively finds what is
  // NEW and relevant to the brain with no question typed (only ~14 days, so it surfaces genuine change).
  async function ask(mode: "question" | "discover" = "question") {
    if (busy || !clientId) return;
    if (mode === "question" && !q.trim()) return;
    setBusy(true); setErr(""); setFindings(null); setDraftFor(null); setSentFor(""); setDraftErr("");
    const d = await fetch(`/api/studio/intel/ask`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, question: mode === "question" ? q : "", mode }),
    }).then((r) => r.json()).catch(() => null);
    setBusy(false);
    if (!d?.ok) { setErr(d?.error || "Couldn't run that."); return; }
    setFindings(Array.isArray(d.findings) ? d.findings : []);
  }

  const brainName = clients.find((c) => c.id === clientId)?.name || "this brain";

  return (
    <div className="rounded-2xl border border-[#818cf8]/30 bg-gradient-to-br from-[#818cf8]/[0.08] to-[#22d3ee]/[0.03] p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xl font-bold text-ink">Ask the market a question</h3>
        <span className="text-sm text-ink-faint">Live Strategist pod · sourced, never invented</span>
      </div>
      <p className="mt-1 text-base text-ink-dim">A one-off market read on demand: what a rival did, a category shift, a threat or an opening, with the move it argues for. <b className="text-ink">Find what&rsquo;s new</b> proactively surfaces fresh topics (last 2 weeks); a typed question looks back up to 3 months.</p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="tabular block text-sm uppercase tracking-[0.16em] text-ink-faint">Brain</span>
          <select value={clientId} onChange={(e) => { setClientId(e.target.value); setFindings(null); setErr(""); }}
            className="mt-1 rounded-lg border border-line bg-surface-2 px-3 py-2 text-base outline-none focus:border-accent">
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      </div>
      <textarea value={q} onChange={(e) => setQ(e.target.value)} rows={2}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ask("question"); }}
        placeholder={`e.g. What has changed in the SA fintech market that affects ${brainName} this week? What did GoTyme just do?`}
        className="mt-3 w-full rounded-lg border border-line bg-surface-2 px-3.5 py-2.5 text-base leading-relaxed text-ink outline-none focus:border-accent" />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button onClick={() => ask("question")} disabled={busy || !q.trim()}
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-base font-bold text-black hover:opacity-90 disabled:opacity-50">
          {busy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-black/30 border-t-black" />}
          {busy ? "Scanning…" : "Ask the market"}
        </button>
        <button onClick={() => ask("discover")} disabled={busy}
          className="inline-flex items-center gap-2 rounded-lg border border-accent/50 px-5 py-2.5 text-base font-bold text-accent hover:bg-accent/10 disabled:opacity-50">
          ✦ Find what&rsquo;s new
        </button>
        <span className="text-sm text-ink-faint">⌘/Ctrl + Enter · takes a minute, it searches the web live</span>
      </div>

      {busy && <div className="mt-4 text-base text-accent"><Working messages={WORKING_MARKET} /></div>}
      {err && <p className="mt-4 text-base text-alert">{err}</p>}

      {findings && !busy && (
        <div className="mt-5 space-y-3">
          {findings.length === 0 ? (
            <p className="rounded-lg border border-line bg-surface-1 px-4 py-3 text-base text-ink-dim">Nothing solid came back on that. A quiet answer is a real one, the pod never pads or invents. Try a sharper question.</p>
          ) : findings.map((f, i) => {
            const move = String(f.campaign_response || "");
            const tag = /\bdefensive\b/i.test(move) && /\bproactive\b/i.test(move) ? "defensive + proactive" : /\bdefensive\b/i.test(move) ? "defensive" : /\bproactive\b/i.test(move) ? "proactive" : "";
            return (
              <div key={i} className="rounded-xl border border-line bg-surface-1 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h4 className="flex-1 text-lg font-bold text-ink">{f.headline}</h4>
                  {tag && <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-sm font-bold uppercase tracking-wide ${tag.includes("defensive") ? "bg-[#f87171]/15 text-[#fca5a5]" : "bg-[#4ade80]/15 text-[#86efac]"}`}>{tag}</span>}
                </div>
                {f.why_it_matters && <p className="mt-1.5 text-base text-ink-dim"><b className="text-ink">Why it matters</b> · {f.why_it_matters}</p>}
                {f.detail && <p className="mt-1.5 whitespace-pre-wrap text-base text-ink-dim">{f.detail}</p>}
                {f.impact_risk && <p className="mt-2 rounded-lg border border-[#fbbf24]/25 bg-[#fbbf24]/[0.05] px-3 py-2 text-base text-ink-dim"><b className="text-[#fcd34d]">What it could do</b> · {f.impact_risk}</p>}
                {f.campaign_response && <p className="mt-1.5 rounded-lg border border-accent/25 bg-accent/[0.05] px-3 py-2 text-base text-ink-dim"><b className="text-accent">The move</b> · {f.campaign_response}</p>}
                {f.sources.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm">
                    {f.sources.map((s, j) => <a key={j} href={s.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">{s.name || "source"} ↗</a>)}
                  </div>
                )}

                {/* CEO THOUGHT-LEADERSHIP (Gary): draft this finding into the client CEO's LinkedIn piece, then email it. */}
                {f.id && (
                  <div className="mt-3 border-t border-line pt-3">
                    {sentFor === f.id ? (
                      <p className="text-base font-semibold text-[#86efac]">✓ Article emailed to the CEO. A copy is in your inbox.</p>
                    ) : draftFor === f.id ? (
                      <div>
                        {drafting ? (
                          <p className="text-base text-accent">Drafting the CEO&rsquo;s article…</p>
                        ) : (
                          <>
                            <div className="flex flex-wrap items-baseline justify-between gap-2">
                              <span className="tabular text-sm uppercase tracking-[0.16em] text-ink-faint">CEO article{ceoName ? ` · ${ceoName}` : ""} · edit before sending</span>
                              {art && <span className="text-sm text-ink-faint">Image idea: {art}</span>}
                            </div>
                            <textarea value={draftText} onChange={(e) => setDraftText(e.target.value)} rows={12}
                              className="mt-2 w-full rounded-lg border border-line bg-surface-2 px-3.5 py-2.5 text-base leading-relaxed text-ink outline-none focus:border-accent" />
                            <label className="mt-3 block">
                              <span className="tabular block text-sm uppercase tracking-[0.16em] text-ink-faint">Send to (CEO email, comma-separated)</span>
                              <input value={recips} onChange={(e) => setRecips(e.target.value)} placeholder="kagiso@mtn.com, ea@mtn.com"
                                className="mt-1 w-full rounded-lg border border-line bg-surface-2 px-3.5 py-2 text-base text-ink outline-none focus:border-accent" />
                            </label>
                            {draftErr && <p className="mt-2 text-base text-alert">{draftErr}</p>}
                            <div className="mt-3 flex flex-wrap items-center gap-2">
                              <button onClick={() => sendArticle(f)} disabled={sending || !recips.trim()}
                                className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2 text-base font-bold text-black hover:opacity-90 disabled:opacity-50">
                                {sending && <span className="h-4 w-4 animate-spin rounded-full border-2 border-black/30 border-t-black" />}
                                {sending ? "Sending…" : "Approve & send to CEO"}
                              </button>
                              <button onClick={() => draftArticle(f)} disabled={drafting || sending} className="rounded-lg border border-line px-4 py-2 text-base text-ink-dim hover:text-ink disabled:opacity-50">Redraft</button>
                              <button onClick={() => { setDraftFor(null); setDraftErr(""); }} className="rounded-lg px-3 py-2 text-base text-ink-faint hover:text-ink">Cancel</button>
                            </div>
                          </>
                        )}
                      </div>
                    ) : (
                      <button onClick={() => draftArticle(f)} disabled={drafting}
                        className="inline-flex items-center gap-2 rounded-lg border border-accent/50 px-4 py-2 text-base font-semibold text-accent hover:bg-accent/10 disabled:opacity-50">
                        ✍️ Draft CEO article
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <p className="text-sm text-ink-faint">These also land in <a href="/strategist" className="text-accent hover:underline">The Strategist · Daily Intelligence</a> queue to accept or bin.</p>
        </div>
      )}
    </div>
  );
}
