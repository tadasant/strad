/**
 * The five operations this server offers, in BILL's vocabulary rather than
 * HTTP's, and the one piece of real behaviour in the whole tree:
 * `setTransactionCoding`, which does not believe BILL when it says SUCCESS.
 *
 * WHY THERE IS NO `glAccount` ANYWHERE HERE. A Spend & Expense transaction has
 * no native chart-of-accounts field. Coding is carried in `customFields`, and
 * when an accounting integration is connected BILL pulls the chart of accounts
 * in as custom-field VALUES — so "Internet/Phone" is a value on a GL-account
 * custom field, and re-coding a transaction is selecting a different value on
 * that field. There is a `/v3/classifications/*` family that looks like the
 * chart of accounts and is not: those endpoints belong to BILL's AP/AR API and
 * authenticate with a `sessionId` and a `devKey`, neither of which exists here.
 *
 * The consequence for a caller is stated in the tool descriptions and is worth
 * stating once here too: `GET /v3/spend/custom-fields/{id}/values` returns
 * `{uuid, value, deleted, id}` and NOTHING else — no account number, no account
 * type, no link back to the QuickBooks or NetSuite account. An agent gets the
 * display string and can map a merchant to a label; it cannot reason about
 * account structure, because the API does not carry any.
 */

import type { BillHttp } from "./client.js";
import { PAGE_MAX, paginate } from "./client.js";
import {
  AuthError,
  InputError,
  LockedTransactionError,
  RateLimitError,
  WriteNotPersistedError,
  type WriteAttempt,
} from "./errors.js";
import { logWarning } from "./logging.js";
import {
  buildUpdateBody,
  resolveIdentifier,
  selectionMatches,
  unresolvedIdentifier,
  WIRE_VARIANTS,
  type Identifier,
  type SelectedValue,
} from "./wire.js";

// ---------------------------------------------------------------------------
// What BILL returns, narrowed to what this server reads.
// ---------------------------------------------------------------------------

interface RawCustomField {
  id?: string;
  uuid?: string;
  name?: string;
  description?: string;
  type?: string;
  multiSelect?: boolean;
  allowCustomValues?: boolean;
  required?: boolean;
  global?: boolean;
  retired?: boolean;
}

interface RawCustomFieldValue {
  id?: string;
  uuid?: string;
  value?: string;
  deleted?: boolean;
}

interface RawSelectedValue {
  id?: string;
  uuid?: string;
  value?: string;
}

interface RawTransactionCustomField {
  id?: string;
  uuid?: string;
  name?: string;
  note?: string;
  isRequired?: boolean;
  selectedValues?: RawSelectedValue[];
}

interface RawTransaction {
  uuid?: string;
  isLocked?: boolean;
  isReconciled?: boolean;
  complete?: boolean;
  status?: string;
  transactionType?: string;
  merchantName?: string;
  rawMerchantName?: string;
  merchantCategoryCode?: string;
  amount?: number;
  budgetName?: string;
  userName?: string;
  cardLastFour?: string;
  occurredTime?: string;
  updatedTime?: string;
  customFields?: RawTransactionCustomField[];
  accountingIntegrationTransactions?: unknown[];
}

// ---------------------------------------------------------------------------
// What this server returns. Deliberately narrower than BILL's payloads: a
// transaction carries receipts, reviews, reviewers, dispute status and currency
// data that a coding agent has no use for, and every one of them is tokens.
// ---------------------------------------------------------------------------

export interface CodingField {
  id?: string;
  uuid?: string;
  name?: string;
  description?: string;
  type?: string;
  multi_select?: boolean;
  allow_custom_values?: boolean;
  required?: boolean;
  applies_to_all_budgets?: boolean;
  retired?: boolean;
  /** This server's GUESS, and labelled as one everywhere it appears. */
  likely_coding_field: boolean;
}

export interface CodingOption {
  /** Pass THIS to set_transaction_coding. */
  id?: string;
  uuid?: string;
  value?: string;
  retired?: boolean;
}

