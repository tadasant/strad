import { test } from "node:test";
import assert from "node:assert/strict";

import { GcsArtifactStore, DEFAULT_LINK_DAYS } from "../build/index.js";

/**
 * `GcsArtifactStore` against a fake `Storage`, injected through the
 * `createStorage` seam that exists for exactly this.
 *
 * The FakeStore tests next door cover the tool surface and deliberately do not
 * model GCS. These cover the half that decides who can read an artifact: ACL
 * normalisation on overwrite, what a failed ACL read is allowed to claim, and the
 * V4 seven-day ceiling. Every one of them is a place where being wrong means
 * reporting an artifact as private when it is not.
 */

const BASE = {
  bucket: "test-bucket",
  clientEmail: "svc@example.iam.gserviceaccount.com",
  privateKey: "-----BEGIN PRIVATE KEY-----fake",
  viewerDomain: "example.com",
  defaultLinkDays: DEFAULT_LINK_DAYS,
};

class NotFound extends Error {
  constructor() {
    super("Not Found");
    this.code = 404;
  }
}

/** A fake GCS object: bytes, metadata and an ACL we can inspect and break. */
function fakeStorage({ objects = new Map(), aclReadFails = false, aclDeleteFails = false } = {}) {
  const signed = [];
  const storage = {
    signed,
    objects,
    bucket() {
      return {
        file(name) {
          const get = () => objects.get(name);
          return {
            name,
            async save(data, opts) {
              const existing = get();
              objects.set(name, {
                data,
                contentType: opts?.metadata?.contentType ?? "application/octet-stream",
                acl: existing?.acl ?? [{ entity: "user-owner", role: "OWNER" }],
                updated: "2026-08-02T00:00:00.000Z",
              });
            },
            async exists() {
              return [objects.has(name)];
            },
            async getMetadata() {
              const o = get();
              return [{ size: o.data.length, contentType: o.contentType, updated: o.updated }];
            },
            async download() {
              return [get().data];
            },
            async delete() {
              objects.delete(name);
            },
            acl: {
              async get() {
                if (aclReadFails) throw new Error("uniform bucket-level access is enabled");
                return [get().acl.map((e) => ({ ...e }))];
              },
              async add({ entity, role }) {
                get().acl.push({ entity, role });
                return [{ entity, role }];
              },
              async delete({ entity }) {
                if (aclDeleteFails) {
                  const err = new Error("does not have storage.objects.update access");
                  err.code = 403;
                  throw err;
                }
                const o = get();
                const before = o.acl.length;
                o.acl = o.acl.filter((e) => e.entity !== entity);
                if (o.acl.length === before) throw new NotFound();
              },
            },
            async getSignedUrl(opts) {
              signed.push(opts);
              return [`https://storage.googleapis.com/test-bucket/${name}?v=${opts.version}`];
            },
          };
        },
        async getFiles(opts) {
          const files = [...objects.entries()]
            .filter(([n]) => n.startsWith(opts.prefix ?? ""))
            .map(([n, o]) => ({ name: n, metadata: { size: o.data.length, contentType: o.contentType, updated: o.updated } }));
          return [files, null, { prefixes: ["screenshots/8379/"] }];
        },
      };
    },
  };
  return storage;
}

const store = (config = {}, fake = fakeStorage()) => ({
  store: new GcsArtifactStore({ ...BASE, ...config }, { createStorage: () => fake }),
  fake,
});

const entities = (fake, name) => fake.objects.get(name).acl.map((e) => e.entity);
const bytes = () => Buffer.from("artifact");

test("a sensitive upload over a world-public object strips allUsers", async () => {
  const fake = fakeStorage();
  const s = store({}, fake).store;
  await s.put(bytes(), { path: "a.png", sensitive: false, expires_in_days: 14 });
  fake.objects.get("a.png").acl.push({ entity: "allUsers", role: "READER" });

  const { artifact } = await s.put(bytes(), { path: "a.png", sensitive: true, expires_in_days: 14 });
  assert.equal(artifact.access, "restricted");
  assert.deepEqual(entities(fake, "a.png"), ["user-owner", "domain-example.com"]);
});

test("a non-sensitive upload over a restricted object drops the domain grant", async () => {
  const fake = fakeStorage();
  const s = store({}, fake).store;
  await s.put(bytes(), { path: "a.png", sensitive: true, expires_in_days: 14 });
  assert.ok(entities(fake, "a.png").includes("domain-example.com"));

  const { artifact } = await s.put(bytes(), { path: "a.png", sensitive: false, expires_in_days: 14 });
  assert.equal(artifact.access, "link");
  assert.deepEqual(entities(fake, "a.png"), ["user-owner"]);
});

test("a non-sensitive upload leaves a pre-existing allUsers grant and says so", async () => {
  const fake = fakeStorage();
  const s = store({}, fake).store;
  await s.put(bytes(), { path: "a.png", sensitive: false, expires_in_days: 14 });
  fake.objects.get("a.png").acl.push({ entity: "allUsers", role: "READER" });

  // De-publishing an object nobody asked to de-publish would break a URL someone
  // may already hold. Report it truthfully instead of quietly changing it.
  const { artifact, link } = await s.put(bytes(), { path: "a.png", sensitive: false, expires_in_days: 14 });
  assert.equal(artifact.access, "public");
  assert.equal(link.expires_at, null);
  assert.ok(entities(fake, "a.png").includes("allUsers"));
});

