/**
 * THE SHAPE OF THE WRITE, and why there is more than one of it.
 *
 * `PUT /v3/spend/transactions/{transactionId}/custom-fields` is the only tool in
 * this server that changes anything, and it is the one endpoint whose contract
 * BILL states twice, differently:
 *
 *   - The API reference says the array items are
 *     `{customFieldId, selectedValues[], note}`, and that `selectedValues` takes
 *     "the custom field value ID or UUID values".
 *     https://developer.bill.com/reference/updatetransactioncustomfields
 *
 *   - The Transactions guide's worked example says `customFieldUuid`.
 *     https://developer.bill.com/docs/transaction-management
 *
 * Both were read against the live documentation while this was written. They
 * disagree about the KEY NAME, and there is no third document that settles it.
 *
 * That would be an annoyance and not a hazard, except for what happens when the
 * body is wrong: the endpoint answers **HTTP 200 `{"status":"SUCCESS"}` and
 * discards the update**. A community implementer who actually called it reports
 * that the `tty_…` / `tvl_…` UUID forms BILL's own GETs hand back are "silently
 * rejected (the API returns SUCCESS but the update is dropped)", and that only
 * the base64 `id` form writes. That report is UNVERIFIED — one developer's field
 * note, not BILL documentation — but BILL contradicting itself corroborates that
 * the endpoint is finicky, and the failure mode is the worst one available for
 * an agent working unattended on someone's books: forty transactions reported
 * re-coded, none of them changed.
 *
 * So this module does not pick a shape. It ENUMERATES them, in the order most
 * likely to work, and `setTransactionCoding` in gateway.ts tries them one at a
 * time and RE-READS THE TRANSACTION AFTER EACH ONE. Nothing here decides that a
 * write succeeded; only the read-back does. A variant that BILL answers 200 to
 * and that changes nothing is a failed variant, and the next one is tried.
 *
 * THE LADDER IS CHEAP IN THE STEADY STATE. The first variant is the one the
 * community report says works, callers are told to pass the `id` form
 * (list_coding_options returns it beside the uuid for exactly this reason), and
 * the winning variant is memoised for the life of the process — so a sweep pays
 * for the ladder once and two calls per transaction after that. It is also
 * SAFE to walk: every attempt is the same idempotent PUT of the same desired
 * state, so an attempt that does nothing costs a call and changes nothing else.
 *
 * WHEN BILL SETTLES ITS OWN DOCUMENTATION, this file is where the answer goes —
 * delete the variants that never win. Until then the ladder is the honest
 * encoding of what is actually known, and `variant` comes back in every
 * successful result so which one works stops being a guess.
 */

/** The two names BILL's two documents give the same field. */
export type FieldKey = "customFieldId" | "customFieldUuid";

/** The two identifier forms BILL hands out for one custom field or value. */
export type IdForm = "id" | "uuid";

/**
 * A custom field or one of its values, in whichever forms are known.
 *
 * Both are usually available: `GET /v3/spend/transactions/{id}/custom-fields`
 * and `GET /v3/spend/custom-fields/{id}/values` each return `id` AND `uuid`.
 * `GET /v3/spend/transactions` is the exception — its embedded `customFields`
 * carry `uuid` only — which is exactly why a caller who lists transactions and
 * writes straight from that result would be writing the form the community
 * report says is dropped.
 */
export interface Identifier {
  id?: string;
  uuid?: string;
  /**
   * FALSE when this server could not learn which form the string is.
   *
   * A caller passes one opaque string per value and BILL hands `id` and `uuid`
   * back from different endpoints, so normally both forms are LOOKED UP (see
   * `resolveIdentifier`) and this is true. When the lookup is impossible — a
   * field the transaction does not currently list, or a value catalog that hit
   * its page bound — the string goes in both slots so a write is still possible,
   * and this says so.
   *
   * It is not cosmetic: a variant that "used" an unresolved identifier sent
   * bytes whose form nobody knows, so it is evidence about nothing. The caller
   * gets `wire_variant_certain: false` and the winning variant is NOT memoised,
   * because the whole value of the memo is that it names a shape that was
   * observed to work.
   */
  resolved?: boolean;
}

export interface WireVariant {
  /** What a result calls it: `<fieldKey>/<valueForm>`. */
  name: string;
  fieldKey: FieldKey;
  /** Which form of the FIELD identifier goes in `fieldKey`. */
  fieldForm: IdForm;
  /** Which form of the VALUE identifiers goes in `selectedValues`. */
  valueForm: IdForm;
}

/**
 * Every body shape this server knows how to send, best first.
 *
 * The order is the argument:
 *
 *   1. `customFieldId` + base64 `id` values — the reference's key name and the
 *      only value form anyone has reported actually persisting.
 *   2. `customFieldId` + `uuid` values — the reference's key name, and the value
 *      form the reference itself says is accepted. If the community report is
 *      wrong, this is what works.
 *   3. `customFieldUuid` + `uuid` values — the Transactions guide's worked
 *      example, verbatim. Last because a key name the reference does not list is
 *      the likeliest one to be ignored outright.
 *
 * `selectedValues` is an ARRAY in every variant, because both BILL documents
 * agree on that much and the same community report that flagged the id form also
 * claimed a bare string — the one claim the documentation actively contradicts
 * twice. A multi-select field needs an array regardless.
 */
