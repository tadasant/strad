/**
 * strad's confirmation layer over the vendored 1Password tools, end to end.
 *
 * Every test drives the REAL vendored registration (`shared/src`) through a real
 * MCP client, over the SDK's in-memory transport, with strad's
 * `withConfirmation` in between. Two things are faked: the 1Password client
 * (so no `op` process runs and no token exists) and the approval endpoint, which
 * is a real HTTP server on loopback speaking the pulsemcp fallback-elicitation
 * protocol the way Zimmer's `/api/v1/elicitations/session/<token>` does.
 *
 * The secret in the fake item is a fixed string, and the strongest assertion in
 * this file is that it does not appear ANYWHERE in a response a human did not
 * approve.
 */
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMCPServer } from '../shared/src/server.js';
import type { IOnePasswordClient, OnePasswordItemDetails } from '../shared/src/types.js';
import {
  ELICITATION_META_KEY,
  REVEAL_TOOLS,
  WRITE_TOOLS,
  forceAskEverything,
  guardWrites,
  withConfirmation,
  type ConfirmationOptions,
} from '../remote/src/confirm.js';

const SECRET = 'hunter2-the-real-password';

const ITEM: OnePasswordItemDetails = {
  id: 'item-id-1',
  title: 'Stripe Live Key',
  category: 'LOGIN',
  vault: { id: 'vault-id-1', name: 'Zimmer' },
  fields: [
    { id: 'username', type: 'STRING', label: 'username', value: 'ops@example.com' },
    { id: 'password', type: 'CONCEALED', label: 'password', value: SECRET },
  ],
};

/** A fake 1Password account: what was asked of it, and one item to answer with. */
function fakeOp() {
  const calls: string[] = [];
  const client: IOnePasswordClient = {
    getVaults: async () => [],
    getItem: async () => {
      calls.push('getItem');
      return structuredClone(ITEM);
    },
    listItems: async () => [],
    listItemsByTag: async () => [],
    createLogin: async (vaultId, title) => {
      calls.push(`createLogin:${title}`);
      return { ...structuredClone(ITEM), title, vault: { id: vaultId, name: 'Zimmer' } };
    },
    createSecureNote: async () => {
      calls.push('createSecureNote');
      return structuredClone(ITEM);
    },
    shareItem: async () => {
      calls.push('shareItem');
      return { url: 'https://share.1password.example/x' } as never;
    },
    createApiCredential: async () => {
      calls.push('createApiCredential');
      return structuredClone(ITEM);
    },
  } as IOnePasswordClient;
  return { client, calls };
}

// ---------------------------------------------------------------------------
// The approval endpoint: Zimmer's side of the protocol, on loopback.
// ---------------------------------------------------------------------------

interface Prompt {
  path: string;
  headers: IncomingMessage['headers'];
  body: { message: string; _meta: Record<string, string> };
}

const approval = {
  /** What a poll answers. `pending` holds the call open. */
  answer: { action: 'accept', content: { confirm: true } } as Record<string, unknown>,
  prompts: [] as Prompt[],
  polls: 0,
};

let http: HttpServer;
let base: string;

beforeAll(async () => {
  http = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST') {
        approval.prompts.push({ path: req.url ?? '', headers: req.headers, body: JSON.parse(raw) });
        res.end(JSON.stringify({ requestId: `req-${approval.prompts.length}` }));
        return;
      }
      approval.polls++;
      res.end(JSON.stringify(approval.answer));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => http.close(() => resolve())));

