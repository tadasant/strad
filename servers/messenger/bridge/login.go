// Copyright (C) 2026 Tadas Antanavicius
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version. See LICENSE in this directory.

package main

// LOGIN, AS A STEP MACHINE SOMEONE ELSE DRIVES.
//
// bridgev2 models every network's login as a sequence of steps — "enter your
// email and password", "enter the code we sent", "approve this on your phone",
// "enter your encrypted-storage PIN" — and mautrix-meta produces whichever
// steps Meta's own login screens ask for. This file holds ONE login in
// progress and moves it forward a step per call; the MCP admin tools are the
// only caller. Nothing here knows which fields a step has: the step says.

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/status"
)

// Flows strad offers, mapped to mautrix-meta's flow IDs. The phone-app logins
// come first: each signs in as a NEW device of its own, the way a phone does,
// rather than borrowing a browser's session.
var loginFlows = map[string]string{
	"android": "messenger-lite-android",
	"ios":     "messenger-lite",
	"cookies": "facebook",
}

// A step blocks no longer than this before the caller gets "still waiting".
const waitStepTimeout = 2 * time.Minute

type Login struct {
	bridge *bridgev2.Bridge
	user   *bridgev2.User

	lock    sync.Mutex
	flow    string
	process bridgev2.LoginProcess
	step    *bridgev2.LoginStep
	started time.Time
	// pending mirrors the current step for InProgress, which must not wait on
	// lock: a display-and-wait step holds it for up to waitStepTimeout.
	pending atomic.Pointer[StepView]
	// waitCancel ends an in-flight display-and-wait step; cancelRequested
	// tells that step it was ended on purpose rather than timed out.
	waitCancel      atomic.Pointer[context.CancelFunc]
	cancelRequested atomic.Bool
	// onComplete runs after a step reaches complete — the host snapshots then,
	// so a fresh login reaches durable storage without waiting for the timer.
	onComplete func()
}

// StepView is what the tools return. Field VALUES are never echoed back.
type StepView struct {
	Flow         string       `json:"flow"`
	Type         string       `json:"type"`
	StepID       string       `json:"step_id"`
	Instructions string       `json:"instructions"`
	Fields       []FieldView  `json:"fields,omitempty"`
	Cookies      []string     `json:"cookies,omitempty"`
	CookiesURL   string       `json:"cookies_url,omitempty"`
	Display      *DisplayView `json:"display,omitempty"`
	Images       []ImageView  `json:"images,omitempty"`
	Account      *AccountView `json:"account,omitempty"`
	Unsupported  string       `json:"unsupported,omitempty"`
}

type FieldView struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Type        string   `json:"type"`
	Description string   `json:"description,omitempty"`
	Optional    bool     `json:"optional,omitempty"`
	Pattern     string   `json:"pattern,omitempty"`
	Options     []string `json:"options,omitempty"`
}

type DisplayView struct {
	Type string `json:"type"`
	Data string `json:"data,omitempty"`
}

type ImageView struct {
	MimeType string `json:"mime_type"`
	Base64   string `json:"base64"`
}

type AccountView struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

var (
	ErrNoLoginInProgress = errors.New("no login is in progress: call messenger_login_start first")
	ErrAlreadyConnected  = errors.New("an account is already logged in: call messenger_logout first to replace it")
	ErrUnknownFlow       = errors.New(`unknown flow: use "android", "ios" or "cookies"`)
	ErrLoginCancelled    = errors.New("the login was cancelled")
)

func view(flow string, step *bridgev2.LoginStep) *StepView {
	v := &StepView{Flow: flow, Type: string(step.Type), StepID: step.StepID, Instructions: step.Instructions}
	switch step.Type {
	case bridgev2.LoginStepTypeUserInput:
		if p := step.UserInputParams; p != nil {
			for _, f := range p.Fields {
				v.Fields = append(v.Fields, FieldView{
					ID: f.ID, Name: f.Name, Type: string(f.Type), Description: f.Description,
					Optional: f.Optional, Pattern: f.Pattern, Options: f.Options,
				})
			}
			for _, a := range p.Attachments {
				if a == nil || len(a.Content) == 0 || a.Info.MimeType == "" {
					continue
				}
				v.Images = append(v.Images, ImageView{MimeType: a.Info.MimeType, Base64: base64.StdEncoding.EncodeToString(a.Content)})
			}
		}
	case bridgev2.LoginStepTypeCookies:
		if p := step.CookiesParams; p != nil {
			v.CookiesURL = p.URL
			for _, f := range p.Fields {
				v.Cookies = append(v.Cookies, f.ID)
			}
		}
	case bridgev2.LoginStepTypeDisplayAndWait:
		if p := step.DisplayAndWaitParams; p != nil {
			v.Display = &DisplayView{Type: string(p.Type), Data: p.Data}
		}
	case bridgev2.LoginStepTypeComplete:
		if p := step.CompleteParams; p != nil && p.UserLogin != nil {
			v.Account = &AccountView{ID: string(p.UserLogin.ID), Name: p.UserLogin.RemoteName}
		}
	default:
		v.Unsupported = "this step needs a browser or a security key, which a server cannot show; " +
			`cancel and try another flow (the "cookies" flow avoids Meta's interactive checks)`
	}
	return v
}

