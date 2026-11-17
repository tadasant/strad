// Copyright (C) 2026 Tadas Antanavicius
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version. See LICENSE in this directory.

package main

// THE MATRIX SIDE, WITH NO MATRIX.
//
// mautrix-meta is a bridgev2 NETWORK connector: everything Messenger-specific
// (login, the Lightspeed socket, end-to-end encryption over whatsmeow,
// encrypted-history restore, backfill, media) lives there, and it talks to the
// rest of the world only through bridgev2's MatrixConnector and MatrixAPI
// interfaces. This file implements those two interfaces against a local SQLite
// table instead of a homeserver. A "room" is a row id, a "send" is an INSERT
// (record.go), and nothing leaves the process.
//
// That is the whole trick, and it is why this is a few hundred lines rather
// than a Messenger client: every protocol decision stays upstream's, at the
// version go.mod pins, and a Meta server-side change is fixed by bumping it.

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/bridgev2/status"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"
)

// serverName is a reserved TLD (RFC 2606), so no ID minted here can ever be
// mistaken for, or resolve to, a real Matrix server.
const serverName = "strad.invalid"

// ownerMXID is the one bridgev2 user. There is exactly one Messenger account
// per process (the component runs at one instance), so it needs no name.
const ownerMXID = id.UserID("@owner:" + serverName)

var errNoMatrix = errors.New("not available: this bridge has no Matrix homeserver")

type Headless struct {
	br  *bridgev2.Bridge
	rec *Recorder

	stateLock sync.Mutex
	state     status.BridgeState
	stateAt   time.Time
}

var (
	_ bridgev2.MatrixConnector                    = (*Headless)(nil)
	_ interface{ BotIntent() bridgev2.MatrixAPI } = (*Headless)(nil)
)

func NewHeadless(rec *Recorder) *Headless { return &Headless{rec: rec} }

func (h *Headless) Init(br *bridgev2.Bridge) { h.br = br }

func (h *Headless) Start(ctx context.Context) error {
	if dm, ok := h.br.Network.(bridgev2.DirectMediableNetwork); ok {
		// Media stays at Meta and is fetched on demand (messenger_get_attachment),
		// so the snapshot carries descriptors, never file bytes.
		dm.SetUseDirectMedia()
	}
	if mfs, ok := h.br.Network.(bridgev2.MaxFileSizeingNetwork); ok {
		mfs.SetMaxFileSize(maxMediaBytes)
	}
	return h.rec.Upgrade(ctx)
}

func (h *Headless) PreStop() {}
func (h *Headless) Stop()    {}

func (h *Headless) GetCapabilities() *bridgev2.MatrixCapabilities {
	return &bridgev2.MatrixCapabilities{AutoJoinInvites: true, BatchSending: true}
}

func (h *Headless) ParseGhostMXID(userID id.UserID) (networkid.UserID, bool) {
	local, server, err := userID.Parse()
	if err != nil || server != serverName || !strings.HasPrefix(local, "ghost_") {
		return "", false
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(local, "ghost_"))
	if err != nil {
		return "", false
	}
	return networkid.UserID(raw), true
}

func (h *Headless) FormatGhostMXID(userID networkid.UserID) id.UserID {
	return id.NewUserID("ghost_"+base64.RawURLEncoding.EncodeToString([]byte(userID)), serverName)
}

func (h *Headless) GhostIntent(userID networkid.UserID) bridgev2.MatrixAPI {
	return &intent{h: h, mxid: h.FormatGhostMXID(userID), sender: userID}
}

func (h *Headless) BotIntent() bridgev2.MatrixAPI {
	return &intent{h: h, mxid: id.NewUserID("bot", serverName), bot: true}
}

func (h *Headless) NewUserIntent(context.Context, id.UserID, string) (bridgev2.MatrixAPI, string, error) {
	return nil, "", errNoMatrix
}

func (h *Headless) SendBridgeStatus(_ context.Context, state *status.BridgeState) error {
	h.stateLock.Lock()
	defer h.stateLock.Unlock()
	h.state = *state
	h.stateAt = time.Now()
	return nil
}

func (h *Headless) LastBridgeState() (status.BridgeState, time.Time) {
	h.stateLock.Lock()
	defer h.stateLock.Unlock()
	return h.state, h.stateAt
}

func (h *Headless) SendMessageStatus(context.Context, *bridgev2.MessageStatus, *bridgev2.MessageStatusEventInfo) {
}

