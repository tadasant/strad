// Copyright (C) 2026 Tadas Antanavicius
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version. See LICENSE in this directory.

package main

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/util/dbutil"
	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"
)

var now = time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)

func newRecorder(t *testing.T) (*Recorder, *Headless) {
	t.Helper()
	db, err := dbutil.NewFromConfig("test", dbutil.Config{PoolConfig: dbutil.PoolConfig{
		Type: "sqlite3-fk-wal", URI: "file:" + filepath.Join(t.TempDir(), "t.db") + "?_txlock=immediate", MaxOpenConns: 1,
	}}, dbutil.ZeroLogger(zerolog.Nop()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	rec := NewRecorder(db, 30*24*time.Hour)
	rec.clock = func() time.Time { return now }
	rec.ownerID = func() networkid.UserID { return "100" }
	if err = rec.Upgrade(context.Background()); err != nil {
		t.Fatal(err)
	}
	return rec, NewHeadless(rec)
}

func text(body string) *event.Content {
	return &event.Content{Parsed: &event.MessageEventContent{MsgType: event.MsgText, Body: body}}
}

func send(t *testing.T, h *Headless, room id.RoomID, sender networkid.UserID, content *event.Content, ts time.Time, msgID string) id.EventID {
	t.Helper()
	resp, err := h.GhostIntent(sender).SendMessage(context.Background(), room, event.EventMessage, content,
		&bridgev2.MatrixSendExtra{Timestamp: ts, MessageMeta: &database.Message{ID: networkid.MessageID(msgID)}})
	if err != nil {
		t.Fatal(err)
	}
	return resp.EventID
}

func TestRecordAndPage(t *testing.T) {
	rec, h := newRecorder(t)
	ctx := context.Background()
	for i, body := range []string{"one", "two", "three"} {
		send(t, h, "!a:strad.invalid", "200", text(body), now.Add(time.Duration(i)*time.Minute), "m"+body)
	}
	send(t, h, "!b:strad.invalid", "100", text("mine"), now, "mmine")

	rows, more, err := rec.Messages(ctx, MessageQuery{Limit: 2})
	if err != nil || !more || len(rows) != 2 || rows[0].Body != "one" || rows[1].Body != "two" {
		t.Fatalf("page 1: %v %v %+v", err, more, rows)
	}
	rows, more, _ = rec.Messages(ctx, MessageQuery{AfterSeq: rows[1].Seq, Limit: 10})
	if more || len(rows) != 2 || rows[0].Body != "three" || !rows[1].FromMe || rows[0].FromMe {
		t.Fatalf("page 2: %v %+v", more, rows)
	}
	rows, _, _ = rec.Messages(ctx, MessageQuery{RoomID: "!b:strad.invalid", Limit: 10})
	if len(rows) != 1 || rows[0].MessageID != "mmine" {
		t.Fatalf("room filter: %+v", rows)
	}
	rows, _, _ = rec.Messages(ctx, MessageQuery{SinceTS: now.Add(90 * time.Second).UnixMilli(), Limit: 10})
	if len(rows) != 1 || rows[0].Body != "three" {
		t.Fatalf("since filter: %+v", rows)
	}
	act, _ := rec.Activity(ctx)
	if act["!a:strad.invalid"].Count != 3 || act["!a:strad.invalid"].LastTS != now.Add(2*time.Minute).UnixMilli() {
		t.Fatalf("activity: %+v", act)
	}
}

func TestEditAndUnsendResurfaceAfterCursor(t *testing.T) {
	rec, h := newRecorder(t)
	ctx := context.Background()
	first := send(t, h, "!a:strad.invalid", "200", text("helo"), now, "m1")
	second := send(t, h, "!a:strad.invalid", "200", text("bye"), now, "m2")
	cursor, _ := rec.MaxSeq(ctx)

	edit := &event.MessageEventContent{MsgType: event.MsgText, Body: " * hello",
		NewContent: &event.MessageEventContent{MsgType: event.MsgText, Body: "hello"}}
	edit.SetEdit(first)
	send(t, h, "!a:strad.invalid", "200", &event.Content{Parsed: edit}, now.Add(time.Minute), "m1")
	if _, err := h.GhostIntent("200").SendMessage(ctx, "!a:strad.invalid", event.EventRedaction,
		&event.Content{Parsed: &event.RedactionEventContent{Redacts: second}}, nil); err != nil {
		t.Fatal(err)
	}

	rows, _, _ := rec.Messages(ctx, MessageQuery{AfterSeq: cursor, Limit: 10})
	if len(rows) != 2 {
		t.Fatalf("want the edit and the unsend after the cursor, got %+v", rows)
	}
	if rows[0].EventID != string(first) || rows[0].Body != "hello" || rows[0].EditedAt == 0 {
		t.Fatalf("edit: %+v", rows[0])
	}
	if rows[1].EventID != string(second) || !rows[1].Deleted || rows[1].Body != "" {
		t.Fatalf("unsend: %+v", rows[1])
	}
}

func TestReactionsAndMedia(t *testing.T) {
	rec, h := newRecorder(t)
	ctx := context.Background()
	uri, _ := h.GenerateContentURI(ctx, networkid.MediaID("media-descriptor"))
	img := &event.MessageEventContent{MsgType: event.MsgImage, Body: "photo.jpg", URL: uri,
		Info: &event.FileInfo{MimeType: "image/jpeg", Size: 1234}}
	evt := send(t, h, "!a:strad.invalid", "200", &event.Content{Parsed: img}, now, "m1")
	react := &event.ReactionEventContent{RelatesTo: event.RelatesTo{Type: event.RelAnnotation, EventID: evt, Key: "👍"}}
	if _, err := h.GhostIntent("100").SendMessage(ctx, "!a:strad.invalid", event.EventReaction, &event.Content{Parsed: react}, nil); err != nil {
		t.Fatal(err)
	}
	row, err := rec.Message(ctx, string(evt))
	if err != nil {
		t.Fatal(err)
	}
	if row.Kind != "image" || row.Body != "" || row.MediaName != "photo.jpg" || row.MediaMime != "image/jpeg" || row.Reactions["100"].Key != "👍" {
		t.Fatalf("row: %+v", row)
	}
	back, err := h.ParseContentURI(ctx, id.ContentURIString(row.MediaURI))
	if err != nil || string(back) != "media-descriptor" {
		t.Fatalf("media id round trip: %q %v", back, err)
	}
}

func TestRetentionAndBlobs(t *testing.T) {
	rec, h := newRecorder(t)
	ctx := context.Background()
	send(t, h, "!a:strad.invalid", "200", text("ancient"), now.Add(-60*24*time.Hour), "old")
	if n, _ := rec.MaxSeq(ctx); n != 0 {
		t.Fatalf("a message older than retention must not be recorded")
	}
	// Avatars (no room) are dropped; chat media is kept.
	avatar, _, _ := h.BotIntent().UploadMedia(ctx, "", []byte("x"), "a.png", "image/png")
	if _, _, _, err := rec.Blob(ctx, string(avatar)); err != ErrNotFound {
		t.Fatalf("avatar kept: %v", err)
	}
	kept, _, _ := h.BotIntent().UploadMedia(ctx, "!a:strad.invalid", []byte("bytes"), "f.txt", "text/plain")
	data, name, mime, err := rec.Blob(ctx, string(kept))
	if err != nil || string(data) != "bytes" || name != "f.txt" || mime != "text/plain" {
		t.Fatalf("blob: %q %q %q %v", data, name, mime, err)
	}
	send(t, h, "!a:strad.invalid", "200", text("new"), now, "new")
	rec.clock = func() time.Time { return now.Add(31 * 24 * time.Hour) }
	if n, _ := rec.Prune(ctx); n != 1 {
		t.Fatalf("prune: %d", n)
	}
}

func TestBatchSendAndGhostIDs(t *testing.T) {
	rec, h := newRecorder(t)
	ctx := context.Background()
	ghost := h.FormatGhostMXID("12345")
	if back, ok := h.ParseGhostMXID(ghost); !ok || back != "12345" {
		t.Fatalf("ghost round trip: %q %v", back, ok)
	}
	if _, ok := h.ParseGhostMXID("@someone:example.org"); ok {
		t.Fatal("foreign MXID parsed as a ghost")
	}
	req := &mautrix.ReqBeeperBatchSend{Events: []*event.Event{
		{Sender: ghost, Type: event.EventMessage, Timestamp: now.UnixMilli(), Content: *text("backfilled")},
	}}
	resp, err := h.BatchSend(ctx, "!a:strad.invalid", req, nil)
	if err != nil || len(resp.EventIDs) != 1 {
		t.Fatal(err)
	}
	row, err := rec.Message(ctx, string(resp.EventIDs[0]))
	if err != nil || row.SenderID != "12345" || row.Body != "backfilled" {
		t.Fatalf("%+v %v", row, err)
	}
	if h.GenerateDeterministicRoomID(networkid.PortalKey{ID: "1"}) == h.GenerateDeterministicRoomID(networkid.PortalKey{ID: "2"}) {
		t.Fatal("room IDs collide")
	}
}

func TestBumpedCursorIsNeverReused(t *testing.T) {
	rec, h := newRecorder(t)
	ctx := context.Background()
	send(t, h, "!b:strad.invalid", "200", text("keep1"), now, "k1")
	send(t, h, "!b:strad.invalid", "200", text("keep2"), now, "k2")
	victim := send(t, h, "!a:strad.invalid", "200", text("x"), now, "v")
	edit := &event.MessageEventContent{MsgType: event.MsgText, Body: " * y", NewContent: &event.MessageEventContent{MsgType: event.MsgText, Body: "y"}}
	edit.SetEdit(victim)
	send(t, h, "!a:strad.invalid", "200", &event.Content{Parsed: edit}, now, "v")
	cursor, _ := rec.MaxSeq(ctx) // a reader has seen the bumped row
	if err := rec.ForgetRoom(ctx, "!a:strad.invalid"); err != nil {
		t.Fatal(err)
	}
	send(t, h, "!b:strad.invalid", "200", text("new"), now, "n")
	rows, _, _ := rec.Messages(ctx, MessageQuery{AfterSeq: cursor, Limit: 10})
	if len(rows) != 1 || rows[0].Body != "new" {
		t.Fatalf("a row inserted after a bumped row was deleted must still be after the cursor: %+v", rows)
	}
}

func TestBotRedactionAndUnreact(t *testing.T) {
	rec, h := newRecorder(t)
	ctx := context.Background()
	evt := send(t, h, "!a:strad.invalid", "200", text("disappearing"), now, "d")
	if _, err := h.BotIntent().SendMessage(ctx, "!a:strad.invalid", event.EventRedaction,
		&event.Content{Parsed: &event.RedactionEventContent{Redacts: evt}}, nil); err != nil {
		t.Fatal(err)
	}
	row, _ := rec.Message(ctx, string(evt))
	if !row.Deleted || row.Body != "" {
		t.Fatalf("a redaction sent as the bot must delete: %+v", row)
	}

	target := send(t, h, "!a:strad.invalid", "200", text("react to me"), now, "r")
	react := &event.ReactionEventContent{RelatesTo: event.RelatesTo{Type: event.RelAnnotation, EventID: target, Key: "❤️"}}
	resp, err := h.GhostIntent("300").SendMessage(ctx, "!a:strad.invalid", event.EventReaction, &event.Content{Parsed: react}, nil)
	if err != nil {
		t.Fatal(err)
	}
	before, _ := rec.Message(ctx, string(target))
	if before.Reactions["300"].Key != "❤️" {
		t.Fatalf("reaction: %+v", before.Reactions)
	}
	if _, err = h.GhostIntent("300").SendMessage(ctx, "!a:strad.invalid", event.EventRedaction,
		&event.Content{Parsed: &event.RedactionEventContent{Redacts: resp.EventID}}, nil); err != nil {
		t.Fatal(err)
	}
	after, _ := rec.Message(ctx, string(target))
	if len(after.Reactions) != 0 || after.Seq <= before.Seq {
		t.Fatalf("unreact must remove the reaction and move the row past the cursor: %+v -> %+v", before, after)
	}
}

func TestLateDecryptionEditCarriesMedia(t *testing.T) {
	rec, h := newRecorder(t)
	ctx := context.Background()
	placeholder := send(t, h, "!a:strad.invalid", "200",
		&event.Content{Parsed: &event.MessageEventContent{MsgType: event.MsgNotice, Body: "Decrypting message failed"}}, now, "p")
	uri, _ := h.GenerateContentURI(ctx, networkid.MediaID("late-image"))
	img := &event.MessageEventContent{MsgType: event.MsgImage, Body: "late.jpg", URL: uri, Info: &event.FileInfo{MimeType: "image/jpeg", Size: 9}}
	edit := &event.MessageEventContent{MsgType: event.MsgImage, Body: " * late.jpg"}
	edit.SetEdit(placeholder) // SetEdit copies the outer content into NewContent
	edit.NewContent = img
	send(t, h, "!a:strad.invalid", "200", &event.Content{Parsed: edit}, now, "p")
	row, _ := rec.Message(ctx, string(placeholder))
	if row.Kind != "image" || row.MediaURI != string(uri) || row.MediaMime != "image/jpeg" || row.Body != "" {
		t.Fatalf("the decrypted message must replace the placeholder whole: %+v", row)
	}
}
