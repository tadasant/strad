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

// How long an answer may take is Meta's business; how long the CALLER may be
// kept waiting is not. strad's console sits behind an ingress that answers 504
// at about sixty seconds, and one step — the secure-storage PIN — waits a full
// minute for an encrypted connection that a checkpointed account never opens.
// So an answer is handed to Meta in the background, and a call returns after
// replyBudget with a "working" view if Meta has not finished; the next
// messenger_login_submit with no input (or messenger_status) picks up the
// result. A var, not a const, so a test can shorten it.
var replyBudget = 25 * time.Second

// A display-and-wait step (approve on another device) is waited on this long
// per flight before the same step stands again; each call still returns within
// replyBudget.
const waitStepTimeout = 2 * time.Minute

// An answer still unresolved after this is abandoned: the login ends rather
// than holding a step nobody can move.
const flightTimeout = 5 * time.Minute

// The step that restores end-to-end encrypted history. It is the only step
// that comes after the account exists, so it is the only one an account Meta
// has already stopped can strand.
const historyPINStepID = "fi.mau.meta.history_pin"

type Login struct {
	bridge *bridgev2.Bridge
	user   *bridgev2.User

	lock    sync.Mutex
	flow    string
	process bridgev2.LoginProcess
	step    *bridgev2.LoginStep
	started time.Time
	// flight is an answer Meta is still working on. While it is set nothing
	// else is sent: a second answer is refused, and a call with no input
	// waits for this one's result.
	flight *flight
	// outcome is how the last login ended (complete, or an error), kept for a
	// caller who was told "working" and comes back for the result.
	outcome *flightResult
	// pending mirrors the current step for InProgress, which must not wait on
	// lock.
	pending atomic.Pointer[StepView]
	// onComplete runs after a step reaches complete — the host snapshots then,
	// so a fresh login reaches durable storage without waiting for the timer.
	onComplete func()
	// deadAccount reports an account Meta has stopped (BAD_CREDENTIALS and
	// kin), if there is one. A field so a test can stand in for the bridge.
	deadAccount func() (status.BridgeState, bool)
}

type flight struct {
	flow   string
	stepID string
	// shown is the step being waited on when nothing was typed (display and
	// wait): its own instructions stand while it works.
	shown  *StepView
	done   chan struct{}
	cancel context.CancelFunc
	result flightResult
}

type flightResult struct {
	view *StepView
	err  error
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
	// Working: the last answer to this step is still with Meta. Nothing was
	// sent by the call that returned this, and nothing will be resent.
	Working bool `json:"working,omitempty"`
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
	ErrLoginEnded        = errors.New("this login has ended; call messenger_login_start to begin again")
	ErrStepInFlight      = errors.New("the previous answer is still with Meta and was NOT sent again: " +
		"call messenger_login_submit with no input (or messenger_status) to get its result")
	ErrAccountStopped = errors.New("Meta has stopped this account's session")
	ErrAnswerOut      = errors.New("an answer is with Meta right now and cannot be called back: " +
		"call messenger_login_submit with no input for its result, then cancel or start again")
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

// deadState: a login Start does not count as live, so a new login may
// replace it.
func deadState(e status.BridgeStateEvent) bool {
	return stoppedState(e) || e == status.StateUnknownError
}

// stoppedState is narrower: Meta itself ended the login. UNKNOWN_ERROR is not
// one — bridgev2 reconnects from it on its own, and mautrix-meta raises it for
// passing encrypted-connection failures — so it neither blocks a PIN nor
// tells a human to log in again.
func stoppedState(e status.BridgeStateEvent) bool {
	return e == status.StateBadCredentials || e == status.StateLoggedOut
}

// live: an account is logged in and not known to be dead. Anything but a
// login Meta ended counts — CONNECTING right after boot, a transient
// disconnect, a backfill — because a phone-app login registers a NEW device
// and would replace the one that is merely reconnecting.
func (l *Login) live() bool {
	for _, ul := range l.user.GetUserLogins() {
		if !deadState(ul.BridgeState.GetPrevUnsent().StateEvent) {
			return true
		}
	}
	return false
}

// stoppedAccount: every account is one Meta has stopped, and there is at
// least one. Only asked at the PIN step, which follows the account's creation
// in the same login — so "all stopped" there means the account this login
// just made has been stopped. The most recent state is the one reported.
func (l *Login) stoppedAccount() (status.BridgeState, bool) {
	if l.deadAccount != nil {
		return l.deadAccount()
	}
	if l.user == nil {
		return status.BridgeState{}, false
	}
	var latest status.BridgeState
	found := false
	for _, ul := range l.user.GetUserLogins() {
		st := ul.BridgeState.GetPrevUnsent()
		if !stoppedState(st.StateEvent) {
			return status.BridgeState{}, false
		}
		if !found || st.Timestamp.After(latest.Timestamp.Time) {
			latest, found = st, true
		}
	}
	return latest, found
}

// Start begins a flow, abandoning any login already in progress — including
// one whose answer is still with Meta.
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
	if err := l.cancelLocked(false); err != nil {
		return nil, err
	}
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
	if step.Type == bridgev2.LoginStepTypeComplete {
		r := l.landLocked(step, nil)
		return r.view, r.err
	}
	return l.showLocked(), nil
}

