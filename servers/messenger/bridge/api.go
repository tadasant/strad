// Copyright (C) 2026 Tadas Antanavicius
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version. See LICENSE in this directory.

package main

// THE LOOPBACK API. One client: servers/messenger/shared, in the same
// container. It listens on 127.0.0.1 only and every request carries the
// bearer token the host generated at spawn, so another process in the
// container that finds the port still cannot read a chat.

import (
	"bytes"
	"cmp"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/id"
	"maunium.net/go/mautrix/mediaproxy"

	"go.mau.fi/mautrix-meta/pkg/metaid"
)

type API struct {
	token    string
	bridge   *bridgev2.Bridge
	user     *bridgev2.User
	rec      *Recorder
	headless *Headless
	login    *Login
	started  time.Time
}

func ownerGhostID(user *bridgev2.User) func() networkid.UserID {
	return func() networkid.UserID {
		ul := user.GetDefaultLogin()
		if ul == nil {
			return ""
		}
		return metaid.MakeUserID(metaid.ParseUserLoginID(ul.ID))
	}
}

func (a *API) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", a.status)
	mux.HandleFunc("GET /threads", a.threads)
	mux.HandleFunc("GET /messages", a.messages)
	mux.HandleFunc("GET /attachment", a.attachment)
	mux.HandleFunc("POST /login/start", a.loginStart)
	mux.HandleFunc("POST /login/submit", a.loginSubmit)
	mux.HandleFunc("POST /login/cancel", a.loginCancel)
	mux.HandleFunc("POST /logout", a.logout)
	mux.HandleFunc("POST /snapshot", a.snapshot)
	return a.auth(mux)
}

func (a *API) auth(next http.Handler) http.Handler {
	want := []byte("Bearer " + a.token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), want) != 1 {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// ---- status -----------------------------------------------------------------

type accountStatus struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	State       string `json:"state"`
	StateError  string `json:"state_error,omitempty"`
	StateReason string `json:"state_message,omitempty"`
}

func (a *API) status(w http.ResponseWriter, r *http.Request) {
	var accounts []accountStatus
	for _, ul := range a.user.GetUserLogins() {
		prev := ul.BridgeState.GetPrev()
		accounts = append(accounts, accountStatus{
			ID: string(ul.ID), Name: ul.RemoteName,
			State: string(prev.StateEvent), StateError: string(prev.Error), StateReason: prev.Message,
		})
	}
	maxSeq, _ := a.rec.MaxSeq(r.Context())
	writeJSON(w, map[string]any{
		"accounts":          accounts,
		"login_in_progress": a.login.InProgress(),
		"cursor":            maxSeq,
		"uptime_seconds":    int(time.Since(a.started).Seconds()),
	})
}

// ---- threads ----------------------------------------------------------------

type threadView struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Type           string `json:"type"`
	Encrypted      bool   `json:"encrypted"`
	MessageRequest bool   `json:"message_request,omitempty"`
	LastMessageAt  int64  `json:"last_message_at_ms,omitempty"`
	LastCursor     int64  `json:"last_cursor,omitempty"`
	Buffered       int64  `json:"buffered_messages"`
}

func roomType(t database.RoomType) string {
	switch t {
	case database.RoomTypeDM:
		return "dm"
	case database.RoomTypeGroupDM, database.RoomTypeDefault:
		return "group"
	default:
		return string(t)
	}
}

// encrypted: an end-to-end encrypted chat is keyed by its WhatsApp-protocol
// JID, which mautrix-meta records in the portal metadata.
func encrypted(p *database.Portal) bool {
	meta, ok := p.Metadata.(*metaid.PortalMetadata)
	return ok && meta.WhatsAppServer != ""
}

func (a *API) ghostName(ctx context.Context, cache map[networkid.UserID]string, uid networkid.UserID) string {
	if uid == "" {
		return ""
	}
	if name, ok := cache[uid]; ok {
		return name
	}
	name := ""
	if g, err := a.bridge.DB.Ghost.GetByID(ctx, uid); err == nil && g != nil {
		name = g.Name
	}
	cache[uid] = name
	return name
}

func (a *API) portalsByRoom(ctx context.Context) (map[id.RoomID]*database.Portal, error) {
	portals, err := a.bridge.DB.Portal.GetAllWithMXID(ctx)
	if err != nil {
		return nil, err
	}
	out := make(map[id.RoomID]*database.Portal, len(portals))
	for _, p := range portals {
		out[p.MXID] = p
	}
	return out, nil
}

