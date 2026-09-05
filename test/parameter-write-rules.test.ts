import { describe, expect, it } from "vitest";
import {
  nextVersionId,
  rankVersions,
  versionIdOf,
  withSecretAccessor,
  SECRET_ACCESSOR_ROLE,
  type IamPolicy,
} from "../src/secrets/parameters/write-rules.ts";

/**
 * The three rules two npm trees have to apply identically, tested where they now
 * live rather than through either caller.
 *
 * These were three hand-written copies of a ranking, two of a mint and two of an
 * IAM edit, held together by five comments saying "same as over there". Byte
 * identity is what `test/vendored.sync.test.ts` guards now; this is the other
 * question, which no drift check can answer: whether the one implementation both
 * trees share is the RIGHT one. It is worth asking directly because the failure
 * is silent — a ranking that picks the wrong version makes a rotate report
 * success while every reader keeps serving the old value — and because the
 * behaviour tests on the `src/` side do not reach it: their fakes list versions
 * in ascending order, where "last one wins" and "greatest suffix" agree.
 */
const at = (vid: string, disabled?: boolean) => ({
  name: `projects/p/locations/global/parameters/some-id/versions/${vid}`,
  ...(disabled === undefined ? {} : { disabled }),
});

describe("rankVersions", () => {
  it("takes the greatest numeric suffix, not the last listed", () => {
    // Parameter Manager lists lexicographically, so this is the order a real
    // list returns for a parameter with twelve versions. Taking the last element
    // picks `v9` and reverts the value by three versions, silently.
    const listed = [
      "v1",
      "v10",
      "v11",
      "v12",
      "v2",
      "v3",
      "v4",
      "v5",
      "v6",
      "v7",
      "v8",
      "v9",
    ].map((vid) => at(vid));
    expect(rankVersions(listed)).toEqual({ vid: "v12", n: 12 });
  });

  it("skips disabled versions", () => {
    expect(rankVersions([at("v1"), at("v2"), at("v3", true)])).toEqual({
      vid: "v2",
      n: 2,
    });
  });

  it("skips a version with no name rather than ranking it", () => {
    expect(rankVersions([{ name: undefined }, at("v4")])).toEqual({
      vid: "v4",
      n: 4,
    });
  });

  it("reads an id whose suffix is not a number as 0", () => {
    // The trap `nextVersionId` exists to avoid, seen from the reading side: a
    // timestamp-shaped id ranks BELOW `v1`, so a store holding one still reports
    // the numbered version as current.
    expect(rankVersions([at("lz4k9x"), at("v1")])).toEqual({ vid: "v1", n: 1 });
    expect(rankVersions([at("lz4k9x")])).toEqual({ vid: "lz4k9x", n: 0 });
  });

  it("has no answer for an empty list, or for one with nothing enabled", () => {
    expect(rankVersions([])).toBeUndefined();
    expect(rankVersions([at("v1", true)])).toBeUndefined();
  });
});

describe("versionIdOf", () => {
  it("takes the last segment of a resource name", () => {
    expect(versionIdOf(at("v7").name)).toBe("v7");
  });

  it("passes undefined through", () => {
    expect(versionIdOf(undefined)).toBeUndefined();
  });
});

describe("nextVersionId", () => {
  it("mints v1 for a parameter with no enabled version", () => {
    expect(nextVersionId(undefined)).toBe("v1");
  });

  it("mints v{n+1} from the same suffix rankVersions read", () => {
    expect(nextVersionId("v1")).toBe("v2");
    expect(nextVersionId("v9")).toBe("v10");
    expect(nextVersionId("v12")).toBe("v13");
  });

  it("mints a NUMBERED id even from one that is not numbered", () => {
    // The recovery from a store someone else wrote a timestamp-shaped id into:
    // the next version is `v1`, which every reader ranks above it.
    expect(nextVersionId("lz4k9x")).toBe("v1");
  });
});

describe("withSecretAccessor", () => {
  const PRINCIPAL = "principal://parametermanager.googleapis.com/…/subject/x";

  it("adds the binding to a policy that has none", () => {
    expect(withSecretAccessor({ etag: "abc" }, PRINCIPAL)).toEqual({
      etag: "abc",
      bindings: [{ role: SECRET_ACCESSOR_ROLE, members: [PRINCIPAL] }],
    });
  });

  it("appends to an existing unconditional binding, keeping its members", () => {
    const policy: IamPolicy = {
      etag: "abc",
      bindings: [{ role: SECRET_ACCESSOR_ROLE, members: ["user:a@b.c"] }],
    };
    expect(withSecretAccessor(policy, PRINCIPAL)).toEqual({
      etag: "abc",
      bindings: [
        { role: SECRET_ACCESSOR_ROLE, members: ["user:a@b.c", PRINCIPAL] },
      ],
    });
  });

  it("returns null when the principal is already a member", () => {
    // Which is what spares the caller a `setIamPolicy` that changes nothing.
    const policy: IamPolicy = {
      bindings: [{ role: SECRET_ACCESSOR_ROLE, members: [PRINCIPAL] }],
    };
    expect(withSecretAccessor(policy, PRINCIPAL)).toBeNull();
  });

  it("adds an unconditional binding beside a conditional one of the same role", () => {
    // Appending to the conditional binding would grant access only while its
    // condition holds — which fails exactly like no grant at all, from a policy
    // that reads as correct.
    const condition = { title: "expiry", expression: "request.time < …" };
    const policy: IamPolicy = {
      bindings: [
        { role: SECRET_ACCESSOR_ROLE, members: ["user:a@b.c"], condition },
      ],
    };
    expect(withSecretAccessor(policy, PRINCIPAL)).toEqual({
      bindings: [
        { role: SECRET_ACCESSOR_ROLE, members: ["user:a@b.c"], condition },
        { role: SECRET_ACCESSOR_ROLE, members: [PRINCIPAL] },
      ],
    });
  });

  it("carries every other binding through untouched, conditions included", () => {
    const condition = { title: "expiry", expression: "request.time < …" };
    const policy: IamPolicy = {
      version: 3,
      etag: "abc",
      bindings: [
        { role: "roles/viewer", members: ["user:a@b.c"], condition },
        { role: "roles/other" },
      ],
    };
    expect(withSecretAccessor(policy, PRINCIPAL)).toEqual({
      version: 3,
      etag: "abc",
      bindings: [
        { role: "roles/viewer", members: ["user:a@b.c"], condition },
        { role: "roles/other", members: [] },
        { role: SECRET_ACCESSOR_ROLE, members: [PRINCIPAL] },
      ],
    });
  });

  it("does not mutate the policy it was given", () => {
    // The caller holds what `getIamPolicy` returned, and an etag-guarded retry
    // has to be able to read it again.
    const policy: IamPolicy = {
      bindings: [{ role: SECRET_ACCESSOR_ROLE, members: ["user:a@b.c"] }],
    };
    withSecretAccessor(policy, PRINCIPAL);
    expect(policy.bindings).toEqual([
      { role: SECRET_ACCESSOR_ROLE, members: ["user:a@b.c"] },
    ]);
  });
});
