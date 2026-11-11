---
title: State store
description: The one GCS bucket every stateful strad server keeps its state in, and how its folders and keys are split.
---

strad has no database and App Platform has no persistent disk. A server that
has to remember something across a restart keeps it in **one GCS bucket**: the
state store. There is one bucket and one service account for a deployment.
Each server gets its own folder and its own encryption key.

| Consumer                                | Folder (must sit under)                           | Its own key                         | Folder variable             |
| --------------------------------------- | ------------------------------------------------- | ----------------------------------- | --------------------------- |
| [WhatsApp](/servers/whatsapp/) bridge   | `whatsapp/` (`whatsapp/prod`, `whatsapp/staging`) | `WHATSAPP_STATE_ENCRYPTION_KEY`     | `WHATSAPP_STATE_PREFIX`     |
| [Slack events](/servers/events/) ingest | `slack-events/`                                   | `SLACK_EVENTS_STATE_ENCRYPTION_KEY` | `SLACK_EVENTS_STATE_PREFIX` |

The code is one module, `src/state/store.ts`: the GCS client, the seal, the
single-writer lease and the rules on this page. Each consumer is its own npm
tree, so the module is vendored into each one (`npm run statestore:sync`) and
CI fails if a copy drifts.

## The three shared variables

| Variable                       | Kind   | What it is                                                         |
| ------------------------------ | ------ | ------------------------------------------------------------------ |
| `STRAD_STATE_GCS_BUCKET`       | config | The bucket's bare name, no `gs://`. Private.                       |
| `STRAD_STATE_GCS_CLIENT_EMAIL` | config | A service account with `roles/storage.objectAdmin` on that bucket. |
| `STRAD_STATE_GCS_PRIVATE_KEY`  | secret | That service account's `private_key` (PEM; `\n`-escaped is fine).  |

Seed them **once**, at `/strad/{env}/gateway/static/`, and reference them from
each consumer's `env:` map:

```yaml
env:
  STRAD_STATE_GCS_BUCKET: "${STRAD_STATE_GCS_BUCKET}"
  STRAD_STATE_GCS_CLIENT_EMAIL: "${STRAD_STATE_GCS_CLIENT_EMAIL}"
  STRAD_STATE_GCS_PRIVATE_KEY: "${STRAD_STATE_GCS_PRIVATE_KEY}"
```

The gateway namespace is the fallback layer for a server's `${NAME}` (see
[Secrets](/operate/secrets/#a-servers-secrets-live-in-that-servers-namespace)),
so one seeded value reaches every consumer that names it. It lands only on the
components of the slugs that name it, not on every container.

Each consumer's **key** belongs in that consumer's own namespace,
`/strad/{env}/mcp/{slug}/static/`. Never seed a key in the gateway namespace.

## Folders and keys

**A folder cannot leave its consumer's root.** The WhatsApp bridge refuses a
prefix that is not `whatsapp` or `whatsapp/…`, and the Slack ingest one outside
`slack-events/`. The check runs at boot and names the variable, so no
configuration can point one server at another's objects.

**Every consumer has its own key.** A WhatsApp key together with its state is
the account: whoever holds both reads every chat and posts as it. The Slack
ingest has no business holding that. Each consumer also writes its own four-byte
magic at the front of every object (`WAS1`, `SLE1`), so an object of one does
not even parse as another's.

Every object except a lease is AES-256-GCM, with the object's full name as
associated data. An object only opens under the name it was written to. The
bucket is not part of that name, so an object copied to another bucket under
the same name still opens.

**One writer per folder.** Each consumer claims a `lease.json` in its folder
when it starts, so the newest process owns it. State is written conditionally
on the generation that process last read. The Slack ingest refreshes a
heartbeat in its lease and takes it back from an owner that went quiet. The
WhatsApp bridge does not: a superseded bridge stays down rather than risk a
second socket on one linked device.

## What one credential costs

Every container that holds `STRAD_STATE_GCS_PRIVATE_KEY` can read, overwrite
and delete **every** consumer's objects. It cannot open them, because that needs
the consumer's key. It can destroy them, or put an older sealed copy back under
the same name. A service account per consumer would have prevented that. One
shared account trades it for one credential to seed and rotate. See
[Limitations #138](/limitations/).

## Setting it up

The bucket and the service account are made in GCP by hand, once per
deployment. It is the one step that needs project IAM:

```sh
PROJECT=…                     # the GCP project
BUCKET=strad-state-prod       # globally unique
SA=strad-state-prod
gcloud storage buckets create "gs://$BUCKET" --project "$PROJECT" \
  --location US --uniform-bucket-level-access --public-access-prevention
gcloud iam service-accounts create "$SA" --project "$PROJECT"
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member "serviceAccount:$SA@$PROJECT.iam.gserviceaccount.com" \
  --role roles/storage.objectAdmin
gcloud iam service-accounts keys create key.json \
  --iam-account "$SA@$PROJECT.iam.gserviceaccount.com"
```

Then seed `client_email` and `private_key` from `key.json`, and the bucket name,
in the console at `/ui/secrets`, and delete `key.json`. Seed each consumer's key
under its own slug. A deploy picks them up.

An existing bucket can become the shared one: the WhatsApp bridge's is the
case. Nothing about a bucket is specific to one consumer except the folders in
it.

## An existing WhatsApp deployment

The WhatsApp bridge read `WHATSAPP_GCS_BUCKET`, `WHATSAPP_GCS_CLIENT_EMAIL`,
`WHATSAPP_GCS_PRIVATE_KEY` and `WHATSAPP_GCS_PREFIX` before the bucket was
shared. It still does, each one only when its successor is unset, so a
deployment that changes nothing keeps working with the same bucket, folder and
service account. No object moves and none is re-sealed.

Two names that disagree about **where** the state is are refused, not resolved.
`STRAD_STATE_GCS_BUCKET` and `WHATSAPP_GCS_BUCKET` naming two buckets, or
`WHATSAPP_STATE_PREFIX` and `WHATSAPP_GCS_PREFIX` naming two folders, stops the
bridge with an error naming both variables. Picking either one would boot
against a place that may not hold the state. The bridge would look unpaired, and
re-pairing it would strand the real state in the other place. A disagreement
about the credential is not refused: the shared name wins, because that is what
a key rotation looks like.

To move onto the shared names, in order:

1. Seed the three `STRAD_STATE_GCS_*` at `/strad/{env}/gateway/static/` with the
   **same** bucket the bridge uses, and its service account.
2. Add the three `${STRAD_STATE_GCS_*}` references to the WhatsApp slug's
   `env:`, rename `WHATSAPP_GCS_PREFIX` to `WHATSAPP_STATE_PREFIX` with the same
   value, and deploy. `whatsapp_status` should still read
   `connected: true, paired: true`.
3. Delete the four legacy parameters from the slug's namespace, and deploy again.

To move the state to **another** bucket, stop the bridge first: disable the
slug and deploy. Copy every object under its folder to the same names in the
new bucket, then point the variables at it and enable the slug. The seal does
not depend on the bucket, so the copies open. Copying while the bridge runs
races its writes.
