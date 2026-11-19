// Copyright (C) 2026 Tadas Antanavicius
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version. See LICENSE in this directory.

package main

// One stored device per phone-app platform (identity.go), presented by every
// login through strad delta D2 (third_party/README.md). These tests are what
// fail if a re-vendor drops D2: the login requests themselves are captured and
// compared, not just what this program stores.

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/rs/zerolog"
	"go.mau.fi/util/dbutil"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"

	"go.mau.fi/mautrix-meta/pkg/messagix"
	"go.mau.fi/mautrix-meta/pkg/messagix/bloks"
	"go.mau.fi/mautrix-meta/pkg/messagix/cookies"
	"go.mau.fi/mautrix-meta/pkg/messagix/types"
	"go.mau.fi/mautrix-meta/pkg/messagix/useragent"
	"go.mau.fi/mautrix-meta/pkg/metaid"
)

// openBridgeDB opens (or reopens — a "restart") a bridge database at path with
// bridgev2's own schema, the shape bridge.db has in production.
func openBridgeDB(t *testing.T, path string) *database.Database {
	t.Helper()
	raw, err := dbutil.NewFromConfig("test", dbutil.Config{PoolConfig: dbutil.PoolConfig{
		Type: "sqlite3-fk-wal", URI: "file:" + path + "?_txlock=immediate", MaxOpenConns: 1,
	}}, dbutil.ZeroLogger(zerolog.Nop()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = raw.Close() })
	db := database.New("", database.MetaTypes{UserLogin: func() any { return &metaid.UserLoginMetadata{} }}, raw)
	if err = db.Upgrade(context.Background()); err != nil {
		t.Fatal(err)
	}
	return db
}

func newIdentities(t *testing.T, db *database.Database) *DeviceIdentities {
	t.Helper()
	ids := NewDeviceIdentities(db.Database, zerolog.Nop())
	if err := ids.Upgrade(context.Background()); err != nil {
		t.Fatal(err)
	}
	return ids
}

// loginRequest is what one phone-app login start sends Meta about the device.
type loginRequest struct {
	body             string
	zeroDeviceID     string
	integrityMachine string
}

// recordingTransport is an http.RoundTripper that keeps every request and answers each
// with a refusal, so a login goes exactly one request deep and no further.
type recordingTransport struct {
	mu   sync.Mutex
	reqs []*http.Request
	body []string
}

func (rt *recordingTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	var b []byte
	if r.Body != nil {
		b, _ = io.ReadAll(r.Body)
	}
	rt.mu.Lock()
	rt.reqs = append(rt.reqs, r)
	rt.body = append(rt.body, string(b))
	rt.mu.Unlock()
	// A 4xx is final: mautrix-meta retries a transport error or a 5xx with
	// backoff, which would only make this test slow.
	return &http.Response{StatusCode: http.StatusBadRequest, Body: io.NopCloser(strings.NewReader(`{}`)),
		Header: http.Header{}, Request: r}, nil
}

// startAndroidLogin runs the first step of a Messenger Lite Android login the
// way the connector does — a client, the device identity, DoLoginSteps — and
// returns the first Bloks request it sent.
func startAndroidLogin(t *testing.T, identity *types.DeviceIdentity) loginRequest {
	t.Helper()
	cl := messagix.NewClient(&cookies.Cookies{Platform: types.MessengerLiteAndroid}, zerolog.Nop(), &messagix.Config{})
	rt := &recordingTransport{}
	cl.GetHTTP().SetTransportOverride(rt)
	if identity != nil {
		cl.MessengerLite.SetDeviceIdentity(identity)
	}
	if _, _, err := cl.MessengerLite.DoLoginSteps(context.Background(), nil); err == nil {
		t.Fatal("the login went past a transport that fails every request")
	}
	rt.mu.Lock()
	defer rt.mu.Unlock()
	for i, r := range rt.reqs {
		if r.Header.Get("x-zero-f-device-id") == "" {
			continue
		}
		body, _ := url.QueryUnescape(rt.body[i])
		return loginRequest{
			body:             body,
			zeroDeviceID:     r.Header.Get("x-zero-f-device-id"),
			integrityMachine: r.Header.Get("x-fb-integrity-machine-id"),
		}
	}
	t.Fatalf("no Bloks login request was sent (%d requests)", len(rt.reqs))
	return loginRequest{}
}

func attestationKeyHash(t *testing.T, identity *types.DeviceIdentity) string {
	t.Helper()
	b, err := bloks.NewBrowser(&bloks.BrowserConfig{Platform: types.MessengerLiteAndroid, Identity: identity})
	if err != nil {
		t.Fatal(err)
	}
	signed, err := b.Bridge.SignRequestData(context.Background(), map[string]any{"x": 1})
	if err != nil {
		t.Fatal(err)
	}
	return signed.(map[string]any)["keyHash"].(string)
}

