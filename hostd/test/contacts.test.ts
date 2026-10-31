import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { QueryResult } from "../src/messages/chatdb.js";
import {
  ContactIndex,
  ContactsCache,
  displayName,
  normalizeEmail,
  phoneKeys,
  readSource,
  type ContactsSources,
} from "../src/messages/contacts.js";
import {
  buildAddressBook,
  FakeMessagesHelper,
  FIXTURE_SOURCE,
  writeAddressBook,
} from "./fake-messages.js";

// Every name, number and address here is invented. The UK numbers are in
// Ofcom's 07700 900xxx drama range and the US ones in 555.

describe("normalising a handle", () => {
  it("lowercases and trims an email, and refuses what is not one", () => {
    expect(normalizeEmail("  Grace@Example.COM ")).toBe("grace@example.com");
    expect(normalizeEmail("mailto:Sam@Example.org")).toBe("sam@example.org");
    expect(normalizeEmail("not an email")).toBeUndefined();
    expect(normalizeEmail("+15551234567")).toBeUndefined();
  });

  it("puts a number in E.164, with the Mac's region for one written without a country code", () => {
    expect(phoneKeys("(555) 123-4567", "US")).toEqual({
      e164: "+15551234567",
      national: "5551234567",
    });
    expect(phoneKeys("1 (555) 123-4567", "US").e164).toBe("+15551234567");
    expect(phoneKeys("555.123.4567", "US").e164).toBe("+15551234567");
    expect(phoneKeys("07700 900123", "GB")).toEqual({
      e164: "+447700900123",
      national: "7700900123",
    });
  });

  it("keeps the country code a number carries, whatever the region", () => {
    expect(phoneKeys("+44 7700 900123", "US")).toEqual({
      e164: "+447700900123",
    });
    expect(phoneKeys("+447700900123")).toEqual({ e164: "+447700900123" });
    expect(phoneKeys("0044 7700 900123", "US")).toEqual({
      e164: "+447700900123",
    });
    expect(phoneKeys("+61 412 345 678", "US").e164).toBe("+61412345678");
  });

  it("without a region, a number with no country code has only its national digits", () => {
    expect(phoneKeys("(555) 123-4567")).toEqual({ national: "5551234567" });
  });

  it("gives an email, a short code and noise no phone keys", () => {
    expect(phoneKeys("grace@example.com", "US")).toEqual({});
    expect(phoneKeys("12", "US")).toEqual({});
    expect(phoneKeys("12345", "US").national).toBeUndefined();
  });
});

describe("a card's name", () => {
  it("is given and family name, else nickname, else company", () => {
    expect(displayName({ first: "Alex", last: "Example" })).toBe(
      "Alex Example",
    );
    expect(displayName({ first: "Alex", middle: "J", last: "Example" })).toBe(
      "Alex J Example",
    );
    expect(displayName({ first: " Grace " })).toBe("Grace");
    expect(displayName({ nickname: "Gee", organization: "Acme" })).toBe("Gee");
    expect(displayName({ organization: "Example Florist" })).toBe(
      "Example Florist",
    );
    expect(displayName({ first: "", last: null })).toBeNull();
  });
});

