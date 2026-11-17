// Copyright (C) 2026 Tadas Antanavicius
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version. See LICENSE in this directory.

package main

// THE BUFFER. Every message bridgev2 "sends to Matrix" lands here as a row, in
// the same SQLite file as bridgev2's and whatsmeow's own tables, so one
// snapshot of one file is the whole state: the login, the encryption keys, the
// chats and the messages.
//
// seq is the read cursor. It is assigned on insert and REASSIGNED when a row
// changes (an edit, an unsend), so "everything after cursor N" also returns
// what changed since N. Timestamps cannot be the cursor: backfill inserts old
// messages late, and a sweep that asked "after the last timestamp I saw" would
// never see them.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"go.mau.fi/util/dbutil"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"
)

const (
	// The largest attachment messenger_get_attachment will fetch from Meta.
	maxMediaBytes = 25 << 20
	// The largest file kept as bytes in the snapshot, for the rare media the
	// network cannot hand over as direct media. Larger ones are dropped.
	maxStoredBlobBytes = 2 << 20
)

var ErrNotFound = errors.New("not found")

type Recorder struct {
	db        *dbutil.Database
	retention time.Duration
	clock     func() time.Time
	// ownerID reports the logged-in account's own network user ID, so a row
	// can say from_me. Empty before login.
	ownerID func() networkid.UserID
}

func NewRecorder(db *dbutil.Database, retention time.Duration) *Recorder {
	return &Recorder{db: db, retention: retention, clock: time.Now, ownerID: func() networkid.UserID { return "" }}
}

const recorderSchema = `
CREATE TABLE IF NOT EXISTS strad_message (
	seq          INTEGER PRIMARY KEY AUTOINCREMENT,
	event_id     TEXT    NOT NULL UNIQUE,
	room_id      TEXT    NOT NULL,
	message_id   TEXT    NOT NULL DEFAULT '',
	part_id      TEXT    NOT NULL DEFAULT '',
	sender_id    TEXT    NOT NULL DEFAULT '',
	from_me      INTEGER NOT NULL DEFAULT 0,
	ts           INTEGER NOT NULL,
	kind         TEXT    NOT NULL,
	body         TEXT    NOT NULL DEFAULT '',
	reply_to     TEXT    NOT NULL DEFAULT '',
	media_uri    TEXT    NOT NULL DEFAULT '',
	media_mime   TEXT    NOT NULL DEFAULT '',
	media_name   TEXT    NOT NULL DEFAULT '',
	media_size   INTEGER NOT NULL DEFAULT 0,
	reactions    TEXT    NOT NULL DEFAULT '{}',
	edited_at    INTEGER NOT NULL DEFAULT 0,
	deleted      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS strad_message_room_seq ON strad_message (room_id, seq);
CREATE INDEX IF NOT EXISTS strad_message_ts ON strad_message (ts);
CREATE TABLE IF NOT EXISTS strad_blob (
	uri     TEXT PRIMARY KEY,
	mime    TEXT NOT NULL DEFAULT '',
	name    TEXT NOT NULL DEFAULT '',
	data    BLOB NOT NULL,
	created INTEGER NOT NULL
);
`

func (r *Recorder) Upgrade(ctx context.Context) error {
	for _, stmt := range strings.Split(recorderSchema, ";") {
		if strings.TrimSpace(stmt) == "" {
			continue
		}
		if _, err := r.db.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("strad recorder schema: %w", err)
		}
	}
	return nil
}

// kindOf is the one word a reader filters on.
func kindOf(content *event.MessageEventContent) string {
	switch content.MsgType {
	case event.MsgText, "":
		return "text"
	case event.MsgNotice:
		return "notice"
	case event.MsgEmote:
		return "emote"
	case event.MsgImage:
		return "image"
	case event.MsgVideo:
		return "video"
	case event.MsgAudio:
		return "audio"
	case event.MsgFile:
		return "file"
	case event.MsgLocation:
		return "location"
	default:
		return strings.TrimPrefix(string(content.MsgType), "m.")
	}
}

