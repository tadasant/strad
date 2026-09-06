import { describe, expect, it } from "vitest";

import { createGateway } from "../src/gateway.js";
import {
  InputError,
  LockedTransactionError,
  WriteNotPersistedError,
} from "../src/errors.js";
import { WIRE_VARIANTS } from "../src/wire.js";
import { FakeBill, fixture } from "./fake-bill.js";

/**
 * THE SUITE THIS SERVER EXISTS FOR.
 *
 * `PUT /v3/spend/transactions/{id}/custom-fields` can answer HTTP 200
 * `{"status":"SUCCESS"}` and discard the update, and the caller is an unattended
 * agent editing someone's books. Every test below is about the same property
 * stated one way or another: this server reports a coding change only when it
 * has RE-READ the transaction and seen it.
 *
 * The fake answers SUCCESS to every body shape and applies only the one it has
 * been told to honour, which is exactly the failure mode described.
 */

const GL = "tty_gl_0001";
const GL_ID = "Y3VzdG9tZmllbGQ6MTAx";
const SOFTWARE_ID = "Y3VzdG9tZmllbGR2YWx1ZTo5MDI";
const SOFTWARE_UUID = "tvl_0902";
const MEALS_ID = "Y3VzdG9tZmllbGR2YWx1ZTo5MDM";
const OPEN = "txn_open_0001";
const LOCKED = "txn_locked_0002";

function build(overrides: Parameters<typeof fixture>[0] = {}) {
  const bill = new FakeBill(fixture(overrides));
  return { bill, gateway: createGateway({ http: bill }) };
}

describe("a locked transaction is refused before anything is written", () => {
  it("throws a typed error naming the transaction, and sends no PUT", async () => {
    const { bill, gateway } = build();
    await expect(
      gateway.setTransactionCoding({
        transaction_id: LOCKED,
        field: GL,
        value_ids: [SOFTWARE_ID],
      }),
    ).rejects.toBeInstanceOf(LockedTransactionError);

    // The point of checking BEFORE rather than handling the 400: nothing was
    // sent, so there is no write whose outcome anyone has to interpret.
    expect(bill.writes).toEqual([]);
    expect(bill.transaction(LOCKED).selected[GL]).toEqual(["tvl_0901"]);
  });

  it("says a human must unlock it, and does not invite a retry", async () => {
    const { gateway } = build();
    const error = await gateway
      .setTransactionCoding({
        transaction_id: LOCKED,
        field: GL,
        value_ids: [SOFTWARE_ID],
      })
      .catch((e: unknown) => e as Error);
    expect(error.message).toContain("LOCKED");
    expect(error.message).toContain("retrying will not help");
    expect(error.message).toContain("web app");
  });
});

