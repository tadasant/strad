/**
 * A fake BILL Spend & Expense company, and — the whole reason it exists — a
 * fake that can LIE THE WAY BILL LIES.
 *
 * `acceptsVariant` is the switch. The real endpoint answers HTTP 200
 * `{"status":"SUCCESS"}` to a body it is going to discard — measured, against a
 * live sandbox company: two values sent to a single-select field come back
 * SUCCESS with the field exactly as it was. So this fake always
 * answers SUCCESS and applies the change only when the body matches the variant
 * it has been told to honour. Set it to `customFieldId/id` and the first attempt
 * lands; set it to `customFieldId/uuid` and the first is silently dropped; set
 * it to `null` and nothing ever persists, which is the case the server must
 * refuse to call a success.
 *
 * `customFieldUuid` is a 400 here because it is a 400 there — the key name in
 * BILL's Transactions guide answers `customFieldId: must not be null`, and no
 * rung of the ladder sends it any more.
 *
 * It implements `BillHttp` rather than intercepting `fetch`, so a passing suite
 * is evidence about the request this server BUILDS and the reply it INTERPRETS.
 * Every identifier in the fixtures is invented — no real company, transaction,
 * merchant or account name appears anywhere in this repo.
 */

import type { BillHttp, RequestOptions } from "../src/client.js";
import { AuthError, BillApiError, RateLimitError } from "../src/errors.js";

export interface FakeValue {
  id: string;
  uuid: string;
  value: string;
  deleted?: boolean;
}

export interface FakeField {
  id: string;
  uuid: string;
  name: string;
  type?: string;
  multiSelect?: boolean;
  retired?: boolean;
  values: FakeValue[];
}

export interface FakeTransaction {
  uuid: string;
  isLocked?: boolean;
  merchantName?: string;
  amount?: number;
  occurredTime?: string;
  updatedTime?: string;
  /** fieldUuid -> the value uuids currently selected. */
  selected: Record<string, string[]>;
  /** fieldUuid -> the note BILL currently holds for it. */
  notes?: Record<string, string>;
  /** Fields this transaction offers at all. Defaults to every field. */
  fieldUuids?: string[];
}

export interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string | number | undefined>;
  body?: unknown;
}

export interface FakeBillOptions {
  fields: FakeField[];
  transactions: FakeTransaction[];
  /**
   * Omit `id` from `GET /transactions/{id}/custom-fields`, keeping only `uuid`.
   *
   * BILL marks `id` DEPRECATED and it is OPTIONAL in the schema, so a deployment
   * that stops receiving it is a shape the server has to survive — and it is the
   * shape that turned an `f.id === field.id` read-back match into
   * `undefined === undefined`, i.e. "the first field in the list, whatever it
   * is". A fake that always emits both forms can never catch that.
   */
  omitIdsOnCodingRead?: boolean;
  /**
   * The one body shape this fake actually honours, by `WireVariant.name`.
   * `null` means every shape is answered SUCCESS and every shape is discarded.
   */
  acceptsVariant: string | null;
  /** Fail the next N requests to this path with this status. */
  failures?: Array<{ path: string; method?: string; status: number; body?: unknown }>;
  /**
   * Apply `selectedValues` and IGNORE `note`, which is what BILL does on a
   * `CUSTOM_SELECTOR` field — the ordinary case for GL coding.
   */
  ignoresNote?: boolean;
  /**
   * ACCEPT `filters=retired:eq:…` on `/v3/spend/custom-fields` and then do
   * nothing with it, which is what the live endpoint does: an unsupported filter
   * field answers `400 …: field [x] is not supported in filter field`, `retired`
   * does not, and the walk comes back carrying every field either way.
   *
   * The `/values` endpoint DOES apply the same filter, so this flag is scoped to
   * the field list. It is off by default because the server must be correct
   * under both behaviours, and the union-then-dedupe it does is what makes it so.
   */
  ignoresRetiredFilterOnFields?: boolean;
  /**
   * A HUMAN EDITING THE SAME TRANSACTION IN THE BILL WEB APP, once, between a
   * write and the read-back that verifies it.
   *
   * This is the only cause anyone has for the `drift` branch of
   * `WriteNotPersistedError`, and it is not exotic: this server is driven by an
   * unattended agent against a company real people also use. The write does not
   * land, so `persisted` is false — but the transaction is no longer what it was
   * either, and an error telling the caller to "treat this as UNCODED" would be
   * describing a row that has since been coded by somebody.
   *
   * Applied ONCE, to the next coding read, so the fake stops being a company
   * with a poltergeist after the case under test.
   */
  concurrentEdit?: { fieldUuid: string; valueUuids: string[] };
}

