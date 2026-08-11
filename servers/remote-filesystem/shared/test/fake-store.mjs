/**
 * An in-memory ArtifactStore that models the ONE thing the tools depend on:
 * sensitivity decides which kind of link comes back, and expiry only exists on
 * the signed kind.
 *
 * It deliberately does NOT model GCS. The real signing and ACL behaviour is
 * exercised against a real bucket (see the PR's evidence); what these tests own
 * is the tool surface an agent sees.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const V4_MAX_DAYS = 7;

export class FakeStore {
  constructor(options = {}) {
    const { defaultDays = 14, now = 1_700_000_000_000 } = options;
    this.objects = new Map();
    // `in`, not a default parameter: a test that passes `viewerDomain: undefined`
    // is asking for a deployment with NO viewer domain, not for the default.
    this._viewerDomain = "viewerDomain" in options ? options.viewerDomain : "example.com";
    this._viewerAccount = options.viewerAccount;
    this._defaultDays = defaultDays;
    this.now = now;
    this.calls = [];
  }

  bucket() {
    return "test-bucket";
  }

  viewerDomain() {
    return this._viewerDomain;
  }

  viewerAccount() {
    return this._viewerAccount;
  }

  defaultLinkDays() {
    return this._defaultDays;
  }

  seed(path, { access = "link", body = "seeded", contentType = "text/plain" } = {}) {
    this.objects.set(path, {
      buffer: Buffer.from(body),
      contentType,
      access,
      updatedAt: new Date(this.now).toISOString(),
    });
    return path;
  }

  async put(data, options) {
    this.calls.push(["put", options]);
    if (options.sensitive && !this._viewerDomain) {
      throw new Error("no viewer domain is configured");
    }
    const path = options.path ?? `uploads/generated-${this.objects.size}.bin`;
    this.objects.set(path, {
      buffer: data,
      contentType: options.content_type ?? "application/octet-stream",
      access: options.sensitive ? "restricted" : "link",
      updatedAt: new Date(this.now).toISOString(),
    });
    return { artifact: this.#artifact(path), link: this.#link(path, options.expires_in_days) };
  }

  async link(path, days) {
    this.calls.push(["link", path, days]);
    this.#require(path);
    return { artifact: this.#artifact(path), link: this.#link(path, days) };
  }

  async setSensitive(path, sensitive, days) {
    this.calls.push(["setSensitive", path, sensitive, days]);
    const object = this.#require(path);
    if (sensitive && !this._viewerDomain) throw new Error("no viewer domain is configured");
    if (sensitive) object.access = "restricted";
    else if (object.access === "restricted") object.access = "link";
    return { artifact: this.#artifact(path), link: this.#link(path, days) };
  }

  async list({ prefix, limit } = {}) {
    const scope = prefix ? (prefix.endsWith("/") ? prefix : `${prefix}/`) : "";
    const files = [];
    const directories = new Set();
    for (const path of this.objects.keys()) {
      if (!path.startsWith(scope)) continue;
      const rest = path.slice(scope.length);
      const slash = rest.indexOf("/");
      if (slash === -1) files.push(this.#artifact(path));
      else directories.add(`${scope}${rest.slice(0, slash)}`);
    }
    return { files: files.slice(0, limit ?? files.length), directories: [...directories] };
  }

  async read(path) {
    const object = this.#require(path);
    return { buffer: object.buffer, artifact: this.#artifact(path) };
  }

  async remove(path) {
    this.#require(path);
    this.objects.delete(path);
  }

  #require(path) {
    const object = this.objects.get(path);
    if (!object) throw new Error(`No artifact at "${path}". Use list_files to find the exact path`);
    return object;
  }

  #artifact(path) {
    const object = this.objects.get(path);
    return {
      path,
      size_bytes: object.buffer.length,
      content_type: object.contentType,
      updated_at: object.updatedAt,
      access: object.access,
    };
  }

  #link(path, days) {
    const object = this.objects.get(path);
    if (object.access === "restricted") {
      return {
        url:
          `https://storage.cloud.google.com/test-bucket/${path}` +
          (this._viewerAccount
            ? `?authuser=${encodeURIComponent(this._viewerAccount)}`
            : ""),
        expires_at: null,
        signing_version: null,
        requires_sign_in: true,
      };
    }
    if (object.access === "public") {
      return {
        url: `https://storage.googleapis.com/test-bucket/${path}`,
        expires_at: null,
        signing_version: null,
        requires_sign_in: false,
      };
    }
    return {
      url: `https://storage.googleapis.com/test-bucket/${path}?Signature=fake&days=${days}`,
      expires_at: new Date(this.now + days * DAY_MS).toISOString(),
      signing_version: days <= V4_MAX_DAYS ? "v4" : "v2",
      requires_sign_in: false,
    };
  }
}