func (a *API) threads(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	updatedAfter, _ := strconv.ParseInt(r.URL.Query().Get("updated_after_ms"), 10, 64)
	limit := clampInt(r.URL.Query().Get("limit"), 100, 1, 500)
	portals, err := a.portalsByRoom(ctx)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	activity, err := a.rec.Activity(ctx)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	names := map[networkid.UserID]string{}
	var out []threadView
	for room, p := range portals {
		act := activity[room]
		if updatedAfter > 0 && act.LastTS < updatedAfter {
			continue
		}
		name := p.Name
		if name == "" && p.OtherUserID != "" {
			name = a.ghostName(ctx, names, p.OtherUserID)
		}
		out = append(out, threadView{
			ID: string(p.ID), Name: name, Type: roomType(p.RoomType), Encrypted: encrypted(p),
			MessageRequest: p.MessageRequest, LastMessageAt: act.LastTS, LastCursor: act.LastSeq, Buffered: act.Count,
		})
	}
	// Most recent first, chats with nothing buffered last.
	sortThreads(out)
	more := len(out) > limit
	if more {
		out = out[:limit]
	}
	writeJSON(w, map[string]any{"threads": out, "has_more": more})
}

// ---- messages ---------------------------------------------------------------

type attachmentView struct {
	Name     string `json:"name,omitempty"`
	MimeType string `json:"mime_type,omitempty"`
	Size     int64  `json:"size_bytes,omitempty"`
}

type reactionView struct {
	SenderID string `json:"sender_id"`
	Emoji    string `json:"emoji"`
}

type messageView struct {
	*Row
	ThreadID   string          `json:"thread_id"`
	ThreadName string          `json:"thread_name,omitempty"`
	SenderName string          `json:"sender_name,omitempty"`
	Attachment *attachmentView `json:"attachment,omitempty"`
	Reactions  []reactionView  `json:"reactions,omitempty"`
}

func (a *API) messages(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()
	portals, err := a.portalsByRoom(ctx)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	query := MessageQuery{Limit: clampInt(q.Get("limit"), 100, 1, 500)}
	query.AfterSeq, _ = strconv.ParseInt(q.Get("cursor"), 10, 64)
	query.SinceTS, _ = strconv.ParseInt(q.Get("since_ms"), 10, 64)
	if thread := q.Get("thread_id"); thread != "" {
		for room, p := range portals {
			if string(p.ID) == thread {
				query.RoomID = room
				break
			}
		}
		if query.RoomID == "" {
			writeErr(w, 404, "no thread with that id: list them with messenger_list_threads")
			return
		}
	}
	rows, more, err := a.rec.Messages(ctx, query)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	names := map[networkid.UserID]string{}
	out := make([]messageView, 0, len(rows))
	next := query.AfterSeq
	for _, row := range rows {
		next = row.Seq
		mv := messageView{Row: row, SenderName: a.ghostName(ctx, names, networkid.UserID(row.SenderID))}
		if p := portals[id.RoomID(row.RoomID)]; p != nil {
			mv.ThreadID = string(p.ID)
			mv.ThreadName = p.Name
		}
		if row.MediaURI != "" && !strings.Contains(row.MediaURI, "/dropped_") {
			mv.Attachment = &attachmentView{Name: row.MediaName, MimeType: row.MediaMime, Size: row.MediaSize}
		}
		for sender, re := range row.Reactions {
			mv.Reactions = append(mv.Reactions, reactionView{SenderID: sender, Emoji: re.Key})
		}
		out = append(out, mv)
	}
	writeJSON(w, map[string]any{"messages": out, "next_cursor": next, "has_more": more})
}

// ---- attachments ------------------------------------------------------------