func mustFor(t *testing.T, ids *DeviceIdentities, p types.Platform) *types.DeviceIdentity {
	t.Helper()
	id, err := ids.For(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// Two login starts, a restart, a third: one device throughout — in the stored
// identity and in what is actually sent to Meta.
func TestIdentityStableAcrossLoginsAndRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bridge.db")
	ids := newIdentities(t, openBridgeDB(t, path))

	first := mustFor(t, ids, types.MessengerLiteAndroid)
	second := mustFor(t, ids, types.MessengerLiteAndroid)
	if first.DeviceID != second.DeviceID || first.FamilyDeviceID != second.FamilyDeviceID ||
		!bytes.Equal(first.AttestationKey, second.AttestationKey) {
		t.Fatal("two login starts got two devices")
	}

	reqA := startAndroidLogin(t, first)
	reqB := startAndroidLogin(t, second)

	// A restart: the same file, opened by a new process.
	ids2 := newIdentities(t, openBridgeDB(t, path))
	third := mustFor(t, ids2, types.MessengerLiteAndroid)
	reqC := startAndroidLogin(t, third)

	if third.DeviceID != first.DeviceID || third.FamilyDeviceID != first.FamilyDeviceID ||
		third.IntegrityMachineID != first.IntegrityMachineID || !bytes.Equal(third.AttestationKey, first.AttestationKey) {
		t.Fatal("the device changed across a restart")
	}
	devUpper := strings.ToUpper(first.DeviceID.String())
	famUpper := strings.ToUpper(first.FamilyDeviceID.String())
	for name, req := range map[string]loginRequest{"first": reqA, "second": reqB, "after restart": reqC} {
		if !strings.Contains(req.body, devUpper) || !strings.Contains(req.body, famUpper) {
			t.Errorf("%s login: the Bloks request does not carry the stored device and family device ids", name)
		}
		if req.zeroDeviceID != first.DeviceID.String() {
			t.Errorf("%s login: x-zero-f-device-id is %q, not the stored device", name, req.zeroDeviceID)
		}
		if req.integrityMachine != first.IntegrityMachineID {
			t.Errorf("%s login: x-fb-integrity-machine-id is not the stored one", name)
		}
	}
	if h1, h2 := attestationKeyHash(t, first), attestationKeyHash(t, third); h1 != h2 {
		t.Error("the attestation key hash changed across a restart")
	}
	if origin := describe(t, ids2)["android"].Origin; origin != originGenerated {
		t.Errorf("origin = %q, want %q", origin, originGenerated)
	}

	// The control: without D2's identity, every start is a new phone. If this
	// stops holding, the assertions above prove nothing.
	if a, b := startAndroidLogin(t, nil), startAndroidLogin(t, nil); a.zeroDeviceID == b.zeroDeviceID {
		t.Error("control: two identity-less logins sent the same device")
	}
}

func describe(t *testing.T, ids *DeviceIdentities) map[string]IdentityView {
	t.Helper()
	views, err := ids.Describe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]IdentityView{}
	for _, v := range views {
		out[v.Flow] = v
	}
	return out
}

const ownerMXIDForTest = "@owner:strad.invalid"

