import { logs, SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import { errorKind } from "./redact.ts";

/**
 * strad's own structured events, on stdout AND in the obs stack.
 *
 * ## Why this exists, and why it did not before
 *
 * strad exported metrics and traces and deliberately no logs. The reasoning was
 * sound: stdout carries upstream error messages — arbitrary text strad did not
 * author — and shipping the stream wholesale would drive straight through the
 * boundary in redact.ts.
 *
 * The cost of that came due. The `secrets` slug served zero tools in production
 * for over a week; `mcp.list_tools_failed` named the failure on every single
 * request, and went to a stream with no ingestor. On App Platform, a log nobody
 * ships is a log nobody reads.
 *
 * So the answer is not "ship stdout" and it is not "ship nothing". It is: ship
 * the events strad AUTHORS, field by field, against an ALLOWLIST.
 *
 * ## The allowlist is the whole design
 *
 * `EXPORTABLE` names every event that may leave the process and, for each, the
 * exact fields that may go with it. A field not on the list is not exported —
 * not truncated, not redacted, not included. That is deliberate:
 *
 *   - It is a DENY-BY-DEFAULT list. A new field added to an existing log call
 *     does not silently start being exported, so nobody widens this boundary by
 *     editing an unrelated line. The exporter cannot leak a field its author
 *     never considered, because considering it is how a field gets on the list.
 *   - `error` is on NO list. Every upstream error message in this codebase lands
 *     in a field of that name, and the one that mattered here was a full HTML
 *     page from someone else's Express. Where an event carries one, the exporter
 *     substitutes `error.kind` — the classification from redact.ts, which is one
 *     of a fixed set of words strad wrote.
 *
 * Everything still goes to stdout in full, unchanged. An operator with a shell
 * sees the upstream's own words; the ingestor sees strad's.
 *
 * ## What is deliberately NOT on the list
 *
 * `NOT_EXPORTED`, below — a second table, keyed the same way, whose values are
 * the REASON. An event's absence from the allowlist otherwise reads the same
 * whether it is a redaction verdict or nobody looking, and those are not the
 * same fact. Every `evt:` literal under `src/` appears in exactly one of the two
 * tables, and `test/telemetry.event-export-decisions.test.ts` fails the build
 * for one that appears in both or in neither.
 */

/**
 * evt -> the fields that may be exported with it.
 *
 * Add an event here only if you can say, for each field, WHERE ITS VALUE COMES
 * FROM at every call site that emits it. That is the part this table cannot
 * check for you: it guarantees which KEYS ship, never what is under them. A slug
 * that came from the config is ours. The same field populated from
 * `req.query.servers` is the caller's, and `mcp.unavailable` shipped exactly
 * that until a review caught it — a client could write any string it liked into
 * the ingestor by asking for a server that does not exist.
 *
 * The rule of thumb that survives that: a value is exportable if a hostile
 * client and a broken upstream can BOTH only ever cause it to take one of a set
 * of values this repo wrote down. A count is safe. A word from a closed set is
 * safe. A string that reached us over the wire is not, however harmless it looks.
 *
 * Keys are also globally consistent in TYPE across events, because an ingestor
 * that derives a schema (Elasticsearch and friends) treats the second type for a
 * key as a mapping conflict and drops the record. Hence `tool_count` and
 * `server_count` rather than reusing `tools` and `servers`, which are arrays
 * elsewhere in this table.
 */
export const EXPORTABLE: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    /** Boot. The roster proves which build is running and what it mounted. */
    "strad.listening": ["port", "mode", "bundle", "env", "servers", "tokens"],
    /**
     * THE line this whole change exists for. `error` is excluded; see above.
     *
     * `attempts` and `retry` come from the HTTP adapter's listing retry
     * (`listRetryOutcome` in gateway/adapters/http.ts): a count strad made,
     * and one of four words this repo wrote (`budget`, `deadline`,
     * `not_transient`, `closed`). Absent for an adapter kind with no retry.
     *
     * `status`, `rpc_code` and `error_class` say what KIND of failure it was
     * (`listFailureDetail` in gateway/adapters/http.ts, #475): the HTTP status
     * and the JSON-RPC error code as integers, and the error's class from a
     * closed set this repo wrote, else `other`. Numbers and class names, never
     * the upstream's text — but enough to tell a `404` from a `-32603` from a
     * dropped socket without stderr. `status` is the same integer key the
     * store and connector records use.
     */
    "mcp.list_tools_failed": [
      "slug",
      "explicit",
      "attempts",
      "retry",
      "status",
      "rpc_code",
      "error_class",
    ],
    "mcp.list_resources_failed": [
      "slug",
      "attempts",
      "retry",
      "status",
      "rpc_code",
      "error_class",
    ],
    /**
     * One transient listing failure the adapter's retry budget absorbed, at
     * Info (gateway/adapters/http.ts). NOT a fault: a slug that is still
     * failing when the budget is spent emits its `_failed` record and that is
     * what pages. This one says how often a listing is rescued, and whether a
     * `_failed` that paged came at the end of a spent budget or never entered
     * one.
     *
     * `slug` is the adapter's own, from the config. `listing` is one of three
     * words this repo wrote (`tools`, `resources`, `events`). `attempt` and
     * `delay_ms` are numbers strad computed from its own budget. `error` is
     * not shipped; it becomes `error.kind`, as on the `_failed` records.
     *
     * Throttled per slug like the `_failed` records, so the exported stream
     * holds at most one of these a minute per slug; the counts on `_failed`
     * are what answer "was this one retried".
     */
    "mcp.list_retry": ["slug", "listing", "attempt", "delay_ms"],
    /**
     * A `local-tunnel` slug that served its troubleshooting tool instead of its
     * own, because its machine was not answering.
     *
     * Deliberately NOT a `_failed` event: nothing failed. It answers "how often
     * is the laptop actually there", which is the only operational question
     * this kind of server raises, and it does so without implying an incident.
     * That is load-bearing rather than tidy — the same condition reported as
     * `mcp.list_tools_failed` ships at ERROR severity and pages an alert rule
     * keyed on it, which is what happened before this event covered every path.
     *
     * `explicit` says whether a client named the slug, and is the one field the
     * older `_failed` record carried that would otherwise be lost. It is a
     * boolean strad computes, not a value from the wire. `state` is a closed
     * set of strad's own words — `offline` or `refused` — and it is the one
     * field here worth alerting on: a machine that is off is somebody's laptop,
     * and one that REFUSES is a credential that has gone stale and will not fix
     * itself. `listed` says whether the slug's own tools made it into the
     * listing, which for this event is always false.
     */
    "mcp.local_machine_offline": ["slug", "listed", "explicit", "state"],
    /**
     * Slugs the `mcp.json` dialect attached with no entitlements.
     *
     * `mcp.json` is a single-principal file and has no notion of who a server
     * is for, so a pasted entry with no `strad: { entitlements: [...] }` gets
     * `[]` — fail closed, and reachable by nobody. That is the right VALUE and
     * a silent one, which on a gateway is indistinguishable from a routing bug
     * nobody has noticed. It ships at Info, not as a fault: nothing is broken,
     * a human has a line to write. The slugs are the config's own, and the
     * config is ours. See src/config/mcp-json.ts.
     */
    "strad.mcp_json_unentitled": ["slugs"],
    /** A slug that is mounted and serving nothing. */
    "strad.tool_surface_degraded": ["slug", "state", "reason"],
    "strad.tool_surface_recovered": ["slug", "tool_count"],
    /**
     * A `local-tunnel` slug whose machine is switched off.
     *
     * Its own event rather than a `_degraded` one with a gentler `state`, and
     * the split is the point: `_degraded` is what an alert rule keys on and what
     * a human reads as "go and look at this". A laptop being off is neither, so
     * it ships at Info under a name nothing pages on — while still answering
     * "how often is that machine actually there", which is the only operational
     * question this kind raises.
     */
    "strad.tool_surface_offline": ["slug", "kind"],
    /**
     * A slug waiting on a `mayBeUnseeded:` credential nobody has seeded yet.
     *
     * Its own event, at Info, for the same reason `_offline` has one: `_degraded`
     * is what an alert rule keys on, and a deploy that shipped ahead of a token
     * on purpose is not something to page a human about at 3am. What it IS is a
     * thing a human finishes later, so it still ships — "which slugs are still
     * waiting" is the operational question this feature creates.
     *
     * `names` is the list of `${NAME}`s, which strad's own config authored. No
     * value, and nothing from an upstream.
     */
    "strad.tool_surface_unconfigured": ["slug", "kind", "names"],
    "strad.tool_surface": [
      "server_count",
      "serving_count",
      "degraded",
      "unconfigured",
    ],
    /**
     * A bundle reports a slug's mount degraded — it lists its tools and says
     * its calls will fail — or serving again. From the tool-surface monitor,
     * in core, on change only (gateway/reachability.ts).
     *
     * The bundle's own words are the thing to keep out, and they never get this
     * far: its `degraded` value is `login failed: ${error.message}` and the
     * like, and `parseBundleHealth` (gateway/mount-health.ts) reads it for its
     * truthiness and drops it. Where each field comes from, at the one call
     * site that emits it: `slug` and `bundle` are the CONFIG's own
     * `supplementary-image` entry — a bundle's reported slugs and paths are
     * only matched against the config's, never copied out — and `state` is a
     * `MountState`, one of two words this repo wrote (`degraded`, `ok`). The
     * `reason` on a degraded payload is strad's own constant sentence, for the
     * stream; it is not on this list, because it says nothing a query needs.
     *
     * Info, not a `_degraded` fault, on purpose: one bit cannot tell a failed
     * login from a credential a human deferred, and a deferred credential is
     * documented as paging nobody. `strad.mcp.mount_degraded` is the channel
     * to alert on, scoped by slug.
     */
    "strad.mount_state": ["slug", "bundle", "state"],
    /**
     * A bundle's report on its mounts became unreadable, or readable again.
     *
     * Worth a record because in between, `strad.mcp.mount_degraded` holds its
     * last value for that bundle's slugs. `bundle` is from the config; `outcome`
     * is a `BundleReportOutcome`, a closed set of this repo's words
     * (`ok`, `unreachable`, `unrecognised`, `unwired`). No status line, no body.
     */
    "strad.mount_report": ["bundle", "outcome"],
    /**
     * A slug that could not be listed because a `mayBeUnseeded:` credential has
     * not been seeded yet.
     *
     * Its own event, at Info, so `mcp.list_tools_failed` and
     * `mcp.list_resources_failed` keep meaning "a fault" — see the branches in
     * gateway/mcpServer.ts. `names` comes from strad's own config; there is no
     * value in it and nothing from an upstream.
     */
    "mcp.server_unconfigured": ["slug", "explicit", "names"],
    /**
     * 424 fail-closed. `requested` and the raw `unavailable` list are NOT here:
     * both are the caller's own query string, echoed back. What ships is the
     * subset that names a CONFIGURED slug plus counts — enough to see "a client
     * keeps asking for `secrets` and being refused", which is the operational
     * question, with nothing a caller can write into.
     */
    "mcp.unavailable": [
      "principal",
      "requested_count",
      "unavailable",
      "unknown_count",
    ],
    /** Entries of the config's own `tools.allow`, not the upstream's names. */
    "mcp.policy_unmatched_tools": ["slug", "tools"],
    /**
     * A `tools/call` the capability policy withheld. ONE FIELD, and the two the
     * payload also carries are the interesting part.
     *
     * `slug` is `parsed.slug`, which by the line that emits this
     * (gateway/mcpServer.ts) has survived `selected.includes()` and
     * `registry.get()` — so it is one of the CONFIG's own slugs by the time it
     * is logged, not the raw string that came off the wire.
     *
     * `tool` is `parsed.tool` — everything the caller wrote after the `__` in
     * `request.params.name`, free text validated against nothing. A client could
     * write any string it liked into the ingestor by calling a tool that does
     * not exist. It stays on the stream, where an operator diagnosing "which
     * tool did they want" can read it.
     *
     * `principal` is off the list for a reason that is NOT the hostile-client
     * half of the rule, and it is the one a per-field trace has to reach the
     * call site to see. `buildGatewayServer` serves two doors: from router.ts
     * this field is the token record's `pubid`, read out of the store, which is
     * what `mcp.unavailable` exports. From ui/playground.ts it is
     * `consolePrincipal(res).id` — a Google OIDC `sub` for the signed-in human
     * (auth/session.ts). The capability check is in the shared half, so the
     * same event carries both, and a person's account identifier is not a value
     * this repo wrote down. One entry cannot say "ours here, theirs there", so
     * the field does not ship.
     *
     * What is lost with `tool` is answered by `strad.mcp.tool_denials`, which
     * counts refusals per slug — the same move `strad.mcp.auth_failures` makes
     * for `mcp.auth_failed`, and the reason the counter and this entry belong in
     * one edit: a policy refusal that reaches no counter and no record is dark
     * in both channels.
     */
    "mcp.tool_denied": ["slug"],
    /**
     * One selected slug's `events/list` failed, so its event types are missing
     * from the union (src/gateway/events.ts). `slug` has matched the request's
     * selection, so it is one of the config's own slugs; the upstream's message
     * is not carried at all. `attempts`, `retry`, `status`, `rpc_code` and
     * `error_class` are the same closed-set and integer fields the
     * `mcp.list_*_failed` records carry, from the same adapter retry.
     */
    "mcp.events_list_failed": [
      "slug",
      "attempts",
      "retry",
      "status",
      "rpc_code",
      "error_class",
    ],
    /**
     * A flow-through call refused for sending a value other than the one its
     * grant pins (src/config/reach.ts). `slug` has matched the selection and
     * `argument` is a KEY of the grant's own `pin:` map or the literal
     * `(undeclared)`, so both are words this repo or the config wrote down.
     * The value that was sent never appears, nor an undeclared argument's name.
     */
    "mcp.pin_refused": ["slug", "argument"],
    /**
     * `/_strad/reach` refused a component-authenticated caller. No fields: the
     * slug in the path is the caller's own bytes until it has matched, which a
     * refusal means it did not. Same shape as `strad.param_refused`.
     */
    "mcp.reach_refused": [],
    /**
     * A token issued by strad's own authorization server (src/http/oauth.ts).
     *
     * Both fields are closed sets this repo wrote down. `grant` is the literal
     * `"authorization_code"` or `"refresh_token"` from the two call sites, not
     * the `grant_type` the caller sent — an unsupported one never reaches here.
     * `client` is the six-byte id minted at registration
     * (`src/auth/mcp-oauth/clients.ts`), which is ours and is not the client id
     * the holder presents: that one carries the whole sealed registration. For
     * a metadata-document client it is `cimd-` and twelve hex characters of a
     * SHA-256 of the document URL (`src/auth/mcp-oauth/cimd.ts`) — derived by
     * this repo, never the caller-chosen URL itself.
     *
     * The HOLDER is absent, and deliberately. It would be a Google `sub` or an
     * email address — a person's account identifier, which is the same field
     * `mcp.tool_denied` declines to ship for the console half of its door. What
     * an operator needs from this channel is that grants are being issued and
     * refreshed at all; who holds them is a question for a console, not an
     * ingestor.
     */
    "mcp_oauth.granted": ["grant", "client"],
    /**
     * A refusal on the far side of a completed Google sign-in: the Workspace
     * domain check, a human pressing Deny, or a grant Google will no longer
     * refresh.
     *
     * `reason` is one of four words this repo authors. It ships where
     * `mcp_oauth.refused` does not because producing one costs a real sign-in
     * at accounts.google.com — the queue-starvation argument that keeps every
     * pre-authentication refusal off this list cannot reach a route you have to
     * authenticate to Google to get to. And it is the record that matters: a
     * `wrong_domain` run is either a person using the wrong account or a
     * deployment pointed at the wrong Workspace, and neither is visible
     * anywhere else.
     */
    "mcp_oauth.denied": ["reason"],
    /**
     * A token revoked through `/oauth/revoke` (RFC 7009). `token` is `access`,
     * `child` (a token-exchange child, with its validated `label` when it has
     * one — see `mcp_oauth.exchange`), `refresh` (a record-backed grant) or
     * `legacy_refresh` (a stateless one).
     * `outcome` is `ok`, `unknown` (no record to revoke), or — without grant
     * records, where revocation happens at Google — `failed`, which means a
     * grant the holder believes is dead is still live until the call is
     * retried, and is the one thing about this endpoint worth an alert.
     */
    "mcp_oauth.revoked": ["token", "outcome", "label"],
    /**
     * An RFC 8693 token exchange (`exchangeGrant` in src/http/oauth.ts),
     * issued or refused AFTER the client's `private_key_jwt` assertion
     * verified — a refusal before that is `mcp_oauth.refused` and does not
     * ship, so producing one of these costs the client's private key and a
     * live access token, and the volume argument does not reach it.
     *
     * `outcome` is `issued` or `refused`; `reason` is a closed set the
     * handler wrote (`exchange`, `child_cap`, `scope_beyond`,
     * `subject_dead`, …); `client` is the derived handle `mcp_oauth.granted`
     * ships; `slug_count` and `ttl_seconds` are numbers this server computed.
     *
     * `label` is the ONE client-authored string on this list, and it is here
     * on purpose: it is how an operator finds which agent session holds which
     * child token, which is the reason it exists. What makes it safe is its
     * shape, checked before it is stored or logged (`EXCHANGE_LABEL`): at
     * most 64 characters of `A-Za-z0-9.:-`, so no strad credential (they all
     * start `strad_`) and no sealed token can be one, and nothing else on
     * this list shares the key. `mcp_oauth.revoked` carries the same
     * label, read back from the child's record, when a child is revoked.
     * No token, subject or child, is on any list.
     *
     * Not in `THROTTLED`, unlike most client-driven events: each `issued`
     * record is the label → child record an operator looks a session up by,
     * so dropping one loses the answer, and every record costs a fresh
     * single-use signed assertion from the client's own key.
     */
    "mcp_oauth.exchange": [
      "outcome",
      "reason",
      "client",
      "label",
      "slug_count",
      "ttl_seconds",
    ],
    /**
     * A server-side grant record changed state (`grant-store.ts`). `action` is
     * `created`, `upgraded`, `rotated`, `reissued` or `revoked`; `reason` is a
     * closed set this repo wrote (`consent`, `refresh`, `grace`,
     * `refresh_replay`, `code_replay`, `console`, …). Every one of these costs
     * a completed sign-in or a valid refresh token to produce, so the volume
     * argument that keeps pre-authentication refusals off this list does not
     * reach it — and `revoked` / `refresh_replay` is the record of a
     * suspected stolen token.
     */
    "mcp_oauth.grant": ["action", "reason"],
    /**
     * The grant store could not be read or written at `stage`. Record-backed
     * grants are failing closed while this fires.
     */
    "mcp_oauth.grant_store_unavailable": ["stage"],
    /** Secrets plumbing, where a silent failure has the same shape as this one. */
    "strad.secrets_hydrated": ["provider", "keys"],
    /**
     * A server persisted a rotated credential, or failed to.
     *
     * Both fields come from the CONFIG — `writableTarget` returns the config's
     * own strings for exactly this reason, so a caller cannot write a slug or a
     * variable name of its choosing into the ingestor by spelling a URL. The
     * failure event carries no `error`: what an operator needs is that this
     * server's next restart is now holding a dead credential, and the store
     * client's exception can quote a rendered value. What it carries instead is
     * `reason`, from a closed set this repo wrote (`WriteBackRefusal` in
     * src/http/params.ts), and the store's numeric HTTP `status` when one
     * answered — enough to tell a 403 from an outage without core's stderr.
     */
    "strad.param_written": ["slug", "variable"],
    "strad.param_write_failed": ["slug", "variable", "reason", "status"],
    /**
     * The `/mcp` system-token roster changed, or could not be read.
     *
     * `pubid` is the non-secret half of a token by construction (`mintToken` in
     * src/auth/tokens.ts makes it from `randomBytes`, and it is the only part of
     * a token that is ever written down). It is never the label and never the
     * roles: a label is typed by a human into a console field, and roles are
     * offered from a closed set but arrive on a form, so neither is a value this
     * repo wrote down. What an operator needs from the ingestor is that a
     * credential was minted or revoked and which one — a record they can then
     * look up on the console page, where the label is.
     *
     * `strad.token_store_unavailable` carries NOTHING, and that is the point: it
     * fires when /mcp is rejecting every request because the records could not be
     * read, and everything that could say more is either the caller's bytes or
     * the store client's own text. The fact is the signal.
     */
    "strad.token_minted": ["pubid"],
    "strad.token_revoked": ["pubid"],
    "strad.token_forgotten": ["pubid"],
    "strad.token_write_failed": [],
    "strad.token_store_unavailable": [],
    /**
     * A `remote-http` server with `oauthRefresh:` minted an upstream access
     * token, or failed to. `slug` is the config's; `rotated` is whether the
     * token endpoint issued a new refresh token with it; `reason` is one of the
     * four `RefreshFailure` words strad wrote (gateway/adapters/oauth-refresh.ts).
     * Never a token, and never the endpoint's own error text.
     */
    "strad.upstream_token_refreshed": ["slug", "rotated"],
    "strad.upstream_token_refresh_failed": ["slug", "reason"],
    /**
     * A component asked core to drop its reading of the parameter store — the
     * `secrets` MCP server's `refresh_gateway` tool, or its write tools after a
     * write. `refreshed` is false when the floor held the request off: the
     * reading was younger than the floor and was left alone.
     */
    "strad.store_refreshed": ["refreshed"],
    /**
     * A hosted server read the CURRENT value of one of its own parameters —
     * either the once-at-boot read a `paramsWritable:` server does, or a
     * `paramsRefresh:` poll.
     *
     * This is the deploy record that runtime refresh would otherwise not have.
     * Baking a credential into a spec leaves a rendered artifact an operator can
     * read back mid-incident; re-reading one under a running process leaves
     * nothing, unless this says so. Same two config-owned fields as the writes
     * above, and emphatically not the value.
     */
    "strad.param_read": ["slug", "variable"],
    /**
     * THE EVENT NAME AND NOTHING ELSE, for the same reason the two above carry
     * config strings only: this one fires when the lookup FAILED, so the only
     * slug and variable in scope are the caller's own bytes. A refusal is
     * usually a typo'd `paramsWritable:` entry, and "this is happening at all"
     * is the operational fact; core's stderr carries which name.
     */
    "strad.param_refused": [],
    /**
     * strad-hostd's custody server deposited a secret through
     * `POST /_strad/deposit` (src/http/deposit.ts), or tried to.
     *
     * `caller` is the depositing `local-tunnel` entry's slug, from the CONFIG —
     * the one matched by its derived bearer. The TARGET slug and variable are
     * the caller's own bytes and go to core's stderr only, for the reason
     * `strad.param_refused` gives. `status` is the store's HTTP status on a
     * failed create. A refused bearer carries nothing.
     */
    "strad.deposit_written": ["caller"],
    "strad.deposit_failed": ["caller", "status"],
    "strad.deposit_refused": [],
    /**
     * A bundle read a store-served INSTANCE's credentials through core
     * (src/http/instances.ts) — the record a runtime-created mount would
     * otherwise not leave, since nothing about it is in a rendered spec. It
     * fires on EVERY sync, once per instance, so it is a heartbeat per instance
     * as much as a record; the sync floor is what bounds its volume.
     *
     * `slug` and `tree` come from the CONFIG (the entry's own slug and the tree
     * its path names), never from the URL; `variables` is how many usable
     * values the namespace held. Never a name and never a value.
     *
     * `strad.instance_refused` carries nothing, for the reason
     * `strad.param_refused` does: the only slug in scope is the caller's bytes.
     */
    "strad.instance_read": ["slug", "tree", "variables"],
    "strad.instance_read_failed": ["slug"],
    "strad.instance_refused": [],
    /**
     * The console connector flow: a human consenting, in strad's own UI, to
     * hand one server slug a credential for their Google account.
     *
     * `slug` and `variable` come from the CONFIG — the flow reads the slug out
     * of sealed state and the variable out of that server's `oauth:` block, and
     * neither is ever taken from a request, so a caller cannot write a string of
     * its choosing into the ingestor. `reason` on `_refused` is a refusal code
     * from a closed set of strad's own words: a ConnectorErrorCode
     * (`account_mismatch`, `scope_not_granted`, …) or `store_failed`.
     *
     * What is NOT here is the whole point. No token, no code, no client secret,
     * no email, no length, no fingerprint — and no upstream text: Google's error
     * bodies are read for nothing, so a refusal ships the classification and
     * stops. `strad.connector_refused` on a rising edge is the operational
     * signal (a token that will not rotate is a server about to go dark), and the
     * reason is enough to tell "wrong account" from "the store is down".
     *
     * `_connect_failed` is the DEPLOYMENT failing to carry a connect through, at
     * either end — `stage` is `begin` (the POST behind the button) or `callback`
     * — rather than a consent being refused: no public URL, no session key, a
     * connector that is not ready, or an OAuth client the console could not
     * read. `reason` is one of those, from a closed set in src/ui/connector.ts.
     * A `remote-http` Connect adds its discovery words to the same set
     * (`metadata_blocked`, `registration_confidential`, `no_client`, …, the
     * `UpstreamErrorCode`s in src/connectors/upstream.ts), each strad's own;
     * `status` is then the HTTP status that decided it.
     * It ends `_failed`, and so ships at ERROR, because the human did nothing
     * wrong in any of those branches.
     *
     * On a client read (`reason: client_unreadable`), `variable` is the
     * config's name for the value that could not be read and `failure` is a
     * closed word (`denied`, `not_found`, `unreadable`, `timeout`, `store`,
     * `credential`, `unexpected`). `status` is the store's HTTP status as a
     * NUMBER, never its status text: the upstream picks it, but a bounded
     * integer carries no text and no value, and it is the difference between a
     * missing grant (403) and a store that is down (5xx). The store's own
     * summary names the Secret Manager resource, and it rides under `error`,
     * which is on no list: it stays on stderr beside the rest of the payload.
     */
    "strad.connector_begin": ["slug"],
    "strad.connector_connected": ["slug", "variable"],
    "strad.connector_refused": ["slug", "reason"],
    "strad.connector_connect_failed": [
      "slug",
      "stage",
      "reason",
      "variable",
      "failure",
      "status",
    ],
    /**
     * The console repairing its OWN read access to one slug's OAuth client —
     * the button behind a `client_unreadable` refusal.
     *
     * `variable` is the config's name for the half being granted, and `result`
     * is `granted` (the IAM policy was written) or `already` (it already carried
     * the member). This is a deliberate widening of what the console's service
     * account can read, on two named secrets, so it is a record an operator
     * should be able to find later without reading stderr.
     *
     * `_grant_failed` ships at ERROR and carries `reason` from a closed set in
     * src/ui/connector.ts. The one worth knowing is `denied`: the binding was
     * written, the store took it, and the value still could not be read — an IAM
     * deny policy, evaluated before allow, is what that looks like. `failure`
     * and `status` are the SAME closed vocabulary `_connect_failed` uses for a
     * client read, because the same function classifies both.
     *
     * NO VALUE, and none of the shapes of one. The store reads the client back
     * to verify the grant and drops it; only the boolean reaches here.
     */
    "strad.connector_client_granted": ["slug", "variable", "result"],
    "strad.connector_client_grant_failed": [
      "slug",
      "reason",
      "variable",
      "failure",
      "status",
    ],
    /**
     * The runtime server roster changed, and the two ways it can.
     *
     * `config_applied` is a human pressing Save in the console;
     * `config_reloaded` is this process picking up a change another one wrote.
     * Both ship the resulting slug list, because "which servers does this
     * gateway serve" is the question an incident asks and `strad.listening`
     * only answers it at boot — after the first console edit that line is
     * stale, and this pair is what keeps the answer current.
     *
     * WHO made the change is deliberately absent. It is a console identity, a
     * person's email, and the stored overlay already carries it for the console
     * to display; the ingestor gets the shape of the change and not the name.
     *
     * `reason` on the failure is a closed vocabulary computed here —
     * `unreadable`, `invalid`, `rebuild_failed` — never an exception's text: a
     * parameter-store client's error can quote a rendered value, and a schema
     * issue can quote a header. Both stay on stderr.
     */
    "strad.config_applied": ["revision", "servers", "upserts", "removals"],
    "strad.config_reloaded": ["revision", "servers"],
    "strad.config_reload_failed": ["reason", "revision"],
    /** Clean SIGTERM or an OOM kill — the difference is one line, or its absence. */
    "strad.shutdown": ["signal"],
    /**
     * THE EVENT NAME AND NOTHING ELSE. All three already reduce their error to a
     * class name or a summary before logging, and all three are still text this
     * repo did not fully author — a rendered secret can end up inside a store
     * client's exception. "This surface is failing" is the operational fact and
     * it needs no field at all; the message stays on stderr for whoever is
     * holding a shell.
     */
    "strad.readiness_failed": [],
    "strad.store_diagnostics_failed": [],
    "strad.console_render_failed": [],
    /**
     * A route whose handler rejected with nothing underneath it catching —
     * emitted by the one guard every async route wears
     * (`src/http/async-route.ts`). Without that guard the same condition is a
     * container exit, so this line is the difference between "a request failed"
     * and "the component restarted", which is the operational question it
     * answers.
     *
     * `route` is a word written down at the mount site — `mcp`, `readiness`,
     * `params_write` — never a path or a slug from the wire. `error.kind` comes
     * from the same closed vocabulary CLASSIFY_ERROR uses, computed by the
     * renderer rather than substituted here, because this renderer keeps the
     * message out of `error` in the first place: an exception raised under /mcp
     * can quote a request body or an upstream's response, and neither is text
     * this repo authored. What lands in `error` is the class, and it stays on
     * stderr.
     *
     * These failures are no longer fatal, so they no longer reach the exception
     * reporter, which used to see them as unhandled rejections and carry a
     * stack. This record and the `internal_error` request outcome are what
     * replace it.
     */
    "strad.route_failed": ["route", "error.kind"],
    /**
     * The console login token (src/auth/console-tokens.ts): minted by a
     * standing credential, exchanged once for a console session, revoked.
     *
     * `jti` is the token's PUBLIC half — 16 hex characters strad generated, the
     * lookup key and never the secret. Every one of these events is emitted
     * only for a jti strad itself minted and holds: a mint, an exchange that
     * succeeded, a revoke that found its record, and a refusal of a token whose
     * SECRET verified. A caller cannot put a string of its choosing here.
     * `minted_by` is `Principal["kind"]`, a closed set. `state` is a word from
     * the store's own refusal vocabulary (`token_consumed`, `token_revoked`,
     * `token_expired`, `burned_in_query`) or, on a revoke, its status.
     *
     * `console.token_exchange_failed` is the tripwire, and it ships at ERROR
     * for that reason: a real token presented after somebody else consumed it,
     * or after it was revoked, is either a broken automation or a stolen token.
     * It is throttled per jti and state — a thief replaying one token cannot
     * flood the queue, and a `burned_in_query` does not hide the
     * `token_consumed` that follows it. The buckets are bounded by how many
     * tokens ever tripped it in this process's life, each minted by a standing
     * credential.
     */
    "console.token_minted": ["jti", "minted_by"],
    "console.token_exchanged": ["jti"],
    "console.token_exchange_failed": ["jti", "state"],
    "console.token_revoked": ["jti", "state"],
    /**
     * THE EVENT NAME AND NOTHING ELSE — and the empty list is the whole verdict.
     *
     * It says the strad image's exporter came up, which nothing else in the
     * ingestor says on its own. Core's next exported record is
     * `strad.listening`, and between the two sits `Registry.build` — every
     * stdio process spawned, every remote upstream connected. A boot that dies
     * in there leaves a running exporter and no record at all, so "the
     * container never started" and "the container started, telemetry was fine,
     * and boot died mounting a server" are the same silence. With this on the
     * list they are not: one of them has a `telemetry.started` and nothing
     * after it.
     *
     * It reaches the ingestor from the strad image ALONE, and the entry claims
     * nothing wider. The bundle and every supplementary image boot through
     * `telemetry/bundle/instrument.mjs`, which configures a trace exporter and a
     * metric reader and NO log record processor, so those containers ship no log
     * records at all and their copy of this line is a `console.log`.
     *
     * Its five fields are all strad's own — `service`, `component` and
     * `environment` are read off the env by `identityFromEnv`, `endpoint` is
     * `OTEL_EXPORTER_OTLP_ENDPOINT` with its userinfo and query stripped, and
     * `browser` is a flag this repo passes — and not one of them is exported,
     * because not one of them adds anything to the record that would carry it.
     * `service`, `component` and `environment` are already resource attributes
     * of every exported record (`service.name`, `strad.component`,
     * `deployment.environment`; see resource.ts), so exporting them again is a
     * second spelling of the same field. A record that ARRIVED has proved its
     * own endpoint. And `browser` belongs to the Chromium observables it
     * installs, which report themselves. The same reasoning that keeps `reason`
     * off `strad.mount_state`: they say nothing a query needs.
     *
     * `telemetry.disabled` and `telemetry.start_failed` come out of the same
     * `log` seam and are on the other table, for a reason no allowlist entry
     * could fix — see there.
     */
    "telemetry.started": [],
  });

