import {
  isSupportedCountry,
  parsePhoneNumberFromString,
} from "libphonenumber-js/min";

import { records, type QueryResult } from "./chatdb.js";

/**
 * Names for the phone numbers and emails chat.db holds, from the owner's
 * Contacts, so a message leaves the Mac with its sender's name beside the raw
 * handle.
 *
 * Contacts keeps a Core Data SQLite file per account under
 * `~/Library/Application Support/AddressBook` (the top-level
 * `AddressBook-v22.abcddb`, and one per `Sources/<id>/`). The helper finds
 * them and reads them under the Full Disk Access it already holds
 * (`hostd/messages/Sources/strad-hostd-messages/Contacts.swift`); the SQL is
 * here, where `test/contacts.test.ts` and `test/messages.test.ts` run it
 * against fixture databases.
 *
 * The whole book is read into one index and kept for `ttlMs`, so a page of
 * 200 messages is 200 map lookups, not 200 database opens.
 */

/** A query against one Contacts source, by the id the helper enumerated. */
export type ContactsQueryFn = (
  source: string,
  sql: string,
  params: (string | number | null)[],
) => Promise<QueryResult>;

/** What the helper's `contacts_sources` op answers. */
export interface ContactsSources {
  state: "readable" | "denied" | "missing" | "error";
  /** ISO 3166 region of the Mac, for a number written without a country code. */
  region?: string;
  sources: string[];
  error?: string;
}

/** One person, as the index needs them: a name and the handles that reach them. */
export interface ContactCard {
  name: string;
  phones: string[];
  emails: string[];
}

/** A lowercased, trimmed email; undefined for anything that is not one. */
export function normalizeEmail(raw: string): string | undefined {
  const s = raw
    .trim()
    .replace(/^mailto:/i, "")
    .toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(s) ? s : undefined;
}

/**
 * What a phone number is matched on.
 *
 * `e164` is the number in E.164 (`+447700900123`), with `region` supplying the
 * country code when the number has none. It is the match.
 *
 * `national` is the number without any country code (`7700900123`), and is
 * set only when the input had no country code AND is not a valid number in
 * the Mac's region. It is the fallback for a contact saved in another
 * country's local form — `07700 900123` on a Mac set to the US — whose E.164
 * under the Mac's region is wrong. A valid domestic number never gets one, so
 * a foreign handle with the same digits is not given a domestic contact's
 * name.
 *
 * Fewer than seven digits (a short code) gets neither key: those are matched
 * by nobody.
 */
export function phoneKeys(
  raw: string,
  region?: string,
): { e164?: string; national?: string } {
  const trimmed = raw.trim();
  if (trimmed.includes("@")) return {};
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 3) return {};
  // `00` is the international prefix most of the world dials; a number saved
  // with it carries its country code, whatever the Mac's region says.
  const international = trimmed.startsWith("+") || /^00[1-9]/.test(digits);
  const text = trimmed.startsWith("+")
    ? trimmed
    : international
      ? `+${digits.slice(2)}`
      : trimmed;
  const parsed = parsePhoneNumberFromString(
    text,
    region && isSupportedCountry(region)
      ? { defaultCountry: region }
      : undefined,
  );
  const out: { e164?: string; national?: string } = {};
  const possible = parsed?.isPossible() ? parsed : undefined;
  if (possible) out.e164 = possible.number;
  if (!international && !possible?.isValid()) {
    // A country code the parser found anyway (`1 555…` under US) still came
    // from the input; strip it via the parse when there is one.
    const national = possible?.nationalNumber ?? digits.replace(/^0+/, "");
    if (national.length >= 7) out.national = national;
  }
  return out;
}

/**
 * Handle → name. A handle that more than one name claims (a shared landline,
 * the same person saved twice with different spellings) takes the name the
 * most cards give it, then the alphabetically first, so the answer does not
 * depend on read order.
 */
export class ContactIndex {
  private readonly emails = new Map<string, Map<string, number>>();
  private readonly e164 = new Map<string, Map<string, number>>();
  private readonly national = new Map<string, Map<string, number>>();

  constructor(
    cards: ContactCard[],
    private readonly region?: string,
  ) {
    for (const card of cards) {
      // One vote per card per key, however many times the card lists it.
      const seen = new Set<string>();
      const add = (map: Map<string, Map<string, number>>, key: string) => {
        const tag = `${map === this.emails ? "e" : map === this.e164 ? "p" : "n"}:${key}`;
        if (seen.has(tag)) return;
        seen.add(tag);
        const names = map.get(key) ?? new Map<string, number>();
        names.set(card.name, (names.get(card.name) ?? 0) + 1);
        map.set(key, names);
      };
      for (const e of card.emails) {
        const key = normalizeEmail(e);
        if (key) add(this.emails, key);
      }
      for (const p of card.phones) {
        const keys = phoneKeys(p, region);
        if (keys.e164) add(this.e164, keys.e164);
        if (keys.national) add(this.national, keys.national);
      }
    }
  }

  /** The name for a chat.db handle, or null when no contact has it. */
  lookup(handle: string | null | undefined): string | null {
    if (!handle) return null;
    if (handle.includes("@")) {
      const key = normalizeEmail(handle);
      return key ? pick(this.emails.get(key)) : null;
    }
    const keys = phoneKeys(handle, this.region);
    const exact = keys.e164 ? pick(this.e164.get(keys.e164)) : null;
    if (exact) return exact;
    // A contact saved without a country code, against a handle that has one:
    // match on the national number, but only when exactly one name claims it,
    // since the same national digits exist in every country.
    if (keys.e164) {
      const parsed = parsePhoneNumberFromString(keys.e164);
      const names = parsed && this.national.get(parsed.nationalNumber);
      if (names && names.size === 1) return [...names.keys()][0]!;
    }
    return null;
  }
}

