// Copyright (C) 2026 Tadas Antanavicius
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version. See LICENSE in this directory.

package main

// ONE PHONE, NOT A NEW ONE PER LOGIN.
//
// A phone-app login ("android", "ios") tells Meta which device it is: a device
// id, a family device id, the machine id Meta issued that device on an earlier
// login, and the key its login requests are signed with. Stock mautrix-meta
// mints all of them fresh on every login, so to Meta every attempt is a phone
// it has never seen — the profile its checkpoints are for. This file keeps ONE
// device per platform in the bridge's own database (so it rides the sealed
// snapshot with everything else) and hands it to every login through
// MetaConnector.DeviceIdentity (strad delta D2, third_party/README.md).
//
// The device a working login already uses is the one Meta trusts, so it is
// adopted rather than replaced: a login's native session in user_login carries
// its device id, family device id and machine id, and the first sync seeds the
// stored device from it. What a login never stored is the attestation key, so a
// seeded device gets a new one, once, and keeps it.
//
// Nothing here touches user_login. It is only ever read.

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog"
	"go.mau.fi/util/dbutil"
	"go.mau.fi/util/random"

	"go.mau.fi/mautrix-meta/pkg/messagix/types"
	"go.mau.fi/mautrix-meta/pkg/messagix/useragent"
)

const identitySchema = `
CREATE TABLE IF NOT EXISTS strad_device_identity (
    platform   TEXT PRIMARY KEY,
    identity   TEXT NOT NULL,
    origin     TEXT NOT NULL,
    created_at INTEGER NOT NULL
)`

// Where a stored device came from.
const (
	// originLiveLogin: adopted from a login that had already signed in.
	originLiveLogin = "live_login"
	// originGenerated: minted here because no login had a device to adopt.
	originGenerated = "generated"
)

type DeviceIdentities struct {
	db    *dbutil.Database
	log   zerolog.Logger
	lock  sync.Mutex
	clock func() time.Time
}

func NewDeviceIdentities(db *dbutil.Database, log zerolog.Logger) *DeviceIdentities {
	return &DeviceIdentities{db: db, log: log, clock: time.Now}
}

func (d *DeviceIdentities) Upgrade(ctx context.Context) error {
	if _, err := d.db.Exec(ctx, identitySchema); err != nil {
		return fmt.Errorf("strad device identity schema: %w", err)
	}
	return nil
}

// For is MetaConnector.DeviceIdentity: the stored device for platform,
// adopting a login's first and minting one only when there is none.
func (d *DeviceIdentities) For(ctx context.Context, platform types.Platform) (*types.DeviceIdentity, error) {
	if !platform.IsMessengerLite() {
		return nil, fmt.Errorf("no device identity for platform %q", platform.String())
	}
	d.lock.Lock()
	defer d.lock.Unlock()
	if err := d.syncLocked(ctx); err != nil {
		// A login whose metadata cannot be read is no reason to refuse one;
		// the stored device (or a new one) still stands.
		d.log.Warn().Err(err).Msg("device identity: could not read existing logins")
	}
	id, _, err := d.load(ctx, platform)
	if err != nil {
		return nil, err
	}
	if id != nil {
		if _, perr := x509.ParsePKCS8PrivateKey(id.AttestationKey); perr != nil {
			// Unreadable: replace the key, keep the device. Otherwise every
			// login would fail until a logout wiped the database.
			fresh, gerr := newIdentity(id.DeviceID, id.FamilyDeviceID, id.MachineID)
			if gerr != nil {
				return nil, gerr
			}
			id.AttestationKey = fresh.AttestationKey
			if err = d.update(ctx, platform, id); err != nil {
				return nil, err
			}
			d.log.Warn().Str("platform", platform.String()).Msg("device identity: unreadable attestation key replaced")
		}
		return id, nil
	}
	id, err = newIdentity(uuid.New(), uuid.New(), "")
	if err != nil {
		return nil, err
	}
	if err = d.insert(ctx, platform, id, originGenerated); err != nil {
		return nil, err
	}
	d.log.Info().Str("platform", platform.String()).Str("origin", originGenerated).Msg("device identity created")
	return id, nil
}

// Sync adopts the device of any login that has one and no stored device yet,
// and records a machine id Meta issued the stored device since. Run at boot
// and after every completed login.
func (d *DeviceIdentities) Sync(ctx context.Context) error {
	d.lock.Lock()
	defer d.lock.Unlock()
	return d.syncLocked(ctx)
}