// A content URI is the media ID, reversibly. Direct media puts the network's
// own descriptor here; messenger_get_attachment turns it back into a download.
func (h *Headless) GenerateContentURI(_ context.Context, mediaID networkid.MediaID) (id.ContentURIString, error) {
	return id.ContentURIString("mxc://" + serverName + "/dm_" + base64.RawURLEncoding.EncodeToString(mediaID)), nil
}

func (h *Headless) ParseContentURI(_ context.Context, uri id.ContentURIString) (networkid.MediaID, error) {
	parsed, err := uri.Parse()
	if err != nil {
		return nil, err
	}
	if parsed.Homeserver != serverName || !strings.HasPrefix(parsed.FileID, "dm_") {
		return nil, fmt.Errorf("not a direct media URI")
	}
	return base64.RawURLEncoding.DecodeString(strings.TrimPrefix(parsed.FileID, "dm_"))
}

func (h *Headless) GetPowerLevels(context.Context, id.RoomID) (*event.PowerLevelsEventContent, error) {
	return &event.PowerLevelsEventContent{}, nil
}

func (h *Headless) GetMembers(context.Context, id.RoomID) (map[id.UserID]*event.MemberEventContent, error) {
	return map[id.UserID]*event.MemberEventContent{}, nil
}

func (h *Headless) GetMemberInfo(context.Context, id.RoomID, id.UserID) (*event.MemberEventContent, error) {
	return nil, nil
}

func (h *Headless) BatchSend(ctx context.Context, roomID id.RoomID, req *mautrix.ReqBeeperBatchSend, extras []*bridgev2.MatrixSendExtra) (*mautrix.RespBeeperBatchSend, error) {
	resp := &mautrix.RespBeeperBatchSend{EventIDs: make([]id.EventID, len(req.Events))}
	for i, evt := range req.Events {
		var extra *bridgev2.MatrixSendExtra
		if i < len(extras) {
			extra = extras[i]
		}
		if evt.ID == "" {
			evt.ID = newEventID()
		}
		sender, _ := h.ParseGhostMXID(evt.Sender)
		ts := time.UnixMilli(evt.Timestamp)
		if err := h.rec.Record(ctx, roomID, evt.ID, evt.Type, &evt.Content, sender, ts, extra); err != nil {
			return nil, err
		}
		resp.EventIDs[i] = evt.ID
	}
	return resp, nil
}

func hashID(prefix string, parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return prefix + base64.RawURLEncoding.EncodeToString(sum[:18])
}

func (h *Headless) GenerateDeterministicRoomID(key networkid.PortalKey) id.RoomID {
	return id.RoomID(hashID("!", string(key.ID), string(key.Receiver)) + ":" + serverName)
}

func (h *Headless) GenerateDeterministicEventID(roomID id.RoomID, _ networkid.PortalKey, messageID networkid.MessageID, partID networkid.PartID) id.EventID {
	return id.EventID(hashID("$", string(roomID), string(messageID), string(partID)) + ":" + serverName)
}

func (h *Headless) GenerateReactionEventID(roomID id.RoomID, target *database.Message, sender networkid.UserID, emojiID networkid.EmojiID) id.EventID {
	return id.EventID(hashID("$", string(roomID), string(target.ID), string(target.PartID), string(sender), string(emojiID)) + ":" + serverName)
}

func (h *Headless) ServerName() string { return serverName }

func newEventID() id.EventID {
	return id.EventID("$" + strings.ReplaceAll(uuid.NewString(), "-", "") + ":" + serverName)
}

// intent is one "Matrix user": a ghost (a Messenger contact, the account's
// own included) or the bot. Sends are recorded; everything that would only
// shape a Matrix client's view of a room is accepted and dropped.
type intent struct {
	h      *Headless
	mxid   id.UserID
	sender networkid.UserID
	bot    bool
}

var _ bridgev2.MatrixAPI = (*intent)(nil)

func (i *intent) GetMXID() id.UserID   { return i.mxid }
func (i *intent) IsDoublePuppet() bool { return false }

func (i *intent) SendMessage(ctx context.Context, roomID id.RoomID, eventType event.Type, content *event.Content, extra *bridgev2.MatrixSendExtra) (*mautrix.RespSendEvent, error) {
	evtID := newEventID()
	if i.bot {
		// Bridge notices ("you were logged out") are not chat messages.
		return &mautrix.RespSendEvent{EventID: evtID}, nil
	}
	ts := time.Now()
	if extra != nil && !extra.Timestamp.IsZero() {
		ts = extra.Timestamp
	}
	if err := i.h.rec.Record(ctx, roomID, evtID, eventType, content, i.sender, ts, extra); err != nil {
		return nil, err
	}
	return &mautrix.RespSendEvent{EventID: evtID}, nil
}