export class FakeBill implements BillHttp {
  readonly environment = "sandbox";
  readonly calls: RecordedCall[] = [];
  acceptsVariant: string | null;

  private readonly fields: FakeField[];
  private readonly transactions: FakeTransaction[];
  private readonly failures: NonNullable<FakeBillOptions["failures"]>;
  private readonly omitIds: boolean;
  private readonly ignoresNote: boolean;
  private readonly ignoresRetiredFilterOnFields: boolean;
  private concurrentEdit?: { fieldUuid: string; valueUuids: string[] };
  /** Set by the first PUT, so the edit lands BETWEEN a write and its read-back. */
  private concurrentEditArmed = false;

  constructor(options: FakeBillOptions) {
    this.fields = options.fields;
    this.transactions = options.transactions;
    this.acceptsVariant = options.acceptsVariant;
    this.failures = [...(options.failures ?? [])];
    this.omitIds = options.omitIdsOnCodingRead ?? false;
    this.ignoresNote = options.ignoresNote ?? false;
    this.ignoresRetiredFilterOnFields =
      options.ignoresRetiredFilterOnFields ?? false;
    this.concurrentEdit = options.concurrentEdit;
  }

  /** The PUTs this fake was sent, in order. */
  get writes(): RecordedCall[] {
    return this.calls.filter((c) => c.method === "PUT");
  }

  transaction(uuid: string): FakeTransaction {
    const found = this.transactions.find((t) => t.uuid === uuid);
    if (!found) throw new Error(`fixture has no transaction ${uuid}`);
    return found;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? "GET";
    this.calls.push({
      method,
      path,
      query: options.query ?? {},
      ...(options.body === undefined ? {} : { body: options.body }),
    });

    const failureIndex = this.failures.findIndex(
      (f) => f.path === path && (f.method ?? "GET") === method,
    );
    if (failureIndex >= 0) {
      const failure = this.failures.splice(failureIndex, 1)[0]!;
      // Classified the way the real client classifies, so a test about "does
      // the ladder walk through THIS kind of failure" is asking the question it
      // means to ask.
      if (failure.status === 401 || failure.status === 403) {
        throw new AuthError(`fake failure ${failure.status}`, failure.status, []);
      }
      if (failure.status === 429) {
        throw new RateLimitError(`fake failure 429`, 429, []);
      }
      throw new BillApiError(
        `fake failure ${failure.status}`,
        failure.status,
        [],
      );
    }

    if (path === "/v3/spend/custom-fields" && method === "GET") {
      return this.listFields(options) as T;
    }
    const valuesMatch = /^\/v3\/spend\/custom-fields\/([^/]+)\/values$/.exec(path);
    if (valuesMatch && method === "GET") {
      return this.listValues(decodeURIComponent(valuesMatch[1]!), options) as T;
    }
    if (path === "/v3/spend/transactions" && method === "GET") {
      return this.listTransactions(options) as T;
    }
    const codingMatch = /^\/v3\/spend\/transactions\/([^/]+)\/custom-fields$/.exec(path);
    if (codingMatch) {
      const id = decodeURIComponent(codingMatch[1]!);
      if (method === "GET") return this.readCoding(id) as T;
      if (method === "PUT") return this.write(id, options.body) as T;
    }
    const txMatch = /^\/v3\/spend\/transactions\/([^/]+)$/.exec(path);
    if (txMatch && method === "GET") {
      return this.readTransaction(decodeURIComponent(txMatch[1]!)) as T;
    }

    throw new BillApiError(`fake has no route for ${method} ${path}`, 404, []);
  }

  // -- reads ----------------------------------------------------------------

  private retiredFilter(options: RequestOptions): boolean | undefined {
    const filters = String(options.query?.filters ?? "");
    if (filters.includes("retired:eq:true")) return true;
    if (filters.includes("retired:eq:false")) return false;
    return undefined;
  }

  private page<T>(items: T[], options: RequestOptions) {
    const max = Number(options.query?.max ?? 20);
    const start = Number(options.query?.nextPage ?? 0);
    const slice = items.slice(start, start + max);
    const end = start + slice.length;
    return {
      results: slice,
      ...(end < items.length ? { nextPage: String(end) } : {}),
    };
  }

  private listFields(options: RequestOptions) {
    const wantRetired = this.ignoresRetiredFilterOnFields
      ? undefined
      : this.retiredFilter(options);
    const matching = this.fields.filter(
      (f) => wantRetired === undefined || Boolean(f.retired) === wantRetired,
    );
    return this.page(
      matching.map((f) => ({
        id: f.id,
        uuid: f.uuid,
        name: f.name,
        type: f.type ?? "CUSTOM_SELECTOR",
        multiSelect: f.multiSelect ?? false,
        retired: Boolean(f.retired),
      })),
      options,
    );
  }

