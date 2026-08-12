import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  DEFAULT_LINK_DAYS,
  DEFAULT_UPLOAD_URL_MINUTES,
  MAX_LINK_DAYS,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_URL_MINUTES,
  type StoreConfig,
} from "./config.js";
import { artifactPayload, ok, fail } from "./tools/shared.js";
import type { StoreFactory, ToolResult } from "./tools/shared.js";

const MAX_LEASES = 1_000;

export interface UploadLeaseInput {
  path?: string;
  content_type?: string;
  is_sensitive?: boolean;
  expires_in_days?: number;
  upload_url_expires_in_minutes?: number;
}

export interface UploadLease {
  token: string;
  path?: string;
  content_type?: string;
  is_sensitive: boolean;
  expires_in_days: number;
  expires_at_ms: number;
  in_flight: boolean;
}

export interface UploadTarget {
  token: string;
  upload_path: string;
  upload_url: string;
  method: "POST";
  expires_at: string;
  max_upload_bytes: number;
  headers: Record<string, string>;
  curl: string;
}

export const UploadLeaseSchema = z.object({
  path: z.string().optional(),
  content_type: z.string().optional(),
  is_sensitive: z.boolean().optional().default(false),
  expires_in_days: z
    .number()
    .positive()
    .max(MAX_LINK_DAYS)
    .optional(),
  upload_url_expires_in_minutes: z
    .number()
    .positive()
    .max(MAX_UPLOAD_URL_MINUTES)
    .optional(),
});

export class UploadLeaseStore {
  private readonly leases = new Map<string, UploadLease>();

  constructor(
    private readonly options: {
      slug: string;
      uploadBaseUrl?: string;
      now?: () => number;
    },
  ) {}

  create(input: UploadLeaseInput, defaultLinkDays: number): UploadTarget {
    const now = this.now();
    this.prune(now);
    if (this.leases.size >= MAX_LEASES) {
      throw new Error(
        "Too many active upload URLs. Wait for old upload URLs to expire, then try again.",
      );
    }

    const minutes =
      input.upload_url_expires_in_minutes ?? DEFAULT_UPLOAD_URL_MINUTES;
    const token = randomBytes(32).toString("base64url");
    const uploadPath = `/mcp-upload/${encodeURIComponent(this.options.slug)}/${token}`;
    const uploadUrl = this.options.uploadBaseUrl
      ? `${this.options.uploadBaseUrl}${uploadPath}`
      : uploadPath;
    const contentType = input.content_type ?? "application/octet-stream";
    const lease: UploadLease = {
      token,
      path: input.path,
      content_type: input.content_type,
      is_sensitive: input.is_sensitive ?? false,
      expires_in_days: input.expires_in_days ?? defaultLinkDays,
      expires_at_ms: now + minutes * 60_000,
      in_flight: false,
    };
    this.leases.set(token, lease);

    return {
      token,
      upload_path: uploadPath,
      upload_url: uploadUrl,
      method: "POST",
      expires_at: new Date(lease.expires_at_ms).toISOString(),
      max_upload_bytes: MAX_UPLOAD_BYTES,
      headers: { "content-type": contentType },
      curl: `curl -fsS -X POST -H ${shellQuote(`Content-Type: ${contentType}`)} --data-binary @/path/to/file ${shellQuote(uploadUrl)}`,
    };
  }

  begin(token: string): UploadLease {
    const lease = this.leases.get(token);
    const now = this.now();
    if (!lease || lease.expires_at_ms <= now) {
      if (lease) this.leases.delete(token);
      throw new Error("This upload URL is missing or expired. Call get_upload_url again.");
    }
    if (lease.in_flight) {
      throw new Error("This upload URL is already being used.");
    }
    lease.in_flight = true;
    return lease;
  }

  finish(token: string): void {
    this.leases.delete(token);
  }

  fail(token: string): void {
    const lease = this.leases.get(token);
    if (!lease) return;
    if (lease.expires_at_ms <= this.now()) {
      this.leases.delete(token);
      return;
    }
    lease.in_flight = false;
  }

  private prune(now: number): void {
    for (const [token, lease] of this.leases) {
      if (lease.expires_at_ms <= now) this.leases.delete(token);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export function createUploadLeaseStore(options: {
  slug: string;
  config?: StoreConfig;
  envPrefix?: string;
  /** The environment this instance reads. See CreateMCPServerOptions.env. */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}): UploadLeaseStore {
  const env = options.env ?? process.env;
  return new UploadLeaseStore({
    slug: options.slug,
    uploadBaseUrl:
      options.config?.uploadBaseUrl ??
      env[prefixed(options.envPrefix ?? "", "UPLOAD_BASE_URL")]?.replace(
        /\/$/,
        "",
      ) ??
      env.STRAD_PUBLIC_URL?.replace(/\/$/, ""),
    now: options.now,
  });
}

export async function handleUploadPost(
  token: string,
  body: Buffer,
  leases: UploadLeaseStore,
  storeFactory: StoreFactory,
): Promise<ToolResult> {
  let lease: UploadLease | undefined;
  try {
    if (!body.length) throw new Error("Upload body is empty.");
    if (body.length > MAX_UPLOAD_BYTES) {
      throw new Error(
        `Upload body is ${body.length} bytes, above the ${MAX_UPLOAD_BYTES}-byte limit.`,
      );
    }

    lease = leases.begin(token);
    const store = storeFactory();
    const { artifact, link } = await store.put(body, {
      path: lease.path,
      content_type: lease.content_type,
      sensitive: lease.is_sensitive,
      expires_in_days: lease.expires_in_days,
    });
    leases.finish(token);
    return ok(artifactPayload(store, artifact, link));
  } catch (err) {
    if (lease) leases.fail(token);
    return fail(err);
  }
}

function prefixed(prefix: string, suffix: string): string {
  return prefix ? `${prefix}_${suffix}` : suffix;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
