/**
 * The remembered device: the three values Cognito's ConfirmDevice step leaves
 * behind, sealed into one GCS object.
 *
 * WHAT THEY ARE. When an MFA challenge succeeds, Cognito hands the client a
 * DEVICE KEY and a DEVICE GROUP KEY; the client invents a random DEVICE
 * PASSWORD and registers a verifier for it. Every later login proves
 * possession of that password over a second SRP exchange (DEVICE_SRP_AUTH),
 * and a remembered device skips the SMS code. So these three values are, with
 * the account password, a login that needs no phone — which is why they live
 * sealed, under a key that is itself a secret, and why no tool returns them.
 *
 * `userIdForSrp` is the name Cognito keys the device under: the pool's
 * internal username (`USER_ID_FOR_SRP`), not the email the account logs in
 * with. The client library stores device keys under it, so the state has to
 * remember it to put them back.
 */
import { open, seal } from "./crypto.js";
import type { BlobStore } from "./gcs.js";

export interface DeviceState {
  userIdForSrp: string;
  deviceKey: string;
  deviceGroupKey: string;
  devicePassword: string;
  /** ISO 8601. */
  enrolledAt: string;
}

const OBJECT = "device.sealed";

export class DeviceStore {
  constructor(
    private readonly blobs: BlobStore,
    private readonly key: Buffer,
    private readonly prefix: string,
  ) {}

  private get name(): string {
    return `${this.prefix}/${OBJECT}`;
  }

  async load(): Promise<DeviceState | null> {
    const sealed = await this.blobs.read(this.name);
    if (!sealed) return null;
    const parsed = JSON.parse(open(this.key, this.name, sealed).toString("utf8")) as DeviceState;
    for (const field of ["userIdForSrp", "deviceKey", "deviceGroupKey", "devicePassword"] as const) {
      if (typeof parsed[field] !== "string" || parsed[field] === "") return null;
    }
    return parsed;
  }

  async save(state: DeviceState): Promise<void> {
    await this.blobs.write(this.name, seal(this.key, this.name, Buffer.from(JSON.stringify(state))));
  }

  async clear(): Promise<void> {
    await this.blobs.delete(this.name);
  }
}