func (d *DeviceIdentities) syncLocked(ctx context.Context) error {
	sessions, err := d.liveSessions(ctx)
	if err != nil {
		return err
	}
	for _, s := range sessions {
		platform := platformOfApp(s.AppID)
		if platform == types.Unset || s.DeviceID == uuid.Nil || s.FamilyDeviceID == uuid.Nil {
			continue
		}
		stored, _, err := d.load(ctx, platform)
		if err != nil {
			return err
		}
		switch {
		case stored == nil:
			id, err := newIdentity(s.DeviceID, s.FamilyDeviceID, s.MachineID)
			if err != nil {
				return err
			}
			if err = d.insert(ctx, platform, id, originLiveLogin); err != nil {
				return err
			}
			d.log.Info().Str("platform", platform.String()).Str("origin", originLiveLogin).
				Bool("machine_id", s.MachineID != "").Msg("device identity adopted from the existing login")
		case stored.DeviceID == s.DeviceID && s.MachineID != "" && s.MachineID != stored.MachineID:
			// Meta issued this device a machine id; a returning phone sends it.
			// Never cleared: a login that came back without one keeps the last.
			stored.MachineID = s.MachineID
			if err = d.update(ctx, platform, stored); err != nil {
				return err
			}
			d.log.Info().Str("platform", platform.String()).Msg("device identity: machine id recorded")
		}
	}
	return nil
}

// liveSessions reads the native session of every login bridgev2 holds, in
// whatever state. A login Meta has stopped still names the device Meta last
// saw, which is the one to keep presenting — even if Meta flagged it, a new
// phone from the same IP is not the better look.
func (d *DeviceIdentities) liveSessions(ctx context.Context) ([]*types.NativeSession, error) {
	rows, err := d.db.Query(ctx, `SELECT metadata FROM user_login ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("read logins: %w", err)
	}
	defer rows.Close()
	var out []*types.NativeSession
	for rows.Next() {
		var raw []byte
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		var meta struct {
			NativeSession *types.NativeSession `json:"native_session"`
		}
		if json.Unmarshal(raw, &meta) == nil && meta.NativeSession != nil {
			out = append(out, meta.NativeSession)
		}
	}
	return out, rows.Err()
}

func platformOfApp(appID string) types.Platform {
	switch appID {
	case useragent.MessengerLiteAndroidAppID:
		return types.MessengerLiteAndroid
	case useragent.MessengerLiteIOSAppID:
		return types.MessengerLiteIOS
	}
	return types.Unset
}

func newIdentity(deviceID, familyDeviceID uuid.UUID, machineID string) (*types.DeviceIdentity, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	return &types.DeviceIdentity{
		DeviceID:           deviceID,
		FamilyDeviceID:     familyDeviceID,
		MachineID:          machineID,
		AttestationKey:     der,
		IntegrityMachineID: string(random.StringBytes(24)),
		USDID:              uuid.New(),
	}, nil
}

func (d *DeviceIdentities) load(ctx context.Context, platform types.Platform) (*types.DeviceIdentity, *identityRow, error) {
	var row identityRow
	err := d.db.QueryRow(ctx,
		`SELECT identity, origin, created_at FROM strad_device_identity WHERE platform = $1`, platform.String(),
	).Scan(&row.raw, &row.origin, &row.createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, nil
	} else if err != nil {
		return nil, nil, fmt.Errorf("read device identity: %w", err)
	}
	var id types.DeviceIdentity
	if err = json.Unmarshal([]byte(row.raw), &id); err != nil {
		return nil, nil, fmt.Errorf("parse device identity: %w", err)
	}
	return &id, &row, nil
}

type identityRow struct {
	raw       string
	origin    string
	createdAt int64
}

func (d *DeviceIdentities) insert(ctx context.Context, platform types.Platform, id *types.DeviceIdentity, origin string) error {
	raw, err := json.Marshal(id)
	if err != nil {
		return err
	}
	_, err = d.db.Exec(ctx,
		`INSERT INTO strad_device_identity (platform, identity, origin, created_at) VALUES ($1, $2, $3, $4)`,
		platform.String(), string(raw), origin, d.clock().UnixMilli())
	return err
}

func (d *DeviceIdentities) update(ctx context.Context, platform types.Platform, id *types.DeviceIdentity) error {
	raw, err := json.Marshal(id)
	if err != nil {
		return err
	}
	_, err = d.db.Exec(ctx, `UPDATE strad_device_identity SET identity = $2 WHERE platform = $1`, platform.String(), string(raw))
	return err
}

// IdentityView is what /status says about a stored device. No identifier is
// ever in it.
type IdentityView struct {
	Flow string `json:"flow"`
	// Origin: "live_login" (adopted from a login that had signed in) or
	// "generated".
	Origin string `json:"origin"`
	// MachineID: Meta has issued this device a machine id, which every login
	// sends.
	MachineID bool   `json:"machine_id"`
	Since     string `json:"since"`
}

func (d *DeviceIdentities) Describe(ctx context.Context) ([]IdentityView, error) {
	d.lock.Lock()
	defer d.lock.Unlock()
	out := []IdentityView{}
	for flow, platform := range map[string]types.Platform{"android": types.MessengerLiteAndroid, "ios": types.MessengerLiteIOS} {
		id, row, err := d.load(ctx, platform)
		if err != nil {
			return nil, err
		} else if id == nil {
			continue
		}
		out = append(out, IdentityView{
			Flow: flow, Origin: row.origin, MachineID: id.MachineID != "",
			Since: time.UnixMilli(row.createdAt).UTC().Format(time.RFC3339),
		})
	}
	if len(out) == 2 && out[0].Flow != "android" {
		out[0], out[1] = out[1], out[0]
	}
	return out, nil
}