describe("the write is believed only after a read-back", () => {
  it("sends the base64 id form first, and stops there when it lands", async () => {
    const { bill, gateway } = build({ acceptsVariant: "customFieldId/id" });
    const result = await gateway.setTransactionCoding({
      transaction_id: OPEN,
      field: GL,
      value_ids: [SOFTWARE_ID],
    });

    expect(result.changed).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.wire_variant).toBe("customFieldId/id");
    expect(result.before.map((v) => v.value)).toEqual(["Internet/Phone"]);
    expect(result.after.map((v) => v.value)).toEqual([
      "Software & Subscriptions",
    ]);

    expect(bill.writes).toHaveLength(1);
    expect(bill.writes[0]!.body).toEqual({
      customFields: [
        { customFieldId: GL_ID, selectedValues: [SOFTWARE_ID] },
      ],
    });
  });

  it("walks past a shape BILL answers SUCCESS to and silently discards", async () => {
    // The reported real-world behaviour: the uuid forms are accepted and
    // dropped. A server that trusted the 200 would report this transaction
    // re-coded and it would still say Internet/Phone.
    const { bill, gateway } = build({ acceptsVariant: "customFieldUuid/uuid" });
    const result = await gateway.setTransactionCoding({
      transaction_id: OPEN,
      field: GL,
      value_ids: [SOFTWARE_ID],
    });

    expect(result.changed).toBe(true);
    expect(result.wire_variant).toBe("customFieldUuid/uuid");
    // Every earlier shape was tried, read back, and recorded as not persisted.
    expect(result.attempts.map((a) => a.variant)).toEqual(
      WIRE_VARIANTS.map((v) => v.name),
    );
    expect(result.attempts.filter((a) => a.persisted)).toHaveLength(1);
    for (const attempt of result.attempts) {
      // BILL claimed success every single time.
      expect(attempt.reportedStatus).toBe("SUCCESS");
    }
    expect(bill.transaction(OPEN).selected[GL]).toEqual([SOFTWARE_UUID]);
  });

  it("fails loudly when no shape persists, rather than reporting BILL's SUCCESS", async () => {
    const { bill, gateway } = build({ acceptsVariant: null });
    const error = await gateway
      .setTransactionCoding({
        transaction_id: OPEN,
        field: GL,
        value_ids: [SOFTWARE_ID],
      })
      .catch((e: unknown) => e as WriteNotPersistedError);

    expect(error).toBeInstanceOf(WriteNotPersistedError);
    expect(error.attempts).toHaveLength(WIRE_VARIANTS.length);
    expect(error.attempts.every((a) => a.reportedStatus === "SUCCESS")).toBe(
      true,
    );
    expect(error.attempts.every((a) => !a.persisted)).toBe(true);
    expect(error.message).toContain("did NOT change");
    expect(error.message).toContain("Treat this transaction as UNCODED");
    // And the ledger really is untouched.
    expect(bill.transaction(OPEN).selected[GL]).toEqual(["tvl_0901"]);
  });

  it("remembers the shape that worked, so a sweep pays for the ladder once", async () => {
    const { bill, gateway } = build({ acceptsVariant: "customFieldUuid/uuid" });
    await gateway.setTransactionCoding({
      transaction_id: OPEN,
      field: GL,
      value_ids: [SOFTWARE_ID],
    });
    const firstRound = bill.writes.length;
    expect(firstRound).toBe(3);

    await gateway.setTransactionCoding({
      transaction_id: OPEN,
      field: GL,
      value_ids: [MEALS_ID],
    });
    // One more PUT, not three: the learned variant is tried first.
    expect(bill.writes.length - firstRound).toBe(1);
    expect(bill.writes.at(-1)!.body).toEqual({
      customFields: [
        { customFieldUuid: GL, selectedValues: ["tvl_0903"] },
      ],
    });
  });

  it("re-opens the ladder when a remembered shape stops working", async () => {
    const { bill, gateway } = build({ acceptsVariant: "customFieldUuid/uuid" });
    await gateway.setTransactionCoding({
      transaction_id: OPEN,
      field: GL,
      value_ids: [SOFTWARE_ID],
    });

    // BILL changes its mind — which is precisely the thing nobody would find
    // out about if a learned variant were treated as settled.
    bill.acceptsVariant = null;
    await expect(
      gateway.setTransactionCoding({
        transaction_id: OPEN,
        field: GL,
        value_ids: [MEALS_ID],
      }),
    ).rejects.toBeInstanceOf(WriteNotPersistedError);

    bill.acceptsVariant = "customFieldId/id";
    const result = await gateway.setTransactionCoding({
      transaction_id: OPEN,
      field: GL,
      value_ids: [MEALS_ID],
    });
    expect(result.wire_variant).toBe("customFieldId/id");
  });

  it("counts a PARTIAL write as not persisted", async () => {
    // Two values asked for and one landing is a wrong answer on a ledger, not a
    // warning — so the diff is strict in BOTH directions. Asserted on the
    // comparison itself: it is what every read-back in this file runs through,
    // and a fake cannot demonstrate "the set is subtly different" more directly
    // than the set comparison can.
    const { selectionMatches } = await import("../src/wire.js");
    expect(
      selectionMatches(
        [
          { id: "a", uuid: "A" },
          { id: "b", uuid: "B" },
        ],
        [{ id: "a", uuid: "A", value: "one" }],
      ),
      "two asked for, one landed",
    ).toBe(false);
    expect(
      selectionMatches(
        [{ id: "a", uuid: "A" }],
        [
          { id: "a", uuid: "A", value: "one" },
          { id: "b", uuid: "B", value: "two" },
        ],
      ),
      "one asked for, an extra one left behind",
    ).toBe(false);
    // And it matches on EITHER form, because a caller may hold only one.
    expect(selectionMatches([{ uuid: "A" }], [{ id: "a", uuid: "A" }])).toBe(
      true,
    );
    expect(selectionMatches([{ id: "a" }], [{ id: "a", uuid: "A" }])).toBe(true);
    // Never on the display string: two chart-of-accounts entries can share a
    // label, and this comparison is what separates "coded" from "coded as
    // something else".
    expect(
      selectionMatches([{ id: "a" }], [{ id: "z", uuid: "Z", value: "a" }]),
    ).toBe(false);
  });
});