func (a *API) attachment(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	row, err := a.rec.Message(ctx, r.URL.Query().Get("id"))
	if errors.Is(err, ErrNotFound) {
		writeErr(w, 404, "no message with that id")
		return
	} else if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	if row.MediaURI == "" || strings.Contains(row.MediaURI, "/dropped_") {
		writeErr(w, 404, "that message has no attachment this bridge can fetch")
		return
	}
	data, mime, err := a.fetchMedia(ctx, row)
	if err != nil {
		writeErr(w, 502, "Meta did not hand over the file: "+err.Error())
		return
	}
	if mime == "" {
		mime = row.MediaMime
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("X-File-Name", row.MediaName)
	_, _ = w.Write(data)
}

func readCapped(rd io.Reader) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(rd, maxMediaBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxMediaBytes {
		return nil, fmt.Errorf("file is larger than %d MB", maxMediaBytes>>20)
	}
	return data, nil
}

func (a *API) fetchMedia(ctx context.Context, row *Row) ([]byte, string, error) {
	if strings.Contains(row.MediaURI, "/blob_") {
		data, _, mime, err := a.rec.Blob(ctx, row.MediaURI)
		return data, mime, err
	}
	mediaID, err := a.headless.ParseContentURI(ctx, id.ContentURIString(row.MediaURI))
	if err != nil {
		return nil, "", err
	}
	dm, ok := a.bridge.Network.(bridgev2.DirectMediableNetwork)
	if !ok {
		return nil, "", fmt.Errorf("direct media unsupported")
	}
	resp, err := dm.Download(ctx, mediaID, nil)
	if err != nil {
		return nil, "", err
	}
	switch m := resp.(type) {
	case *mediaproxy.GetMediaResponseData:
		defer m.Reader.Close()
		data, err := readCapped(m.Reader)
		return data, m.ContentType, err
	case *mediaproxy.GetMediaResponseCallback:
		var buf bytes.Buffer
		if _, err := m.Callback(&buf); err != nil {
			return nil, "", err
		}
		data, err := readCapped(&buf)
		return data, m.ContentType, err
	case *mediaproxy.GetMediaResponseFile:
		f, err := os.CreateTemp("", "strad-messenger-dl-*")
		if err != nil {
			return nil, "", err
		}
		defer os.Remove(f.Name())
		defer f.Close()
		meta, err := m.Callback(f)
		if err != nil {
			return nil, "", err
		}
		if _, err = f.Seek(0, io.SeekStart); err != nil {
			return nil, "", err
		}
		data, err := readCapped(f)
		mime := ""
		if meta != nil {
			mime = meta.ContentType
		}
		return data, mime, err
	case *mediaproxy.GetMediaResponseURL:
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.URL, nil)
		if err != nil {
			return nil, "", err
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, "", err
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			return nil, "", fmt.Errorf("media host answered %d", res.StatusCode)
		}
		data, err := readCapped(res.Body)
		return data, res.Header.Get("Content-Type"), err
	default:
		return nil, "", fmt.Errorf("unexpected media response %T", resp)
	}
}

// ---- login ------------------------------------------------------------------

func readBody(r *http.Request, v any) error {
	return json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(v)
}

func (a *API) loginStart(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Flow string `json:"flow"`
	}
	if err := readBody(r, &body); err != nil {
		writeErr(w, 400, "bad body")
		return
	}
	step, err := a.login.Start(r.Context(), body.Flow)
	if err != nil {
		writeErr(w, loginErrCode(err), err.Error())
		return
	}
	writeJSON(w, step)
}

func (a *API) loginSubmit(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Input map[string]string `json:"input"`
	}
	if err := readBody(r, &body); err != nil {
		writeErr(w, 400, "bad body")
		return
	}
	if body.Input == nil {
		body.Input = map[string]string{}
	}
	step, err := a.login.Submit(r.Context(), body.Input)
	for k := range body.Input {
		delete(body.Input, k)
	}
	if err != nil {
		writeErr(w, loginErrCode(err), err.Error())
		return
	}
	writeJSON(w, step)
}

func loginErrCode(err error) int {
	switch {
	case errors.Is(err, ErrNoLoginInProgress), errors.Is(err, ErrAlreadyConnected):
		return http.StatusConflict
	case errors.Is(err, ErrUnknownFlow):
		return http.StatusBadRequest
	default:
		return http.StatusUnprocessableEntity
	}
}

func (a *API) loginCancel(w http.ResponseWriter, _ *http.Request) {
	a.login.Cancel()
	writeJSON(w, map[string]bool{"cancelled": true})
}

func (a *API) logout(w http.ResponseWriter, r *http.Request) {
	a.login.Cancel()
	n := 0
	for _, ul := range a.user.GetUserLogins() {
		ul.Logout(r.Context())
		n++
	}
	writeJSON(w, map[string]int{"logged_out": n})
}

// ---- snapshot ---------------------------------------------------------------

// snapshot writes a consistent copy of the whole database to `path` (inside
// the data directory). VACUUM INTO is SQLite's own online backup: it reads
// one transaction, so the copy never holds half a write.
func (a *API) snapshot(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path string `json:"path"`
	}
	if err := readBody(r, &body); err != nil || body.Path == "" {
		writeErr(w, 400, "path required")
		return
	}
	_ = os.Remove(body.Path)
	if _, err := a.bridge.DB.Exec(r.Context(), "VACUUM INTO $1", body.Path); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, map[string]string{"path": body.Path})
}

// ---- helpers ----------------------------------------------------------------

func clampInt(raw string, fallback, lo, hi int) int {
	n, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return max(lo, min(hi, n))
}

func sortThreads(t []threadView) {
	slices.SortFunc(t, func(a, b threadView) int {
		if a.LastMessageAt != b.LastMessageAt {
			return cmp.Compare(b.LastMessageAt, a.LastMessageAt)
		}
		return strings.Compare(a.ID, b.ID)
	})
}