func (r *Recorder) tooOld(ts time.Time) bool {
	return r.retention > 0 && ts.Before(r.clock().Add(-r.retention))
}

// Record is every send, live or backfilled.
func (r *Recorder) Record(ctx context.Context, roomID id.RoomID, eventID id.EventID, evtType event.Type, content *event.Content, sender networkid.UserID, ts time.Time, extra *bridgev2.MatrixSendExtra) error {
	if content.Parsed == nil {
		_ = content.ParseRaw(evtType)
	}
	switch evtType {
	case event.EventMessage, event.EventSticker:
		msg, ok := content.Parsed.(*event.MessageEventContent)
		if !ok {
			return nil
		}
		if msg.RelatesTo != nil && msg.RelatesTo.Type == event.RelReplace {
			return r.edit(ctx, msg.RelatesTo.EventID, msg, ts)
		}
		if r.tooOld(ts) {
			return nil
		}
		kind := kindOf(msg)
		if evtType == event.EventSticker {
			kind = "sticker"
		}
		var messageID, partID string
		if extra != nil && extra.MessageMeta != nil {
			messageID = string(extra.MessageMeta.ID)
			partID = string(extra.MessageMeta.PartID)
		}
		replyTo := ""
		if msg.RelatesTo != nil && msg.RelatesTo.InReplyTo != nil {
			replyTo = string(msg.RelatesTo.InReplyTo.EventID)
		}
		body := msg.Body
		mediaName := ""
		var mediaMime string
		var mediaSize int
		if msg.URL != "" {
			mediaName = msg.FileName
			if mediaName == "" {
				mediaName = msg.Body
			}
			if msg.FileName == "" || msg.FileName == msg.Body {
				body = "" // the body of a captionless file is its name
			}
			if msg.Info != nil {
				mediaMime = msg.Info.MimeType
				mediaSize = msg.Info.Size
			}
		}
		fromMe := sender != "" && sender == r.ownerID()
		_, err := r.db.Exec(ctx, `
			INSERT INTO strad_message (event_id, room_id, message_id, part_id, sender_id, from_me, ts, kind, body, reply_to, media_uri, media_mime, media_name, media_size)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
			ON CONFLICT (event_id) DO NOTHING`,
			eventID, roomID, messageID, partID, sender, fromMe, ts.UnixMilli(), kind, body, replyTo,
			string(msg.URL), mediaMime, mediaName, mediaSize)
		return err
	case event.EventReaction:
		react, ok := content.Parsed.(*event.ReactionEventContent)
		if !ok || react.RelatesTo.EventID == "" {
			return nil
		}
		return r.react(ctx, react.RelatesTo.EventID, sender, react.RelatesTo.Key, ts)
	case event.EventRedaction:
		red, ok := content.Parsed.(*event.RedactionEventContent)
		if !ok || red.Redacts == "" {
			return nil
		}
		return r.redact(ctx, red.Redacts, ts)
	}
	return nil
}

// bumpSeq moves a changed row to the end of the cursor order.
func (r *Recorder) bumpSeq(ctx context.Context, eventID id.EventID) error {
	_, err := r.db.Exec(ctx, `
		UPDATE strad_message SET seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM strad_message)
		WHERE event_id = $1`, eventID)
	return err
}

func (r *Recorder) edit(ctx context.Context, target id.EventID, msg *event.MessageEventContent, ts time.Time) error {
	newContent := msg.NewContent
	if newContent == nil {
		newContent = msg
	}
	body := strings.TrimPrefix(newContent.Body, " * ")
	res, err := r.db.Exec(ctx, `UPDATE strad_message SET body = $2, edited_at = $3 WHERE event_id = $1`, target, body, ts.UnixMilli())
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil
	}
	return r.bumpSeq(ctx, target)
}