/**
 * evt -> why it does not leave the process.
 *
 * The counterpart to `EXPORTABLE`, and it exists because the two things an
 * empty slot can mean — "we decided this must not ship" and "nobody looked" —
 * look identical from here, and one of them is how a boundary erodes. Every
 * `evt:` literal under `src/` is in exactly one of the two tables, and
 * `test/telemetry.event-export-decisions.test.ts` reads the call sites as TEXT
 * to check it, so the lists are compared rather than maintained in parallel.
 *
 * An entry here is a REDACTION VERDICT. Moving one up to
 * `EXPORTABLE` takes the same per-field "where does this value come from at
 * every call site" answer that table demands, one event at a time — the rule
 * being that a hostile client and a broken upstream can BOTH only ever make the
 * value one of a set this repo wrote down.
 *
 * Four of these are the BOOT LINES, and none of them is here for a redaction
 * reason — their fields would all pass the field test. Each fires around the
 * lifecycle of the very exporter that would have to carry it: one because none
 * is configured, one because it failed to start, and the two `errors.*` because
 * `startErrorReporter` runs ahead of `startTelemetry`. It is worth saying where
 * those lines are, since an operator hunting a silent deployment goes looking
 * for them: the container console, and nowhere else.
 *
 * Both tables are held against event NAMES. Neither says an entry is
 * EFFECTIVE — an `EXPORTABLE` entry for a call site that does not go through
 * `event()`, or that runs before a logger is wired, would ship nothing at all,
 * and the four above are what that looks like. `startErrorReporter` writes
 * through its own `log` seam for exactly that reason; `startTelemetry`'s seam
 * defaults to `event()`, which is what makes `telemetry.started`'s allowlist
 * entry mean something.
 */
