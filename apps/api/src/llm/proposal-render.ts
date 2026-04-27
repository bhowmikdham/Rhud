/**
 * Pure-function token substitution for proposal scaffolds.
 *
 * Tokens look like {{token_name}}. Unknown tokens are left in place
 * (helps the user spot typos) — they don't crash. Whitespace inside
 * the braces is tolerated: {{ client_name }} works the same as
 * {{client_name}}.
 *
 * The token list is small + intentional. Adding more is cheap, but
 * each new token is part of the public contract with consultancy
 * admins, so resist the urge to add fragmented variants.
 */

const TOKEN_RE = /\{\{\s*([a-z0-9_:]+)\s*\}\}/gi;

export interface ScaffoldContext {
  clientEmail: string;
  /** Derived from the email's local part — first segment before "." */
  clientName: string;
  opportunityName: string | null;
  tenantName: string;
  serviceLine: string;
  templateName: string;
  /** Final price (approved if set, else base) in major units rendered
   *  with the configured currency. */
  priceFormatted: string;
  currency: string;
  /** "DD MMM YYYY" — locale-neutral display date for proposal headers. */
  dateToday: string;
  /** Bulleted list of question + answer pairs from the gathering form.
   *  Capped at 25 items so a wildly long form doesn't blow up the
   *  proposal. */
  scopeSummary: string;
  /** Bulleted list of priced line items (service line + scope value
   *  + price). Empty string when no quote / no breakdown. */
  lineItems: string;
}

export const AVAILABLE_TOKENS: ReadonlyArray<{ token: string; description: string }> = [
  { token: 'client_email',     description: "Recipient's email address." },
  { token: 'client_name',      description: "Best-guess of the recipient's name (the email's local part, capitalised)." },
  { token: 'opportunity_name', description: 'The opportunity label, if one was set when issuing.' },
  { token: 'tenant_name',      description: 'Your workspace name (e.g. your consultancy).' },
  { token: 'service_line',     description: "The template's service line tag." },
  { token: 'template_name',    description: "The template's display name." },
  { token: 'price',            description: 'Final price (approved overrides base) with currency, e.g. "INR 250,000".' },
  { token: 'currency',         description: 'ISO currency code only.' },
  { token: 'date_today',       description: 'Today\'s date formatted "27 Apr 2026".' },
  { token: 'scope_summary',    description: 'Bulleted list of the client-confirmed scope answers.' },
  { token: 'line_items',       description: 'Bulleted list of priced line items from the quote.' },
];

/** Substitute {{tokens}} in `scaffold` with values from `ctx`.
 *  Returns the rendered Markdown text. Unknown tokens are left as-is. */
export function renderScaffold(scaffold: string, ctx: ScaffoldContext): string {
  const map: Record<string, string> = {
    client_email:     ctx.clientEmail,
    client_name:      ctx.clientName,
    opportunity_name: ctx.opportunityName ?? '',
    tenant_name:      ctx.tenantName,
    service_line:     ctx.serviceLine,
    template_name:    ctx.templateName,
    price:            ctx.priceFormatted,
    currency:         ctx.currency,
    date_today:       ctx.dateToday,
    scope_summary:    ctx.scopeSummary,
    line_items:       ctx.lineItems,
  };
  return scaffold.replace(TOKEN_RE, (match, key: string) => {
    const k = key.toLowerCase();
    return Object.prototype.hasOwnProperty.call(map, k) ? map[k]! : match;
  });
}

/** Pretty-format the local part of an email as a name guess.
 *    "alex.morgan@x.com"  → "Alex Morgan"
 *    "billing-team@x.com" → "Billing Team"
 *    "j" — falls back to the literal email when too short to guess. */
export function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  if (local.length < 2) return email;
  const tokens = local
    .split(/[._+-]+/)
    .filter(Boolean)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
  return tokens.length > 0 ? tokens.join(' ') : email;
}
