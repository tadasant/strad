/**
 * THE SHAPE OF THE WRITE, and why there is still more than one of it.
 *
 * `PUT /v3/spend/transactions/{transactionId}/custom-fields` is the only tool in
 * this server that changes anything, and BILL states its contract twice,
 * differently:
 *
 *   - The API reference says the array items are
 *     `{customFieldId, selectedValues[], note}`, and that `selectedValues` takes
 *     "the custom field value ID or UUID values".
 *     https://developer.bill.com/reference/updatetransactioncustomfields
 *
 *   - The Transactions guide's worked example says `customFieldUuid`.
 *     https://developer.bill.com/docs/transaction-management
 *
 * THE ENDPOINT SETTLED IT. Every shape below and several that are not below were
 * sent to a live BILL sandbox company, each followed by a read-back:
 *
 *   - `customFieldUuid` is a HARD 400 — `customFieldId: must not be null`. The
 *     Transactions guide's example does not work and is not in the ladder.
 *   - `customFieldId` accepts BOTH forms: the base64 `id` and the `tty_…` uuid.
 *   - `selectedValues` accepts BOTH forms too, and the two mixed in one body.
 *
 * So the community field note this ladder was built around — that the `tty_…` /
 * `tvl_…` uuid forms BILL's own GETs hand back are "silently rejected (the API
 * returns SUCCESS but the update is dropped)" — is FALSE. Every uuid form
 * persisted. The claim is recorded here because it shaped the design and because
 * a reader will find it again; it is not evidence about this API.
 *
 * WHAT IS TRUE IS THE FAILURE MODE ITSELF, and it was reproduced. Send two
 * values to a `multiSelect: false` field and BILL answers **HTTP 200
 * `{"status":"SUCCESS"}` and does nothing at all** — the field comes back
 * exactly as it was. Probed across an empty field, a coded one, two values,
 * three, and a list containing the value already selected: every one SUCCESS,
 * every one discarded whole. No error, no warning, and an agent that believed
 * the reply would report a transaction re-coded that is still coded the way it
 * was last month. That is what `setTransactionCoding` re-reads to catch, and it
 * is why nothing here treats a 200 as evidence.
 *
 * SO THE LADDER STAYS, AT TWO RUNGS, and the reason is no longer BILL's
 * documentation — it is which identifier forms a caller happens to hold.
 * `buildUpdateBody` returns null when a variant needs a form this deployment
 * does not have, so `customFieldId/uuid` is what writes when only uuids are on
 * hand (a field read out of a `list_transactions` result carries no `id`).
 * Both rungs are proven; the `id` rung is first because it is the form
 * `list_coding_options` returns and the tool descriptions tell callers to pass.
 *
 * `setTransactionCoding` in gateway.ts tries a rung and RE-READS THE TRANSACTION
 * AFTER IT. Nothing here decides that a write succeeded; only the read-back
 * does. A rung that BILL answers 200 to and that moves nothing is a failed rung,
 * and the next one is tried. The winning rung is memoised for the life of the
 * process, so a sweep pays for the ladder once and two calls per transaction
 * after that — and walking it is SAFE, because every attempt is the same
 * idempotent PUT of the same desired state.
 */

/** The one key name BILL's write endpoint accepts. `customFieldUuid` is a 400. */
export type FieldKey = "customFieldId";

/** The two identifier forms BILL hands out for one custom field or value. */
export type IdForm = "id" | "uuid";

/**
 * A custom field or one of its values, in whichever forms are known.
 *
 * Both are usually available: `GET /v3/spend/transactions/{id}/custom-fields`
 * and `GET /v3/spend/custom-fields/{id}/values` each return `id` AND `uuid`.
 * `GET /v3/spend/transactions` is the exception — its embedded `customFields`
 * carry `uuid` only, which is why the second rung of the ladder exists: a caller
 * writing straight from a transaction list holds no `id` to send.
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
 * Every body shape this server sends, best first. Both were observed to persist
 * against a live sandbox company; the order is about which forms a caller holds,
 * not about which one BILL prefers.
 *
 *   1. `customFieldId` + base64 `id` values — the form `list_coding_options`
 *      returns and every tool description tells callers to pass.
 *   2. `customFieldId` + `uuid` values — what writes when only uuids are on
 *      hand, which is the case for a field or value read out of a
 *      `list_transactions` result.
 *
 * There is no third rung. `customFieldUuid`, the Transactions guide's worked
 * example, answers 400 `customFieldId: must not be null`.
 *
 * `selectedValues` is an ARRAY in both variants, because both BILL documents
 * agree on that much and a multi-select field needs one regardless. BILL also
 * accepts a bare string there — that was tested too — but an array is the
 * documented shape and the only one that can express more than one value.
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
