"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// THE STRATEGIST EMAIL CONTROL, PER BRAIN (Gary: "I should have the ability to switch a client on/off on the
// daily or weekly strategist email... specify the email addresses this goes to and be able to add/remove").
//
// It sits above the review queue on the Strategist page and tracks whichever brain is selected. Two things,
// both saved the moment they change (no separate Save button to forget):
//   1. CADENCE - Off / Daily (Mon-Fri) / Weekly (Mon 08:30). This is a cost dial: a paid Opus + web-search pass
//      runs for the brain every time its digest fires, so 'off' stops the spend, not just the email.
//   2. RECIPIENTS - the brain's own list. Empty falls back to the platform default so nothing silently stops.

type Schedule = "off" | "daily" | "weekly";
type NewsletterSchedule = "off" | "daily" | "weekly" | "monthly";

const OPTIONS: { id: Schedule; label: string; sub: string }[] = [
  { id: "off", label: "Off", sub: "No run, no email" },
  { id: "daily", label: "Daily", sub: "Mon-Fri, 08:30" },
  { id: "weekly", label: "Weekly", sub: "Mon, 08:30" },
];

const NEWS_OPTIONS: { id: NewsletterSchedule; label: string; sub: string }[] = [
  { id: "off", label: "Off", sub: "No draft" },
  { id: "daily", label: "Daily", sub: "Mon-Fri" },
  { id: "weekly", label: "Weekly", sub: "Mondays" },
  { id: "monthly", label: "Monthly", sub: "1st Monday" },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function IntelEmailControl({ clientId, clientName }: { clientId: string; clientName: string }) {
  const [briefed, setBriefed] = useState(true);
  const [schedule, setSchedule] = useState<Schedule>("weekly");
  const [newsletterSchedule, setNewsletterSchedule] = useState<NewsletterSchedule>("off");
  const [recipients, setRecipients] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Read the current setting whenever the selected brain changes.
  useEffect(() => {
    if (!clientId) return;
    let live = true;
    setLoaded(false); setErr("");
    fetch(`/api/studio/intel/schedule?clientId=${clientId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (!live) return;
        setBriefed(d?.briefed !== false);
        setSchedule((["off", "daily", "weekly"].includes(d?.schedule) ? d.schedule : "weekly") as Schedule);
        setNewsletterSchedule((["off", "daily", "weekly", "monthly"].includes(d?.newsletterSchedule) ? d.newsletterSchedule : "off") as NewsletterSchedule);
        setRecipients(Array.isArray(d?.recipients) ? d.recipients : []);
        setLoaded(true);
      })
      .catch(() => { if (live) { setLoaded(true); } });
    return () => { live = false; };
  }, [clientId]);

  // Persist the whole state (cadence + list together, the way the route writes it). Called on every change so
  // there is nothing to remember to press.
  const persist = useCallback(async (next: { schedule: Schedule; recipients: string[]; newsletterSchedule?: NewsletterSchedule }) => {
    setSaving(true); setErr("");
    const r = await fetch("/api/studio/intel/schedule", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, schedule: next.schedule, recipients: next.recipients, newsletterSchedule: next.newsletterSchedule ?? newsletterSchedule }),
    }).then((x) => x.json()).catch(() => null);
    setSaving(false);
    if (r?.ok) {
      setSaved(true);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 1800);
    } else {
      setErr(r?.error || "Couldn't save that. Please try again.");
    }
  }, [clientId, newsletterSchedule]);

  function pick(s: Schedule) {
    if (s === schedule || !briefed) return;
    setSchedule(s);
    persist({ schedule: s, recipients });
  }

  function pickNewsletter(s: NewsletterSchedule) {
    if (s === newsletterSchedule || !briefed) return;
    setNewsletterSchedule(s);
    persist({ schedule, recipients, newsletterSchedule: s });
  }

  function addRecipient() {
    const v = draft.trim().toLowerCase();
    if (!v) return;
    if (!EMAIL_RE.test(v)) { setErr(`"${v}" doesn't look like an email address.`); return; }
    if (recipients.includes(v)) { setDraft(""); return; }
    const next = [...recipients, v];
    setRecipients(next); setDraft(""); setErr("");
    persist({ schedule, recipients: next });
  }

  function removeRecipient(e: string) {
    const next = recipients.filter((x) => x !== e);
    setRecipients(next);
    persist({ schedule, recipients: next });
  }

  if (!briefed && loaded) {
    return (
      <div className="rounded-xl border border-line bg-surface-1 p-4">
        <div className="tabular text-sm uppercase tracking-[0.2em] text-ink-faint">Intelligence email</div>
        <p className="mt-1.5 text-[15px] text-ink-dim">
          <b className="text-ink">{clientName}</b> has no Strategist brief yet, so there is nothing to schedule.
          Give it a brief first and the on/off and cadence controls appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-line bg-surface-1 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="tabular text-sm uppercase tracking-[0.2em] text-ink-faint">Intelligence email</div>
        <div aria-live="polite" className="text-[13px]">
          {saving ? <span className="text-ink-faint">Saving…</span>
            : saved ? <span className="text-[#86efac]">✓ Saved</span>
              : null}
        </div>
      </div>
      <p className="mt-1.5 text-[15px] leading-relaxed text-ink-dim">
        When <b className="text-ink">{clientName}</b>&apos;s Strategist emails, and who gets it. Off means the
        brain is skipped entirely on the automated run, so it costs nothing on the days it is silent.
      </p>

      {/* CADENCE: a 3-state segmented control. Each fires a paid run when it lands, so the sub-labels spell out
          exactly which days it will run. */}
      <div role="radiogroup" aria-label="Intelligence email cadence" className="mt-3 grid grid-cols-3 gap-2">
        {OPTIONS.map((o) => {
          const on = schedule === o.id;
          return (
            <button key={o.id} role="radio" aria-checked={on} disabled={!loaded}
              onClick={() => pick(o.id)}
              className={`rounded-lg border px-3 py-2.5 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#a855f7] disabled:opacity-50 ${
                on ? "border-[#a855f7]/60 bg-[#a855f7]/12" : "border-line bg-surface-2 hover:border-line-strong"
              }`}>
              <div className={`text-[16px] font-bold ${on ? "text-[#c79bff]" : "text-ink"}`}>{o.label}</div>
              <div className="mt-0.5 text-[13px] text-ink-faint">{o.sub}</div>
            </button>
          );
        })}
      </div>

      {/* RECIPIENTS: chips you can remove, plus a field to add. Empty means fall back to the platform default. */}
      <div className="mt-4">
        <label className="tabular block text-sm uppercase tracking-[0.2em] text-ink-faint">Sends to</label>
        {recipients.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {recipients.map((e) => (
              <span key={e} className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface-2 py-1 pl-3 pr-1.5 text-[15px] text-ink">
                {e}
                <button onClick={() => removeRecipient(e)} aria-label={`Remove ${e}`} title="Remove"
                  className="rounded-md px-1.5 text-[14px] font-bold text-ink-faint transition hover:bg-[#f87171]/20 hover:text-[#fca5a5]">✕</button>
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-[14px] text-ink-faint">
            No addresses set for this brain, so it falls back to the platform default list.
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input value={draft} onChange={(e) => { setDraft(e.target.value); setErr(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addRecipient(); } }}
            placeholder="name@company.co.za"
            className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[15px] text-ink outline-none focus:border-[#60a5fa]" />
          <button onClick={addRecipient} disabled={!draft.trim()}
            className="rounded-lg border border-line px-3.5 py-2 text-[15px] font-semibold text-ink-dim transition hover:border-line-strong hover:text-ink disabled:opacity-40">
            + Add
          </button>
        </div>
      </div>

      {/* CEO ARTICLE AUTOMATION (Gary): on this cadence the run finds a fresh topic, drafts the client CEO's
          LinkedIn article and emails the DRAFT to the recipients above, for you to review and forward to the CEO.
          It never emails the CEO directly. Off by default; it fires a paid run when it lands, like the digest. */}
      <div className="mt-4 border-t border-line pt-4">
        <label className="tabular block text-sm uppercase tracking-[0.2em] text-ink-faint">CEO thought-leadership article</label>
        <p className="mt-1.5 text-[14px] leading-relaxed text-ink-dim">
          Auto-draft <b className="text-ink">{clientName}</b>&apos;s CEO article on this cadence and email the draft to the
          list above to review, then forward to the CEO. Never sent to the CEO automatically.
        </p>
        <div role="radiogroup" aria-label="CEO article automation cadence" className="mt-3 grid grid-cols-4 gap-2">
          {NEWS_OPTIONS.map((o) => {
            const on = newsletterSchedule === o.id;
            return (
              <button key={o.id} role="radio" aria-checked={on} disabled={!loaded}
                onClick={() => pickNewsletter(o.id)}
                className={`rounded-lg border px-2.5 py-2.5 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#a855f7] disabled:opacity-50 ${
                  on ? "border-[#a855f7]/60 bg-[#a855f7]/12" : "border-line bg-surface-2 hover:border-line-strong"
                }`}>
                <div className={`text-[15px] font-bold ${on ? "text-[#c79bff]" : "text-ink"}`}>{o.label}</div>
                <div className="mt-0.5 text-[12px] text-ink-faint">{o.sub}</div>
              </button>
            );
          })}
        </div>
      </div>

      {err && <p className="mt-2 text-[14px] text-[#fca5a5]">{err}</p>}
    </div>
  );
}