// Submit answers the current step. input is the step's fields by ID.
//
// A call with NO input sends nothing to Meta, ever: it returns the result of
// an answer still in flight (waiting up to replyBudget for it), or the current
// step. The one exception is a display-and-wait step, where "no input" is the
// answer — wait for the approval. So a caller that was told "working", or
// whose connection dropped, can always ask again with no input and never
// re-sends a password, a code or a PIN by doing so. To submit an EMPTY value
// (skipping the optional PIN), name the field: {"pin": ""}.
func (l *Login) Submit(ctx context.Context, input map[string]string) (*StepView, error) {
	l.lock.Lock()
	if f := l.flight; f != nil {
		l.lock.Unlock()
		if len(input) > 0 {
			return nil, ErrStepInFlight
		}
		return l.await(ctx, f)
	}
	if l.process == nil || l.step == nil {
		defer l.lock.Unlock()
		// The caller was told "working" and the answer then ended the login:
		// hand that ending over (it stays until the next start or cancel).
		if o := l.outcome; o != nil && len(input) == 0 {
			return o.view, o.err
		}
		return nil, ErrNoLoginInProgress
	}
	if l.step.StepID == historyPINStepID {
		if state, stopped := l.stoppedAccount(); stopped {
			// The PIN step waits a full minute for an encrypted connection that a
			// stopped account never opens, and then fails. Do not spend a PIN
			// attempt on it — Meta counts them — and do not hold a step that
			// cannot finish, whether this call carries the PIN or only asks.
			defer l.lock.Unlock()
			err := fmt.Errorf("%w: %w (%s%s). The PIN was NOT sent. %s", ErrLoginEnded, ErrAccountStopped,
				state.Error, suffix(": ", state.Message), stoppedAdvice(state))
			l.endLocked(nil, err)
			return nil, err
		}
	}
	if len(input) == 0 && l.step.Type != bridgev2.LoginStepTypeDisplayAndWait {
		defer l.lock.Unlock()
		return l.showLocked(), nil
	}
	call, err := l.prepareLocked(input)
	if err != nil {
		l.lock.Unlock()
		return nil, err
	}
	f := l.launchLocked(call)
	l.lock.Unlock()
	return l.await(ctx, f)
}

type stepCall func(context.Context) (*bridgev2.LoginStep, error)

// prepareLocked validates the answer and binds it to the process, sending
// nothing. The returned call owns its own copy of input: the caller's map is
// wiped as soon as Submit returns.
func (l *Login) prepareLocked(input map[string]string) (stepCall, error) {
	own := make(map[string]string, len(input))
	for k, v := range input {
		own[k] = v
	}
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
				if v, present := own[f.ID]; present {
					var err error
					if own[f.ID], err = f.Validate(v); err != nil {
						return nil, fmt.Errorf("%s: %w", f.Name, err)
					}
				}
			}
		}
		return func(ctx context.Context) (*bridgev2.LoginStep, error) {
			defer clear(own)
			return p.SubmitUserInput(ctx, own)
		}, nil
	case bridgev2.LoginStepTypeCookies:
		p, ok := l.process.(bridgev2.LoginProcessCookies)
		if !ok {
			return nil, fmt.Errorf("this login cannot take cookies")
		}
		return func(ctx context.Context) (*bridgev2.LoginStep, error) {
			defer clear(own)
			return p.SubmitCookies(ctx, own)
		}, nil
	case bridgev2.LoginStepTypeDisplayAndWait:
		p, ok := l.process.(bridgev2.LoginProcessDisplayAndWait)
		if !ok {
			return nil, fmt.Errorf("this login cannot wait")
		}
		step := l.step
		return func(ctx context.Context) (*bridgev2.LoginStep, error) {
			waitCtx, cancel := context.WithTimeout(ctx, waitStepTimeout)
			defer cancel()
			next, err := p.Wait(waitCtx)
			if err != nil && waitCtx.Err() != nil && ctx.Err() == nil {
				// Still waiting is not a failure: the same step stands.
				return step, nil
			}
			return next, err
		}, nil
	default:
		return nil, fmt.Errorf("step %q cannot be completed from here", l.step.StepID)
	}
}