func (r *Recorder) redact(ctx context.Context, target id.EventID, ts time.Time) error {
	res, err := r.db.Exec(ctx, `
		UPDATE strad_message SET deleted = 1, body = '', media_uri = '', edited_at = $2
		WHERE event_id = $1`, target, ts.UnixMilli())
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		// A redaction of a reaction: find the message carrying it.
		return r.unreact(ctx, target)
	}
	return r.bumpSeq(ctx, target)
}

// Reactions are a map of sender -> emoji, stored as JSON on the target row,
// with the reaction's own event ID kept so an unreact can find it.
type reactionEntry struct {
	Key     string `json:"key"`
	EventID string `json:"event_id,omitempty"`
}

func (r *Recorder) react(ctx context.Context, target id.EventID, sender networkid.UserID, key string, _ time.Time) error {
	return r.updateReactions(ctx, target, func(m map[string]reactionEntry) bool {
		m[string(sender)] = reactionEntry{Key: key}
		return true
	})
}

func (r *Recorder) unreact(ctx context.Context, _ id.EventID) error {
	// bridgev2 sends reaction removals as redactions of the reaction event,
	// whose ID this table never saw (reactions are folded into their target).
	// Losing a removed reaction is a cosmetic gap, not worth a second table.
	return nil
}

func (r *Recorder) updateReactions(ctx context.Context, target id.EventID, fn func(map[string]reactionEntry) bool) error {
	var raw string
	err := r.db.QueryRow(ctx, `SELECT reactions FROM strad_message WHERE event_id = $1`, target).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	} else if err != nil {
		return err
	}
	m := map[string]reactionEntry{}
	_ = json.Unmarshal([]byte(raw), &m)
	if !fn(m) {
		return nil
	}
	out, _ := json.Marshal(m)
	_, err = r.db.Exec(ctx, `UPDATE strad_message SET reactions = $2 WHERE event_id = $1`, target, string(out))
	return err
}

