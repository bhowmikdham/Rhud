'use client';

/**
 * Floating setup / workspace-overview panel.
 *
 * Mounted by AppShell so it appears on every authenticated page. Fetches
 * its own data (rate cards, templates, opportunities) on mount and
 * derives a 3-step progress checklist. Collapses to a small pill on the
 * bottom-right; expanded shows the full checklist with click-through
 * links to each step's destination.
 *
 * Collapse state is persisted in localStorage so a user who dismissed it
 * stays dismissed across navigations and reloads. Default is open when
 * anything is incomplete, collapsed when all three are done — that way
 * fresh orgs see guidance immediately, established orgs aren't nagged.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import {
  opportunities,
  rateCards,
  templates,
  type EngagementSummary,
  type RateCardSummary,
  type Template,
} from '@/lib/api';
import { Icon } from './icon';

const STORAGE_KEY = 'rhud.setup.collapsed';
/** Flag set when the admin has visited Settings → Categories at least
 *  once. Cheap signal that they've at least seen the taxonomy, so we
 *  can stop nudging. The Categories tab writes this on mount. */
const TAXONOMY_SEEN_KEY = 'rhud.setup.taxonomySeen';

/**
 * Routes where the floating pill would obscure footer action buttons
 * (Save changes, etc.) and adds no value (the user is already in the
 * settings flow). Suppress on the entire /settings tree.
 */
function isSuppressedRoute(pathname: string | null): boolean {
  if (!pathname) return false;
  return pathname === '/settings' || pathname.startsWith('/settings/');
}

