import { describe, expect, it } from 'vitest';
import { EmailExtractorService } from './email-extractor.service.js';

// We unit-test the two pure-ish internals that don't need DI: the LLM JSON
// parsing (fence-stripping, prose-trimming, schema validation) and the
// coercion to the strict result shape. We reach them via a thin subclass
// that exposes them — they're private but logically pure.
class Probe extends EmailExtractorService {
  constructor() {
    // The pure methods never touch the injected deps, so nulls are safe here.
    super(null as never, null as never, null as never);
  }
  pub_parse(text: string) {
    return (this as unknown as { parseLlmJson(t: string): unknown }).parseLlmJson(text);
  }
  pub_coerce(parsed: unknown, dto: { fromEmail: string; subject: string; bodyText: string }) {
    return (this as unknown as { coerce(p: unknown, d: unknown): unknown }).coerce(parsed, dto);
  }
}

const dto = { fromEmail: 'nitesh@gisconsulting.in', subject: 'FW: VA Report', bodyText: '...' };

describe('EmailExtractorService.parseLlmJson', () => {
  const probe = new Probe();

  it('parses a clean JSON object', () => {
    const out = probe.pub_parse('{"client":{"company":"Techspire"},"fields":[]}') as { client: { company: string } };
    expect(out.client.company).toBe('Techspire');
  });

  it('strips ```json fences', () => {
    const out = probe.pub_parse('```json\n{"isForwarded":true,"fields":[]}\n```') as { isForwarded: boolean };
    expect(out.isForwarded).toBe(true);
  });

  it('trims leading prose before the JSON object', () => {
    const out = probe.pub_parse('Here is the result:\n{"forwardedFrom":"x@y.com","fields":[]}') as { forwardedFrom: string };
    expect(out.forwardedFrom).toBe('x@y.com');
  });

  it('throws on non-JSON so the caller can fall back', () => {
    expect(() => probe.pub_parse('the model refused')).toThrow();
  });
});

describe('EmailExtractorService.coerce', () => {
  const probe = new Probe();

  it('maps the LLM shape into the strict client + fields result', () => {
    const out = probe.pub_coerce(
      {
        client: { company: 'Techspire Services', contactName: 'Yash Gupta', email: 'yash@techspire.co.in', phone: '+91-99', address: 'Pune', website: 'https://techspireservices.com' },
        isForwarded: true,
        forwardedFrom: 'nitesh@gisconsulting.in',
        fields: [{ label: 'Application Name', value: 'MESA' }, { label: 'Architecture', value: '3-tier' }],
      },
      dto,
    ) as { client: Record<string, string | null>; structuredFields: unknown[]; source: string };
    expect(out.client.company).toBe('Techspire Services');
    expect(out.client.email).toBe('yash@techspire.co.in');
    expect(out.client.phone).toBe('+91-99');
    expect(out.structuredFields).toHaveLength(2);
    expect(out.source).toBe('llm');
  });

  it('defaults client email to the apparent sender when the model omits it', () => {
    const out = probe.pub_coerce({ client: {}, fields: [] }, dto) as { client: { email: string | null } };
    expect(out.client.email).toBe('nitesh@gisconsulting.in');
  });

  it('drops empty-label field rows and trims blanks to null', () => {
    const out = probe.pub_coerce(
      { client: { company: '   ' }, fields: [{ label: '', value: 'x' }, { label: 'Real', value: '' }] },
      dto,
    ) as { client: { company: string | null }; structuredFields: Array<{ label: string; value: string }> };
    expect(out.client.company).toBeNull();
    expect(out.structuredFields).toEqual([{ label: 'Real', value: '' }]);
  });

  it('caps fields at 100', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ label: `L${i}`, value: `V${i}` }));
    const out = probe.pub_coerce({ client: {}, fields: many }, dto) as { structuredFields: unknown[] };
    expect(out.structuredFields).toHaveLength(100);
  });
});