  private field(ref: string): FakeField {
    const found = this.fields.find((f) => f.id === ref || f.uuid === ref);
    if (!found) throw new BillApiError(`no such custom field ${ref}`, 404, []);
    return found;
  }

  private listValues(ref: string, options: RequestOptions) {
    const wantRetired = this.retiredFilter(options);
    const values = this.field(ref).values.filter(
      (v) => wantRetired === undefined || Boolean(v.deleted) === wantRetired,
    );
    return this.page(
      values.map((v) => ({
        id: v.id,
        uuid: v.uuid,
        value: v.value,
        deleted: Boolean(v.deleted),
      })),
      options,
    );
  }

  private embeddedFields(tx: FakeTransaction) {
    return this.fieldsOf(tx).map((f) => ({
      uuid: f.uuid,
      name: f.name,
      selectedValues: (tx.selected[f.uuid] ?? []).map((uuid) => {
        const v = f.values.find((x) => x.uuid === uuid)!;
        return { uuid: v.uuid, value: v.value };
      }),
    }));
  }

  private fieldsOf(tx: FakeTransaction): FakeField[] {
    return tx.fieldUuids
      ? this.fields.filter((f) => tx.fieldUuids!.includes(f.uuid))
      : this.fields;
  }

  private listTransactions(options: RequestOptions) {
    return this.page(
      this.transactions.map((t) => ({
        uuid: t.uuid,
        isLocked: Boolean(t.isLocked),
        merchantName: t.merchantName,
        amount: t.amount,
        occurredTime: t.occurredTime,
        updatedTime: t.updatedTime,
        transactionType: "CLEAR",
        customFields: this.embeddedFields(t),
      })),
      options,
    );
  }

  private readTransaction(uuid: string) {
    const tx = this.transaction(uuid);
    return {
      uuid: tx.uuid,
      isLocked: Boolean(tx.isLocked),
      merchantName: tx.merchantName,
      amount: tx.amount,
      customFields: this.embeddedFields(tx),
    };
  }

  private readCoding(uuid: string) {
    const tx = this.transaction(uuid);
    if (this.concurrentEdit && this.concurrentEditArmed) {
      const { fieldUuid, valueUuids } = this.concurrentEdit;
      // Once, and only after a PUT — the before-state read has to be the state
      // that was really there, or there is no drift to observe.
      this.concurrentEdit = undefined;
      tx.selected[fieldUuid] = valueUuids;
    }
    return {
      results: this.fieldsOf(tx).map((f) => ({
        // BOTH FORMS, which the transactions endpoint does not give — this is
        // the asymmetry the whole server is arranged around. `id` is optional
        // in BILL's schema though, so `omitIdsOnCodingRead` drops it.
        ...(this.omitIds ? {} : { id: f.id }),
        uuid: f.uuid,
        name: f.name,
        note: tx.notes?.[f.uuid],
        isRequired: false,
        selectedValues: (tx.selected[f.uuid] ?? []).map((valueUuid) => {
          const v = f.values.find((x) => x.uuid === valueUuid)!;
          return {
            ...(this.omitIds ? {} : { id: v.id }),
            uuid: v.uuid,
            value: v.value,
          };
        }),
      })),
    };
  }

  // -- the write, and the lie ------------------------------------------------

