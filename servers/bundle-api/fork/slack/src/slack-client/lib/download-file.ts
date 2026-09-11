/**
 * Opens a Slack file for STREAMING.
 *
 * Slack's url_private requires the bot token in the Authorization header.
 *
 * This returns the open response rather than a Buffer on purpose. The bytes are
 * piped from Slack to the caller without ever being fully resident: a 39MB zip
 * costs no more memory here than a 39KB screenshot, and the 1GB container this
 * mount runs on is not sized for `arrayBuffer()` on an attachment of unknown
 * size. The caller pipes `body` and never awaits the whole of it.
 *
 * REDIRECTS ARE NOT FOLLOWED. `redirect: 'manual'` because undici strips the
 * Authorization header on a cross-origin hop — so a followed redirect would
 * arrive at Slack's CDN unauthenticated and return a login page with a 200,
 * which the caller would happily stream as if it were the file. A redirect is
 * surfaced as a failure to be looked at rather than silently chased.
 */
export interface SlackFileStream {
  body: ReadableStream<Uint8Array>;
  contentType?: string;
  contentLength?: number;
}

export async function openFile(
  headers: Record<string, string>,
  fileUrl: string
): Promise<SlackFileStream> {
  const response = await fetch(fileUrl, {
    method: 'GET',
    headers,
    redirect: 'manual',
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      `Slack redirected the file download (${response.status}). The bot token is not being ` +
        `honoured on that URL; refusing to follow, because the redirect target would be fetched ` +
        `without it.`
    );
  }

  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error('Slack returned no body for this file.');
  }

  const length = Number(response.headers.get('content-length'));

  return {
    body: response.body,
    contentType: response.headers.get('content-type') ?? undefined,
    contentLength: Number.isFinite(length) && length > 0 ? length : undefined,
  };
}
