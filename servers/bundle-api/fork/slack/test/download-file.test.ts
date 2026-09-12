// `slack_download_file` and the route that honours what it mints.
//
// THE BUG THIS REPLACED. The tool used to write the attachment into this
// container's tmpdir and return `file://<path>`. On a remote gateway that path
// names nothing the caller can open, so the tool reported success and the
// session could not read the file — and, being a "success", nothing retried.
// Slack offers no pass-through URL to hand over instead: `url_private*` needs
// the bot token, and the only unauthenticated form is minted by a user-token
// method that makes the file public until somebody revokes it.
//
// So four things are pinned here, and each of them is a way the replacement
// could go quietly wrong rather than loudly:
//
//   1. The tool returns a URL, never a path. A `file://` in this output is the
//      original bug returning.
//   2. A link is honoured ONCE. The second GET is refused.
//   3. A GET that never produced bytes gives the link back, so an ordinary
//      retry is possible after a Slack failure.
//   4. The bytes STREAM. Nothing in this path awaits a whole file.
import { describe, expect, it } from 'vitest';

import { createMCPServer, type ISlackClient } from '../src/server.js';
import { downloadFileTool, type DownloadLinkConfig } from '../src/tools/download-file.js';
import { deriveKey } from '../src/download-link.js';
import type { SlackFile } from '../src/types.js';

const FILE: SlackFile = {
  id: 'F0C14TKKJUR',
  name: '2025 documents.zip',
  mimetype: 'application/zip',
  size: 39_000_000,
  url_private_download: 'https://files.slack.com/files-pri/T1-F1/download/2025.zip',
} as SlackFile;

function stubClient(over: Partial<ISlackClient> = {}): ISlackClient {
  return {
    getFileInfo: async () => FILE,
    openFile: async () => ({
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1, 2, 3]));
          c.close();
        },
      }),
      contentType: 'application/zip',
      contentLength: 3,
    }),
    ...over,
  } as ISlackClient;
}

const BOT = 'xoxb-workspace-a';

const LINK: DownloadLinkConfig = {
  publicSlug: 'slack-zimmer',
  publicBaseUrl: 'https://strad.tadasant.com',
  key: deriveKey('internal-token', 'slack-zimmer', BOT),
  ttlSeconds: 900,
};

function callTool(client: ISlackClient, ctx: { downloadLink?: DownloadLinkConfig }) {
  const tool = downloadFileTool(null as never, () => client, ctx);
  return tool.handler({ file_id: FILE.id });
}

