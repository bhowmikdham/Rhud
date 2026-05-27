import { describe, expect, it } from 'vitest';
import {
  disambiguateForwardedSender,
  extractStructuredFields,
  MAX_STRUCTURED_FIELDS,
} from './email-parser.js';

describe('disambiguateForwardedSender', () => {
  // Mirrors the real-world Outlook screenshot the user reported:
  // Bhowmik (tenant user) receives a fwd from Nitesh (also @gisconsulting.in),
  // who forwarded from yash.gupta@techspire.co.in (the actual prospect).
  const FORWARDED_BODY = `Fyi...for testing Rhud.

Regards,
Nitesh Suri
VP Sales
G-Info Technology Solutions Pvt. Ltd.

From: yash.gupta@techspire.co.in <yash.gupta@techspire.co.in>
Date: Tuesday, 12 May 2026 at 11:53 AM
To: Nitesh Suri <nitesh.suri@gisconsulting.in>
Subject: Request for VA Report of CII Systems

Hi Sir,

I hope you are doing well!
We are in requirement of carrying out the VA activity ...`;

  it('returns external sender when forwarder shares tenant domain', () => {
    const result = disambiguateForwardedSender({
      sender: { email: 'nitesh.suri@gisconsulting.in', name: 'Nitesh Suri' },
      tenantUserEmail: 'bhowmik@gisconsulting.in',
      bodyText: FORWARDED_BODY,
    });
    expect(result).toEqual({ email: 'yash.gupta@techspire.co.in' });
  });

  it('returns external sender when forwarder IS the tenant user', () => {
    const result = disambiguateForwardedSender({
      sender: { email: 'bhowmik@gisconsulting.in', name: 'Bhowmik Dham' },
      tenantUserEmail: 'bhowmik@gisconsulting.in',
      bodyText: FORWARDED_BODY,
    });
    expect(result?.email).toBe('yash.gupta@techspire.co.in');
  });

  it('returns null when sender is already external', () => {
    const result = disambiguateForwardedSender({
      sender: { email: 'yash.gupta@techspire.co.in', name: 'Yash Gupta' },
      tenantUserEmail: 'bhowmik@gisconsulting.in',
      bodyText: FORWARDED_BODY,
    });
    expect(result).toBeNull();
  });

  it('skips chained internal forwarders, returns first external', () => {
    const body = `Latest comment.

From: alice@gisconsulting.in
To: bhowmik@gisconsulting.in
Subject: Fwd

From: bob@gisconsulting.in
To: alice@gisconsulting.in
Subject: Fwd

From: real.prospect@external.com
To: bob@gisconsulting.in
Subject: Original

Original body here.`;
    const result = disambiguateForwardedSender({
      sender: { email: 'alice@gisconsulting.in' },
      tenantUserEmail: 'bhowmik@gisconsulting.in',
      bodyText: body,
    });
    expect(result?.email).toBe('real.prospect@external.com');
  });

  it('returns null when internal forward has no external upstream', () => {
    const body = `Hey, can you look at this?

From: alice@gisconsulting.in
To: bhowmik@gisconsulting.in
Subject: Just internal stuff`;
    const result = disambiguateForwardedSender({
      sender: { email: 'alice@gisconsulting.in' },
      tenantUserEmail: 'bhowmik@gisconsulting.in',
      bodyText: body,
    });
    expect(result).toBeNull();
  });

  it('parses display name with quotes', () => {
    const body = `From: "Yash Gupta" <yash.gupta@techspire.co.in>
Subject: ...`;
    const result = disambiguateForwardedSender({
      sender: { email: 'nitesh@gisconsulting.in' },
      tenantUserEmail: 'me@gisconsulting.in',
      bodyText: body,
    });
    expect(result).toEqual({ email: 'yash.gupta@techspire.co.in', name: 'Yash Gupta' });
  });

  it('suppresses redundant "email <email>" as display name', () => {
    // Needs a real forwarded-header block (To:/Date:/Subject: nearby) to
    // pass the stricter `looksLikeForwardedHeaderBlock` guard. The shape
    // we're testing is the parser's name-suppression behaviour, not the
    // header-detection logic.
    const body = `From: yash.gupta@techspire.co.in <yash.gupta@techspire.co.in>
Date: Tue, 12 May 2026
To: nitesh@gisconsulting.in
Subject: RFP`;
    const result = disambiguateForwardedSender({
      sender: { email: 'nitesh@gisconsulting.in' },
      tenantUserEmail: 'me@gisconsulting.in',
      bodyText: body,
    });
    expect(result).toEqual({ email: 'yash.gupta@techspire.co.in' });
  });

  it('handles empty body without throwing', () => {
    const result = disambiguateForwardedSender({
      sender: { email: 'me@gisconsulting.in' },
      tenantUserEmail: 'me@gisconsulting.in',
      bodyText: '',
    });
    expect(result).toBeNull();
  });

  it('ignores bare "From:" mentions in body prose (no To:/Date:/Subject: nearby)', () => {
    // Real-world false positive: replies/notes containing things like
    // "From: the team — go ahead with X" should not be misread as
    // forwarded headers.
    const body = `Quick comment from me.

    From: the analyst team's perspective, our notes are:
    - alice@external.com mentioned the deadline
    - bob@othercompany.net asked about pricing

    Let me know.`;
    const result = disambiguateForwardedSender({
      sender: { email: 'me@gisconsulting.in' },
      tenantUserEmail: 'me@gisconsulting.in',
      bodyText: body,
    });
    expect(result).toBeNull();
  });

  it('still matches a real forwarded header with only Sent: + Subject:', () => {
    // Outlook desktop often uses "Sent:" instead of "Date:". Confirm
    // our nearby-header check accepts that form.
    const body = `Forwarded.

From: real.prospect@external.com
Sent: Tuesday, 12 May 2026 11:53 AM
Subject: RFP`;
    const result = disambiguateForwardedSender({
      sender: { email: 'me@gisconsulting.in' },
      tenantUserEmail: 'me@gisconsulting.in',
      bodyText: body,
    });
    expect(result?.email).toBe('real.prospect@external.com');
  });
});

