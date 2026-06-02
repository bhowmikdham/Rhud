'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { opportunities, rateCards, describeError, type RateCardSummary } from '@/lib/api';
import { Icon } from '@/components/icon';

/**
 * Attach-a-rate-card card. Shown on a direct-ingest opportunity (no
 * template) that has no rate card yet — the case where extraction ran
 * but matching / inference / pricing are all gated off. Lets the rep
 * attach a published rate card straight to the opportunity and reprice
 * from the extracted scope, without first issuing a client scoping link.
 */
export function AttachRateCardCard({
  engagementId,
  onAttached,
}: {
  engagementId: string;
  onAttached: () => void | Promise<void>;
}) {
  const [cards, setCards] = useState<RateCardSummary[] | null>(null);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    rateCards
      .list()
      .then((all) => {
        if (!alive) return;
        const published = all.filter((c) => c.status === 'published');
        setCards(published);
        if (published[0]) setSelected(published[0].id);
      })
      .catch((e) => {
        if (alive) setErr(describeError(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  async function attach() {
    if (!selected) return;
    setBusy(true);
    setErr(null);
    try {
      await opportunities.attachRateCard(engagementId, selected);
      await onAttached();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ padding: 22, marginTop: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        <Icon.Sparkle size={12} /> Price this opportunity from the email
      </div>
      <p style={{ margin: '0 0 12px', color: 'var(--fg-muted)', fontSize: 12.5, lineHeight: 1.5 }}>
        Extraction pulled the data points out of the message, but matching, inference and
        pricing need a rate card to score against. Attach one to price straight from the
        extracted scope — no client scoping link required. You can still send scoping
        questions later; the client&rsquo;s answers will take precedence.
      </p>
      {cards === null ? (
        <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
          <span className="spin" /> Loading rate cards…
        </div>
      ) : cards.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--fg-muted)' }}>
          No published rate cards yet —{' '}
          <Link href="/rate-cards" className="link">create one</Link> first.
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={busy}
            style={{
              minWidth: 220,
              padding: '6px 10px',
              borderRadius: 7,
              border: '1px solid var(--border)',
              background: 'var(--bg-elev)',
              color: 'var(--fg)',
              fontSize: 12.5,
            }}
          >
            {cards.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · v{c.version} · {c.currency}
              </option>
            ))}
          </select>
          <button className="btn sm" disabled={busy || !selected} onClick={() => void attach()}>
            {busy ? (
              <>
                <span className="spin" /> Pricing…
              </>
            ) : (
              <>
                <Icon.Sparkle size={11} /> Attach &amp; price
              </>
            )}
          </button>
        </div>
      )}
      {err && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--danger)' }}>{err}</div>
      )}
    </div>
  );
}