export const NOT_EXPORTED: Readonly<Record<string, string>> = Object.freeze({
  "console.token_login_refused":
    "The unauthenticated half of the console token exchange: a garbled, " +
    "unknown or wrong-secret token, or none at all. Its one field, `reason`, " +
    "is a closed set, but anyone who can reach the route produces one record " +
    "per request — mcp.auth_failed's queue-starvation argument, on the console " +
    "door. A refusal of a token whose secret DID verify is a different event, " +
    "console.token_exchange_failed, and that one ships.",
  "mcp.events_forbidden":
    "An events/poll naming an event whose server the request did not select. " +
    "The only field is `principal`, which is a token pubid through /mcp, and " +
    "the event name the caller sent is its own bytes and is not recorded at " +
    "all. Client-driven, one per refused poll, so it would be the queue-" +
    "starvation shape too; the refusal itself is the caller's answer.",
  "mcp.auth_failed":
    "Its attributes are safe — `reason` is a closed set — but it is emitted " +
    "BEFORE authentication succeeds, so anyone who can reach /mcp produces one " +
    "exported record per request. A bot spraying bad bearer tokens would fill " +
    "the batch queue and evict mcp.list_tools_failed, which is the one signal " +
    "this file exists to deliver. strad.mcp.auth_failures already counts the " +
    "same thing, by the same `reason`, in a channel with no queue to starve.",
  "mcp_oauth.refused":
    "Every refusal on the /oauth/* routes that happens BEFORE a human has been " +
    "identified: an unregistered client_id, a redirect_uri that is not one the " +
    "client registered, a missing or `plain` PKCE challenge, an expired " +
    "transaction. Its two fields are closed sets this repo wrote down, and the " +
    "objection is the one that keeps mcp.auth_failed off the list: these are " +
    "public, unauthenticated routes, so anyone who can reach the gateway can " +
    "produce one exported record per request and evict the records this " +
    "pipeline exists to deliver. The refusals that CANNOT be sprayed — the ones " +
    "on the far side of a completed Google sign-in — are a separate event, " +
    "mcp_oauth.denied, and that one ships.",
  "mcp.request":
    "It fires on EVERY authenticated request, which is the queue-starvation " +
    "argument that keeps mcp.auth_failed off the list, one token further in. " +
    "Its fields would survive the field test — resolveSelection has already " +
    "matched every slug in `requested` against the entitled set, so an " +
    "unconfigured string never reaches this line — but the volume is the " +
    "objection. The mcp.request span carries requested and selected as " +
    "attributes, and strad.mcp.requests counts the outcomes.",
  "ui.app.tool_call":
    "The app host's twin of ui.playground.tool_call, and it stays for the " +
    "same reason: `tool` arrives from a page the SERVER wrote, so it is not a " +
    "word from a set this repo wrote down, and strad.mcp.tool_calls already " +
    "carries the call with strad.surface=app.",
  "ui.playground.tool_call":
    "Two of its three fields are ours — `server` is the slug the console route " +
    "resolved out of the config, `principal` is the console session's id — and " +
    "`tool` is not: a human types it into a text field, so it is not a word " +
    "from a set this repo wrote down. That leaves a slug-only shape, which is " +
    "the reason this one stays put rather than following mcp.tool_denied up: " +
    "strad.mcp.tool_calls already carries this call with strad.surface=" +
    "playground and mcp.server, in a channel with no queue to starve, so an " +
    "export minus `tool` would be a second spelling of a metric that is " +
    "already there. The name is the only thing it would add, and the name is " +
    "the field that cannot go.",
  "telemetry.disabled":
    "It fires on the path where OTEL_EXPORTER_OTLP_ENDPOINT is unset, so there " +
    "is no exporter to carry it — which is precisely what it says. It goes " +
    "through event() like its two siblings, and event() finds no logger wired: " +
    "the verdict is structural rather than a property of the call site, and no " +
    "allowlist entry could change it.",
  "telemetry.start_failed":
    "The exporter did not come up, so on the path that matters the channel " +
    "that would carry this is the one that is missing. ONE path is not that: a " +
    "throw from startRuntimeMetrics or the browser hooks lands in the same " +
    "catch with a logger already wired, and what that record would add over " +
    "its own name is `error` — which is on no list, because a store client's " +
    "exception can quote a rendered value. Worth writing down either way: when " +
    "telemetry goes quiet, this line is on stderr and nowhere else.",
  "errors.started":
    "Its fields are safe — component, environment, release and the DSN's HOST, " +
    "all boot-time facts from config — and they are unreachable. It is emitted " +
    "through startErrorReporter's own `log` seam, and startErrorReporter runs " +
    "BEFORE startTelemetry (src/index.ts), so no log exporter exists yet: " +
    "routed through event() it would find no logger and export nothing. An " +
    "entry on the other table would be a verdict that ships no byte.",
  "errors.start_failed":
    "The same blind spot as telemetry.start_failed, one layer over: exception " +
    "reporting failed to start, and the record saying so can only go to stdout.",
});