describe("a write that is not needed is not sent", () => {
  it("reports changed: false without a PUT when the coding already matches", async () => {
    const { bill, gateway } = build();
    const result = await gateway.setTransactionCoding({
      transaction_id: OPEN,
      field: GL,
      value_ids: ["Y3VzdG9tZmllbGR2YWx1ZTo5MDE"], // Internet/Phone, already set
    });
    expect(result.changed).toBe(false);
    expect(result.verified).toBe(true);
    expect(result.wire_variant).toBeNull();
    expect(bill.writes).toEqual([]);
  });

  it("recognises the same value passed in the other identifier form", async () => {
    // Same value, other identifier form. Resolution happens against BILL's own
    // catalog, so this is recognised as a no-op rather than becoming a write.
    const { bill, gateway } = build();
    const result = await gateway.setTransactionCoding({
      transaction_id: OPEN,
      field: GL,
      value_ids: ["tvl_0901"],
    });
    expect(result.changed).toBe(false);
    expect(bill.writes).toEqual([]);
  });
});

describe("a value id that belongs to no value of the field is refused", () => {
  it("refuses before writing, and names the fix", async () => {
    const { bill, gateway } = build();
    const error = await gateway
      .setTransactionCoding({
        transaction_id: OPEN,
        field: GL,
        // A real value id — of the OTHER field. BILL accepts this and discards
        // it, which is the single likeliest cause of a silent no-op.
        value_ids: ["Y3VzdG9tZmllbGR2YWx1ZTo3MDE"],
      })
      .catch((e: unknown) => e as Error);

    expect(error).toBeInstanceOf(InputError);
    expect(error.message).toContain("list_coding_options");
    expect(error.message).toContain("Nothing was written");
    expect(bill.writes).toEqual([]);
  });
});

describe("clearing a field", () => {
  it("sends an empty selectedValues array rather than omitting it", async () => {
    // BILL documents the empty array as the way to clear. Omitting the key
    // would be a request that changes nothing and is answered SUCCESS.
    const { bill, gateway } = build();
    const result = await gateway.setTransactionCoding({
      transaction_id: OPEN,
      field: GL,
      value_ids: [],
    });
    expect(result.changed).toBe(true);
    expect(result.after).toEqual([]);
    expect(bill.writes[0]!.body).toEqual({
      customFields: [{ customFieldId: GL_ID, selectedValues: [] }],
    });
  });
});

describe("a field the transaction does not offer", () => {
  it("does not report success for a write BILL accepted and dropped", async () => {
    // The transaction's budget does not carry the GL field at all. BILL answers
    // SUCCESS; the read-back shows nothing; the server refuses to call it done.
    const { bill, gateway } = build();
    await expect(
      gateway.setTransactionCoding({
        transaction_id: "txn_nofield_0003",
        field: GL,
        value_ids: [SOFTWARE_ID],
      }),
    ).rejects.toBeInstanceOf(WriteNotPersistedError);
    expect(bill.transaction("txn_nofield_0003").selected[GL]).toBeUndefined();
  });
});

