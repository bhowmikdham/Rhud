'use client';

import { useState } from 'react';
import { Icon } from '@/components/icon';
import type { GatheringLinkInfo } from '@/lib/api';

/**
 * Wraps the gathering-link card with a "Send scoping questions" /
 * "Re-issue link" CTA. Visible on every opportunity, not just ones
 * that already have a link:
 *
 *   - Direct-ingest opportunity, no link yet → big "Send scoping
 *     questions to client" CTA. Pressing it opens IssueLinkModal,
 *     which attaches a template + mints the first token in one call
 *     (POST /opportunities/:id/links, emits link_issued).
 *   - Link-share / already-linked opportunity → shows the existing
 *     GatheringLinkCard, plus a smaller "Re-issue link" button
 *     (emits link_reissued; the previous link can be revoked
 *     separately if needed).
 *
 * See docs/direct-ingest.md §7.2.
 */
export function ScopingQuestionsCard({
  engagementId,
  currentTemplateId,
  link,
  onOpenModal,
}: {
  engagementId: string;
  currentTemplateId: string | null;
  link: GatheringLinkInfo | null;
  onOpenModal(): void;
}) {
  void engagementId; // Used by parent's modal; the card itself only renders.
  void currentTemplateId;
  if (!link) {
    return (
      <div
        className="card"
        style={{
          padding: 22,
          marginTop: 16,
          background: 'var(--bg-elev)',
        }}
      >
        <div
          className="section-label"
          style={{
            marginBottom: 10,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <Icon.Link size={11} /> Need more from the client?
        </div>
        <p
          style={{
            margin: '0 0 14px',
            fontSize: 12.5,
            color: 'var(--fg-muted)',
            lineHeight: 1.55,
          }}
        >
          Send a tokenised scoping link with follow-up questions. Useful
          when the requirements you already imported leave gaps — pick a
          template, set how long the link stays live, and the client
          fills it in their browser.
        </p>
        <button className="btn accent" onClick={onOpenModal}>
          <Icon.Send size={12} /> Send scoping questions
        </button>
      </div>
    );
  }
  return (
    <>
      <GatheringLinkCard link={link} />
      <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
        <button className="btn sm ghost" onClick={onOpenModal}>
          <Icon.Refresh size={11} /> Re-issue link
        </button>
      </div>
    </>
  );
}

/** Live gathering link card — surfaces the URL the rep generated when
 *  the opportunity was issued. Lets them copy it back into chat after
 *  leaving the new-opportunity wizard. Renders revoked / expired states
 *  inline so they aren't tempted to share a dead link. */
function GatheringLinkCard({ link }: { link: GatheringLinkInfo }) {
  const [copied, setCopied] = useState(false);
  const dead = link.isRevoked || link.isExpired;
  const expDate = new Date(link.expiresAt);
  return (
    <div
      className="card"
      style={{
        padding: 22, marginTop: 16,
        background: dead ? 'var(--bg-sunk)' : 'var(--bg-elev)',
        opacity: dead ? 0.85 : 1,
      }}
    >
      <div className="section-label" style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon.Link size={11} /> Gathering link
        {link.isRevoked && <span style={{ color: 'var(--danger)', fontSize: 10.5, fontWeight: 600 }}>· REVOKED</span>}
        {!link.isRevoked && link.isExpired && <span style={{ color: 'var(--warn)', fontSize: 10.5, fontWeight: 600 }}>· EXPIRED</span>}
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 12px',
        background: 'var(--bg-sunk)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        fontFamily: 'var(--font-mono)', fontSize: 12,
        color: 'var(--fg-muted)',
        wordBreak: 'break-all',
      }}>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {link.url}
        </span>
        <button
          className="btn sm ghost"
          onClick={() => {
            void navigator.clipboard.writeText(link.url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          }}
          title="Copy link to clipboard"
        >
          {copied ? <><Icon.Check size={11} /> Copied</> : <><Icon.Copy size={11} /> Copy</>}
        </button>
      </div>

      <div style={{
        marginTop: 10,
        display: 'flex', flexWrap: 'wrap', gap: 14,
        fontSize: 11.5, color: 'var(--fg-subtle)',
      }}>
        <span><Icon.Clock size={10} /> Expires {expDate.toLocaleString()}</span>
        <span>·</span>
        <span>{link.accessCount} {link.accessCount === 1 ? 'access' : 'accesses'}</span>
      </div>

      {dead && (
        <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
          {link.isRevoked
            ? 'This link was revoked. Issue a new opportunity to send a fresh one.'
            : 'This link has expired. Issue a new opportunity to send a fresh one.'}
        </p>
      )}
    </div>
  );
}