  private write(uuid: string, body: unknown) {
    const tx = this.transaction(uuid);
    // The real endpoint refuses a locked transaction; the server is supposed to
    // never get here, and this is what proves it does not.
    if (tx.isLocked) {
      throw new BillApiError("transaction is locked", 400, [
        { code: "BDC_LOCKED", message: "transaction is locked" },
      ]);
    }

    const entry = (body as { customFields?: Array<Record<string, unknown>> })
      ?.customFields?.[0];
    if (!entry) throw new BillApiError("customFields is required", 400, []);

    // VERBATIM FROM THE LIVE API: `customFieldUuid` — the key name in BILL's
    // Transactions guide — is not an alias, it is a 400, and the message names
    // the key it wanted instead.
    if (typeof entry.customFieldId !== "string") {
      throw new BillApiError("customFieldId: must not be null", 400, [
        { code: "BDC_1101", message: "customFieldId: must not be null" },
      ]);
    }

    const fieldKey = "customFieldId";
    const fieldRef = entry[fieldKey] as string;
    const field = this.field(fieldRef);
    const selected = (entry.selectedValues ?? []) as string[];

    // Which form did the caller send the VALUES in? Determined by looking them
    // up, the same way a real backend would have to. An empty array carries no
    // form of its own, so the FIELD reference is what is left to go on.
    const valueForm = selected.length === 0
      ? field.id === fieldRef
        ? "id"
        : "uuid"
      : field.values.some((v) => v.id === selected[0])
        ? "id"
        : "uuid";

    const variant = `${fieldKey}/${valueForm}`;

    // A field the transaction's budget does not carry is the OTHER way BILL
    // answers SUCCESS to a write it discards, and it is independent of the body
    // shape — so the fake drops it even when the shape is the honoured one.
    const applies = this.fieldsOf(tx).some((f) => f.uuid === field.uuid);

    if (this.concurrentEdit) this.concurrentEditArmed = true;

    // ALWAYS 200 SUCCESS. This is the behaviour under test.
    if (applies && this.acceptsVariant === variant) {
      if (typeof entry.note === "string" && !this.ignoresNote) {
        tx.notes = { ...(tx.notes ?? {}), [field.uuid]: entry.note };
      }
      const uuids = selected.map((raw) => {
        const v = field.values.find((x) => x.id === raw || x.uuid === raw);
        if (!v) throw new BillApiError(`no such value ${raw}`, 400, []);
        return v.uuid;
      });
      // TOO MANY VALUES FOR A SINGLE-SELECT FIELD: SUCCESS, AND NOTHING HAPPENS.
      // Measured against a live BILL company, across an empty field, a coded
      // one, two values, three, and a list that included the current value —
      // every one came back 200 SUCCESS with the field EXACTLY as it was. BILL
      // does not take the first and drop the rest; it drops the update whole.
      // It is the sharpest available demonstration of why a 200 is not
      // evidence, and it is the one an agent hits by treating a single-select
      // field as multi-select.
      const singleSelect = field.multiSelect !== true;
      if (!(singleSelect && uuids.length > 1)) {
        tx.selected[field.uuid] = uuids;
      }
    }
    return { status: "SUCCESS" };
  }
}

/** A small, realistic company: one GL field, one other field, three values. */
export function fixture(overrides: Partial<FakeBillOptions> = {}): FakeBillOptions {
  return {
    fields: [
      {
        id: "Y3VzdG9tZmllbGQ6MTAx",
        uuid: "tty_gl_0001",
        name: "GL Account",
        values: [
          {
            id: "Y3VzdG9tZmllbGR2YWx1ZTo5MDE",
            uuid: "tvl_0901",
            value: "Internet/Phone",
          },
          {
            id: "Y3VzdG9tZmllbGR2YWx1ZTo5MDI",
            uuid: "tvl_0902",
            value: "Software & Subscriptions",
          },
          {
            id: "Y3VzdG9tZmllbGR2YWx1ZTo5MDM",
            uuid: "tvl_0903",
            value: "Meals & Entertainment",
          },
          {
            id: "Y3VzdG9tZmllbGR2YWx1ZTo5MDQ",
            uuid: "tvl_0904",
            value: "Retired Account",
            deleted: true,
          },
        ],
      },
      {
        id: "Y3VzdG9tZmllbGQ6MjAy",
        uuid: "tty_project_0002",
        name: "Project",
        multiSelect: true,
        values: [
          {
            id: "Y3VzdG9tZmllbGR2YWx1ZTo3MDE",
            uuid: "tvl_0701",
            value: "Platform",
          },
          {
            id: "Y3VzdG9tZmllbGR2YWx1ZTo3MDI",
            uuid: "tvl_0702",
            value: "Growth",
          },
        ],
      },
    ],
    transactions: [
      {
        uuid: "txn_open_0001",
        merchantName: "Northwind Broadband",
        amount: 89.99,
        occurredTime: "2026-09-02T17:04:00.000Z",
        updatedTime: "2026-09-02T17:30:00.000Z",
        selected: { tty_gl_0001: ["tvl_0901"] },
      },
      {
        uuid: "txn_locked_0002",
        merchantName: "Northwind Broadband",
        amount: 12.5,
        isLocked: true,
        selected: { tty_gl_0001: ["tvl_0901"] },
      },
      {
        // A transaction whose budget does not offer the GL field at all.
        uuid: "txn_nofield_0003",
        merchantName: "Contoso Coffee",
        amount: 4.25,
        selected: {},
        fieldUuids: ["tty_project_0002"],
      },
    ],
    acceptsVariant: "customFieldId/id",
    ...overrides,
  };
}
