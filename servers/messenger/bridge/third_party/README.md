# third_party/mautrix-meta — PATCHED VENDOR

A copy of [mautrix-meta](https://github.com/mautrix/meta) **v0.2611.0**, the Go
module (`go.mau.fi/mautrix-meta`), built into `strad-messenger-bridge` through
the `replace` at the end of `../go.mod`. It is AGPL-3.0, like the bridge; its own
`LICENSE` and `LICENSE.exceptions` are kept here.

It is upstream's module byte for byte, except:

- the repository tooling a module build never reads is left out (`.github/`,
  `.gitlab-ci.yml`, `.idea/`, `.gitignore`, `.dockerignore`, `.editorconfig`,
  `.pre-commit-config.yaml`, the Dockerfiles and the `build*.sh` /
  `docker-run.sh` scripts), and
- the deltas below, each marked `strad delta` in the source.

| # | File | Delta | Why | Test |
| --- | --- | --- | --- | --- |
| D1 | `pkg/messagix/bloks/interp.go` | `bk.action.callback.Make` is evaluated exactly like `bk.action.callback.MakeWithScopeOnly`: its one argument, the callback. Both return an error instead of panicking when called with no argument | Messenger's authenticator-code (TOTP) screen wraps its Continue handler in `callback.Make`, and the stock interpreter failed the tap locally with `unimplemented function bk.action.callback.Make (1 args)`, ending the phone-app login at 2FA. Not implemented upstream as of mautrix-meta `main` at d41f1e3 (2026-11-18) | `../bloks_totp_test.go` |
| D2 | `pkg/messagix/types/device_identity.go` (new), `pkg/messagix/bloks/selenium.go`, `pkg/messagix/messengerlite.go`, `pkg/messagix/httpclient/http.go`, `pkg/messagix/httpclient/graphql.go`, `pkg/connector/connector.go`, `pkg/connector/login.go` | A `types.DeviceIdentity` (device id, family device id, Meta-issued `machine_id`, attestation key, the Android `x-fb-integrity-machine-id` placeholder, the iOS `x-meta-usdid-uuid`) can be supplied through `MetaConnector.DeviceIdentity`; a Messenger Lite login then presents it instead of minting a new device: in the Bloks browser's ids and signing key, and in the Bloks request headers that upstream re-randomises per request (`x-zero-f-device-id` / `app-scope-id-header` become the device id, as upstream's own logged-in push registration sends them). Nil keeps upstream's behaviour | Upstream makes every login a brand-new phone to Meta, and one tripped a checkpoint that forced a password change. strad keeps one device per platform (`../identity.go`) and adopts the device of the login already running. Not offered upstream | `../identity_test.go` |

## Checking the copy against upstream

```
go mod download -json go.mau.fi/mautrix-meta@v0.2611.0   # prints its "Dir"
diff -r <that Dir> third_party/mautrix-meta
```

The output is the files listed as left out above, plus each delta in the table
(D2 adds one file, `pkg/messagix/types/device_identity.go`).
Anything else is an undocumented change.

## Moving to a newer mautrix-meta

1. Copy the new release's module over this directory (drop the same tooling
   files), then re-apply every row of the table, unless the release already does
   what the row does — then delete the row and its `strad delta` comment.
2. Set the `go.mau.fi/mautrix-meta` version in `../go.mod` to the release, so
   `go mod tidy` resolves the same dependency graph upstream declared, and copy
   that release's `replace github.com/imroc/req/v3 => …` line.
3. `go mod tidy && go vet ./... && go test ./...` in `bridge/`.

CI's `gofmt -l .` walks this copy too, so a release formatted by a newer gofmt
fails it: run `gofmt -w third_party` after re-copying. That is formatting only,
and `diff -r` against upstream will show it.
