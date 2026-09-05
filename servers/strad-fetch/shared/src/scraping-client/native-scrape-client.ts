/**
 * Native scraping client implementation
 * Provides basic HTTP fetching without external services
 */

import { fetch } from 'undici';
import { ContentParserFactory } from '../content-parsers/index.js';
import { assertFetchableUrl, blockedUrlCause, guardedDispatcher } from './url-guard.js';

export interface INativeScrapingClient {
  scrape(url: string, options?: NativeScrapingOptions): Promise<NativeScrapingResult>;
}

export interface NativeScrapingOptions {
  timeout?: number;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: string;
}

export interface NativeScrapingResult {
  success: boolean;
  data?: string;
  error?: string;
  statusCode?: number;
  headers?: Record<string, string>;
  contentType?: string;
  contentLength?: number;
  metadata?: Record<string, unknown>;
}

export class NativeScrapingClient implements INativeScrapingClient {
  private defaultHeaders: Record<string, string> = {
    // Identify honestly as strad, not as the upstream this is forked from: a
    // site operator who blocks or rate-limits this traffic should be able to
    // tell whose it is.
    'User-Agent': 'Mozilla/5.0 (compatible; strad-fetch/1.0; +https://strad.tadasant.com)',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate',
    'Cache-Control': 'no-cache',
  };

  private parserFactory = new ContentParserFactory();

  async scrape(url: string, options: NativeScrapingOptions = {}): Promise<NativeScrapingResult> {
    // Outside the try so a fetch that THROWS still clears it. A refusal is a
    // throw, and a timer nobody cancelled holds the event loop open for the
    // whole budget — a minute, by the tool's default.
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    try {
      // Scheme and literal address, before anything is dispatched. See
      // ./url-guard.ts — the connector behind `guardedDispatcher()` is what
      // covers the two things this call cannot see, resolved addresses and
      // redirect hops.
      // The parsed URL is what gets fetched, so the thing that was checked and
      // the thing that is dispatched cannot drift apart.
      const target = assertFetchableUrl(url);

      const controller = new AbortController();
      timeoutId = options.timeout ? setTimeout(() => controller.abort(), options.timeout) : null;

      const response = await fetch(target, {
        method: options.method || 'GET',
        headers: {
          ...this.defaultHeaders,
          ...options.headers,
        },
        body: options.body,
        signal: controller.signal,
        // undici's own `fetch`, not the global one, so the dispatcher this
        // passes is certainly the one that opens the socket.
        dispatcher: guardedDispatcher(),
      });

      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      if (!response.ok) {
        return {
          success: false,
          error: `HTTP ${response.status}: ${response.statusText}`,
          statusCode: response.status,
          headers: responseHeaders,
        };
      }

      // Get content type for routing to appropriate parser
      const contentType = response.headers.get('content-type') || 'text/plain';

      // Determine if we need binary handling
      const isBinary = this.parserFactory.requiresBinaryHandling(contentType);

      // Fetch content as ArrayBuffer or text based on content type
      const rawData = isBinary ? await response.arrayBuffer() : await response.text();

      // Parse content through appropriate parser
      const parsed = await this.parserFactory.parse(rawData, contentType);

      return {
        success: true,
        data: parsed.content,
        statusCode: response.status,
        headers: responseHeaders,
        contentType,
        contentLength: rawData instanceof ArrayBuffer ? rawData.byteLength : rawData.length,
        metadata: parsed.metadata,
      };
    } catch (error) {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      // A refusal raised in the connector arrives as `TypeError: fetch failed`
      // with the real reason as `cause`; the caller gets the reason.
      const blocked = blockedUrlCause(error);
      if (blocked) {
        return {
          success: false,
          error: blocked.message,
        };
      }

      if (error instanceof Error && error.name === 'AbortError') {
        return {
          success: false,
          error: 'Request timeout',
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
