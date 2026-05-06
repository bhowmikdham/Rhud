/**
 * docx canonical-Document specs.
 *
 * Tests `splitIntoTextBlocks` directly (the pure splitter the
 * `parseDocxToDocument` flow runs after mammoth produces raw text).
 * The full mammoth round-trip is exercised in the e2e gathering test;
 * here we lock in the heading-detection contract that downstream LLM
 * extraction depends on for `appId` grouping.
 */

import { describe, it, expect } from 'vitest';
import { splitIntoTextBlocks } from './docx.parser.js';

describe('splitIntoTextBlocks — heading detection', () => {
  it('produces no blocks for empty input', () => {
    expect(splitIntoTextBlocks('')).toEqual([]);
    expect(splitIntoTextBlocks('   ')).toEqual([]);
  });

  it('treats a single paragraph with no heading as one body block', () => {
    const blocks = splitIntoTextBlocks(
      'This is a single paragraph of text without any heading.',
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.heading).toBeNull();
    expect(blocks[0]!.body).toContain('single paragraph');
  });

  it('splits on numbered headings ("1. Foo", "2. Bar")', () => {
    const blocks = splitIntoTextBlocks([
      '1. Introduction',
      'Some intro text here.',
      '',
      '2. Application Inventory',
      'Asset list goes here.',
      'More details below.',
    ].join('\n'));
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.heading).toBe('1. Introduction');
    expect(blocks[0]!.headingDepth).toBe(1);
    expect(blocks[0]!.body).toContain('intro text');
    expect(blocks[1]!.heading).toBe('2. Application Inventory');
    expect(blocks[1]!.body).toContain('Asset list');
  });

  it('detects nested numbered headings ("1.2 Foo") with depth 2', () => {
    const blocks = splitIntoTextBlocks([
      '1.2 Sub Section',
      'Body of sub.',
    ].join('\n'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.headingDepth).toBe(2);
  });

  it('detects ALL-CAPS lines as depth-1 headings', () => {
    const blocks = splitIntoTextBlocks([
      'OVERVIEW',
      'This is the overview body.',
      '',
      'SCOPE',
      'These are the scope details.',
    ].join('\n'));
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.heading).toBe('OVERVIEW');
    expect(blocks[0]!.headingDepth).toBe(1);
    expect(blocks[1]!.heading).toBe('SCOPE');
  });

  it('detects Title Case lines as depth-2 headings', () => {
    const blocks = splitIntoTextBlocks([
      'Application Overview',
      'A web app on AWS.',
      '',
      'Security Posture',
      'See attached.',
    ].join('\n'));
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.heading).toBe('Application Overview');
    expect(blocks[0]!.headingDepth).toBe(2);
    expect(blocks[1]!.heading).toBe('Security Posture');
  });

  it('does NOT treat sentence-cased text ending in a period as a heading', () => {
    const blocks = splitIntoTextBlocks([
      '1. Methodology',
      'We tested the application.',
      'We focused on input validation.',
    ].join('\n'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.heading).toBe('1. Methodology');
    expect(blocks[0]!.body).toContain('We tested the application.');
    expect(blocks[0]!.body).toContain('We focused on input validation.');
  });

  it('preserves paragraph breaks within a body block', () => {
    const blocks = splitIntoTextBlocks([
      '1. Notes',
      'First paragraph.',
      '',
      'Second paragraph.',
    ].join('\n'));
    expect(blocks).toHaveLength(1);
    // Blank line preserved between paragraphs.
    expect(blocks[0]!.body).toMatch(/First paragraph\.\s*\n\s*\n\s*Second paragraph\./);
  });

  it('rejects too-short or too-long lines as headings', () => {
    // Single-letter "X" — too short
    const tooShort = splitIntoTextBlocks(['X', 'body'].join('\n'));
    expect(tooShort).toHaveLength(1);
    expect(tooShort[0]!.heading).toBeNull();
    // 100-char line is over the 80-char threshold
    const longLine = 'x'.repeat(100);
    const tooLong = splitIntoTextBlocks([longLine, 'body'].join('\n'));
    expect(tooLong[0]!.heading).toBeNull();
  });

  it('rejects lines ending in colon, comma, or semicolon as headings', () => {
    // "Note:" looks heading-shaped but ends in a colon — sentence punct.
    const blocks = splitIntoTextBlocks([
      'Note: applies to API',
      'body content',
    ].join('\n'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.heading).toBeNull();
  });

  it('does not split when many short Title Case sentences appear in a row', () => {
    // Sentence punctuation guards against this case — "We Tested It." ends
    // in a period so it's not a heading.
    const blocks = splitIntoTextBlocks([
      'We Tested It.',
      'We Found Bugs.',
      'We Fixed Them.',
    ].join('\n'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.heading).toBeNull();
  });
});
