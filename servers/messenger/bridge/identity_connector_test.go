// Copyright (C) 2026 Tadas Antanavicius
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version. See LICENSE in this directory.

package main

// Delta D2 end to end through the connector: MetaConnector.DeviceIdentity is
// what MetaNativeLogin.StartWithParams consults, so dropping that hook (and not
// only the messagix half) fails here. Both phone-app flows.

import (
	"context"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"maunium.net/go/mautrix/bridgev2"

	"go.mau.fi/mautrix-meta/pkg/connector"
	"go.mau.fi/mautrix-meta/pkg/messagix/types"
)

type fingerprintingRecorder struct{ recordingTransport }

func (*fingerprintingRecorder) SetFingerprint(string) {}

// connectorLoginStart starts a phone-app login exactly as the bridge does —
// CreateLogin's process, Start — over a recording transport, and returns the
// first Bloks request's headers and decoded body.
func connectorLoginStart(t *testing.T, ids *DeviceIdentities, platform types.Platform) (map[string]string, string) {
	t.Helper()
	meta := &connector.MetaConnector{Bridge: &bridgev2.Bridge{}, DeviceIdentity: ids.For}
	login := &connector.MetaNativeLogin{Mode: platform, Main: meta}
	rt := &fingerprintingRecorder{}
	if _, err := login.StartWithParams(context.Background(), bridgev2.LoginStartParams{HTTP: rt}); err == nil {
		t.Fatal("the login went past a transport that refuses every request")
	}
	rt.mu.Lock()
	defer rt.mu.Unlock()
	for i, r := range rt.reqs {
		if r.Header.Get("x-fb-friendly-name") == "" {
			continue
		}
		h := map[string]string{}
		for _, k := range []string{"x-fb-device-id", "x-fb-family-device-id", "x-meta-usdid-uuid", "x-zero-f-device-id", "x-fb-integrity-machine-id"} {
			h[k] = r.Header.Get(k)
		}
		body, _ := url.QueryUnescape(rt.body[i])
		return h, body
	}
	t.Fatalf("no Bloks login request was sent (%d requests)", len(rt.reqs))
	return nil, ""
}

func TestConnectorLoginPresentsStoredDevice(t *testing.T) {
	ids := newIdentities(t, openBridgeDB(t, filepath.Join(t.TempDir(), "bridge.db")))

	t.Run("android", func(t *testing.T) {
		id := mustFor(t, ids, types.MessengerLiteAndroid)
		for range 2 {
			h, body := connectorLoginStart(t, ids, types.MessengerLiteAndroid)
			if !strings.Contains(body, strings.ToUpper(id.DeviceID.String())) || h["x-zero-f-device-id"] != id.DeviceID.String() {
				t.Fatal("the connector's Android login does not present the stored device")
			}
			if h["x-fb-integrity-machine-id"] != id.IntegrityMachineID {
				t.Fatal("the connector's Android login does not send the stored integrity machine id")
			}
		}
	})

	t.Run("ios", func(t *testing.T) {
		id := mustFor(t, ids, types.MessengerLiteIOS)
		// A device Meta has already issued a machine id to sends it.
		id.MachineID = "storedMachineIdForTestOK"
		if err := ids.update(context.Background(), types.MessengerLiteIOS, id); err != nil {
			t.Fatal(err)
		}
		for range 2 {
			h, body := connectorLoginStart(t, ids, types.MessengerLiteIOS)
			if h["x-fb-device-id"] != strings.ToUpper(id.DeviceID.String()) ||
				h["x-fb-family-device-id"] != strings.ToUpper(id.FamilyDeviceID.String()) {
				t.Fatal("the connector's iOS login does not present the stored device")
			}
			if h["x-meta-usdid-uuid"] != strings.ToUpper(id.USDID.String()) {
				t.Fatal("the connector's iOS login does not send the stored usdid")
			}
			if !strings.Contains(body, id.MachineID) {
				t.Fatal("the connector's iOS login does not send the stored machine id")
			}
		}
	})
}

// A stored key that no longer parses is replaced, not a reason every login
// fails until a logout wipes the database.
func TestIdentityRepairsUnreadableKey(t *testing.T) {
	ids := newIdentities(t, openBridgeDB(t, filepath.Join(t.TempDir(), "bridge.db")))
	id := mustFor(t, ids, types.MessengerLiteAndroid)
	id.AttestationKey = []byte("not a key")
	if err := ids.update(context.Background(), types.MessengerLiteAndroid, id); err != nil {
		t.Fatal(err)
	}
	fixed := mustFor(t, ids, types.MessengerLiteAndroid)
	if fixed.DeviceID != id.DeviceID {
		t.Fatal("repairing the key changed the device")
	}
	if attestationKeyHash(t, fixed) == "" || attestationKeyHash(t, fixed) != attestationKeyHash(t, mustFor(t, ids, types.MessengerLiteAndroid)) {
		t.Fatal("the repaired key is not stable")
	}
}