/**
 * Events whose `error` field should become `error.kind`.
 *
 * Kept separate from the allowlist so the two rules read independently: the
 * allowlist says what MAY be exported, this says what a caught exception is
 * allowed to turn into.
 */
const CLASSIFY_ERROR = new Set([
  "mcp.list_tools_failed",
  "mcp.list_resources_failed",
  "mcp.list_retry",
]);

/** Set by startTelemetry once an SDK is running. Null means stdout only. */
let logger: Logger | null = null;

export function enableEventExport(name: string, version: string): void {
  logger = logs.getLogger(name, version);
}

export function disableEventExport(): void {
  logger = null;
}

/** Test seam: the current logger, so a test can assert it is or is not wired. */
export function eventExportEnabled(): boolean {
  return logger !== null;
}

/**
 * Events that fire on the REQUEST path, throttled per (evt, slug).
 *
 * EVERY exportable event a client can drive is here, and that is the rule rather
 * than a list of the noisy ones. `mcp.list_tools_failed` is emitted once per
 * failing slug per listing, so a client polling a 27-slug gateway can produce 27
 * records a second; `mcp.policy_unmatched_tools` fires on every `tools/list` for
 * a slug with one typo in its `tools.allow`; `mcp.unavailable` fires on every
 * 424. The batch processor's queue is shared, and a flood of one fact evicts the
 * others — which is the same argument that keeps `mcp.auth_failed` off the
 * allowlist entirely. The only difference here is that it takes a valid token.
 *
 * One record a minute per slug says exactly as much. `mcp.unavailable` carries
 * no slug, so it keys on one global bucket, which is the right granularity for
 * it anyway.
 *
 * stdout is never throttled. It has no queue to starve.
 */
