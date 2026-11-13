# ssh — strad's SSH server

Break-glass shell and SFTP on ONE host per instance, authenticated by a private
key from the environment it is handed, against a pinned host key and nothing
else. A tree in the strad bundle image; every SSH slug is a store-served
instance of it at `/_instance/ssh/{slug}`.

It replaces the npm `ssh-agent-mcp-server` and keeps its tool names:
`ssh_connection_info`, `ssh_list_directory`, `ssh_download`, `ssh_upload`,
`ssh_execute` — plus `ssh_check_connection`, the retry an agent calls after
bringing a spun-down host back up. A host that does not answer never fails the
MCP connection: `initialize` and `tools/list` open no socket, and every tool
call that cannot reach it returns an `UNREACHABLE` error saying to bring it up
and call `ssh_check_connection` (with the slug's optional
`SSH_UNREACHABLE_HINT` quoted). The full description — setup, the pin, who may be entitled to a
slug, and what changed from upstream — is the docs page,
[`docs/servers/ssh`](../../docs/src/content/docs/servers/ssh.md).

## Layout

| File                     | What it owns                                                                      |
| ------------------------ | --------------------------------------------------------------------------------- |
| `shared/src/config.ts`   | The `SSH_*` variables, the key parse, the error that says where to seed them      |
| `shared/src/host-key.ts` | Pin parsing (keyscan line, bare key, `SHA256:` fingerprint), matching, negotiation |
| `shared/src/client.ts`   | One connection per call: the route, the pin check, exec with bounded output, SFTP |
| `shared/src/tailnet.ts`  | Which hosts are tailnet hosts, and the SOCKS5 dial through the bundle's tailscaled |
| `shared/src/tools.ts`    | The six tools and the one error path                                             |
| `shared/src/server.ts`   | `createMCPServer({ version, label, env })`, the factory the bundle host mounts    |

## Tests

```
npm ci && npm test
```

`shared/test/server.test.ts` drives the real `ssh2` client against a real SSH
server on loopback (`shared/test/fake-host.ts`: ssh2's server half, `exec` handed
to the local `sh`, SFTP served from a temp directory) through a real MCP client.
It covers a mismatched or unpinned host key being refused before any
authentication attempt, missing values refusing without connecting, the private
key appearing in no tool result, and a down host: listing that opens nothing,
the `UNREACHABLE` message on every tool, and `ssh_check_connection` going from
`unreachable` to `ok` when the host comes up, with no new MCP session.
`shared/test/tailnet.test.ts` puts a SOCKS5 proxy in front of the same host and
covers the tailnet route: a tailnet address goes through the proxy with the pin
still enforced, a public host does not, and the three tailnet failures (no
egress configured, sidecar down, tailnet could not reach the host) each say
which they are. See [`docs/operate/tailnet`](../../docs/src/content/docs/operate/tailnet.md).
