// Copyright (C) 2026 Tadas Antanavicius
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version. See LICENSE in this directory.

package main

import (
	"context"
	"errors"
	"strings"
	"testing"

	"maunium.net/go/mautrix/bridgev2"
)

// A login process whose authenticator-code step fails the way the TOTP
// Continue tap did before delta D1: locally, before Meta is asked anything.
type failingTOTPProcess struct{ cancelled int }

func (p *failingTOTPProcess) Start(context.Context) (*bridgev2.LoginStep, error) { return nil, nil }
func (p *failingTOTPProcess) Cancel()                                            { p.cancelled++ }
func (p *failingTOTPProcess) SubmitUserInput(context.Context, map[string]string) (*bridgev2.LoginStep, error) {
	return nil, errors.New("tapping continue: on_click: unimplemented function bk.action.callback.Make (1 args)")
}

func TestFailedStepEndsTheLoginCleanly(t *testing.T) {
	proc := &failingTOTPProcess{}
	step := &bridgev2.LoginStep{
		Type:   bridgev2.LoginStepTypeUserInput,
		StepID: "fi.mau.meta.totp",
		UserInputParams: &bridgev2.LoginUserInputParams{Fields: []bridgev2.LoginInputDataField{
			{ID: "totp_code", Name: "Six-digit code", Type: bridgev2.LoginInputFieldType2FACode},
		}},
	}
	l := &Login{flow: "android", process: proc, step: step}
	l.pending.Store(view("android", step))

	_, err := l.Submit(context.Background(), map[string]string{"totp_code": "123456"})
	if !errors.Is(err, ErrLoginEnded) {
		t.Fatalf("got %v, want ErrLoginEnded", err)
	}
	if !strings.Contains(err.Error(), "messenger_login_start") || !strings.Contains(err.Error(), "callback.Make") {
		t.Errorf("the error should say how to begin again AND what failed: %q", err)
	}
	if proc.cancelled != 1 {
		t.Errorf("the process was cancelled %d times, want once", proc.cancelled)
	}
	if l.InProgress() != nil {
		t.Errorf("messenger_status still reports a pending step: %+v", l.InProgress())
	}
	if l.process != nil || l.step != nil || l.flow != "" {
		t.Errorf("login state survived the failure: flow=%q process=%v step=%v", l.flow, l.process, l.step)
	}

	// A retried submit is told plainly there is nothing to answer, rather than
	// replaying the dead step.
	if _, err := l.Submit(context.Background(), map[string]string{"totp_code": "123456"}); !errors.Is(err, ErrNoLoginInProgress) {
		t.Fatalf("retry got %v, want ErrNoLoginInProgress", err)
	}
	if loginErrCode(ErrNoLoginInProgress) != 409 {
		t.Errorf("no-login-in-progress should be a 409")
	}
}