// live: an account is logged in and not known to be dead. Anything but a
// login Meta ended counts — CONNECTING right after boot, a transient
// disconnect, a backfill — because a phone-app login registers a NEW device
// and would replace the one that is merely reconnecting.
func (l *Login) live() bool {
	for _, ul := range l.user.GetUserLogins() {
		switch ul.BridgeState.GetPrev().StateEvent {
		case status.StateBadCredentials, status.StateLoggedOut, status.StateUnknownError:
		default:
			return true
		}
	}
	return false
}

// Start begins a flow, abandoning any login already in progress.
func (l *Login) Start(ctx context.Context, flow string) (*StepView, error) {
	flowID, ok := loginFlows[flow]
	if !ok {
		return nil, ErrUnknownFlow
	}
	l.lock.Lock()
	defer l.lock.Unlock()
	if l.live() {
		return nil, ErrAlreadyConnected
	}
	l.cancelLocked()
	process, err := l.bridge.Network.CreateLogin(ctx, l.user, flowID)
	if err != nil {
		return nil, err
	}
	step, err := process.Start(ctx)
	if err != nil {
		process.Cancel()
		return nil, err
	}
	l.flow, l.process, l.step, l.started = flow, process, step, time.Now()
	return l.advanceLocked(ctx)
}

// Submit answers the current step. input is the step's fields by ID; for a
// display-and-wait step it is ignored and the call waits for the step to move.
func (l *Login) Submit(ctx context.Context, input map[string]string) (*StepView, error) {
	l.lock.Lock()
	defer l.lock.Unlock()
	if l.process == nil || l.step == nil {
		return nil, ErrNoLoginInProgress
	}
	var next *bridgev2.LoginStep
	var err error
	switch l.step.Type {
	case bridgev2.LoginStepTypeUserInput:
		p, ok := l.process.(bridgev2.LoginProcessUserInput)
		if !ok {
			return nil, fmt.Errorf("this login cannot take input")
		}
		if fields := l.step.UserInputParams; fields != nil {
			for _, f := range fields.Fields {
				if f.Validate == nil {
					continue
				}
				if v, present := input[f.ID]; present {
					if input[f.ID], err = f.Validate(v); err != nil {
						return nil, fmt.Errorf("%s: %w", f.Name, err)
					}
				}
			}
		}
		next, err = p.SubmitUserInput(ctx, input)
	case bridgev2.LoginStepTypeCookies:
		p, ok := l.process.(bridgev2.LoginProcessCookies)
		if !ok {
			return nil, fmt.Errorf("this login cannot take cookies")
		}
		next, err = p.SubmitCookies(ctx, input)
	case bridgev2.LoginStepTypeDisplayAndWait:
		p, ok := l.process.(bridgev2.LoginProcessDisplayAndWait)
		if !ok {
			return nil, fmt.Errorf("this login cannot wait")
		}
		waitCtx, cancel := context.WithTimeout(ctx, waitStepTimeout)
		// Cancel interrupts the wait without the lock this call holds.
		l.waitCancel.Store(&cancel)
		next, err = p.Wait(waitCtx)
		l.waitCancel.Store(nil)
		cancel()
		if l.cancelRequested.Swap(false) {
			l.cancelLocked()
			return nil, ErrLoginCancelled
		}
		if err != nil && waitCtx.Err() != nil {
			// Still waiting is not a failure, and neither is the caller hanging
			// up: the same step stands.
			return view(l.flow, l.step), nil
		}
	default:
		return nil, fmt.Errorf("step %q cannot be completed from here", l.step.StepID)
	}
	if err != nil {
		// A failed step ends the login: Meta's flows do not resume mid-way.
		l.cancelLocked()
		return nil, err
	}
	l.step = next
	return l.advanceLocked(ctx)
}

func (l *Login) advanceLocked(_ context.Context) (*StepView, error) {
	v := view(l.flow, l.step)
	l.pending.Store(v)
	if l.step.Type == bridgev2.LoginStepTypeComplete {
		l.pending.Store(nil)
		l.process, l.step = nil, nil
		if l.onComplete != nil {
			go l.onComplete()
		}
	}
	return v, nil
}

func (l *Login) Cancel() {
	if stop := l.waitCancel.Load(); stop != nil {
		l.cancelRequested.Store(true)
		(*stop)()
	}
	l.lock.Lock()
	defer l.lock.Unlock()
	l.cancelLocked()
}

func (l *Login) cancelLocked() {
	if l.process != nil {
		l.process.Cancel()
	}
	l.process, l.step, l.flow = nil, nil, ""
	l.pending.Store(nil)
}

// InProgress reports the pending step, if any, for messenger_status.
func (l *Login) InProgress() *StepView {
	return l.pending.Load()
}