func (i *intent) SendState(context.Context, id.RoomID, event.Type, string, *event.Content, time.Time) (*mautrix.RespSendEvent, error) {
	return &mautrix.RespSendEvent{EventID: newEventID()}, nil
}

func (i *intent) MarkRead(context.Context, id.RoomID, id.EventID, time.Time) error { return nil }
func (i *intent) MarkUnread(context.Context, id.RoomID, bool) error                { return nil }
func (i *intent) MarkTyping(context.Context, id.RoomID, bridgev2.TypingType, time.Duration) error {
	return nil
}

func (i *intent) DownloadMedia(ctx context.Context, uri id.ContentURIString, _ *event.EncryptedFileInfo) ([]byte, error) {
	data, _, _, err := i.h.rec.Blob(ctx, string(uri))
	return data, err
}

func (i *intent) DownloadMediaToFile(ctx context.Context, uri id.ContentURIString, file *event.EncryptedFileInfo, _ bool, callback func(*os.File) error) error {
	data, err := i.DownloadMedia(ctx, uri, file)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp("", "strad-messenger-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if _, err = f.Write(data); err != nil {
		return err
	}
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	return callback(f)
}

// UploadMedia keeps bytes only for media that belongs to a chat and that the
// network could not hand over as direct media; avatars (no room) are dropped,
// because nothing here serves a profile picture and every contact has one.
func (i *intent) UploadMedia(ctx context.Context, roomID id.RoomID, data []byte, fileName, mimeType string) (id.ContentURIString, *event.EncryptedFileInfo, error) {
	if roomID == "" || len(data) > maxStoredBlobBytes {
		return id.ContentURIString("mxc://" + serverName + "/dropped_" + uuid.NewString()), nil, nil
	}
	uri := id.ContentURIString("mxc://" + serverName + "/blob_" + uuid.NewString())
	return uri, nil, i.h.rec.PutBlob(ctx, string(uri), data, fileName, mimeType)
}

func (i *intent) UploadMediaStream(ctx context.Context, roomID id.RoomID, _ int64, _ bool, cb bridgev2.FileStreamCallback) (id.ContentURIString, *event.EncryptedFileInfo, error) {
	f, err := os.CreateTemp("", "strad-messenger-up-*")
	if err != nil {
		return "", nil, err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	res, err := cb(f)
	if err != nil {
		return "", nil, err
	}
	path := f.Name()
	if res.ReplacementFile != "" {
		path = res.ReplacementFile
		defer os.Remove(res.ReplacementFile)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", nil, err
	}
	return i.UploadMedia(ctx, roomID, data, res.FileName, res.MimeType)
}

func (i *intent) SetDisplayName(context.Context, string) error            { return nil }
func (i *intent) SetAvatarURL(context.Context, id.ContentURIString) error { return nil }
func (i *intent) SetExtraProfileMeta(context.Context, any) error          { return nil }
func (i *intent) SetProfile(context.Context, any) error                   { return nil }

func (i *intent) CreateRoom(_ context.Context, req *mautrix.ReqCreateRoom) (id.RoomID, error) {
	if req != nil && req.MeowRoomID != "" {
		return req.MeowRoomID, nil
	}
	return id.RoomID("!" + strings.ReplaceAll(uuid.NewString(), "-", "") + ":" + serverName), nil
}

func (i *intent) DeleteRoom(ctx context.Context, roomID id.RoomID, _ bool) error {
	return i.h.rec.ForgetRoom(ctx, roomID)
}

func (i *intent) EnsureJoined(context.Context, id.RoomID, ...bridgev2.EnsureJoinedParams) error {
	return nil
}
func (i *intent) EnsureInvited(context.Context, id.RoomID, id.UserID) error { return nil }
func (i *intent) TagRoom(context.Context, id.RoomID, event.RoomTag, bool) error {
	return nil
}
func (i *intent) MuteRoom(context.Context, id.RoomID, time.Time) error { return nil }

func (i *intent) GetEvent(ctx context.Context, roomID id.RoomID, eventID id.EventID) (*event.Event, error) {
	return nil, mautrix.MNotFound
}