const THROTTLED = new Set([
  "mcp.list_tools_failed",
  "mcp.list_resources_failed",
  // Up to two per failing listing, and a client drives listings.
  "mcp.list_retry",
  "mcp.local_machine_offline",
  // A slug waiting on a deferred credential fires this on every tools/list and
  // resources/list a client sends, for as long as the value is pending — which
  // is exactly the unbounded, client-driven shape this set exists for. Left out,
  // it would evict genuine faults from the shared batch queue.
  "mcp.server_unconfigured",
  "mcp.policy_unmatched_tools",
  "mcp.unavailable",
  // A refusal is entirely client-driven: a caller that keeps calling a withheld
  // tool produces one per request, for as long as it keeps asking. It buckets on
  // the slug, which is the whole of what the record carries — and is why the
  // payload names that field `slug` rather than `server`: the key below reads
  // `payload.slug`, so the other spelling would bucket every slug's refusals
  // into one global 60s window and hide all but the first. The count is not
  // throttled; `strad.mcp.tool_denials` is the continuous half of this pair,
  // and the record is the narration.
  "mcp.tool_denied",
  // Every events/list a client sends, for as long as one upstream cannot list.
  "mcp.events_list_failed",
  // Driven by a hosted server's own calls, one per refused call.
  "mcp.pin_refused",
  // Client-driven through the request path, though the minter's backoff
  // already holds it to one attempt per window per slug.
  "strad.upstream_token_refresh_failed",
  // A signed-in console session can press Connect as often as it likes, and
  // every press on a deployment that cannot carry it through is an ERROR
  // record. One a minute per slug says the same thing.
  "strad.connector_connect_failed",
  // The repair button beside it, pressed the same way by the same session.
  "strad.connector_client_grant_failed",
  // A handler that rejects is a bug rather than a routine refusal, so this one
  // is expected to be silent — but the surface it guards is /mcp, whose input a
  // caller controls, and "a bug a client can drive on demand" is exactly the
  // shape this set exists for. It keys on `route` rather than `slug` (see the
  // key below), so a flood on one route does not hide the first record from
  // another. stdout is not throttled.
  "strad.route_failed",
  // Only a caller holding a real token's secret can drive it, but a thief can
  // replay one token as fast as the socket allows. Keyed per jti and state.
  "console.token_exchange_failed",
]);
const THROTTLE_MS = 60_000;
const lastExported = new Map<string, number>();