test("a domain grant for another domain is cleared, in both directions", async () => {
  const fake = fakeStorage();
  const s = store({}, fake).store;
  await s.put(bytes(), { path: "a.png", sensitive: false, expires_in_days: 14 });
  fake.objects.get("a.png").acl.push({ entity: "domain-elsewhere.test", role: "READER" });

  const { artifact } = await s.setSensitive("a.png", false, 14);
  assert.equal(artifact.access, "link");
  assert.deepEqual(entities(fake, "a.png"), ["user-owner"]);
});

test("an ACL that cannot be removed fails the call — it never reports success", async () => {
  const fake = fakeStorage({ aclDeleteFails: true });
  const s = store({}, fake).store;
  await s.put(bytes(), { path: "a.png", sensitive: false, expires_in_days: 14 });
  fake.objects.get("a.png").acl.push({ entity: "allUsers", role: "READER" });

  // The dangerous shape: a sensitive upload whose allUsers strip is refused, and
  // which then reports `restricted` for a world-readable object.
  await assert.rejects(
    s.put(bytes(), { path: "a.png", sensitive: true, expires_in_days: 14 }),
    /Could not remove the "allUsers" grant/,
  );
});

test("an unreadable ACL refuses to issue a link rather than signing one", async () => {
  const fake = fakeStorage({ aclReadFails: false });
  const s = store({}, fake).store;
  await s.put(bytes(), { path: "a.png", sensitive: true, expires_in_days: 14 });

  // UBLA switched on, or the credential lost ACL read. Signing here would turn a
  // sign-in-gated artifact into an anonymous URL, minted by a read-only tool.
  const blind = store({}, fakeStorage({ objects: fake.objects, aclReadFails: true })).store;
  await assert.rejects(blind.link("a.png", 14), /cannot read the object's ACL/);
});

test("allAuthenticatedUsers counts as public, not as a private link", async () => {
  const fake = fakeStorage();
  const s = store({}, fake).store;
  await s.put(bytes(), { path: "a.png", sensitive: false, expires_in_days: 14 });
  fake.objects.get("a.png").acl.push({ entity: "allAuthenticatedUsers", role: "READER" });

  const { artifact } = await s.link("a.png", 14);
  assert.equal(artifact.access, "public", "any Google account is not a private object");
});

test("a 7-day request signs V4 and stays inside the 604800s ceiling", async () => {
  const { store: s, fake } = store();
  await s.put(bytes(), { path: "a.png", sensitive: false, expires_in_days: 7 });
  const opts = fake.signed.at(-1);
  assert.equal(opts.version, "v4");
  assert.ok(
    (opts.expires - Date.now()) / 1000 <= 604800,
    `expiry ${(opts.expires - Date.now()) / 1000}s must not exceed the V4 cap`,
  );
});

test("the 14-day default signs V2, because V4 cannot reach it", async () => {
  const { store: s, fake } = store();
  await s.put(bytes(), { path: "a.png", sensitive: false, expires_in_days: DEFAULT_LINK_DAYS });
  assert.equal(fake.signed.at(-1).version, "v2");
});

test("rootPath confines every entry point, and a `..` SEGMENT is refused", async () => {
  const { store: s } = store({ rootPath: "screenshots" });
  await s.put(bytes(), { path: "a.png", sensitive: false, expires_in_days: 14 });
  await assert.rejects(s.link("../../etc/passwd", 14), /Path traversal/);
  await assert.rejects(s.read("../secret.txt", 14), /Path traversal/);
  await assert.rejects(s.remove("../secret.txt"), /Path traversal/);
  await assert.rejects(s.list({ prefix: "../elsewhere" }), /Path traversal/);
});

test("`..` inside a NAME is a legal artifact, not traversal", async () => {
  const { store: s } = store();
  const { artifact } = await s.put(bytes(), { path: "report..txt", sensitive: false, expires_in_days: 14 });
  assert.equal(artifact.path, "report..txt");
});

test("rootPath is added on the way in and stripped on the way out", async () => {
  const { store: s, fake } = store({ rootPath: "screenshots" });
  const { artifact } = await s.put(bytes(), { path: "pr-1/shot.png", sensitive: false, expires_in_days: 14 });
  assert.equal(artifact.path, "pr-1/shot.png", "the caller never sees the root");
  assert.ok(fake.objects.has("screenshots/pr-1/shot.png"), "the object carries it");
});

test("listed directories carry no trailing slash, so they feed straight back in", async () => {
  const { store: s } = store();
  await s.put(bytes(), { path: "screenshots/a.png", sensitive: false, expires_in_days: 14 });
  const page = await s.list({ prefix: "screenshots" });
  assert.deepEqual(page.directories, ["screenshots/8379"]);
});

test("a missing object is a helpful error from every path that reads one", async () => {
  const { store: s } = store();
  await assert.rejects(s.link("nope.png", 14), /Use list_files/);
  await assert.rejects(s.read("nope.png"), /Use list_files/);
  await assert.rejects(s.remove("nope.png"), /Use list_files/);
  await assert.rejects(s.setSensitive("nope.png", true, 14), /Use list_files/);
});

test("a sensitive upload is refused outright when no viewer domain is configured", async () => {
  const { store: s, fake } = store({ viewerDomain: undefined });
  await assert.rejects(
    s.put(bytes(), { path: "a.png", sensitive: true, expires_in_days: 14 }),
    /no viewer domain is configured/,
  );
  assert.equal(fake.objects.size, 0, "nothing is stored when the grant cannot be made");
});