export function SetupPanel() {
  const { user, tenant } = useAuth();
  const pathname = usePathname();
  const [cards, setCards] = useState<RateCardSummary[] | null>(null);
  const [tmpls, setTmpls] = useState<Template[] | null>(null);
  const [opps, setOpps] = useState<EngagementSummary[] | null>(null);
  const [taxonomySeen, setTaxonomySeen] = useState<boolean>(false);

  // `null` = not yet hydrated from localStorage; once we know the user's
  // preference we use it, otherwise we fall back to "open if incomplete".
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null);

  useEffect(() => {
    if (!user) return;
    rateCards.list().then(setCards).catch(() => setCards([]));
    templates.list().then(setTmpls).catch(() => setTmpls([]));
    opportunities.list().then(setOpps).catch(() => setOpps([]));
  }, [user]);

  // Re-read the taxonomy-seen flag whenever the pathname changes — so
  // visiting /settings?tab=categories flips the checklist item to done
  // without needing a full reload.
  useEffect(() => {
    setTaxonomySeen(window.localStorage.getItem(TAXONOMY_SEEN_KEY) === '1');
  }, [pathname]);

  useEffect(() => {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === '1') setUserCollapsed(true);
    else if (raw === '0') setUserCollapsed(false);
    else setUserCollapsed(null);
  }, []);

  if (!user) return null;
  if (isSuppressedRoute(pathname)) return null;
  if (cards === null || tmpls === null || opps === null) return null;

  const isAdmin = user.role === 'admin';
  const hasPublishedCard = cards.some((c) => c.status === 'published');
  const hasTemplate = tmpls.length > 0;
  const hasOpportunity = opps.length > 0;
  // Nudge a taxonomy step only for admins on the default Cybersecurity
  // template who haven't yet visited the Categories tab. Other tenants
  // (or non-admins, or anyone who's already seen it) don't see the row
  // at all — we keep the checklist tight.
  const showTaxonomyStep =
    isAdmin
    && tenant?.industryTemplateSlug === 'cybersecurity'
    && !taxonomySeen;

  const steps = [
    {
      done: hasPublishedCard,
      title: isAdmin ? 'Upload your rate card' : 'Get your rate card published',
      blurb: isAdmin
        ? 'Drop the CSaaS spreadsheet — we parse it into a draft you can publish.'
        : 'Quotes need a published rate card. An admin needs to upload one.',
      href: '/rate-cards',
      cta: isAdmin ? 'Upload' : 'View',
    },
    {
      done: hasTemplate,
      title: 'Create a scope-gathering template',
      blurb: 'Decision-tree form your sales team sends to clients.',
      href: '/templates',
      cta: 'Create',
    },
    {
      done: hasOpportunity,
      title: 'Issue your first opportunity link',
      blurb: 'Pick a template, add a client email — they fill, you quote.',
      href: '/opportunities/new',
      cta: 'Issue',
    },
    ...(showTaxonomyStep
      ? [{
          done: false,
          title: 'Confirm your scope categories',
          blurb: "Defaults to Cybersecurity. Customize or pick a different industry template.",
          href: '/settings?tab=categories',
          cta: 'Review',
        }]
      : []),
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const allDone = doneCount === steps.length;

  const collapsed = userCollapsed ?? allDone;

  function setCollapsed(next: boolean) {
    setUserCollapsed(next);
    window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  }

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        title={allDone ? 'Workspace overview' : `Setup: ${doneCount} of ${steps.length} done`}
        style={{
          position: 'fixed', right: 16, bottom: 16, zIndex: 'var(--z-dropdown)',
          appearance: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 12px',
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 999,
          boxShadow: 'var(--shadow-md)',
          fontSize: 12, fontWeight: 500, color: 'var(--fg)',
          transition: 'transform .15s, box-shadow .15s',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = 'var(--shadow-lg)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'var(--shadow-md)'; }}
      >
        <ProgressDots done={doneCount} total={steps.length} compact />
        <span>{allDone ? 'Workspace' : `Setup ${doneCount}/${steps.length}`}</span>
        <Icon.ChevronRight size={11} style={{ color: 'var(--fg-subtle)', transform: 'rotate(-90deg)' }} />
      </button>
    );
  }

  return (
    <div
      role="complementary"
      aria-label="Workspace setup"
      style={{
        position: 'fixed', right: 16, bottom: 16, zIndex: 'var(--z-dropdown)',
        width: 300,
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        boxShadow: 'var(--shadow-lg)',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--divider)', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em' }}>
            {allDone ? 'Workspace overview' : 'Get set up'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 2 }}>
            {allDone
              ? 'Everything wired up.'
              : `${doneCount} of ${steps.length} done`}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          aria-label="Collapse"
          style={{
            appearance: 'none', border: 0, background: 'transparent', cursor: 'pointer',
            width: 22, height: 22, borderRadius: 6,
            display: 'grid', placeItems: 'center', color: 'var(--fg-subtle)',
            transition: 'background .15s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <Icon.X size={11} />
        </button>
      </div>

      <div style={{ padding: '6px 8px 8px' }}>
        {steps.map((s, i) => (
          <Link
            key={i}
            href={s.href}
            style={{
              display: 'grid', gridTemplateColumns: '20px 1fr auto',
              alignItems: 'center', gap: 10,
              padding: '8px 8px',
              borderRadius: 8,
              textDecoration: 'none', color: 'inherit',
              opacity: s.done ? 0.7 : 1,
              transition: 'background .15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <span
              style={{
                width: 18, height: 18, borderRadius: 999,
                display: 'grid', placeItems: 'center',
                background: s.done ? 'var(--ok)' : 'transparent',
                border: '1.5px solid ' + (s.done ? 'var(--ok)' : 'var(--border-strong)'),
                color: s.done ? 'var(--bg)' : 'var(--fg-subtle)',
              }}
            >
              {s.done ? <Icon.Check size={10} /> : <span style={{ fontSize: 10, fontWeight: 600 }}>{i + 1}</span>}
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{
                fontSize: 12, fontWeight: 500,
                textDecoration: s.done ? 'line-through' : 'none',
                color: s.done ? 'var(--fg-muted)' : 'var(--fg)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {s.title}
              </div>
              {!s.done && (
                <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 1, lineHeight: 1.3 }}>
                  {s.blurb}
                </div>
              )}
            </div>
            <Icon.ChevronRight size={11} style={{ color: 'var(--fg-faint)' }} />
          </Link>
        ))}
      </div>
    </div>
  );
}

function ProgressDots({ done, total, compact }: { done: number; total: number; compact?: boolean }) {
  const w = compact ? 5 : 6;
  return (
    <span style={{ display: 'inline-flex', gap: 3 }}>
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          style={{
            width: w, height: w, borderRadius: 999,
            background: i < done ? 'var(--ok)' : 'var(--bg-sunk)',
            border: i < done ? 'none' : '1px solid var(--border)',
          }}
        />
      ))}
    </span>
  );
}