describe('extractStructuredFields', () => {
  it('extracts 2-column label/value rows', () => {
    const html = `<table>
      <tr><td>Application Name</td><td>MESA, MBIS</td></tr>
      <tr><td>Architecture</td><td>3-tier</td></tr>
      <tr><td>Back-end Database</td><td>Oracle 12 C</td></tr>
    </table>`;
    const fields = extractStructuredFields(html);
    expect(fields).toEqual([
      { label: 'Application Name', value: 'MESA, MBIS' },
      { label: 'Architecture', value: '3-tier' },
      { label: 'Back-end Database', value: 'Oracle 12 C' },
    ]);
  });

  it('extracts 3-column serial/label/value rows (CII-questionnaire shape)', () => {
    const html = `<table>
      <tr><td>1</td><td>Application Name</td><td>MESA, MBIS</td></tr>
      <tr><td>2</td><td>Details of Architecture</td><td>3-tier</td></tr>
      <tr><td>3</td><td>Supporting OS for software</td><td>Linux 7.4 &amp; Windows 2016</td></tr>
    </table>`;
    const fields = extractStructuredFields(html);
    expect(fields).toEqual([
      { label: 'Application Name', value: 'MESA, MBIS' },
      { label: 'Details of Architecture', value: '3-tier' },
      { label: 'Supporting OS for software', value: 'Linux 7.4 & Windows 2016' },
    ]);
  });

  it('skips obvious header rows', () => {
    // Two data rows needed after header is dropped (the "real data table"
    // guard requires ≥2 surviving rows).
    const html = `<table>
      <tr><th>S. No.</th><th>Parameters</th><th>Description</th></tr>
      <tr><td>1</td><td>Mobile Application Name</td><td>Biasearch</td></tr>
      <tr><td>2</td><td>Development Platform</td><td>Android</td></tr>
    </table>`;
    const fields = extractStructuredFields(html);
    expect(fields).toEqual([
      { label: 'Mobile Application Name', value: 'Biasearch' },
      { label: 'Development Platform', value: 'Android' },
    ]);
  });

  it('keeps empty values so the rep sees what is missing', () => {
    const html = `<table>
      <tr><td>1</td><td>Total No. of input fields</td><td>-</td></tr>
      <tr><td>2</td><td>Number of Web Services</td><td></td></tr>
    </table>`;
    const fields = extractStructuredFields(html);
    expect(fields).toHaveLength(2);
    expect(fields[0]).toEqual({ label: 'Total No. of input fields', value: '-' });
    expect(fields[1]).toEqual({ label: 'Number of Web Services', value: '' });
  });

  it('dedupes repeated labels across tables', () => {
    // Both tables need ≥2 data rows to pass the "real data table" guard.
    const html = `<table>
      <tr><td>1</td><td>Total No. of input fields</td><td>NA</td></tr>
      <tr><td>2</td><td>Architecture</td><td>3-tier</td></tr>
    </table>
    <table>
      <tr><td>5</td><td>Total No. of input fields</td><td>-</td></tr>
      <tr><td>6</td><td>Database</td><td>Oracle</td></tr>
    </table>`;
    const fields = extractStructuredFields(html);
    // 3 unique labels — "Total No. of input fields" from the first table
    // wins; the second table's row is deduped.
    expect(fields.map((f) => f.label)).toEqual([
      'Total No. of input fields',
      'Architecture',
      'Database',
    ]);
    expect(fields[0]?.value).toBe('NA');
  });

  it('returns empty array on garbage input', () => {
    expect(extractStructuredFields('')).toEqual([]);
    expect(extractStructuredFields('<p>just paragraphs, no tables</p>')).toEqual([]);
  });

  it('collapses whitespace in cell text', () => {
    const html = `<table>
      <tr><td>  Application\n  Name  </td><td>MESA,\t\tMBIS</td></tr>
      <tr><td>Architecture</td><td>3-tier</td></tr>
    </table>`;
    const fields = extractStructuredFields(html);
    expect(fields[0]).toEqual({ label: 'Application Name', value: 'MESA, MBIS' });
  });

  // ── new heuristics (signature pollution / layout-table guards) ────

  it('skips signature-card tables (single row of contact info)', () => {
    // Outlook injects a contact-card table at the bottom of forwarded
    // messages. One row, looks like 2-col KV. We don't want it surfacing
    // as a "Detected field."
    const html = `<table>
      <tr><td>Mobile</td><td>+91-99999-99999</td></tr>
    </table>`;
    const fields = extractStructuredFields(html);
    expect(fields).toEqual([]);
  });

  it('skips image-only spacer tables (marketing / calendar invite)', () => {
    const html = `<table>
      <tr><td><img src="x" /></td><td><img src="y" /></td></tr>
      <tr><td><img src="z" /></td><td><img src="w" /></td></tr>
    </table>`;
    const fields = extractStructuredFields(html);
    expect(fields).toEqual([]);
  });

  it('skips tables nested deeper than 2 levels (Outlook layout scaffolding)', () => {
    // Outlook desktop wraps the message in nested layout tables.
    // Anything at depth ≥3 is layout, not data. Depth counts table
    // ancestors of the table being considered, so the innermost
    // here is at depth 3 (three table parents).
    const html = `<table><tr><td>
      <table><tr><td>
        <table><tr><td>
          <table>
            <tr><td>Foo</td><td>Bar</td></tr>
            <tr><td>Baz</td><td>Qux</td></tr>
          </table>
        </td></tr></table>
      </td></tr></table>
    </td></tr></table>`;
    const fields = extractStructuredFields(html);
    expect(fields).toEqual([]);
  });

  it('skips header rows where any cell is a <th> (catches plain-styled headers)', () => {
    // Earlier rule required BOTH label and value to look like headers.
    // Real headers usually only have a header-shape in column 1.
    const html = `<table>
      <tr><th>Particulars</th><th>Description</th></tr>
      <tr><td>Real Label</td><td>Real Value</td></tr>
      <tr><td>Another</td><td>One</td></tr>
    </table>`;
    const fields = extractStructuredFields(html);
    expect(fields.map((f) => f.label)).toEqual(['Real Label', 'Another']);
  });

  it('skips header rows where first cell matches the broader token list', () => {
    // No <th> tags — pure <td> table. Detect via first-cell token match.
    // Tokens added: particulars, item, q., question, aspect, remarks, etc.
    const html = `<table>
      <tr><td>Item</td><td>Notes</td></tr>
      <tr><td>Real Label</td><td>Real Value</td></tr>
      <tr><td>Another</td><td>One</td></tr>
    </table>`;
    const fields = extractStructuredFields(html);
    expect(fields.map((f) => f.label)).toEqual(['Real Label', 'Another']);
  });

  it('caps output at MAX_STRUCTURED_FIELDS to guard the pane render', () => {
    // Synthesize a table with twice the cap. Should silently truncate.
    const rows = Array.from({ length: MAX_STRUCTURED_FIELDS * 2 }, (_, i) =>
      `<tr><td>Label ${i}</td><td>Value ${i}</td></tr>`,
    ).join('');
    const fields = extractStructuredFields(`<table>${rows}</table>`);
    expect(fields).toHaveLength(MAX_STRUCTURED_FIELDS);
    expect(fields[0]?.label).toBe('Label 0');
  });

  it('keeps the original CII multi-table fixture working end-to-end', () => {
    // Both tables have ≥2 data rows so they survive the new guard.
    // Headers are skipped, dedupe still works.
    const html = `
      <table>
        <tr><td>1</td><td>Application Name</td><td>MESA, MBIS (Thick Clients)</td></tr>
        <tr><td>2</td><td>Details of Architecture</td><td>3-tier</td></tr>
        <tr><td>3</td><td>Supporting OS for software</td><td>Linux 7.4 &amp; Windows 2016 Standard</td></tr>
      </table>
      <table>
        <tr><th>S. No.</th><th>Parameters</th><th>Description</th></tr>
        <tr><td>1</td><td>Mobile Application Name</td><td>Biasearch</td></tr>
        <tr><td>2</td><td>Development platform Details</td><td>Android</td></tr>
        <tr><td>13</td><td>Is there any payment gateway ?</td><td>No</td></tr>
      </table>`;
    const labels = extractStructuredFields(html).map((f) => f.label);
    expect(labels).toContain('Application Name');
    expect(labels).toContain('Mobile Application Name');
    expect(labels).not.toContain('S. No.');
    expect(labels).not.toContain('Parameters');
  });

  it('handles real-world CII questionnaire (multi-table + headers + empties)', () => {
    const html = `
      <table>
        <tr><td>1</td><td>Application Name</td><td>MESA, MBIS (Thick Clients) &amp; Mobile Web android based app</td></tr>
        <tr><td>2</td><td>Details of Architecture</td><td>3-tier</td></tr>
        <tr><td>3</td><td>Supporting OS for software</td><td>Linux 7.4 &amp; Windows 2016 Standard</td></tr>
        <tr><td>4</td><td>Application Server with Version</td><td>NA</td></tr>
        <tr><td>7</td><td>Back-end Database</td><td>Oracle 12 C</td></tr>
        <tr><td>8</td><td>No. of login modules</td><td>3 (MBIS, MESA &amp; Biosearch)</td></tr>
      </table>
      <table>
        <tr><th>S. No.</th><th>Parameters</th><th>Description</th></tr>
        <tr><td>1</td><td>Mobile Application Name</td><td>Biasearch</td></tr>
        <tr><td>2</td><td>Development platform Details</td><td>Android</td></tr>
        <tr><td>13</td><td>Is there any payment gateway ?</td><td>No</td></tr>
        <tr><td>21</td><td>What's driving your interest in VAPT/Security audit</td><td>Compliance Needs</td></tr>
      </table>`;
    const fields = extractStructuredFields(html);
    const labels = fields.map((f) => f.label);
    expect(labels).toContain('Application Name');
    expect(labels).toContain('Back-end Database');
    expect(labels).toContain('Mobile Application Name');
    expect(labels).toContain("What's driving your interest in VAPT/Security audit");
    expect(labels).not.toContain('S. No.');
    expect(labels).not.toContain('Parameters');
    expect(fields.find((f) => f.label === 'Back-end Database')?.value).toBe('Oracle 12 C');
  });
});