export interface TransactionSummary {
  uuid?: string;
  occurred_time?: string;
  updated_time?: string;
  amount?: number;
  merchant_name?: string;
  raw_merchant_name?: string;
  merchant_category_code?: string;
  budget_name?: string;
  user_name?: string;
  card_last_four?: string;
  status?: string;
  transaction_type?: string;
  is_locked?: boolean;
  is_reconciled?: boolean;
  /** How many accounting-integration records BILL has exported for it. */
  accounting_exports?: number;
  custom_fields: Array<{
    uuid?: string;
    name?: string;
    selected_values: Array<{ uuid?: string; value?: string }>;
  }>;
}

export interface TransactionCoding {
  transaction_id: string;
  is_locked?: boolean;
  writable: boolean;
  fields: Array<{
    id?: string;
    uuid?: string;
    name?: string;
    note?: string;
    is_required?: boolean;
    selected_values: SelectedValue[];
  }>;
}

export interface CodingWriteResult {
  transaction_id: string;
  field: { id?: string; uuid?: string; name?: string };
  before: SelectedValue[];
  after: SelectedValue[];
  changed: boolean;
  verified: true;
  /** Which body shape actually persisted, or null when no write was needed. */
  wire_variant: string | null;
  /**
   * Whether `wire_variant` is EVIDENCE about which shape BILL honours.
   *
   * False when an identifier's form could not be looked up, so the winning
   * attempt sent bytes whose form nobody knows. The write is no less verified —
   * the read-back is what decides that — but the variant name is not a finding.
   */
  wire_variant_certain?: boolean;
  /**
   * Present only when the write asked for a `note`. BILL accepts `note` on a
   * `NOTE`-type field and ignores it on a `CUSTOM_SELECTOR`, so this is reported
   * BESIDE the value diff rather than folded into it: a coding change that
   * really landed must not be reported as a failure because a note BILL was
   * never going to store did not appear.
   */
  note_persisted?: boolean;
  attempts: WriteAttempt[];
}

// ---------------------------------------------------------------------------

export interface ListFieldsQuery {
  limit: number;
  include_retired: boolean;
  query?: string;
}

export interface ListOptionsQuery {
  field: string;
  limit: number;
  include_retired: boolean;
  query?: string;
}

export interface ListTransactionsQuery {
  limit: number;
  cursor?: string;
  filters: string[];
  sort?: string;
}

export interface SetCodingRequest {
  transaction_id: string;
  field: string;
  value_ids: string[];
  note?: string;
}

export interface BillGateway {
  listCodingFields(
    query: ListFieldsQuery,
  ): Promise<{ fields: CodingField[]; truncated: boolean }>;
  listCodingOptions(
    query: ListOptionsQuery,
  ): Promise<{ options: CodingOption[]; truncated: boolean }>;
  listTransactions(
    query: ListTransactionsQuery,
  ): Promise<{ transactions: TransactionSummary[]; next_cursor?: string }>;
  getTransactionCoding(transactionId: string): Promise<TransactionCoding>;
  setTransactionCoding(request: SetCodingRequest): Promise<CodingWriteResult>;
}

/**
 * Names that suggest a custom field carries the chart of accounts.
 *
 * A HEURISTIC, AND SAID TO BE ONE WHEREVER IT SURFACES. BILL's custom-field
 * `type` enum has exactly two members, `CUSTOM_SELECTOR` and `NOTE`; there is no
 * `GL_ACCOUNT` type and no field anywhere in the payload that says a custom
 * field's values came from an accounting integration rather than from a human
 * typing them. So there is no way to answer "which field is the GL field"
 * correctly from the API, and the choice is between guessing and saying nothing.
 *
 * Guessing, labelled, is more useful than silence — a first call to
 * list_coding_fields on a real company returns a handful of fields and this
 * ranks the likely one first. It is never load-bearing: no tool filters on it,
 * `set_transaction_coding` neither reads nor requires it, and a caller that
 * ignores it entirely loses nothing.
 */
const CODING_FIELD_HINTS =
  /\b(gl|g\/l|general ledger|ledger|chart of accounts|coa|account|accounting|category|categories|expense type|expense account)\b/i;

function likelyCodingField(field: RawCustomField): boolean {
  if (field.type === "NOTE") return false;
  return CODING_FIELD_HINTS.test(field.name ?? "");
}

function toSelectedValue(raw: RawSelectedValue): SelectedValue {
  return {
    ...(raw.id === undefined ? {} : { id: raw.id }),
    ...(raw.uuid === undefined ? {} : { uuid: raw.uuid }),
    ...(raw.value === undefined ? {} : { value: raw.value }),
  };
}

