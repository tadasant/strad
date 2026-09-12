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
 */
export interface SlackFileStream {
  body: ReadableStream<Uint8Array>;
  contentType?: string;
  /**
   * Bytes the caller will actually receive, or undefined when that is not
   * knowable in advance. See {@link openFile} for why a header is not enough.
   */
  contentLength?: number;
}

/** Redirect hops allowed before we give up. Slack needs at most one. */
const MAX_HOPS = 3;

export async function openFile(
  headers: Record<string, string>,
  fileUrl: string
): Promise<SlackFileStream> {
  let url = fileUrl;
  let response: Response | undefined;

  // REDIRECTS ARE FOLLOWED ONLY WITHIN ONE ORIGIN, by hand.
  //
  // `redirect: 'follow'` is wrong here: undici strips the Authorization header
  // on a cross-origin hop, so the redirect target would be fetched
  // UNAUTHENTICATED and Slack would answer a sign-in page with a 200 — which
  // this function would hand back as if it were the file. Refusing every
  // redirect is wrong too: a same-origin hop keeps the header and used to work,
  // so blanket refusal would break the file classes that take one.
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    response = await fetch(url, { method: 'GET', headers, redirect: 'manual' });

    if (response.status < 300 || response.status >= 400) break;

    const location = response.headers.get('location');
    if (!location) {
      throw new Error(`Slack redirected the file download (${response.status}) with no location.`);
    }

    const next = new URL(location, url);
    if (next.origin !== new URL(url).origin) {
      throw new Error(
        `Slack redirected the file download across origins (${response.status}). Refusing to ` +
          `follow: the bot token is not sent on a cross-origin hop, so the target would be ` +
          `fetched unauthenticated and a sign-in page would be served as the file.`
      );
    }

    // The body of a redirect is not the file, and leaving it open leaks a socket.
    await response.body?.cancel();
    url = next.toString();
  }

  if (!response) throw new Error('Slack returned no response for this file.');

  if (response.status >= 300 && response.status < 400) {
    throw new Error(`Slack redirected the file download more than ${MAX_HOPS} times.`);
  }

  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error('Slack returned no body for this file.');
  }

  // A CONTENT-LENGTH IS ONLY USABLE WHEN THE BODY WAS NOT ENCODED.
  //
  // fetch asks for `gzip, deflate` and DECOMPRESSES the body, but leaves the
  // response's `content-length` describing the COMPRESSED bytes — 133 for a
  // 100,000-byte payload, measured. Passing that on sets a `Content-Length` the
  // caller's file will never reach, and Node stops writing at it: a truncated
  // file delivered under a 200 whose length header MATCHES, so nothing
  // downstream can detect the shortfall. That is precisely the "reported
  // success the caller cannot use" this whole module exists to remove.
  //
  // Undefined is a fine answer — the response is then chunked, and a transfer
  // cut short is a broken stream rather than a short file.
  const encoded = response.headers.get('content-encoding');
  const declared = Number(response.headers.get('content-length'));
  const contentLength =
    !encoded && Number.isFinite(declared) && declared > 0 ? declared : undefined;

  return {
    body: response.body,
    contentType: response.headers.get('content-type') ?? undefined,
    contentLength,
  };
}
