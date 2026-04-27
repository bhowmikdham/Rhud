'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  rateCards,
  describeError,
  type RateCardFull,
  type RateCardServiceLineFull,
  type RateCardTier,
} from '@/lib/api';
import { useRequireAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/app-shell';
import { Icon } from '@/components/icon';
import { useConfirm } from '@/components/confirm';

export default function RateCardDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const user = useRequireAuth();
  const router = useRouter();
  const confirm = useConfirm();
  const [card, setCard] = useState<RateCardFull | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<'publish' | 'archive' | null>(null);

  const canEdit = user ? user.role === 'admin' : false;

  const refresh = useCallback(() => {
    rateCards.get(id).then(setCard).catch((e) => setErr(describeError(e)));
  }, [id]);

  useEffect(() => {
    if (!user) return;
    refresh();
  }, [user, refresh]);

  async function publish() {
    if (busy) return;
    setBusy('publish');
    setErr(null);
    try {
      const updated = await rateCards.publish(id);
      setCard(updated);
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  async function archive() {
    if (busy) return;
    const ok = await confirm({
      title: 'Archive this rate card?',
      body: `Quotes already issued aren't affected, but new opportunities can't price against an archived card. You can unarchive later by uploading a new version.`,
      tone: 'warn',
      confirmLabel: 'Archive',
    });
    if (!ok) return;
    setBusy('archive');
    setErr(null);
    try {
      const updated = await rateCards.archive(id);
      setCard(updated);
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <AppShell
      crumbs={[
        { label: 'Pricing' },
        { label: 'Rate cards', href: '/rate-cards' },
        { label: card?.name ?? '…' },
      ]}
    >
      <div className="page-inner">
        {err && (
          <div className="card" style={{
            padding: 12, color: 'var(--danger)', fontSize: 12.5, marginBottom: 16,
            background: 'var(--danger-tint)',
            borderColor: 'color-mix(in oklch, var(--danger) 22%, transparent)',
          }}>{err}</div>
        )}

        {card === null && !err ? (
          <div className="empty">Loading…</div>
        ) : card ? (
          <>
            <div className="page-header">
              <div>
                <h1 className="page-title">{card.name}</h1>
                <p className="page-subtitle" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <StatusChip status={card.status} />
                  <span style={{ color: 'var(--fg-subtle)' }}>v{card.version} · {card.currency}</span>
                </p>
              </div>
              {canEdit && (
                <div className="page-actions">
                  {card.status === 'draft' && (
                    <button onClick={publish} disabled={busy !== null} className="btn accent">
                      {busy === 'publish' ? <span className="spin" /> : <><Icon.Check size={13} /> Publish</>}
                    </button>
                  )}
                  {card.status === 'published' && (
                    <button onClick={archive} disabled={busy !== null} className="btn danger">
                      {busy === 'archive' ? <span className="spin" /> : <>Archive</>}
                    </button>
                  )}
                  {card.status === 'archived' && (
                    <button onClick={() => router.push('/rate-cards')} className="btn ghost">
                      Back to list
                    </button>
                  )}
                </div>
              )}
            </div>

            <Summary card={card} />

            <h2 style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em', margin: '28px 0 12px' }}>
              Service lines
            </h2>
            {card.serviceLines.length === 0 ? (
              <div className="card" style={{ padding: 18 }}>
                <div className="empty" style={{ padding: 24 }}>
                  No service lines on this card. Re-upload the spreadsheet — the parser may not have recognised any rows.
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {card.serviceLines.map((sl) => (
                  <ServiceLineCard key={sl.id} sl={sl} currency={card.currency} />
                ))}
              </div>
            )}

            {card.openPricedServices.length > 0 && (
              <>
                <h2 style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em', margin: '28px 0 12px' }}>
                  Case-by-case priced services
                </h2>
                <div className="card" style={{ overflow: 'hidden' }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Service</th>
                        <th style={{ width: 200 }}>Category</th>
                      </tr>
                    </thead>
                    <tbody>
                      {card.openPricedServices.map((s) => (
                        <tr key={s.id} style={{ cursor: 'default' }}>
                          <td className="cell-strong">{s.displayName}</td>
                          <td className="cell-muted">{s.category ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <div style={{ marginTop: 24, fontSize: 11.5, color: 'var(--fg-subtle)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Icon.FileText size={11} />
              To revise tiers or service lines, upload a new version from the
              {' '}
              <Link href="/rate-cards" style={{ color: 'var(--fg-muted)', textDecoration: 'underline' }}>rate cards list</Link>.
            </div>
          </>
        ) : null}
      </div>
    </AppShell>
  );
}

function Summary({ card }: { card: RateCardFull }) {
  const tierCount = card.serviceLines.reduce((n, sl) => n + sl.tiers.length, 0);
  return (
    <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
      <Stat label="Service lines" value={String(card.serviceLines.length)} />
      <Stat label="Pricing tiers" value={String(tierCount)} />
      <Stat label="Open-priced services" value={String(card.openPricedServices.length)} />
    </div>
  );
}

function ServiceLineCard({ sl, currency }: { sl: RateCardServiceLineFull; currency: string }) {
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--divider)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>{sl.displayName}</div>
          <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', marginTop: 2 }}>
            Scope unit: <span className="mono">{sl.scopeUnit}</span> · Pricing: <span className="mono">{sl.pricingModel}</span>
          </div>
        </div>
        <span className="chip outline mono" style={{ fontSize: 10.5 }}>{sl.slug}</span>
      </div>
      {sl.tiers.length === 0 ? (
        <div className="empty" style={{ padding: 24, fontSize: 12.5 }}>No tiers — service line will not produce a quote.</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 140 }}>Range</th>
              <th>Methodology</th>
              <th style={{ width: 110 }}>Customer</th>
              <th style={{ width: 140, textAlign: 'right' }}>Price</th>
            </tr>
          </thead>
          <tbody>
            {sl.tiers.map((t) => (
              <tr key={t.id} style={{ cursor: 'default' }}>
                <td className="cell-mono">{rangeLabel(t)}</td>
                <td className="cell-muted">{t.displayLabel ?? t.methodology ?? '—'}</td>
                <td><CustomerChip type={t.customerType} /></td>
                <td className="cell-mono" style={{ textAlign: 'right', fontWeight: 500, color: 'var(--fg)' }}>
                  {formatPrice(t.priceCents, currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function rangeLabel(t: RateCardTier): string {
  if (t.rangeMax === null) return `${t.rangeMin}+`;
  if (t.rangeMin === t.rangeMax) return String(t.rangeMin);
  return `${t.rangeMin}–${t.rangeMax}`;
}

function formatPrice(cents: number, currency: string): string {
  // Treat the integer as minor-units of the card's currency. INR = paise,
  // USD = cents, etc. Intl.NumberFormat picks the right symbol + grouping.
  const major = cents / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(major);
  } catch {
    return `${currency} ${major.toLocaleString()}`;
  }
}

function StatusChip({ status }: { status: RateCardFull['status'] }) {
  if (status === 'published') return <span className="chip ok"><Icon.Dot size={8} /> Published</span>;
  if (status === 'archived') return <span className="chip outline"><Icon.Dot size={8} /> Archived</span>;
  return <span className="chip warn"><Icon.Dot size={8} /> Draft</span>;
}

function CustomerChip({ type }: { type: 'internal' | 'external' }) {
  return (
    <span className={'chip ' + (type === 'internal' ? 'accent' : 'outline')} style={{ fontSize: 10.5 }}>
      {type}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}
