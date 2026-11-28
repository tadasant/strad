import type { Request, RequestHandler, Response } from "express";
import type { StradConfig } from "../config/schema.ts";
import {
  CLIENT_METADATA_ROUTE_PREFIX,
  clientMetadataDocument,
} from "../connectors/upstream.ts";

/**
 * `GET /_strad/oauth/client/{slug}.json` — strad's client ID metadata document
 * for one `remote-http` Connect (draft-ietf-oauth-client-id-metadata-document).
 *
 * The client here is STRAD, signing in to an upstream's authorization server
 * from the console; src/auth/mcp-oauth/cimd.ts is the other direction, strad's
 * own authorization server reading a client's document.
 *
 * UNAUTHENTICATED, and it has to be: the reader is the upstream's
 * authorization server, which fetches this URL because it was handed it as a
 * `client_id`, and it holds no credential of strad's. What it discloses is
 * config and no secret — a client name, the console's callback, and the grant
 * shape — for a slug whose Connect would sign in with it. Every other path
 * under the prefix, and every other slug, is the same bare `404`, so the route
 * does not tell an outsider which slugs exist.
 *
 * CORE ONLY, beside the console whose callback it names. Cached briefly: the
 * document changes only on a deploy, and an authorization server may fetch it
 * on every sign-in.
 */
export const CLIENT_METADATA_ROUTE = `${CLIENT_METADATA_ROUTE_PREFIX}/:file`;

export function createClientMetadataHandler(
  config: StradConfig,
): RequestHandler {
  return (req: Request, res: Response) => {
    const file = req.params.file ?? "";
    const slug = file.endsWith(".json") ? file.slice(0, -".json".length) : "";
    const document = slug ? clientMetadataDocument(config, slug) : null;
    if (!document) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.set("Cache-Control", "public, max-age=300");
    res.json(document);
  };
}