func (r *Recorder) ForgetRoom(ctx context.Context, roomID id.RoomID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM strad_message WHERE room_id = $1`, roomID)
	return err
}

func (r *Recorder) PutBlob(ctx context.Context, uri string, data []byte, name, mime string) error {
	_, err := r.db.Exec(ctx, `
		INSERT INTO strad_blob (uri, mime, name, data, created) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (uri) DO NOTHING`, uri, mime, name, data, r.clock().UnixMilli())
	return err
}

func (r *Recorder) Blob(ctx context.Context, uri string) (data []byte, name, mime string, err error) {
	err = r.db.QueryRow(ctx, `SELECT data, name, mime FROM strad_blob WHERE uri = $1`, uri).Scan(&data, &name, &mime)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return
}

// Prune drops rows past the retention window. Called on a timer.
func (r *Recorder) Prune(ctx context.Context) (int64, error) {
	if r.retention <= 0 {
		return 0, nil
	}
	cutoff := r.clock().Add(-r.retention).UnixMilli()
	res, err := r.db.Exec(ctx, `DELETE FROM strad_message WHERE ts < $1`, cutoff)
	if err != nil {
		return 0, err
	}
	if _, err = r.db.Exec(ctx, `DELETE FROM strad_blob WHERE created < $1`, cutoff); err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// Row is one buffered message as the API returns it.
type Row struct {
	Seq       int64                    `json:"seq"`
	EventID   string                   `json:"id"`
	RoomID    string                   `json:"-"`
	MessageID string                   `json:"message_id,omitempty"`
	SenderID  string                   `json:"sender_id"`
	FromMe    bool                     `json:"from_me"`
	TS        int64                    `json:"timestamp_ms"`
	Kind      string                   `json:"type"`
	Body      string                   `json:"text"`
	ReplyTo   string                   `json:"reply_to,omitempty"`
	MediaURI  string                   `json:"-"`
	MediaMime string                   `json:"-"`
	MediaName string                   `json:"-"`
	MediaSize int64                    `json:"-"`
	Reactions map[string]reactionEntry `json:"-"`
	EditedAt  int64                    `json:"edited_at_ms,omitempty"`
	Deleted   bool                     `json:"deleted,omitempty"`
}

const rowColumns = `seq, event_id, room_id, message_id, sender_id, from_me, ts, kind, body, reply_to, media_uri, media_mime, media_name, media_size, reactions, edited_at, deleted`

func scanRow(row dbutil.Scannable) (*Row, error) {
	var out Row
	var reactions string
	err := row.Scan(&out.Seq, &out.EventID, &out.RoomID, &out.MessageID, &out.SenderID, &out.FromMe, &out.TS, &out.Kind,
		&out.Body, &out.ReplyTo, &out.MediaURI, &out.MediaMime, &out.MediaName, &out.MediaSize, &reactions, &out.EditedAt, &out.Deleted)
	if err != nil {
		return nil, err
	}
	out.Reactions = map[string]reactionEntry{}
	_ = json.Unmarshal([]byte(reactions), &out.Reactions)
	return &out, nil
}

// MessageQuery is one page. RoomID empty means every chat.
type MessageQuery struct {
	RoomID   id.RoomID
	AfterSeq int64
	SinceTS  int64
	Limit    int
}

// Messages returns up to Limit rows after the cursor, oldest seq first, and
// whether more are waiting.
func (r *Recorder) Messages(ctx context.Context, q MessageQuery) ([]*Row, bool, error) {
	where := []string{"seq > $1"}
	args := []any{q.AfterSeq}
	if q.RoomID != "" {
		args = append(args, q.RoomID)
		where = append(where, fmt.Sprintf("room_id = $%d", len(args)))
	}
	if q.SinceTS > 0 {
		args = append(args, q.SinceTS)
		where = append(where, fmt.Sprintf("ts >= $%d", len(args)))
	}
	args = append(args, q.Limit+1)
	rows, err := r.db.Query(ctx, fmt.Sprintf(`SELECT %s FROM strad_message WHERE %s ORDER BY seq ASC LIMIT $%d`,
		rowColumns, strings.Join(where, " AND "), len(args)), args...)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	var out []*Row
	for rows.Next() {
		row, err := scanRow(rows)
		if err != nil {
			return nil, false, err
		}
		out = append(out, row)
	}
	if err = rows.Err(); err != nil {
		return nil, false, err
	}
	more := len(out) > q.Limit
	if more {
		out = out[:q.Limit]
	}
	return out, more, nil
}

func (r *Recorder) Message(ctx context.Context, eventID string) (*Row, error) {
	row, err := scanRow(r.db.QueryRow(ctx, fmt.Sprintf(`SELECT %s FROM strad_message WHERE event_id = $1`, rowColumns), eventID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return row, err
}

// RoomActivity is per-room: the newest message time, the newest seq, and how
// many rows are buffered.
type RoomActivity struct {
	LastTS  int64
	LastSeq int64
	Count   int64
}

func (r *Recorder) Activity(ctx context.Context) (map[id.RoomID]RoomActivity, error) {
	rows, err := r.db.Query(ctx, `SELECT room_id, MAX(ts), MAX(seq), COUNT(*) FROM strad_message GROUP BY room_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[id.RoomID]RoomActivity{}
	for rows.Next() {
		var room id.RoomID
		var a RoomActivity
		if err = rows.Scan(&room, &a.LastTS, &a.LastSeq, &a.Count); err != nil {
			return nil, err
		}
		out[room] = a
	}
	return out, rows.Err()
}

// MaxSeq is the cursor a reader that has seen everything holds.
func (r *Recorder) MaxSeq(ctx context.Context) (int64, error) {
	var seq sql.NullInt64
	err := r.db.QueryRow(ctx, `SELECT MAX(seq) FROM strad_message`).Scan(&seq)
	return seq.Int64, err
}