export const WIRE_VARIANTS: readonly WireVariant[] = [
  {
    name: "customFieldId/id",
    fieldKey: "customFieldId",
    fieldForm: "id",
    valueForm: "id",
  },
  {
    name: "customFieldId/uuid",
    fieldKey: "customFieldId",
    fieldForm: "uuid",
    valueForm: "uuid",
  },
  {
    name: "customFieldUuid/uuid",
    fieldKey: "customFieldUuid",
    fieldForm: "uuid",
    valueForm: "uuid",
  },
];

export interface UpdateBody {
  customFields: Array<Record<string, unknown>>;
}

/**
 * One variant's request body, or `null` when this deployment does not hold the
 * identifier forms that variant needs.
 *
 * Null rather than a throw, and rather than a silent substitution of the other
 * form. Substituting is what would make the ladder a lie — an attempt logged as
 * `customFieldId/id` that actually sent uuids proves nothing about which form
 * works, which is the one question the ladder exists to answer.
 */
export function buildUpdateBody(
  variant: WireVariant,
  field: Identifier,
  values: Identifier[],
  note?: string,
): UpdateBody | null {
  const fieldIdentifier = field[variant.fieldForm];
  if (!fieldIdentifier) return null;

  const selectedValues: string[] = [];
  for (const value of values) {
    const identifier = value[variant.valueForm];
    if (!identifier) return null;
    selectedValues.push(identifier);
  }

  return {
    customFields: [
      {
        [variant.fieldKey]: fieldIdentifier,
        // ALWAYS PRESENT, including when empty. BILL documents the empty array
        // as the way to clear a field's selected values, so omitting it for an
        // empty selection would turn "clear this coding" into "change nothing"
        // — and the endpoint would answer SUCCESS to that too.
        selectedValues,
        ...(note === undefined ? {} : { note }),
      },
    ],
  };
}

/** One value as the transaction currently carries it. */
export interface SelectedValue {
  id?: string;
  uuid?: string;
  value?: string;
}

/**
 * Does what the transaction now carries match what the caller asked for?
 *
 * THE DIFF IS WHAT MAKES A SUCCESS REAL, so it is deliberately strict in both
 * directions: every desired identifier must be present, and nothing else may be.
 * A partial write — two of three values landing — is a wrong answer on a ledger,
 * not a warning.
 *
 * An identifier matches an observed value on EITHER form, because the caller may
 * legitimately hold only one of them and the read-back returns both. Matching on
 * the display string as well would be a mistake: two chart-of-accounts entries
 * can share a label, and this comparison is what stands between "coded" and
 * "coded as something else".
 */
export function selectionMatches(
  desired: Identifier[],
  observed: SelectedValue[],
): boolean {
  if (desired.length !== observed.length) return false;
  const remaining = [...observed];
  for (const want of desired) {
    const index = remaining.findIndex(
      (o) =>
        (want.id !== undefined && o.id === want.id) ||
        (want.uuid !== undefined && o.uuid === want.uuid),
    );
    if (index === -1) return false;
    remaining.splice(index, 1);
  }
  return remaining.length === 0;
}

/**
 * Turn one string a caller passed into both of its identifier forms, using a
 * catalog read from BILL. `null` when the catalog does not contain it.
 *
 * A caller passes one string per value and this server cannot tell which form it
 * is — `id` and `uuid` are both opaque, and a guess that lands on the wrong
 * branch of the ladder is precisely the silent failure everything here exists to
 * prevent. So the forms are LOOKED UP rather than inferred, against the field's
 * own value list.
 *
 * That the lookup can FAIL is the more valuable half. An identifier that belongs
 * to no value of this field is the likeliest real cause of a write that BILL
 * answers 200 to and drops — a value id copied from the wrong field, or a `uuid`
 * scraped out of a `list_transactions` result for a different field. Catching it
 * here turns that into a refusal that names the fix, before a PUT is sent,
 * instead of three attempts and a `WriteNotPersistedError`.
 */
export function resolveIdentifier(
  raw: string,
  catalog: readonly SelectedValue[],
): Identifier | null {
  const match = catalog.find((k) => k.id === raw || k.uuid === raw);
  if (!match) return null;
  return {
    ...(match.id === undefined ? {} : { id: match.id }),
    ...(match.uuid === undefined ? {} : { uuid: match.uuid }),
    resolved: true,
  };
}

/**
 * The identifier for a string whose form could not be looked up.
 *
 * Both slots, so every variant can still build a body and the read-back still
 * decides — and `resolved: false`, so nothing downstream mistakes the attempt
 * that happened to land for evidence about which form BILL honours.
 */
export function unresolvedIdentifier(raw: string): Identifier {
  return { id: raw, uuid: raw, resolved: false };
}