const saved = { ...process.env };
beforeEach(() => {
  approval.answer = { action: 'accept', content: { confirm: true } };
  approval.prompts = [];
  approval.polls = 0;
  // A Zimmer session running this suite has its own container-wide approval
  // URL in its environment, which the layer rightly refuses to ask through.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ELICITATION_')) delete process.env[key];
  }
  forceAskEverything(process.env);
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

/** A session's approval URL, the way core forwards it to a `confirmations: true` slug. */
function channel(session = 'session-a') {
  return {
    [ELICITATION_META_KEY]: {
      url: `${base}/api/v1/elicitations/session/${session}`,
      slug: 'onepassword-tadas-all',
      ttlMs: 10_000,
      headers: { 'CF-Access-Client-Id': 'strad-id', 'CF-Access-Client-Secret': 'strad-secret' },
    },
  };
}

/** One mount, connected to one MCP client, the way the bundle host builds it per request. */
async function mount(op: IOnePasswordClient, options: ConfirmationOptions = {}) {
  const server = new Server(
    { name: 'onepassword-mcp-server', version: 'test' },
    { capabilities: { resources: {}, tools: {} } }
  );
  await createMCPServer({ version: 'test' }).registerHandlers(
    withConfirmation(server, { pollIntervalMs: 20, ...options }),
    () => guardWrites(op)
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  // A client with no elicitation capability of its own, like a headless agent.
  const client = new Client({ name: 'test', version: 'test' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

function text(result: unknown): string {
  return ((result as { content: Array<{ text: string }> }).content ?? [])
    .map((c) => c.text)
    .join('\n');
}

const getItem = (meta?: Record<string, unknown>) => ({
  name: 'onepassword_get_item',
  arguments: { items: [{ itemId: 'Stripe Live Key' }] },
  ...(meta ? { _meta: meta } : {}),
});

const createLogin = (meta?: Record<string, unknown>) => ({
  name: 'onepassword_create_login',
  arguments: {
    items: [{ vaultId: 'vault-id-1', title: 'New Key', username: 'u', password: 'p' }],
  },
  ...(meta ? { _meta: meta } : {}),
});

describe('a reveal goes to the calling session, and only an approval reveals', () => {
  it('asks the session named on the call, then reveals when the human approves', async () => {
    const op = fakeOp();
    const client = await mount(op.client);

    const result = await client.callTool(getItem(channel()));
    expect(approval.prompts).toHaveLength(1);
    const prompt = approval.prompts[0]!;
    expect(prompt.path).toBe('/api/v1/elicitations/session/session-a');
    // The prompt names the slug and the item, so a human can judge it.
    expect(prompt.body.message).toContain('strad slug onepassword-tadas-all');
    expect(prompt.body.message).toContain('Stripe Live Key');
    expect(prompt.body._meta['com.pulsemcp/tool-name']).toBe('onepassword_get_item');
    // strad's edge credential, from `confirmationHeaders:`, on the POST.
    expect(prompt.headers['cf-access-client-id']).toBe('strad-id');
    expect(prompt.headers['cf-access-client-secret']).toBe('strad-secret');

    expect(text(result)).toContain(SECRET);
    expect(text(result)).toContain('"_credentialsRevealed": true');
  });

  it('reveals NOTHING when the human declines', async () => {
    approval.answer = { action: 'decline' };
    const op = fakeOp();
    const client = await mount(op.client);

    const result = await client.callTool(getItem(channel()));

    expect(approval.prompts).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(text(result)).toContain('[REDACTED]');
    expect(text(result)).toContain('"_credentialsRevealed": false');
  });

  it('reveals nothing on an accept with the confirm box unticked', async () => {
    approval.answer = { action: 'accept', content: { confirm: false } };
    const client = await mount(fakeOp().client);

    const result = await client.callTool(getItem(channel()));

    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('reveals nothing on an answer it does not recognise', async () => {
    approval.answer = { action: 'sure-why-not' };
    const client = await mount(fakeOp().client);

    const result = await client.callTool(getItem(channel()));

    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('reveals nothing when the approval endpoint fails, and does not echo its body', async () => {
    const client = await mount(fakeOp().client);
    const meta = channel();
    (meta[ELICITATION_META_KEY] as { url: string }).url = 'http://127.0.0.1:1/nowhere';

    const result = await client.callTool(getItem(meta));

    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('refuses a reveal with no channel, before 1Password is even asked', async () => {
    const op = fakeOp();
    const client = await mount(op.client);

    const result = await client.callTool(getItem());

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('onepassword_get_item was NOT run');
    expect(text(result)).toContain('nothing was revealed');
    expect(op.calls).toEqual([]);
    expect(approval.prompts).toHaveLength(0);
  });

  it("refuses a reveal whose channel core refused, and repeats core's reason", async () => {
    const op = fakeOp();
    const client = await mount(op.client);

    const result = await client.callTool(
      getItem({ [ELICITATION_META_KEY]: { refused: 'not under an allowed prefix' } })
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('not under an allowed prefix');
    expect(op.calls).toEqual([]);
  });

  it('refuses when the container sets a container-wide approval URL', async () => {
    process.env.ELICITATION_REQUEST_URL = `${base}/container-wide`;
    process.env.ELICITATION_POLL_URL = `${base}/container-wide`;
    const op = fakeOp();
    const client = await mount(op.client);

    const result = await client.callTool(getItem(channel()));

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('container-wide');
    expect(op.calls).toEqual([]);
    expect(approval.prompts).toHaveLength(0);
  });

  it('still asks when the container set DANGEROUSLY_SKIP_ELICITATIONS, because the host removes it', async () => {
    process.env.DANGEROUSLY_SKIP_ELICITATIONS = 'true';
    process.env.OP_ELICITATION_READ = 'false';
    process.env.OP_WHITELISTED_ITEMS = 'Stripe Live Key';
    expect(forceAskEverything(process.env).sort()).toEqual([
      'DANGEROUSLY_SKIP_ELICITATIONS',
      'OP_ELICITATION_READ',
      'OP_WHITELISTED_ITEMS',
    ]);
    approval.answer = { action: 'decline' };
    const client = await mount(fakeOp().client);

    const result = await client.callTool(getItem(channel()));

    expect(approval.prompts).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('lets metadata through with no channel: it reveals no value and never asks', async () => {
    const op = fakeOp();
    const client = await mount(op.client);

    const result = await client.callTool({
      name: 'onepassword_get_item_metadata',
      arguments: { items: [{ itemId: 'Stripe Live Key' }] },
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(approval.prompts).toHaveLength(0);
  });

  it('keeps two sessions calling at once apart', async () => {
    const client = await mount(fakeOp().client);

    await Promise.all([
      client.callTool(getItem(channel('session-a'))),
      client.callTool(getItem(channel('session-b'))),
    ]);

    expect(approval.prompts.map((p) => p.path).sort()).toEqual([
      '/api/v1/elicitations/session/session-a',
      '/api/v1/elicitations/session/session-b',
    ]);
  });
});

describe('a write asks too, unless the mount is the provisioning posture', () => {
  it('asks before a write, and writes nothing when the human declines', async () => {
    approval.answer = { action: 'decline' };
    const op = fakeOp();
    const client = await mount(op.client);

    const result = await client.callTool(createLogin(channel()));

    expect(approval.prompts).toHaveLength(1);
    expect(approval.prompts[0]!.body._meta['com.pulsemcp/tool-name']).toBe(
      'onepassword_create_login'
    );
    expect(text(result)).toContain('declined');
    expect(op.calls).toEqual([]);
  });

  it('writes once the human approves', async () => {
    const op = fakeOp();
    const client = await mount(op.client);

    await client.callTool(createLogin(channel()));

    expect(approval.prompts).toHaveLength(1);
    expect(op.calls).toEqual(['createLogin:New Key']);
  });

  it('refuses a write with no channel', async () => {
    const op = fakeOp();
    const client = await mount(op.client);

    const result = await client.callTool(createLogin());

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Nothing was written to 1Password');
    expect(op.calls).toEqual([]);
  });

  it('confirmWrites: false writes unasked, with or without a channel', async () => {
    const op = fakeOp();
    const client = await mount(op.client, { confirmWrites: false });

    await client.callTool(createLogin());
    await client.callTool(createLogin(channel()));

    expect(approval.prompts).toHaveLength(0);
    expect(op.calls).toEqual(['createLogin:New Key', 'createLogin:New Key']);
  });

  it('confirmWrites: false still puts every reveal to a human', async () => {
    approval.answer = { action: 'decline' };
    const op = fakeOp();
    const client = await mount(op.client, { confirmWrites: false });

    const refused = await client.callTool(getItem());
    const declined = await client.callTool(getItem(channel()));

    expect(refused.isError).toBe(true);
    expect(approval.prompts).toHaveLength(1);
    expect(JSON.stringify(declined)).not.toContain(SECRET);
  });

  it('a call dropped while the human decides writes nothing, even if they approve afterwards', async () => {
    approval.answer = { action: 'pending' };
    const op = fakeOp();
    const client = await mount(op.client);
    const controller = new AbortController();

    const call = client.callTool(createLogin(channel()), undefined, { signal: controller.signal });
    while (approval.polls === 0) await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await expect(call).rejects.toThrow();
    approval.answer = { action: 'accept', content: { confirm: true } };
    await new Promise((r) => setTimeout(r, 100));

    expect(op.calls).toEqual([]);
  });
});

describe('guardWrites', () => {
  it('passes every method through outside a call (the drop test above covers the refusal)', async () => {
    const op = fakeOp();
    const guarded = guardWrites(op.client);
    // Outside any call scope there is no signal to have fired: the write runs.
    await guarded.createLogin('v', 'Outside', 'u', 'p');
    await guarded.getItem('Stripe Live Key');
    expect(op.calls).toEqual(['createLogin:Outside', 'getItem']);
  });
});

describe('the confirmed lists match the vendored tree', () => {
  it('names every tool that calls requestConfirmation, and nothing else', () => {
    const dir = join(__dirname, '..', 'shared', 'src', 'tools');
    const eliciting: string[] = [];
    for (const file of readdirSync(dir)) {
      const source = readFileSync(join(dir, file), 'utf8');
      if (!/requestConfirmation\(/.test(source)) continue;
      const name = source.match(/'com\.pulsemcp\/tool-name':\s*'([^']+)'/)?.[1];
      expect(name, `${file} elicits but names no tool`).toBeTruthy();
      eliciting.push(name!);
    }
    expect([...REVEAL_TOOLS, ...WRITE_TOOLS].sort()).toEqual(eliciting.sort());
  });
});