function pick(names: Map<string, number> | undefined): string | null {
  if (!names || names.size === 0) return null;
  return (
    [...names.entries()].sort(
      ([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0),
    )[0]?.[0] ?? null
  );
}

/** The name Contacts shows for a card: given and family name, else nickname, else company. */
export function displayName(r: Record<string, unknown>): string | null {
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const person = [s(r.first), s(r.middle), s(r.last)].filter(Boolean).join(" ");
  return person || s(r.nickname) || s(r.organization) || null;
}

/** Columns of `ZABCDRECORD` read when present, NULL otherwise. */
const NAME_COLUMNS: [string, string][] = [
  ["ZFIRSTNAME", "first"],
  ["ZMIDDLENAME", "middle"],
  ["ZLASTNAME", "last"],
  ["ZNICKNAME", "nickname"],
  ["ZORGANIZATION", "organization"],
];

/** Rows per page of one source's phones or emails. */
const PAGE = 2000;

/**
 * Every card in one source. Phones and emails are each read in Z_PK pages,
 * so a large book never meets the helper's per-query row ceiling.
 */
export async function readSource(
  query: ContactsQueryFn,
  source: string,
): Promise<ContactCard[]> {
  const have = new Set(
    (
      await query(
        source,
        "SELECT name FROM pragma_table_info('ZABCDRECORD')",
        [],
      )
    ).rows.map((row) => String(row[0])),
  );
  const names = NAME_COLUMNS.map(([col, as]) =>
    have.has(col) ? `r.${col} AS ${as}` : `NULL AS ${as}`,
  ).join(", ");
  const cards = new Map<number, ContactCard>();
  const read = async (
    table: string,
    column: string,
    into: "phones" | "emails",
  ) => {
    let after = 0;
    for (;;) {
      const rows = records(
        await query(
          source,
          `SELECT v.Z_PK AS pk, v.${column} AS value, r.Z_PK AS person, ${names} ` +
            `FROM ${table} v JOIN ZABCDRECORD r ON r.Z_PK = v.ZOWNER ` +
            `WHERE v.Z_PK > ? AND v.${column} IS NOT NULL ORDER BY v.Z_PK LIMIT ?`,
          [after, PAGE],
        ),
      );
      for (const row of rows) {
        const name = displayName(row);
        if (!name || typeof row.value !== "string") continue;
        const person = Number(row.person);
        const card = cards.get(person) ?? { name, phones: [], emails: [] };
        card[into].push(row.value);
        cards.set(person, card);
      }
      if (rows.length < PAGE) return;
      after = Number(rows.at(-1)!.pk);
    }
  };
  await read("ZABCDPHONENUMBER", "ZFULLNUMBER", "phones");
  await read("ZABCDEMAILADDRESS", "ZADDRESS", "emails");
  return [...cards.values()];
}

/**
 * The index, read once and kept for `ttlMs`. Names are best-effort: a book
 * the helper cannot read is an index with nothing in it and a `warning`,
 * never a failed read of the messages themselves. A refresh that fails keeps
 * serving the last index it built.
 */
export class ContactsCache {
  private index?: ContactIndex;
  private warning?: string;
  private loadedAt = -Infinity;
  private loading?: Promise<void>;

  constructor(
    private readonly opts: {
      sources: () => Promise<ContactsSources>;
      query: ContactsQueryFn;
      ttlMs: number;
      /** How long a failed read waits before it is tried again. */
      retryMs: number;
      now?: () => number;
    },
  ) {}

  async get(): Promise<{ index: ContactIndex; warning?: string }> {
    const now = (this.opts.now ?? Date.now)();
    const age = now - this.loadedAt;
    const fresh = this.warning
      ? age < this.opts.retryMs
      : age < this.opts.ttlMs;
    if (!fresh) {
      this.loading ??= this.load().finally(() => (this.loading = undefined));
      await this.loading;
    }
    return {
      index: this.index ?? new ContactIndex([]),
      ...(this.warning ? { warning: this.warning } : {}),
    };
  }

  private async load(): Promise<void> {
    try {
      const found = await this.opts.sources();
      if (found.state !== "readable") {
        throw new Error(
          found.state === "denied"
            ? "strad-hostd-messages cannot read Contacts: it needs Full Disk Access"
            : found.state === "missing"
              ? "this Mac has no Contacts databases"
              : `cannot read Contacts: ${found.error ?? "unknown error"}`,
        );
      }
      // One account's database that will not read (locked mid-sync, or a
      // schema this code does not know) costs that account's names, not
      // everyone's.
      const cards: ContactCard[] = [];
      const failed: string[] = [];
      for (const source of found.sources) {
        try {
          cards.push(...(await readSource(this.opts.query, source)));
        } catch (err) {
          failed.push((err as Error).message);
        }
      }
      if (found.sources.length > 0 && failed.length === found.sources.length)
        throw new Error(failed[0]);
      this.index = new ContactIndex(cards, found.region);
      this.warning = failed.length
        ? `${failed.length} of ${found.sources.length} Contacts databases could not be read, so some names may be missing: ${failed[0]}`
        : undefined;
    } catch (err) {
      // A re-read that fails keeps the names the last one found, and says so.
      this.warning = this.index
        ? `Contacts could not be re-read, so names are from an earlier read and may be out of date: ${(err as Error).message}`
        : `contact names unavailable: ${(err as Error).message}`;
    }
    // A partial read is retried as soon as a failed one.
    this.loadedAt = (this.opts.now ?? Date.now)();
  }
}