describe('slack_download_file', () => {
  it('returns a fetchable URL on the gateway, not a local path', async () => {
    const result = await callTool(stubClient(), { downloadLink: LINK });
    const body = JSON.parse(result.content[0]!.text) as Record<string, string>;

    expect(result.isError).toBeFalsy();
    expect(body.download_url).toMatch(
      /^https:\/\/strad\.tadasant\.com\/mcp-download\/slack-zimmer\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
    );
    expect(result.content[0]!.text).not.toContain('file://');
    expect(result.content[0]!.text).not.toContain('/tmp');
  });

  it('addresses the GATEWAY slug, not the /slack mount path it is served at', async () => {
    const result = await callTool(stubClient(), { downloadLink: LINK });
    const body = JSON.parse(result.content[0]!.text) as Record<string, string>;
    expect(body.download_url).toContain('/mcp-download/slack-zimmer/');
  });

  it('reports the file metadata and an expiry the caller can act on', async () => {
    const result = await callTool(stubClient(), { downloadLink: LINK });
    const body = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

    expect(body.name).toBe('2025 documents.zip');
    expect(body.mime_type).toBe('application/zip');
    expect(body.size_bytes).toBe(39_000_000);
    expect(body.single_use).toBe(true);
    expect(Date.parse(body.expires_at as string)).toBeGreaterThan(Date.now());
  });

  // The curl line is pasted into a shell, so a filename Slack accepted is
  // untrusted input arriving at one. Two properties matter, and neither is
  // "the name looks tidy": it cannot name a path outside the cwd, and it cannot
  // end the `-o '…'` quoting and start a second command.
  it.each([
    ['a traversal', '../../etc/passwd'],
    ['a quote-escape', "x'; rm -rf ~; echo '"],
    ['a command substitution', 'y$(whoami)`id`.zip'],
    ['a leading dash that curl would read as an option', '-o /etc/passwd'],
    ['a name that is only dots', '..'],
  ])('neutralises %s in the filename it puts in the curl command', async (_label, name) => {
    const result = await callTool(stubClient({ getFileInfo: async () => ({ ...FILE, name }) as SlackFile }), {
      downloadLink: LINK,
    });
    const body = JSON.parse(result.content[0]!.text) as Record<string, string>;
    const target = /-o '([^']*)'/.exec(body.curl!)?.[1];

    // The quoting survived: there is exactly one single-quoted -o argument.
    expect(target).toBeDefined();
    // And what is inside it is one plain filename in the current directory.
    expect(target).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(target).not.toContain('/');
    // The real name is still reported faithfully; only the shell target is tamed.
    expect(body.name).toBe(name);
  });

  it('says downloads are unavailable rather than minting a URL nothing serves', async () => {
    const result = await callTool(stubClient(), {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('cannot serve');
    expect(result.content[0]!.text).not.toContain('http');
  });

  it('fails on a bad file id at mint time, not later at fetch time', async () => {
    const result = await callTool(
      stubClient({
        getFileInfo: async () => {
          throw new Error('Slack API error: file_not_found');
        },
      }),
      { downloadLink: LINK }
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('file_not_found');
  });

  it('refuses a file Slack will not serve, without minting a link for it', async () => {
    const noUrl = { ...FILE, url_private_download: undefined, url_private: undefined };
    const result = await callTool(stubClient({ getFileInfo: async () => noUrl as SlackFile }), {
      downloadLink: LINK,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('no downloadable URL');
  });
});

describe('handleDownload', () => {
  const created = () =>
    createMCPServer({
      version: 'test',
      download: {
        publicSlug: 'slack-zimmer',
        publicBaseUrl: 'https://strad.tadasant.com',
        internalToken: 'internal-token',
        workspaceToken: BOT,
      },
    });

  /** Mint through the tool, exactly as a caller would receive it. */
  async function mint(client: ISlackClient): Promise<string> {
    const result = await callTool(client, { downloadLink: LINK });
    const body = JSON.parse(result.content[0]!.text) as { download_url: string };
    return body.download_url.split('/').pop()!;
  }

  it('honours a freshly minted link and streams the body', async () => {
    const server = created();
    const client = stubClient();
    const token = await mint(client);

    const outcome = await server.handleDownload(token, () => client);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.filename).toBe('2025 documents.zip');
    expect(outcome.contentType).toBe('application/zip');
    // A ReadableStream, not a Buffer: nothing here has the whole file.
    expect(outcome.body).toBeInstanceOf(ReadableStream);

    const reader = outcome.body.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
  });

  it('refuses the SECOND use of the same link', async () => {
    const server = created();
    const client = stubClient();
    const token = await mint(client);

    expect((await server.handleDownload(token, () => client)).ok).toBe(true);

    const second = await server.handleDownload(token, () => client);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.status).toBe(403);
      expect(second.error).toContain('already been used');
    }
  });

  it('gives the link back when Slack failed, so a retry is still possible', async () => {
    const server = created();
    let attempt = 0;
    const client = stubClient({
      openFile: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('Failed to download file: 503 Service Unavailable');
        return {
          body: new ReadableStream<Uint8Array>({
            start(c) {
              c.close();
            },
          }),
          contentType: 'application/zip',
          contentLength: 0,
        };
      },
    });
    const token = await mint(client);

    await expect(server.handleDownload(token, () => client)).rejects.toThrow('503');
    // The failure was not the caller's fault, so the link survives it.
    expect((await server.handleDownload(token, () => client)).ok).toBe(true);
  });

  it('refuses a token this mount did not sign', async () => {
    const server = created();
    const client = stubClient();
    const foreign = downloadFileTool(null as never, () => client, {
      downloadLink: { ...LINK, key: deriveKey('internal-token', 'slack', BOT) },
    });
    const result = await foreign.handler({ file_id: FILE.id });
    const body = JSON.parse(result.content[0]!.text) as { download_url: string };
    const token = body.download_url.split('/').pop()!;

    const outcome = await server.handleDownload(token, () => client);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(403);
  });

  it('re-checks the file with Slack rather than trusting the link', async () => {
    const server = created();
    const client = stubClient();
    const token = await mint(client);

    // Deleted between mint and fetch.
    const gone = stubClient({
      getFileInfo: async () => ({ ...FILE, url_private_download: undefined, url_private: undefined }) as SlackFile,
    });
    const outcome = await server.handleDownload(token, () => gone);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(404);

    // And the link was NOT spent by it. Nothing was served, so a retry — the
    // natural response to a 404 — must not come back "already used", which
    // would describe the wrong problem entirely.
    expect((await server.handleDownload(token, () => client)).ok).toBe(true);
  });

  it('serves nothing at all when the deployment configured no download route', async () => {
    const server = createMCPServer({ version: 'test' });
    const outcome = await server.handleDownload('anything');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(404);
  });
});

describe('the Content-Length handed to the caller', () => {
  const created = () =>
    createMCPServer({
      version: 'test',
      download: {
        publicSlug: 'slack-zimmer',
        publicBaseUrl: 'https://strad.tadasant.com',
        internalToken: 'internal-token',
        workspaceToken: BOT,
      },
    });

  async function mintWith(client: ISlackClient): Promise<string> {
    const result = await callTool(client, { downloadLink: LINK });
    const body = JSON.parse(result.content[0]!.text) as { download_url: string };
    return body.download_url.split('/').pop()!;
  }

  // `files.info` reports the file's size; the GET reports THIS body's length.
  // Declaring the former over the latter is a malformed response — the caller
  // waits for bytes that never come, or sees a truncation that never happened.
  it('comes from the response, never from the files.info metadata', async () => {
    const client = stubClient({
      openFile: async () => ({
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.close();
          },
        }),
        contentType: 'application/zip',
        // Slack sent no content-length on this body.
        contentLength: undefined,
      }),
    });
    const token = await mintWith(client);

    const outcome = await created().handleDownload(token, () => client);
    expect(outcome.ok).toBe(true);
    // FILE.size is 39_000_000 — it must not have leaked into the framing.
    if (outcome.ok) expect(outcome.contentLength).toBeUndefined();
  });

  it('is used when the response did declare one', async () => {
    const client = stubClient();
    const token = await mintWith(client);

    const outcome = await created().handleDownload(token, () => client);
    if (outcome.ok) expect(outcome.contentLength).toBe(3);
  });
});