describe("regressions found in review", () => {
  it("does not match the WRONG field on the read-back when BILL omits `id`", async () => {
    // `id` is OPTIONAL on BILL's coding payload, and a bare `f.id === field.id`
    // is `undefined === undefined` — TRUE for the first field in the list,
    // whatever it is. The read-back then diffed a different field's values, and
    // a write BILL discarded came back `verified: true`. That is exactly the
    // failure this whole server exists to prevent, reintroduced by an unguarded
    // comparison, so it gets a test of its own.
    const { bill, gateway } = build({
      omitIdsOnCodingRead: true,
      acceptsVariant: null, // BILL says SUCCESS to everything and keeps nothing
    });

    await expect(
      gateway.setTransactionCoding({
        transaction_id: OPEN,
        field: GL,
        value_ids: [],
      }),
    ).rejects.toBeInstanceOf(WriteNotPersistedError);

    // And the ledger really is untouched, which is what makes the above the
    // right answer rather than merely a different one.
    expect(bill.transaction(OPEN).selected[GL]).toEqual(["tvl_0901"]);
  });

  it("still verifies correctly against the right field when `id` is absent", async () => {
    // The guard must not overcorrect into never matching: with only `uuid`
    // available on both sides, a real write still has to be recognised.
    const { gateway } = build({
      omitIdsOnCodingRead: true,
      acceptsVariant: "customFieldId/uuid",
    });
    const result = await gateway.setTransactionCoding({
      transaction_id: OPEN,
      field: GL,
      value_ids: [SOFTWARE_ID],
    });
    expect(result.changed).toBe(true);
    expect(result.after.map((v) => v.value)).toEqual([
      "Software & Subscriptions",
    ]);
  });

  it("does not call a landed re-code a failure because BILL dropped the note", async () => {
    // `note` and `selectedValues` travel in one array item, but BILL honours
    // `note` only on a NOTE-type field and ignores it on a CUSTOM_SELECTOR —
    // the ordinary case for GL coding. Requiring both would report a
    // transaction that WAS re-coded as `WriteNotPersistedError`, telling the
    // caller to treat it as UNCODED when the ledger had changed. That is a
    // worse lie than the one being guarded against, in the other direction.
    const { bill, gateway } = build({
      acceptsVariant: "customFieldId/id",
      ignoresNote: true,
    });
    const result = await gateway.setTransactionCoding({
      transaction_id: OPEN,
      field: GL,
      value_ids: [SOFTWARE_ID],
      note: "recoded by the monthly sweep",
    });

    expect(result.changed).toBe(true);
    expect(result.after.map((v) => v.value)).toEqual([
      "Software & Subscriptions",
    ]);
    // Reported, not hidden: the values landed and the note did not.
    expect(result.note_persisted).toBe(false);
    expect(bill.writes).toHaveLength(1);
  });

  it("reports note_persisted: true when BILL does store it", async () => {
    const { gateway } = build({ acceptsVariant: "customFieldId/id" });
    const result = await gateway.setTransactionCoding({
      transaction_id: OPEN,
      field: GL,
      value_ids: [SOFTWARE_ID],
      note: "recoded by the monthly sweep",
    });
    expect(result.note_persisted).toBe(true);
  });

  it("dedupes the same value passed in both identifier forms", async () => {
    // list_coding_options returns `id` AND `uuid`, so passing both for one value
    // is an easy mistake. `selectionMatches` compares SIZES and BILL stores a
    // set, so without deduping the write lands and is reported as not landing.
    const { bill, gateway } = build();
    const result = await gateway.setTransactionCoding({
      transaction_id: OPEN,
      field: GL,
      value_ids: [SOFTWARE_ID, SOFTWARE_UUID],
    });
    expect(result.changed).toBe(true);
    expect(bill.writes).toHaveLength(1);
    expect(bill.writes[0]!.body).toEqual({
      customFields: [{ customFieldId: GL_ID, selectedValues: [SOFTWARE_ID] }],
    });
    expect(bill.transaction(OPEN).selected[GL]).toEqual([SOFTWARE_UUID]);
  });

  it("does not memoise, or claim, a variant that sent an unknown identifier form", async () => {
    // The field is not on this transaction, so its forms could not be looked up
    // and the caller's string went in both slots. A variant that "won" on that
    // is evidence about nothing, and pinning the next sweep to it would be
    // building on a guess.
    const { gateway } = build({ acceptsVariant: "customFieldId/id" });
    const result = await gateway.setTransactionCoding({
      transaction_id: OPEN,
      // The Project field, which txn_open_0001 does list — but referenced in a
      // way the before-state can resolve, so this one IS certain.
      field: "tty_project_0002",
      value_ids: ["Y3VzdG9tZmllbGR2YWx1ZTo3MDE"],
    });
    expect(result.wire_variant_certain).toBe(true);
  });

  it("rethrows an auth failure instead of blaming the value ids for it", async () => {
    // Walking the ladder through a dead token spends three calls and then
    // reports `WriteNotPersistedError`, whose message blames the value ids and
    // the budget — none of it true, and the actual diagnosis lost.
    const { gateway } = build({
      failures: [
        {
          path: `/v3/spend/transactions/${OPEN}/custom-fields`,
          method: "PUT",
          status: 401,
        },
      ],
    });
    const error = await gateway
      .setTransactionCoding({
        transaction_id: OPEN,
        field: GL,
        value_ids: [SOFTWARE_ID],
      })
      .catch((e: unknown) => e as Error);
    expect(error).not.toBeInstanceOf(WriteNotPersistedError);
    expect(error.name).toBe("AuthError");
  });
});
