// The events ingest's half of strad's shared state store: which variables it
// reads, and that its folder cannot leave `slack-events/` in the shared bucket.
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  EventsConfigError,
  loadEventsConfig,
  missingEventsEnv,
} from '../src/events/config.js';
import { EventsStore } from '../src/events/store.js';
import { MemoryBlobStore } from '../src/events/state-store.js';

const KEY = randomBytes(32).toString('base64');
const ENV = {
  SLACK_APP_TOKEN: 'xapp-1-test',
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_EVENTS_STATE_ENCRYPTION_KEY: KEY,
  STRAD_STATE_GCS_BUCKET: 'strad-state-prod',
  STRAD_STATE_GCS_CLIENT_EMAIL: 'sa@example.iam.gserviceaccount.com',
  STRAD_STATE_GCS_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
};

describe('events config on the shared state store', () => {
  it('names its own variables and the shared store, in order', () => {
    expect(missingEventsEnv({})).toEqual([
      'SLACK_APP_TOKEN',
      'SLACK_BOT_TOKEN',
      'SLACK_EVENTS_STATE_ENCRYPTION_KEY',
      'STRAD_STATE_GCS_BUCKET',
      'STRAD_STATE_GCS_CLIENT_EMAIL',
      'STRAD_STATE_GCS_PRIVATE_KEY',
    ]);
    const config = loadEventsConfig(ENV);
    expect(config.bucket).toBe('strad-state-prod');
    expect(config.prefix).toBe('slack-events');
    expect(config.privateKey).toContain('\nabc\n');
  });

  it('keeps its folder under slack-events/, never another consumer’s', () => {
    expect(loadEventsConfig({ ...ENV, SLACK_EVENTS_STATE_PREFIX: '/slack-events/prod/' }).prefix).toBe(
      'slack-events/prod'
    );
    for (const outside of ['whatsapp/prod', 'whatsapp', '/', 'slack-eventsx']) {
      expect(() => loadEventsConfig({ ...ENV, SLACK_EVENTS_STATE_PREFIX: outside })).toThrow(
        EventsConfigError
      );
    }
  });

  it('refuses a short key without quoting it', () => {
    const short = randomBytes(16).toString('base64');
    let message = '';
    try {
      loadEventsConfig({ ...ENV, SLACK_EVENTS_STATE_ENCRYPTION_KEY: short });
    } catch (err) {
      expect(err).toBeInstanceOf(EventsConfigError);
      message = (err as Error).message;
    }
    expect(message).toContain('SLACK_EVENTS_STATE_ENCRYPTION_KEY must be exactly 32 bytes');
    expect(message).not.toContain(short);
  });

  it('seals under its own key and magic: a buffer does not open under another key', async () => {
    const blobs = new MemoryBlobStore();
    const key = randomBytes(32);
    const store = new EventsStore(blobs, key, 'slack-events');
    await store.claimLease();
    const doc = { version: 1, events: [] } as never;
    await store.writeBuffer(doc, (theirs) => theirs);
    const sealed = blobs.objects.get('slack-events/buffer.bin')!.data;
    expect(sealed.subarray(0, 4).toString()).toBe('SLE1');
    const other = new EventsStore(blobs, randomBytes(32), 'slack-events');
    await expect(other.readBuffer()).rejects.toThrow(/does not open with SLACK_EVENTS_STATE_ENCRYPTION_KEY/);
  });
});