/**
 * Emit one structured event.
 *
 * ALWAYS writes the full payload to stdout/stderr — those streams are the
 * operator's own console and nothing here narrows them. Then, if the event is
 * exportable and an SDK is running, ships the allowlisted subset.
 *
 * Never throws. A telemetry pipeline must not be able to break a request path,
 * and this one is called from inside the gateway's error handling.
 */
export function event(payload: Record<string, unknown>): void {
  const evt = typeof payload.evt === "string" ? payload.evt : undefined;
  // A failure or a degradation goes to stderr — including `mcp.auth_failed`,
  // which the router used to write to stdout. That is a deliberate change and
  // the only one: everything a log scraper would key on now agrees with what the
  // event is, rather than with which call site happened to emit it.
  const fault = Boolean(
    evt && (evt.endsWith("_failed") || evt.endsWith("_degraded")),
  );
  const stream = fault ? console.error : console.log;

  try {
    stream(JSON.stringify(payload));
  } catch {
    // A circular reference or a BigInt in a payload is a bug in the caller, not
    // a reason to take down the request that was already failing.
    stream(JSON.stringify({ evt, unserializable: true }));
  }

  if (!logger || !evt) return;
  const allowed = EXPORTABLE[evt];
  if (!allowed) return;

  if (THROTTLED.has(evt)) {
    // `route` beside `slug` because `strad.route_failed` carries no slug:
    // without it, one failing route's 60s bucket would swallow every other
    // route's first record. `jti` and `state` for the same reason, one event
    // over.
    const bucket =
      payload.slug ??
      payload.route ??
      (payload.jti !== undefined
        ? `${String(payload.jti)}:${String(payload.state)}`
        : "");
    const key = `${evt}:${String(bucket)}`;
    const now = Date.now();
    const last = lastExported.get(key);
    if (last !== undefined && now - last < THROTTLE_MS) return;
    lastExported.set(key, now);
  }

  try {
    logger.emit({
      // From the FAULT rule, not from CLASSIFY_ERROR — those answer different
      // questions, and conflating them shipped `strad.tool_surface_degraded`
      // and `strad.readiness_failed` at INFO. `severity >= ERROR` is the first
      // filter any operator writes, and a fault invisible to it is a fault
      // nobody sees.
      severityNumber: fault ? SeverityNumber.ERROR : SeverityNumber.INFO,
      // The event name, not the message. A body is free text and free text is
      // how an upstream's words get in; there is nothing to put here that the
      // attributes do not already say in a queryable form.
      body: evt,
      attributes: exportableAttributes(evt, payload, allowed),
    });
  } catch {
    // An export failure is not this request's problem.
  }
}

/** Test seam: the throttle is process-global and would leak between cases. */
export function resetEventThrottle(): void {
  lastExported.clear();
}

function exportableAttributes(
  evt: string,
  payload: Record<string, unknown>,
  allowed: readonly string[],
): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {
    "strad.evt": evt,
  };

  for (const key of allowed) {
    const value = payload[key];
    if (value === undefined || value === null) continue;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      out[key] = value;
    } else if (
      Array.isArray(value) &&
      value.every((v) => typeof v === "string")
    ) {
      out[key] = value as string[];
    }
    // Anything else — an object, a mixed array — is dropped rather than
    // stringified. A nested structure is exactly where an unreviewed field
    // hides, and JSON.stringify would carry it straight out.
  }

  // The classification, in place of the message. `errorKind` returns one of a
  // fixed set of words this repo wrote — "timeout", "connection", "http", … —
  // derived from the error's shape and never from its text.
  if (CLASSIFY_ERROR.has(evt) && payload.error !== undefined) {
    out["error.kind"] = errorKind(payload.error);
  }

  return out;
}