describe("matching a handle to a contact", () => {
  const index = new ContactIndex(
    [
      { name: "Alex Example", phones: ["(555) 123-4567"], emails: [] },
      { name: "Grace", phones: [], emails: ["Grace@Example.COM"] },
      { name: "Example Florist", phones: ["+44 7700 900123"], emails: [] },
      // Saved in UK local form on a Mac whose region is the US.
      { name: "Jordan Sample", phones: ["07700 900456"], emails: [] },
      { name: "Sydney Office", phones: ["+61 412 345 678"], emails: [] },
    ],
    "US",
  );

  it("matches an E.164 handle to a number saved without its country code", () => {
    expect(index.lookup("+15551234567")).toBe("Alex Example");
  });

  it("matches a handle chat.db holds without its country code", () => {
    expect(index.lookup("5551234567")).toBe("Alex Example");
    expect(index.lookup("(555) 123-4567")).toBe("Alex Example");
  });

  it("matches international numbers", () => {
    expect(index.lookup("+447700900123")).toBe("Example Florist");
    expect(index.lookup("+61412345678")).toBe("Sydney Office");
  });

  it("matches a contact saved in another country's local form, by its national number", () => {
    expect(index.lookup("+447700900456")).toBe("Jordan Sample");
  });

  it("matches an email whatever its case", () => {
    expect(index.lookup("grace@example.com")).toBe("Grace");
    expect(index.lookup("GRACE@example.com")).toBe("Grace");
  });

  it("leaves an unmatched handle, and no handle, without a name", () => {
    expect(index.lookup("+15559876543")).toBeNull();
    expect(index.lookup("+447700900999")).toBeNull();
    expect(index.lookup("someone@example.org")).toBeNull();
    expect(index.lookup("12345")).toBeNull();
    expect(index.lookup(null)).toBeNull();
    expect(index.lookup("")).toBeNull();
  });

  it("does not guess between two people a national number could be", () => {
    const two = new ContactIndex(
      [
        { name: "Jordan Sample", phones: ["07700 900456"], emails: [] },
        { name: "Riley Placeholder", phones: ["7700900456"], emails: [] },
      ],
      "US",
    );
    expect(two.lookup("+447700900456")).toBeNull();
  });

  it("gives a shared handle the name most cards give it, then the first alphabetically", () => {
    const shared = new ContactIndex([
      { name: "Home", phones: ["+15550001111"], emails: [] },
      { name: "Alex Example", phones: ["+1 555 000 1111"], emails: [] },
      { name: "Alex Example", phones: ["+15550001111"], emails: [] },
      { name: "Bea", phones: ["+15550002222"], emails: [] },
      { name: "Ann", phones: ["+15550002222"], emails: [] },
    ]);
    expect(shared.lookup("+15550001111")).toBe("Alex Example");
    expect(shared.lookup("+15550002222")).toBe("Ann");
  });

  it("names each participant of a group on their own", () => {
    const group = ["+15551234567", "grace@example.com", "+15559876543"];
    expect(group.map((h) => index.lookup(h))).toEqual([
      "Alex Example",
      "Grace",
      null,
    ]);
  });
});

/** The fake helper's `query` op against a Contacts source. */
function sourceQuery(fake: FakeMessagesHelper) {
  let calls = 0;
  const query = async (
    source: string,
    sql: string,
    params: (string | number | null)[],
  ) => {
    calls++;
    return (await call(fake, "query", {
      contacts_source: source,
      sql,
      params,
      max_rows: 5000,
    })) as QueryResult;
  };
  return { query, calls: () => calls };
}

async function call(
  fake: FakeMessagesHelper,
  op: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const stream = await fake.transport();
  return new Promise((resolve, reject) => {
    stream.once("data", (chunk: Buffer) => {
      const reply = JSON.parse(chunk.toString("utf8")) as {
        ok: boolean;
        result?: unknown;
        error?: { message: string };
      };
      stream.end();
      if (reply.ok) resolve(reply.result);
      else reject(new Error(reply.error!.message));
    });
    stream.write(JSON.stringify({ id: 1, op, args }) + "\n");
  });
}

describe("reading the Contacts databases", () => {
  it("enumerates every source with a database, and reads each one's cards", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hostd-contacts-"));
    const fake = new FakeMessagesHelper("/unused", {
      contactsDir: buildAddressBook(dir),
      region: "US",
    });
    const found = fake.contactsSources();
    expect(found.state).toBe("readable");
    expect(found.sources).toEqual(["main", FIXTURE_SOURCE]);
    const { query } = sourceQuery(fake);
    const main = await readSource(query, "main");
    expect(main).toEqual([
      { name: "Alex Example", phones: ["(555) 123-4567"], emails: [] },
      { name: "Example Florist", phones: ["+44 7700 900123"], emails: [] },
      { name: "Grace", phones: [], emails: ["Grace@Example.COM"] },
    ]);
    await expect(readSource(query, "../../etc")).rejects.toThrow(
      /no Contacts source/,
    );
  });

  it("reads a book with a missing name column, and pages through a large one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hostd-contacts-"));
    const cards = Array.from({ length: 2500 }, (_, i) => ({
      first: `Person${i}`,
      phones: [`+1555${String(1000000 + i).slice(1)}`],
    }));
    writeAddressBook(
      join(dir, "AddressBook", "AddressBook-v22.abcddb"),
      cards,
      { omitNickname: true },
    );
    const fake = new FakeMessagesHelper("/unused", {
      contactsDir: join(dir, "AddressBook"),
    });
    const { query, calls } = sourceQuery(fake);
    const read = await readSource(query, "main");
    expect(read).toHaveLength(2500);
    // The column probe, two pages of phones and one of emails.
    expect(calls()).toBe(4);
  });
});

