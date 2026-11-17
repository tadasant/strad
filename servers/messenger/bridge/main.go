// Copyright (C) 2026 Tadas Antanavicius
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version. See LICENSE in this directory.

// strad-messenger-bridge is the Messenger half of strad's `messenger` server:
// mautrix-meta's network connector, run headless (headless.go), behind a
// loopback HTTP API (api.go) that the TypeScript MCP server in
// servers/messenger/shared is the only client of.
//
// It is a SEPARATE PROGRAM, and that is the licensing boundary: mautrix-meta
// is AGPL-3.0, so this directory is too, and strad (MIT) talks to it over a
// socket rather than linking it. See README.md in the parent directory.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/util/dbutil"
	_ "go.mau.fi/util/dbutil/litestream"
	"gopkg.in/yaml.v3"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/bridgeconfig"
	"maunium.net/go/mautrix/bridgev2/commands"

	"go.mau.fi/mautrix-meta/pkg/connector"
)

// The bridgev2 settings that matter here. Everything Matrix-facing is off;
// backfill is ON with its queue, because that is what both catches a chat up
// after a reconnect and restores encrypted history from Meta's backup.
const bridgeYAML = `
bridge:
    command_prefix: "!fb"
    personal_filtering_spaces: false
    private_chat_portal_meta: true
    bridge_status_notices: none
    unknown_error_max_auto_reconnects: 10
    tag_only_on_create: true
    mute_only_on_create: true
    portal_event_buffer: 64
    kick_matrix_users: false
    cleanup_on_logout:
        enabled: false
    relay:
        enabled: false
    portal_create_filter:
        mode: deny
        list: []
    permissions:
        "@owner:strad.invalid": admin
backfill:
    enabled: true
    max_initial_messages: 50
    max_catchup_messages: 500
    unread_hours_threshold: 720
    threads:
        max_initial_messages: 50
    queue:
        enabled: true
        manual: false
        batch_size: 100
        batch_delay: 20
        max_batches: 4
        max_batches_override: {}
`

type settings struct {
	dataDir   string
	listen    string
	token     string
	proxy     string
	retention time.Duration
	logLevel  zerolog.Level
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func readSettings() (*settings, error) {
	s := &settings{
		dataDir: os.Getenv("MESSENGER_BRIDGE_DATA_DIR"),
		listen:  envOr("MESSENGER_BRIDGE_LISTEN", "127.0.0.1:0"),
		token:   os.Getenv("MESSENGER_BRIDGE_TOKEN"),
		proxy:   os.Getenv("MESSENGER_PROXY"),
	}
	if s.dataDir == "" || s.token == "" {
		return nil, fmt.Errorf("MESSENGER_BRIDGE_DATA_DIR and MESSENGER_BRIDGE_TOKEN are required")
	}
	host, _, err := net.SplitHostPort(s.listen)
	if err != nil || (host != "127.0.0.1" && host != "::1" && host != "localhost") {
		return nil, fmt.Errorf("MESSENGER_BRIDGE_LISTEN must be a loopback address")
	}
	days, err := strconv.Atoi(envOr("MESSENGER_BUFFER_MAX_AGE_DAYS", "30"))
	if err != nil || days < 1 || days > 365 {
		return nil, fmt.Errorf("MESSENGER_BUFFER_MAX_AGE_DAYS must be a whole number of days from 1 to 365")
	}
	s.retention = time.Duration(days) * 24 * time.Hour
	s.logLevel, err = zerolog.ParseLevel(envOr("MESSENGER_BRIDGE_LOG_LEVEL", "info"))
	if err != nil {
		return nil, err
	}
	return s, nil
}

func main() {
	if err := run(); err != nil {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"event": "fatal", "error": err.Error()})
		os.Exit(1)
	}
}

func run() error {
	s, err := readSettings()
	if err != nil {
		return err
	}
	// Logs go to stderr as JSON. The host never ships stderr (it carries text
	// Meta wrote); stdout carries only this program's own events.
	log := zerolog.New(os.Stderr).Level(s.logLevel).With().Timestamp().Str("component", "messenger-bridge").Logger()
	zerolog.DefaultContextLogger = &log

	if err = os.MkdirAll(s.dataDir, 0o700); err != nil {
		return err
	}
	dbPath := filepath.Join(s.dataDir, "bridge.db")
	db, err := dbutil.NewFromConfig("strad-messenger-bridge", dbutil.Config{
		PoolConfig: dbutil.PoolConfig{
			Type:         "sqlite3-fk-wal",
			URI:          "file:" + dbPath + "?_txlock=immediate",
			MaxOpenConns: 5,
			MaxIdleConns: 1,
		},
	}, dbutil.ZeroLogger(log.With().Str("db_section", "main").Logger()))
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}

	var cfg bridgeconfig.Config
	if err = yaml.Unmarshal([]byte(bridgeYAML), &cfg); err != nil {
		return fmt.Errorf("bridge config: %w", err)
	}
	cfg.Bridge.Backfill = cfg.Backfill

	meta := &connector.MetaConnector{}
	example, _, _ := meta.GetConfig()
	if err = yaml.Unmarshal([]byte(example), &meta.Config); err != nil {
		return fmt.Errorf("network config: %w", err)
	}
	meta.Config.E2EEBackfill = true
	meta.Config.LogRedactedLoginResponses = false
	if s.proxy != "" {
		meta.Config.Proxy = s.proxy
		meta.Config.ProxyMedia = true
		meta.Config.ProxyE2EE = true
		meta.Config.ProxyMessengerLite = true
		meta.Config.ProxyOther = true
	}

	rec := NewRecorder(db, s.retention)
	headless := NewHeadless(rec)
	br := bridgev2.NewBridge("", db, log, &cfg.Bridge, headless, meta, commands.NewProcessor)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	if err = br.StartConnectors(ctx); err != nil {
		return fmt.Errorf("start: %w", err)
	}
	user, err := br.GetUserByMXID(ctx, ownerMXID)
	if err != nil {
		return fmt.Errorf("owner user: %w", err)
	}
	rec.ownerID = ownerGhostID(user)
	if err = br.StartLogins(ctx); err != nil {
		return fmt.Errorf("start logins: %w", err)
	}
	go br.PostStart(ctx)

	api := &API{
		token:    s.token,
		bridge:   br,
		user:     user,
		rec:      rec,
		headless: headless,
		login:    &Login{bridge: br, user: user},
		started:  time.Now(),
	}
	api.login.onComplete = func() { emit(map[string]any{"event": "login_complete"}) }

	ln, err := net.Listen("tcp", s.listen)
	if err != nil {
		return err
	}
	srv := &http.Server{Handler: api.Routes(), ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	emit(map[string]any{"event": "listening", "addr": ln.Addr().String()})

	go pruneLoop(ctx, rec, log)

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
	br.StopWithTimeout(5 * time.Second)
	_ = db.Close()
	emit(map[string]any{"event": "stopped"})
	return nil
}

// emit writes one JSON line to stdout: the host's whole protocol for events
// it has not asked for (ready, login complete, stopped).
func emit(v map[string]any) {
	_ = json.NewEncoder(os.Stdout).Encode(v)
}

func pruneLoop(ctx context.Context, rec *Recorder, log zerolog.Logger) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		if n, err := rec.Prune(ctx); err != nil {
			log.Warn().Err(err).Msg("prune failed")
		} else if n > 0 {
			log.Info().Int64("rows", n).Msg("pruned messages past retention")
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
