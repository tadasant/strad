/**
 * What a statement looks like to a caller, and how a date range becomes the
 * `startOn` + `period` pair the API takes.
 *
 * THE FIELD MAPPING IS DEFENSIVE ON PURPOSE. The portal's bundle proves three
 * fields of an Apiture document — `_id`, `endOn`, `_links["apiture:document"]`
 * — and the rest of the shape comes from Apiture's generic document model,
 * which LiveOak's deployment has never been observed returning. So each output
 * field reads the first of a few plausible names that is a string, and a
 * field that is absent is omitted rather than invented. What is certain is
 * marked in the tool description; what is not is said in the docs.
 */
import type { RawDocument } from "./apiture.js";

export interface Statement {
  statement_id: string;
  /** The last day the statement covers, YYYY-MM-DD — the date the portal shows. */
  end_on?: string;
  start_on?: string;
  name?: string;
  description?: string;
  category?: string;
  /** Masked, as Apiture returns it ("*1234"). Never the full number. */
  account?: string;
  account_name?: string;
  created_at?: string;
  content_type?: string;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

const first = (o: Record<string, unknown> | undefined, ...keys: string[]): string | undefined => {
  if (!o) return undefined;
  for (const k of keys) {
    const v = str(o[k]);
    if (v) return v;
  }
  return undefined;
};

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** A date-time or date, cut to its date. */
const day = (v: string | undefined): string | undefined => v?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];

/**
 * The account a document belongs to, masked. Apiture puts it under `account`
 * or as the first of `accounts`, with the number under `accountNumbers.masked`
 * (the portal renders `accountNumbers.masked.substr(-4)`).
 */
function accountOf(raw: RawDocument): { account?: string; account_name?: string } {
  const accounts = Array.isArray(raw.accounts) ? raw.accounts : [];
  const acct = obj(raw.account) ?? obj(accounts[0]);
  if (!acct) return {};
  const masked = first(obj(acct.accountNumbers), "masked") ?? first(acct, "maskedNumber");
  const out: { account?: string; account_name?: string } = {};
  if (masked) out.account = masked.length > 4 ? `*${masked.slice(-4)}` : masked;
  const name = first(acct, "name", "title", "label");
  if (name) out.account_name = name;
  return out;
}

export function normalizeStatement(raw: RawDocument): Statement | null {
  const id = typeof raw._id === "string" || typeof raw._id === "number" ? String(raw._id) : undefined;
  if (!id) return null;
  const s: Statement = { statement_id: id };
  const endOn = day(first(raw, "endOn", "statementDate", "date"));
  if (endOn) s.end_on = endOn;
  const startOn = day(first(raw, "startOn"));
  if (startOn) s.start_on = startOn;
  const name = first(raw, "name", "title", "label");
  if (name) s.name = name;
  const description = first(raw, "description");
  if (description) s.description = description;
  const category = first(raw, "category", "type");
  if (category) s.category = category;
  Object.assign(s, accountOf(raw));
  const created = first(raw, "createdAt", "created");
  if (created) s.created_at = created;
  const contentType = first(raw, "contentType", "mediaType");
  if (contentType) s.content_type = contentType;
  return s;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

export interface DateRange {
  from: string;
  to: string;
  /** What the API is sent: the first of `from`'s month, as the portal sends it. */
  startOn: string;
  /**
   * Whole months from `startOn` through `to`'s month (the portal's "last 6
   * months" is the first of the month six back, `P7M`), plus one month of
   * slack: a statement can be issued after the month it covers, and
   * `inRange` cuts the answer back to what was asked for.
   */
  period: string;
}

/** The longest range one call may ask for. LiveOak keeps about seven years. */
export const MAX_RANGE_MONTHS = 84;

/**
 * `from` and `to` are inclusive calendar days. The default is the last twelve
 * months: from the first of the month a year ago, through today.
 */
export function resolveRange(from: string | undefined, to: string | undefined, now = new Date()): DateRange {
  for (const [name, v] of [["from", from], ["to", to]] as const) {
    if (v !== undefined && (!ISO_DAY.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)))) {
      throw new InputError(`\`${name}\` must be a date as YYYY-MM-DD, e.g. "2026-09-01"; got "${v}".`);
    }
  }
  const today = now.toISOString().slice(0, 10);
  const resolvedTo = to ?? today;
  const resolvedFrom =
    from ?? new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  if (resolvedFrom > resolvedTo) {
    throw new InputError(`\`from\` (${resolvedFrom}) is after \`to\` (${resolvedTo}).`);
  }
  const [fy, fm] = resolvedFrom.split("-").map(Number) as [number, number];
  const [ty, tm] = resolvedTo.split("-").map(Number) as [number, number];
  const months = (ty - fy) * 12 + (tm - fm) + 1;
  if (months > MAX_RANGE_MONTHS) {
    throw new InputError(
      `That range spans ${months} months; one call covers at most ${MAX_RANGE_MONTHS}. Split it.`,
    );
  }
  return {
    from: resolvedFrom,
    to: resolvedTo,
    startOn: new Date(Date.UTC(fy, fm - 1, 1)).toISOString(),
    period: `P${months + 1}M`,
  };
}

/** Keep the statements whose end date falls in the range; one with no date is kept. */
export function inRange(s: Statement, range: DateRange): boolean {
  if (!s.end_on) return true;
  return s.end_on >= range.from && s.end_on <= range.to;
}

/** Newest first, undated last. */
export function byEndDateDesc(a: Statement, b: Statement): number {
  return (b.end_on ?? "").localeCompare(a.end_on ?? "");
}

/** `liveoak-statement-2026-09-30-1234.pdf` — what the download link's file is called. */
export function statementFilename(s: Statement, contentType: string): string {
  const ext = contentType === "application/pdf" ? "pdf" : contentType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
  const parts = ["liveoak-statement", s.end_on, s.account?.replace(/\D/g, "")].filter(
    (p): p is string => !!p,
  );
  return `${parts.join("-")}.${ext}`;
}