describe("the contacts cache", () => {
  function setup(over: { denied?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "hostd-contacts-"));
    const fake = new FakeMessagesHelper("/unused", {
      contactsDir: buildAddressBook(dir),
      region: "US",
      contactsDenied: over.denied,
    });
    let now = 0;
    let sourceCalls = 0;
    const { query, calls } = sourceQuery(fake);
    const cache = new ContactsCache({
      sources: async () => {
        sourceCalls++;
        return fake.contactsSources() as ContactsSources;
      },
      query,
      ttlMs: 600_000,
      retryMs: 60_000,
      now: () => now,
    });
    return {
      fake,
      cache,
      advance: (ms: number) => (now += ms),
      sourceCalls: () => sourceCalls,
      queries: calls,
    };
  }

  it("reads the book once for many lookups, and again after the TTL", async () => {
    const t = setup();
    const first = await t.cache.get();
    expect(first.warning).toBeUndefined();
    expect(first.index.lookup("+15551234567")).toBe("Alex Example");
    expect(first.index.lookup("+447700900456")).toBe("Jordan Sample");
    const afterFirst = t.queries();
    for (let i = 0; i < 200; i++) await t.cache.get();
    expect(t.sourceCalls()).toBe(1);
    expect(t.queries()).toBe(afterFirst);
    t.advance(600_001);
    await t.cache.get();
    expect(t.sourceCalls()).toBe(2);
  });

  it("reads once when many lookups arrive together", async () => {
    const t = setup();
    await Promise.all(Array.from({ length: 10 }, () => t.cache.get()));
    expect(t.sourceCalls()).toBe(1);
  });

  it("without Full Disk Access over Contacts: no names, a warning, and a retry a minute later", async () => {
    const t = setup({ denied: true });
    const r = await t.cache.get();
    expect(r.index.lookup("+15551234567")).toBeNull();
    expect(r.warning).toMatch(/contact names unavailable.*Full Disk Access/);
    await t.cache.get();
    expect(t.sourceCalls()).toBe(1);
    t.advance(60_001);
    t.fake.state.contactsDenied = false;
    const again = await t.cache.get();
    expect(again.warning).toBeUndefined();
    expect(again.index.lookup("+15551234567")).toBe("Alex Example");
  });

  it("keeps serving the last index when a refresh fails", async () => {
    const t = setup();
    await t.cache.get();
    t.fake.state.contactsDenied = true;
    t.advance(600_001);
    const r = await t.cache.get();
    expect(r.warning).toMatch(/unavailable/);
    expect(r.index.lookup("grace@example.com")).toBe("Grace");
  });

  it("names what one unreadable account leaves, and says some are missing", async () => {
    const t = setup();
    const broken = new ContactsCache({
      sources: async () => t.fake.contactsSources() as ContactsSources,
      query: async (source, sql, params) => {
        if (source !== "main") throw new Error("database is locked");
        return sourceQuery(t.fake).query(source, sql, params);
      },
      ttlMs: 600_000,
      retryMs: 60_000,
    });
    const r = await broken.get();
    expect(r.index.lookup("+15551234567")).toBe("Alex Example");
    expect(r.index.lookup("+447700900456")).toBeNull();
    expect(r.warning).toMatch(/1 of 2 Contacts databases could not be read/);
  });
});
