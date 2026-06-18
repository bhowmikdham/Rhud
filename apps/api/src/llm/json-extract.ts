/**
 * Tolerant parser for JSON emitted by an LLM.
 *
 * LLMs wrap output in markdown fences, prepend prose, and — the failure that
 * motivated this util — emit STRUCTURALLY-BROKEN JSON. The worst offender is
 * Gemini's OpenAI-compat endpoint: when it rejects a `response_format`
 * json_schema (it 4xx's / ignores schemas carrying `additionalProperties:false`,
 * see `sanitizeSchemaForProvider` in openai-compat.provider.ts) the call falls
 * back to UNCONSTRAINED generation. Unconstrained, the model echoes verbatim
 * document text — spreadsheet cells like `2 Apps (Doctor & "Health") - Andriod`,
 * multi-line comments — straight into string values WITHOUT escaping the inner
 * quotes / newlines, producing JSON that `JSON.parse` rejects at the first
 * stray character. At temperature 0 this is DETERMINISTIC: every re-draw repeats
 * the identical malformation, so a plain retry loop never recovers (the MedTech
 * extraction bug — 26 points / 3 of 7 sheets, parse error at the same offset
 * on every attempt).
 *
 * Strategy, strict → lenient, so a well-formed response is NEVER altered and we
 * only reach the lossy repair stage once cheaper exact parses have failed:
 *
 *   1. `strict`    — JSON.parse the fence-stripped text as-is. The 99% path.
 *   2. `substring` — JSON.parse the first `{`…last `}` slice. Drops prose
 *                    preamble / trailing commentary that is otherwise valid.
 *   3. `repair`    — jsonrepair the slice, then parse. Fixes unescaped inner
 *                    quotes, raw control chars, trailing commas, single quotes,
 *                    missing separators, and a truncated tail. Only ever runs on
 *                    input that already failed exact parsing, so any success is
 *                    strictly better than dropping the whole response.
 *   3b. `repair`   — final fallback: jsonrepair the WHOLE cleaned text. Catches
 *                    severe truncation with no closing brace (the `{`…`}` slice
 *                    is empty) and the rare structural brace living inside a
 *                    broken string value.
 *
 * Throws {@link LlmJsonParseError} (carrying a short raw preview) only when even
 * repair cannot recover a value. Callers decide whether that's fatal (extraction
 * surfaces it to trigger the structured fallback) or soft (the mapper records it
 * as `parseError` and shows the heuristic).
 *
 * REPAIR IS LOSSY BY NATURE — a `via: 'repair'` result means the bytes were
 * already invalid JSON and were reconstructed by best-effort heuristics, so some
 * values may be subtly wrong:
 *   - Lone backslashes (Windows paths `C:\Users`, UNC `\\host\share`) are
 *     dropped/normalised, since `\U` is not a valid JSON escape.
 *   - A truncated trailing value (number cut mid-digit, string cut mid-word) is
 *     closed with whatever partial bytes survived.
 * This is acceptable ONLY because (a) repair never runs on well-formed input
 * (strict/substring parse it first), (b) every `via: 'repair'` is logged by the
 * caller, and (c) the real defence is preventing malformation at the source —
 * `sanitizeSchemaForProvider` keeps Gemini's constrained JSON decoding engaged,
 * which escapes these correctly so they never reach repair. Callers that price
 * off repaired numbers (the mapper) additionally guard the truncated-tail case.
 */
import { jsonrepair } from 'jsonrepair';

export type LlmJsonVia = 'strict' | 'substring' | 'repair' | 'repair-whole';

export interface LlmJsonResult {
  /** The parsed value. `unknown` — the caller validates its shape. */
  value: unknown;
  /** Which stage produced it. `repair`/`repair-whole` mean the bytes were
   *  malformed and jsonrepair reconstructed them — worth a WARN so prod surfaces
   *  how often the provider is handing us broken JSON. `repair-whole` is the
   *  riskier variant: there was no complete `{…}` slice (severe truncation with
   *  no closing brace), so a TRAILING value may be fabricated from a cut-off
   *  token — callers pricing off repaired numbers special-case it. */
  via: LlmJsonVia;
}

export class LlmJsonParseError extends Error {
  /** First ~200 chars of the (fence-stripped) response, for diagnostics. */
  readonly rawPreview: string;
  constructor(message: string, rawPreview: string) {
    super(message);
    this.name = 'LlmJsonParseError';
    this.rawPreview = rawPreview;
  }
}

/** Strip a leading/trailing markdown code fence. Handles both a full
 *  ```json … ``` block (returns the inner content) and a lone leading/trailing
 *  fence marker (some models open a fence but never close it). */
export function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const block = trimmed.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (block && block[1] != null) return block[1].trim();
  return trimmed
    .replace(/^```(?:json|JSON)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

/** First `{`…last `}` (or `[`…`]`) slice, whichever opens first. Null when no
 *  matching pair exists. Used to drop prose around an otherwise-parseable
 *  object so the repair stage works on clean structure. */
function braceSlice(text: string): string | null {
  const firstObj = text.indexOf('{');
  const firstArr = text.indexOf('[');
  let open = -1;
  let close = -1;
  // Pick whichever container opens first in the text.
  const useObj =
    firstObj !== -1 && (firstArr === -1 || firstObj < firstArr);
  if (useObj) {
    open = firstObj;
    close = text.lastIndexOf('}');
  } else if (firstArr !== -1) {
    open = firstArr;
    close = text.lastIndexOf(']');
  }
  if (open === -1 || close === -1 || close <= open) return null;
  return text.slice(open, close + 1);
}

function tryParse(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function tryRepair(s: string): unknown | undefined {
  let repaired: string;
  try {
    repaired = jsonrepair(s);
  } catch {
    return undefined;
  }
  return tryParse(repaired);
}

/**
 * Parse JSON from an LLM response, tolerating fences, prose, and structural
 * corruption. See the module header for the staged strategy. Throws
 * {@link LlmJsonParseError} when nothing recovers a value.
 *
 * `undefined`/`null` are valid JSON-parse outputs in theory but never from our
 * prompts; they are treated as "recovered" only at the strict stage (a literal
 * `null` body), never as a repair success.
 */
export function parseLlmJson(raw: string): LlmJsonResult {
  const preview = (raw ?? '').slice(0, 200);
  if (!raw || !raw.trim()) {
    throw new LlmJsonParseError('empty response', preview);
  }

  const cleaned = stripCodeFences(raw);

  // 1. strict — exact parse of the cleaned text.
  const strict = tryParse(cleaned);
  if (strict !== undefined) return { value: strict, via: 'strict' };

  const slice = braceSlice(cleaned);
  if (slice != null) {
    // 2. substring — strip surrounding prose, parse the structural slice.
    const sub = tryParse(slice);
    if (sub !== undefined) return { value: sub, via: 'substring' };

    // 3. repair the slice.
    const repairedSlice = tryRepair(slice);
    if (repairedSlice !== undefined) return { value: repairedSlice, via: 'repair' };
  }

  // 3b. repair the whole cleaned text — severe truncation (no closing brace, so
  //     `slice` was null) or a structural brace inside a broken string value.
  //     Flagged `repair-whole`: the trailing value may be fabricated from a
  //     cut-off token (no complete object survived to slice), so pricing callers
  //     treat its last item as untrustworthy.
  const repairedWhole = tryRepair(cleaned);
  if (repairedWhole !== undefined) return { value: repairedWhole, via: 'repair-whole' };

  throw new LlmJsonParseError('unparseable JSON even after repair', preview);
}