// seedProdShapedLogin writes a logged-in Android account the way bridgev2 and
// mautrix-meta persist one after a phone-app login: the owner user, and a
// user_login whose metadata carries the cookies, the encrypted-device id and
// the native session. Every value is fake.
func seedProdShapedLogin(t *testing.T, db *database.Database, session *types.NativeSession) {
	t.Helper()
	ctx := context.Background()
	if err := db.User.Insert(ctx, &database.User{BridgeID: "", MXID: ownerMXIDForTest}); err != nil {
		t.Fatal(err)
	}
	c := &cookies.Cookies{Platform: types.MessengerLiteAndroid}
	c.UpdateValues(map[cookies.MetaCookieName]string{"c_user": "100000000000001", "xs": "fake-xs", "datr": "fake-datr"})
	err := db.UserLogin.Insert(ctx, &database.UserLogin{
		BridgeID: "", UserMXID: ownerMXIDForTest, ID: networkid.UserLoginID("100000000000001"), RemoteName: "Test Owner",
		Metadata: &metaid.UserLoginMetadata{
			Platform:      types.MessengerLiteAndroid,
			Cookies:       c,
			WADeviceID:    7,
			NativeSession: session,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
}

func userLoginRows(t *testing.T, db *database.Database) []string {
	t.Helper()
	rows, err := db.Query(context.Background(), `SELECT id || '|' || remote_name || '|' || metadata FROM user_login ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err = rows.Scan(&s); err != nil {
			t.Fatal(err)
		}
		out = append(out, s)
	}
	return out
}

// The upgrade path: the first boot of this image over a database that already
// holds a working Android login adopts that login's device — so the next login
// is the phone Meta already trusts — and leaves the login itself untouched.
func TestIdentitySeededFromExistingLogin(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bridge.db")
	db := openBridgeDB(t, path)
	live := &types.NativeSession{
		AccessToken:    "fake-access-token",
		AppID:          useragent.MessengerLiteAndroidAppID,
		DeviceID:       uuid.New(),
		FamilyDeviceID: uuid.New(),
		MachineID:      "fakeMachineIdIssuedByMet",
	}
	seedProdShapedLogin(t, db, live)
	before := userLoginRows(t, db)

	// Boot of the new image: schema, then sync — main.go's order.
	ids := newIdentities(t, db)
	if err := ids.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	if v := describe(t, ids)["android"]; v.Origin != originLiveLogin || !v.MachineID {
		t.Fatalf("after boot: %+v, want adopted from the live login with its machine id", v)
	}

	// The next login presents the live login's device, machine id included.
	id := mustFor(t, ids, types.MessengerLiteAndroid)
	if id.DeviceID != live.DeviceID || id.FamilyDeviceID != live.FamilyDeviceID || id.MachineID != live.MachineID {
		t.Fatal("the stored device is not the live login's")
	}
	req := startAndroidLogin(t, id)
	if !strings.Contains(req.body, strings.ToUpper(live.DeviceID.String())) || req.zeroDeviceID != live.DeviceID.String() {
		t.Error("the next login does not send the live login's device id")
	}
	if req.integrityMachine != live.MachineID {
		t.Error("the next login does not send the machine id Meta issued the live device")
	}

	// Not logged out: the login row is byte for byte what it was.
	if after := userLoginRows(t, db); strings.Join(after, "\n") != strings.Join(before, "\n") {
		t.Fatalf("user_login changed:\n%v\n%v", before, after)
	}
	ul, err := db.UserLogin.GetByID(context.Background(), "100000000000001")
	if err != nil || ul == nil {
		t.Fatalf("the login no longer loads: %v", err)
	}
	if got := ul.Metadata.(*metaid.UserLoginMetadata).NativeSession; got == nil || got.DeviceID != live.DeviceID || got.AccessToken != live.AccessToken {
		t.Fatal("the login's native session changed")
	}

	// A restart: still the adopted device, and a second boot sync changes nothing.
	ids2 := newIdentities(t, openBridgeDB(t, path))
	if err = ids2.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	again := mustFor(t, ids2, types.MessengerLiteAndroid)
	if again.DeviceID != live.DeviceID || !bytes.Equal(again.AttestationKey, id.AttestationKey) {
		t.Fatal("the adopted device did not survive a restart")
	}
}

// After a login, the machine id Meta issued is recorded and sent from then on;
// a login that comes back without one does not clear it; and a login on a
// device other than the stored one never replaces it.
func TestIdentityRecordsMachineID(t *testing.T) {
	db := openBridgeDB(t, filepath.Join(t.TempDir(), "bridge.db"))
	ids := newIdentities(t, db)
	ctx := context.Background()

	id := mustFor(t, ids, types.MessengerLiteAndroid)
	if id.MachineID != "" {
		t.Fatal("a new device has a machine id")
	}
	// The login this device just completed, as mautrix-meta saves it.
	seedProdShapedLogin(t, db, &types.NativeSession{
		AccessToken: "fake", AppID: useragent.MessengerLiteAndroidAppID,
		DeviceID: id.DeviceID, FamilyDeviceID: id.FamilyDeviceID, MachineID: "issuedAfterTheFirstLogin",
	})
	if err := ids.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if got := mustFor(t, ids, types.MessengerLiteAndroid); got.MachineID != "issuedAfterTheFirstLogin" || got.DeviceID != id.DeviceID {
		t.Fatalf("machine id not recorded: %q", got.MachineID)
	}

	setSession := func(s *types.NativeSession) {
		ul, err := db.UserLogin.GetByID(ctx, "100000000000001")
		if err != nil {
			t.Fatal(err)
		}
		ul.Metadata.(*metaid.UserLoginMetadata).NativeSession = s
		if err = db.UserLogin.Update(ctx, ul); err != nil {
			t.Fatal(err)
		}
	}
	setSession(&types.NativeSession{AccessToken: "fake", AppID: useragent.MessengerLiteAndroidAppID,
		DeviceID: id.DeviceID, FamilyDeviceID: id.FamilyDeviceID})
	if err := ids.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if got := mustFor(t, ids, types.MessengerLiteAndroid); got.MachineID != "issuedAfterTheFirstLogin" {
		t.Fatal("a login without a machine id cleared the stored one")
	}

	setSession(&types.NativeSession{AccessToken: "fake", AppID: useragent.MessengerLiteAndroidAppID,
		DeviceID: uuid.New(), FamilyDeviceID: uuid.New(), MachineID: "someOtherDevice"})
	if err := ids.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if got := mustFor(t, ids, types.MessengerLiteAndroid); got.DeviceID != id.DeviceID || got.MachineID != "issuedAfterTheFirstLogin" {
		t.Fatal("a login on another device replaced the stored one")
	}

	// iOS is its own phone.
	if ios := mustFor(t, ids, types.MessengerLiteIOS); ios.DeviceID == id.DeviceID {
		t.Fatal("iOS and Android share a device")
	}
}
