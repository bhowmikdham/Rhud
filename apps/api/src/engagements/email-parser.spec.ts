import { describe, expect, it } from 'vitest';
import {
  disambiguateForwardedSender,
  extractStructuredFields,
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
    const body = `From: yash.gupta@techspire.co.in <yash.gupta@techspire.co.in>`;
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
    const html = `<table>
      <tr><th>S. No.</th><th>Parameters</th><th>Description</th></tr>
      <tr><td>1</td><td>Mobile Application Name</td><td>Biasearch</td></tr>
    </table>`;
    const fields = extractStructuredFields(html);
    expect(fields).toEqual([
      { label: 'Mobile Application Name', value: 'Biasearch' },
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
    const html = `<table>
      <tr><td>1</td><td>Total No. of input fields</td><td>NA</td></tr>
    </table>
    <table>
      <tr><td>5</td><td>Total No. of input fields</td><td>-</td></tr>
    </table>`;
    const fields = extractStructuredFields(html);
    expect(fields).toHaveLength(1);
    expect(fields[0]?.value).toBe('NA');
  });

  it('returns empty array on garbage input', () => {
    expect(extractStructuredFields('')).toEqual([]);
    expect(extractStructuredFields('<p>just paragraphs, no tables</p>')).toEqual([]);
  });

  it('collapses whitespace in cell text', () => {
    const html = `<table>
      <tr><td>  Application\n  Name  </td><td>MESA,\t\tMBIS</td></tr>
    </table>`;
    const fields = extractStructuredFields(html);
    expect(fields[0]).toEqual({ label: 'Application Name', value: 'MESA, MBIS' });
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