// launchLocked runs the call in the background, detached from the HTTP
// request: a caller hanging up (or an ingress timing out) must not cancel an
// answer Meta is already processing, because the only way to "retry" it would
// be to send it again.
func (l *Login) launchLocked(call stepCall) *flight {
	parent := context.Background()
	if l.bridge != nil && l.bridge.BackgroundCtx != nil {
		parent = l.bridge.BackgroundCtx
	}
	ctx, cancel := context.WithTimeout(parent, flightTimeout)
	f := &flight{flow: l.flow, stepID: l.step.StepID, done: make(chan struct{}), cancel: cancel}
	if l.step.Type == bridgev2.LoginStepTypeDisplayAndWait {
		f.shown = view(l.flow, l.step)
	}
	l.flight = f
	l.pending.Store(workingView(f))
	go func() {
		defer cancel()
		next, err := call(ctx)
		l.lock.Lock()
		defer l.lock.Unlock()
		if l.flight == f {
			l.flight = nil
			f.result = l.landLocked(next, err)
		} else {
			f.result = flightResult{err: ErrLoginCancelled}
		}
		close(f.done)
	}()
	return f
}

// landLocked applies a finished answer to the login.
func (l *Login) landLocked(next *bridgev2.LoginStep, err error) flightResult {
	if err == nil && next == nil {
		err = errors.New("the login returned no next step")
	}
	if err != nil {
		// A failed step ends the login: Meta's flows do not resume mid-way, and
		// a step that failed in mautrix-meta's own interpreter would fail the
		// same way again. Nothing is left half-done — the next call is a fresh
		// messenger_login_start — and the error says so, so whoever is typing
		// the codes does not retry a step that no longer exists.
		err = fmt.Errorf("%w: %w", ErrLoginEnded, err)
		l.endLocked(nil, err)
		return flightResult{err: err}
	}
	l.step = next
	v := l.showLocked()
	if next.Type == bridgev2.LoginStepTypeComplete {
		l.endLocked(v, nil)
		if l.onComplete != nil {
			go l.onComplete()
		}
	}
	return flightResult{view: v}
}

// await waits for a flight up to replyBudget, or until the caller leaves.
func (l *Login) await(ctx context.Context, f *flight) (*StepView, error) {
	t := time.NewTimer(replyBudget)
	defer t.Stop()
	select {
	case <-f.done:
		return f.result.view, f.result.err
	case <-t.C:
	case <-ctx.Done():
	}
	return workingView(f), nil
}

// workingView reads only the flight, so await can build it without the lock.
// A waited-on step keeps its own type and instructions: nothing was typed, so
// there is nothing "sent once" to warn about.
func workingView(f *flight) *StepView {
	if f.shown != nil {
		v := *f.shown
		v.Working = true
		return &v
	}
	return &StepView{
		Flow: f.flow, Type: "working", StepID: f.stepID, Working: true,
		Instructions: "Meta is still processing the answer to this step. It was sent ONCE and will not be " +
			"sent again. Call messenger_login_submit with no input to get the result (each call waits up " +
			"to " + replyBudget.String() + "), or check messenger_status. Do not type the value again.",
	}
}

func (l *Login) showLocked() *StepView {
	v := view(l.flow, l.step)
	l.pending.Store(v)
	return v
}

// endLocked closes the login, keeping how it ended for a caller still
// polling.
func (l *Login) endLocked(v *StepView, err error) {
	if l.process != nil && err != nil {
		l.process.Cancel()
	}
	l.process, l.step, l.flow = nil, nil, ""
	l.pending.Store(nil)
	l.outcome = &flightResult{view: v, err: err}
}

// Cancel abandons the login. While a TYPED answer is with Meta it refuses:
// mautrix-meta cannot call one back, so "cancelled" would be a lie — the
// account could still be created a moment later. Waiting on an approval can
// always be cancelled. force (logout) abandons the login regardless.
func (l *Login) Cancel(force bool) error {
	l.lock.Lock()
	defer l.lock.Unlock()
	return l.cancelLocked(force)
}

func (l *Login) cancelLocked(force bool) error {
	if f := l.flight; f != nil && f.shown == nil && !force {
		return ErrAnswerOut
	}
	if f := l.flight; f != nil {
		f.cancel()
		l.flight = nil
	}
	if l.process != nil {
		l.process.Cancel()
	}
	l.process, l.step, l.flow, l.outcome = nil, nil, "", nil
	l.pending.Store(nil)
	return nil
}

// InProgress reports the pending step, if any, for messenger_status.
func (l *Login) InProgress() *StepView {
	return l.pending.Load()
}

func suffix(sep, s string) string {
	if s == "" {
		return ""
	}
	return sep + s
}

// stoppedAdvice is what a human does about an account Meta has stopped.
func stoppedAdvice(state status.BridgeState) string {
	switch state.Error {
	case "fb-checkpoint-required", "fb-challenge-required", "fb-consent-required", "fb-account-suspended":
		return "Sign in at facebook.com in a browser and do what it asks. If that changes the password, " +
			"the bridge's session is gone: call messenger_login_start again with the new password."
	}
	return "Call messenger_login_start to log in again."
}