/** Case-insensitive substring, applied locally over what BILL returned. */
function matchesQuery(text: string | undefined, query: string | undefined) {
  if (!query) return true;
  return (text ?? "").toLowerCase().includes(query.toLowerCase());
}

export interface CreateGatewayOptions {
  http: BillHttp;
  /** Injected in tests. Production reads the clock. */
  now?: () => number;
}

/** How long a field's value catalog is reused within one process. */
const CATALOG_TTL_MS = 5 * 60 * 1000;

/** A page walk that stops well short of a rate-limit spike. */
const CATALOG_LIMIT = 1000;

export function createGateway(options: CreateGatewayOptions): BillGateway {
  const { http } = options;
  const now = options.now ?? (() => Date.now());

  /**
   * The winning body shape, remembered for the life of the process.
   *
   * The ladder is only cheap because of this: a sweep pays for it on the first
   * transaction and goes straight to the shape that worked for every one after.
   * It is a HINT and never a shortcut — the read-back still runs on every single
   * write, and a memoised variant that stops working simply loses its attempt
   * and hands over to the rest of the ladder.
   */
  let learnedVariant: string | undefined;

  /**
   * One field's value catalog, so a sweep does not re-read the chart of accounts
   * per transaction. A chart of accounts does not move during a sweep, and the
   * TTL bounds how wrong that assumption can get.
   */
  const catalogs = new Map<
    string,
    { values: SelectedValue[]; truncated: boolean; expires: number }
  >();

  /**
   * A field's values, live or retired.
   *
   * TWO WALKS, NOT ONE, and BILL's filter grammar is why. `retired` is
   * filterable with `eq` and nothing else — there is no `in`, and no way to
   * write "either" — and the parameter defaults to `retired:eq:false`. So
   * "everything" is the union of two queries. Doing it in one and hoping the
   * default meant "all" is how a retired value silently disappears from a
   * catalog that a diff is about to be run against.
   */
  async function fetchValues(
    field: string,
    includeRetired: boolean,
    limit: number,
  ): Promise<{ results: RawCustomFieldValue[]; truncated: boolean }> {
    const path = `/v3/spend/custom-fields/${encodeURIComponent(field)}/values`;
    const live = await paginate<RawCustomFieldValue>(
      http,
      path,
      { filters: "retired:eq:false" },
      limit,
      PAGE_MAX.customFields,
    );
    if (!includeRetired || live.truncated) return live;
    const retired = await paginate<RawCustomFieldValue>(
      http,
      path,
      { filters: "retired:eq:true" },
      limit - live.results.length,
      PAGE_MAX.customFields,
    );
    return {
      results: [...live.results, ...retired.results],
      truncated: retired.truncated,
    };
  }

  /**
   * One field's values, with whether the walk saw ALL of them.
   *
   * `truncated` is carried rather than dropped because the caller uses this to
   * decide that an id does not exist, and a catalog that stopped at its page
   * bound cannot support that conclusion.
   */
  async function valueCatalog(
    field: string,
  ): Promise<{ values: SelectedValue[]; truncated: boolean }> {
    const cached = catalogs.get(field);
    if (cached && cached.expires > now())
      return { values: cached.values, truncated: cached.truncated };
    // Retired values included. A caller coding to one is doing something odd,
    // and refusing it as "no such value" would be the wrong diagnosis for it.
    const { results, truncated } = await fetchValues(field, true, CATALOG_LIMIT);
    const values = results.map(toSelectedValue);
    catalogs.set(field, {
      values,
      truncated,
      expires: now() + CATALOG_TTL_MS,
    });
    return { values, truncated };
  }

  async function readCoding(transactionId: string) {
    const body = await http.request<{
      results?: RawTransactionCustomField[];
    }>(`/v3/spend/transactions/${encodeURIComponent(transactionId)}/custom-fields`);
    return body.results ?? [];
  }

  async function readTransaction(transactionId: string) {
    return http.request<RawTransaction>(
      `/v3/spend/transactions/${encodeURIComponent(transactionId)}`,
    );
  }

  return {
    async listCodingFields(query) {
      // Two walks when retired fields are wanted, for the same reason as
      // `fetchValues`: `retired` is `eq`-only and defaults to false, so
      // "everything" is a union rather than an omitted filter.
      const live = await paginate<RawCustomField>(
        http,
        "/v3/spend/custom-fields",
        { filters: "retired:eq:false" },
        query.limit,
        PAGE_MAX.customFields,
      );
      const retired =
        query.include_retired && !live.truncated
          ? await paginate<RawCustomField>(
              http,
              "/v3/spend/custom-fields",
              { filters: "retired:eq:true" },
              query.limit - live.results.length,
              PAGE_MAX.customFields,
            )
          : { results: [] as RawCustomField[], truncated: live.truncated };
      const results = [...live.results, ...retired.results];
      const truncated = live.truncated || retired.truncated;
      const fields = results
        .filter((f) => matchesQuery(f.name, query.query))
        .map((f) => ({
          ...(f.id === undefined ? {} : { id: f.id }),
          ...(f.uuid === undefined ? {} : { uuid: f.uuid }),
          ...(f.name === undefined ? {} : { name: f.name }),
          ...(f.description === undefined ? {} : { description: f.description }),
          ...(f.type === undefined ? {} : { type: f.type }),
          ...(f.multiSelect === undefined ? {} : { multi_select: f.multiSelect }),
          ...(f.allowCustomValues === undefined
            ? {}
            : { allow_custom_values: f.allowCustomValues }),
          ...(f.required === undefined ? {} : { required: f.required }),
          ...(f.global === undefined ? {} : { applies_to_all_budgets: f.global }),
          ...(f.retired === undefined ? {} : { retired: f.retired }),
          likely_coding_field: likelyCodingField(f),
        }));
      // The guess, surfaced by ORDER as well as by the flag: a first call on a
      // real company should not make a human read twenty rows to find the one.
      fields.sort(
        (a, b) => Number(b.likely_coding_field) - Number(a.likely_coding_field),
      );
      return { fields, truncated };
    },

    async listCodingOptions(query) {
      const { results, truncated } = await fetchValues(
        query.field,
        query.include_retired,
        query.limit,
      );
      const options = results
        .filter((v) => matchesQuery(v.value, query.query))
        .map((v) => ({
          ...(v.id === undefined ? {} : { id: v.id }),
          ...(v.uuid === undefined ? {} : { uuid: v.uuid }),
          ...(v.value === undefined ? {} : { value: v.value }),
          ...(v.deleted === undefined ? {} : { retired: v.deleted }),
        }));
      return { options, truncated };
    },

    async listTransactions(query) {
      // ONE `filters` PARAMETER, COMMA-SEPARATED. BILL's schema is explicit:
      // `filters={field_01}:{op}:{value},{field_02}:{op}:{value}`. Sending
      // several `filters=` parameters instead is the obvious other guess, and it
      // would silently apply only one of them — a sweep that believes it is
      // reading yesterday's transactions and is reading all of them.
      const body = await http.request<{
        results?: RawTransaction[];
        nextPage?: string;
      }>("/v3/spend/transactions", {
        query: {
          max: Math.min(query.limit, PAGE_MAX.transactions),
          ...(query.cursor ? { nextPage: query.cursor } : {}),
          ...(query.filters.length > 0
            ? { filters: query.filters.join(",") }
            : {}),
          ...(query.sort ? { sort: query.sort } : {}),
        },
      });
      const transactions = (body.results ?? []).map((t) => ({
        ...(t.uuid === undefined ? {} : { uuid: t.uuid }),
        ...(t.occurredTime === undefined
          ? {}
          : { occurred_time: t.occurredTime }),
        ...(t.updatedTime === undefined ? {} : { updated_time: t.updatedTime }),
        ...(t.amount === undefined ? {} : { amount: t.amount }),
        ...(t.merchantName === undefined
          ? {}
          : { merchant_name: t.merchantName }),
        ...(t.rawMerchantName === undefined
          ? {}
          : { raw_merchant_name: t.rawMerchantName }),
        ...(t.merchantCategoryCode === undefined
          ? {}
          : { merchant_category_code: t.merchantCategoryCode }),
        ...(t.budgetName === undefined ? {} : { budget_name: t.budgetName }),
        ...(t.userName === undefined ? {} : { user_name: t.userName }),
        ...(t.cardLastFour === undefined
          ? {}
          : { card_last_four: t.cardLastFour }),
        ...(t.status === undefined ? {} : { status: t.status }),
        ...(t.transactionType === undefined
          ? {}
          : { transaction_type: t.transactionType }),
        ...(t.isLocked === undefined ? {} : { is_locked: t.isLocked }),
        ...(t.isReconciled === undefined
          ? {}
          : { is_reconciled: t.isReconciled }),
        ...(t.accountingIntegrationTransactions === undefined
          ? {}
          : {
              accounting_exports: t.accountingIntegrationTransactions.length,
            }),
        // uuid ONLY, because that is all BILL puts in an embedded transaction's
        // customFields. It is deliberately not renamed to `id` here: a caller
        // that writes straight from this result would be writing the form the
        // ladder in wire.ts exists because of.
        custom_fields: (t.customFields ?? []).map((f) => ({
          ...(f.uuid === undefined ? {} : { uuid: f.uuid }),
          ...(f.name === undefined ? {} : { name: f.name }),
          selected_values: (f.selectedValues ?? []).map((v) => ({
            ...(v.uuid === undefined ? {} : { uuid: v.uuid }),
            ...(v.value === undefined ? {} : { value: v.value }),
          })),
        })),
      }));
      return {
        transactions,
        ...(body.nextPage ? { next_cursor: body.nextPage } : {}),
      };
    },

    async getTransactionCoding(transactionId) {
      // TWO CALLS, and the second one is the point. The custom-fields endpoint
      // carries the coding and says nothing about whether the transaction will
      // accept a change; `isLocked` lives on the transaction itself. A read that
      // answered "here is the coding" without "and you cannot change it" would
      // send a caller into a write it was always going to be refused.
      const [transaction, results] = await Promise.all([
        readTransaction(transactionId),
        readCoding(transactionId),
      ]);
      return {
        transaction_id: transactionId,
        ...(transaction.isLocked === undefined
          ? {}
          : { is_locked: transaction.isLocked }),
        writable: transaction.isLocked !== true,
        fields: results.map((f) => ({
          ...(f.id === undefined ? {} : { id: f.id }),
          ...(f.uuid === undefined ? {} : { uuid: f.uuid }),
          ...(f.name === undefined ? {} : { name: f.name }),
          ...(f.note === undefined ? {} : { note: f.note }),
          ...(f.isRequired === undefined ? {} : { is_required: f.isRequired }),
          selected_values: (f.selectedValues ?? []).map(toSelectedValue),
        })),
      };
    },

    async setTransactionCoding(request) {
      const { transaction_id: txId, field: fieldRef, value_ids: valueIds } = request;

      // 1. LOCK FIRST. Documented as a hard refusal on BILL's side, and the one
      //    pre-condition that costs a single call to check. Everything else this
      //    function does is designed around not trusting a 200; this is the one
      //    failure it can rule out before spending a write.
      const transaction = await readTransaction(txId);
      if (transaction.isLocked === true) throw new LockedTransactionError(txId);

      // 2. THE BEFORE STATE, from the endpoint that returns BOTH identifier
      //    forms. This is where the field's `id` comes from — `list_transactions`
      //    only ever carries its `uuid`.
      const before = await readCoding(txId);
      const target = before.find(
        (f) => f.id === fieldRef || f.uuid === fieldRef,
      );

      const field: Identifier = target
        ? {
            ...(target.id === undefined ? {} : { id: target.id }),
            ...(target.uuid === undefined ? {} : { uuid: target.uuid }),
            resolved: true,
          }
        : // A field the transaction does not currently list is not necessarily a
          // mistake — an untagged optional field can be absent — so the caller's
          // own reference goes in both slots so a write is still possible, and
          // `resolved: false` records that nothing here knows which form it is.
          unresolvedIdentifier(fieldRef);

      if (!target) {
        // Said out loud rather than swallowed: the likeliest reason a field is
        // absent from a transaction is that it does not apply to that
        // transaction's budget, and that is a write BILL will answer SUCCESS to
        // and drop.
        logWarning(
          `transaction ${txId} does not currently list custom field ` +
            `${fieldRef}; a write to a field that does not apply to the ` +
            `transaction's budget is accepted and discarded`,
        );
      }

      /**
       * Does one read-back entry name the field this write is about?
       *
       * GUARDED ON BOTH SIDES, and that is not defensive spelling. `id` is
       * OPTIONAL on BILL's payload, so a bare `f.id === field.id` is
       * `undefined === undefined` — true — for the FIRST field in the list
       * whenever neither carries an `id`. The read-back would then diff the
       * wrong field's values, and a write BILL discarded could come back
       * `verified: true`. That is the exact failure this whole function exists
       * to prevent, reintroduced by a two-character omission, so the same
       * guard `selectionMatches` uses lives here too.
       */
      const namesTarget = (f: { id?: string; uuid?: string }): boolean =>
        (field.id !== undefined && f.id === field.id) ||
        (field.uuid !== undefined && f.uuid === field.uuid);

      const beforeValues = (target?.selectedValues ?? []).map(toSelectedValue);

      // 3. RESOLVE EVERY VALUE TO BOTH FORMS, against the field's own catalog.
      //    Two things happen here, and the second matters more: the ladder gets
      //    honest `id` and `uuid` strings to send instead of a guess about which
      //    form the caller pasted, AND an identifier that belongs to no value of
      //    this field is refused now, by name, rather than becoming three
      //    attempts and a `WriteNotPersistedError`. A wrong value id is the
      //    likeliest real cause of a write BILL discards.
      const desired: Identifier[] = [];
      if (valueIds.length > 0) {
        const catalog = await valueCatalog(fieldRef);
        const unknown: string[] = [];
        for (const raw of valueIds) {
          const resolved = resolveIdentifier(raw, catalog.values);
          if (resolved) desired.push(resolved);
          // A TRUNCATED CATALOG CANNOT CONVICT. `fetchValues` stops at its page
          // bound, so on a chart of accounts longer than that bound an id can be
          // perfectly valid and simply not in the pages we read. Refusing it
          // would block a correct write on this server's own budget, so the
          // string goes through unresolved instead and the read-back — which is
          // the real safety net — decides. Only a COMPLETE catalog is evidence
          // that an id does not exist.
          else if (catalog.truncated) desired.push(unresolvedIdentifier(raw));
          else unknown.push(raw);
        }
        if (unknown.length > 0) {
          throw new InputError(
            `${unknown.length} of the ${valueIds.length} value id(s) given ` +
              `(${unknown.join(", ")}) belong to no value of custom field ` +
              `"${target?.name ?? fieldRef}" — BILL's catalog for that field ` +
              `holds ${catalog.values.length} value(s) and none of them has ` +
              `that id or uuid. Nothing was written. Call list_coding_options ` +
              `with field="${fieldRef}" and pass the \`id\` it returns; an id ` +
              `from a DIFFERENT custom field is accepted by the write endpoint ` +
              `and then discarded.`,
          );
        }
      }

      // DEDUPED, because `selectionMatches` compares SIZES and BILL stores a
      // set. The same value passed twice — trivially, its `id` and its `uuid`,
      // both of which list_coding_options returns — would ask for two entries,
      // get the one BILL actually stores back, and be reported as a write that
      // did not land when it did.
      const seen = new Set<string>();
      const wanted = desired.filter((d) => {
        const key = d.uuid ?? d.id ?? "";
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // 4. ALREADY THERE? Then there is nothing to write, and saying so is more
      //    honest than sending a PUT so the result can carry a variant name. A
      //    sweep that re-runs over transactions it already coded should cost
      //    reads, not writes.
      if (selectionMatches(wanted, beforeValues) && request.note === undefined) {
        return {
          transaction_id: txId,
          field: {
            ...identifierOf(field),
            ...(target?.name === undefined ? {} : { name: target.name }),
          },
          before: beforeValues,
          after: beforeValues,
          changed: false,
          verified: true,
          wire_variant: null,
          attempts: [],
        };
      }

      // Whether the winning variant will be EVIDENCE. A variant that sent an
      // identifier whose form nobody looked up proves nothing about which shape
      // BILL honours, so it is reported as uncertain and never memoised.
      const formsCertain =
        field.resolved !== false && wanted.every((d) => d.resolved !== false);

      // 5. THE LADDER. Each variant is a PUT followed by a re-read and a diff.
      //    Nothing here treats BILL's `{"status":"SUCCESS"}` as evidence.
      const ordered = [...WIRE_VARIANTS].sort(
        (a, b) =>
          Number(b.name === learnedVariant) - Number(a.name === learnedVariant),
      );
      const attempts: WriteAttempt[] = [];

      for (const variant of ordered) {
        const body = buildUpdateBody(variant, field, wanted, request.note);
        if (!body) continue;

        let httpStatus = 200;
        let reportedStatus: string | undefined;
        try {
          const reply = await http.request<{ status?: string }>(
            `/v3/spend/transactions/${encodeURIComponent(txId)}/custom-fields`,
            { method: "PUT", body },
          );
          reportedStatus = reply?.status;
        } catch (err) {
          // A BODY-SHAPED REFUSAL IS INFORMATION, NOT THE END: it is the loud
          // case, and the next shape in the ladder is exactly what it argues
          // for. A failure that is NOT about the body is a different thing, and
          // walking the ladder through one would spend three calls and then
          // blame the value ids in a `WriteNotPersistedError` for what was
          // really a dead token or a spent rate-limit budget. So those two are
          // rethrown with their own diagnosis intact.
          if (err instanceof AuthError || err instanceof RateLimitError) throw err;
          httpStatus = errorStatus(err);
          if (httpStatus === 0) throw err;
        }

        const after = await readCoding(txId);
        const observedField = after.find(namesTarget);
        const observed = (observedField?.selectedValues ?? []).map(
          toSelectedValue,
        );
        // THE VALUE DIFF IS THE VERDICT, and the note is reported beside it.
        //
        // They travel in the same array item, so it is tempting to require both
        // — but BILL accepts `note` only on a `NOTE`-type field and ignores it
        // on a `CUSTOM_SELECTOR`, which is the ordinary case here. Folding it in
        // would mean a transaction that really was re-coded coming back as
        // `WriteNotPersistedError`, telling a caller to treat it as UNCODED when
        // the ledger had in fact changed. That is a worse lie than the one this
        // function is guarding against, in the opposite direction.
        const persisted = selectionMatches(wanted, observed);
        const notePersisted =
          request.note === undefined
            ? undefined
            : observedField?.note === request.note;

        attempts.push({
          variant: variant.name,
          fieldKey: variant.fieldKey,
          valueForm: variant.valueForm,
          formsCertain,
          httpStatus,
          ...(reportedStatus === undefined ? {} : { reportedStatus }),
          observedAfter: observed.map((v) => v.value ?? v.uuid ?? v.id ?? "?"),
          ...(request.note === undefined
            ? {}
            : { observedNote: observedField?.note ?? "" }),
          persisted,
        });

        if (persisted) {
          // MEMOISED ONLY WHEN IT MEANS SOMETHING. A variant that won while
          // sending an identifier of unknown form is not a finding about BILL,
          // and pinning the next sweep to it would be building on a guess.
          if (formsCertain) learnedVariant = variant.name;
          return {
            transaction_id: txId,
            field: {
              ...identifierOf(field),
              ...(target?.name === undefined ? {} : { name: target.name }),
            },
            before: beforeValues,
            after: observed,
            changed: true,
            verified: true,
            wire_variant: variant.name,
            wire_variant_certain: formsCertain,
            ...(notePersisted === undefined
              ? {}
              : { note_persisted: notePersisted }),
            attempts,
          };
        }
      }

      // Every shape tried, every one read back, none of them changed anything.
      // A memoised variant that stopped working must not keep being tried first
      // forever.
      learnedVariant = undefined;
      throw new WriteNotPersistedError(txId, attempts);
    },
  };
}

/** An identifier as a RESULT carries it — the two forms, without the bookkeeping. */
function identifierOf(field: Identifier): { id?: string; uuid?: string } {
  return {
    ...(field.id === undefined ? {} : { id: field.id }),
    ...(field.uuid === undefined ? {} : { uuid: field.uuid }),
  };
}

/** The HTTP status carried by a `BillApiError`, or 0 for anything else. */
function errorStatus(err: unknown): number {
  const status = (err as { status?: unknown })?.status;
  return typeof status === "number" ? status : 0;
}

