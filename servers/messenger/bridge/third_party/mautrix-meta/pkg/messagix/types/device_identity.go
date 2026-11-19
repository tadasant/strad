package types

import "github.com/google/uuid"

// strad delta D2 (third_party/README.md): the phone a Messenger Lite login
// claims to be, supplied by the embedding program so that every login can
// present the SAME device. Upstream mints every one of these fresh per login
// (and two of them fresh per request), which makes each login look to Meta
// like a brand-new phone.
//
// A nil *DeviceIdentity anywhere means upstream behaviour: mint fresh ones.
type DeviceIdentity struct {
	DeviceID       uuid.UUID `json:"device_id"`
	FamilyDeviceID uuid.UUID `json:"family_device_id"`
	// MachineID is issued by Meta in a successful login's response, never by
	// the client. A real phone keeps it and sends it on every later login;
	// empty until this device has completed one.
	MachineID string `json:"machine_id,omitempty"`
	// AttestationKey is the P-256 key login request data is signed with,
	// PKCS#8 DER. Its hash is sent beside every signature.
	AttestationKey []byte `json:"attestation_key"`
	// IntegrityMachineID is sent as the Android x-fb-integrity-machine-id
	// header while MachineID is still empty; 24 characters.
	IntegrityMachineID string `json:"integrity_machine_id"`
	// USDID is the iOS x-meta-usdid-uuid header.
	USDID uuid.UUID `json:"usdid"`
}

// IntegrityMachineIDHeader is the value of the Android
// x-fb-integrity-machine-id header: the Meta-issued machine id once there is
// one, the stable placeholder before.
func (d *DeviceIdentity) IntegrityMachineIDHeader() string {
	if d.MachineID != "" {
		return d.MachineID
	}
	return d.IntegrityMachineID
}
