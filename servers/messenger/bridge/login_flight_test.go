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
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/status"
)

// A PIN step that takes as long as the test says, the way the real one waits
// a full minute for an encrypted connection.
type slowPINProcess struct {
	release chan struct{}
	calls   atomic.Int32
	mu      sync.Mutex
	seen    []map[string]string
	ctxErr  error
	next    *bridgev2.LoginStep
	err     error
}

func (p *slowPINProcess) Start(context.Context) (*bridgev2.LoginStep, error) { return nil, nil }
func (p *slowPINProcess) Cancel()                                            {}
func (p *slowPINProcess) SubmitUserInput(ctx context.Context, in map[string]string) (*bridgev2.LoginStep, error) {
	p.calls.Add(1)
	p.mu.Lock()
	p.seen = append(p.seen, in)
	p.mu.Unlock()
	select {
	case <-p.release:
	case <-ctx.Done():
		p.ctxErr = ctx.Err()
		return nil, ctx.Err()
	}
	return p.next, p.err
}

func pinStep() *bridgev2.LoginStep {
	return &bridgev2.LoginStep{
		Type:   bridgev2.LoginStepTypeUserInput,
		StepID: historyPINStepID,
		UserInputParams: &bridgev2.LoginUserInputParams{Fields: []bridgev2.LoginInputDataField{
			{ID: "pin", Name: "Secure storage PIN", Type: bridgev2.LoginInputFieldTypePassword, Optional: true},
		}},
	}
}

func completeStep() *bridgev2.LoginStep {
	return &bridgev2.LoginStep{Type: bridgev2.LoginStepTypeComplete, StepID: "fi.mau.meta.complete"}
}

func atPIN(proc bridgev2.LoginProcess) *Login {
	step := pinStep()
	l := &Login{flow: "android", process: proc, step: step,
		deadAccount: func() (status.BridgeState, bool) { return status.BridgeState{}, false }}
	l.pending.Store(view("android", step))
	return l
}

func shortBudget(t *testing.T, d time.Duration) {
	old := replyBudget
	replyBudget = d
	t.Cleanup(func() { replyBudget = old })
}

func TestALongStepAnswersWorkingAndIsNeverResent(t *testing.T) {
	shortBudget(t, 30*time.Millisecond)
	proc := &slowPINProcess{release: make(chan struct{}), next: completeStep()}
	l := atPIN(proc)
	var completed atomic.Int32
	l.onComplete = func() { completed.Add(1) }

	first, err := l.Submit(context.Background(), map[string]string{"pin": "123456"})
	if err != nil {
		t.Fatalf("first submit: %v", err)
	}
	if !first.Working || first.Type != "working" || first.StepID != historyPINStepID {
		t.Fatalf("a step past the reply budget should answer working, got %+v", first)
	}
	if p := l.InProgress(); p == nil || !p.Working {
		t.Errorf("messenger_status should show the step as working, got %+v", p)
	}

	// The human, seeing no answer, types the PIN again: refused, not forwarded.
	if _, err := l.Submit(context.Background(), map[string]string{"pin": "123456"}); !errors.Is(err, ErrStepInFlight) {
		t.Fatalf("a second answer while one is in flight: got %v, want ErrStepInFlight", err)
	}
	if loginErrCode(ErrStepInFlight) != 409 {
		t.Errorf("in-flight should be a 409")
	}
	// Asking with no input waits, and still sends nothing.
	if again, err := l.Submit(context.Background(), nil); err != nil || !again.Working {
		t.Fatalf("a poll while in flight: %+v, %v", again, err)
	}
	if n := proc.calls.Load(); n != 1 {
		t.Fatalf("the PIN reached the process %d times, want exactly once", n)
	}

	close(proc.release)
	done, err := l.Submit(context.Background(), nil)
	if err != nil || done.Type != string(bridgev2.LoginStepTypeComplete) {
		t.Fatalf("the poll after Meta answered: %+v, %v", done, err)
	}
	if n := proc.calls.Load(); n != 1 {
		t.Fatalf("the PIN reached the process %d times, want exactly once", n)
	}
	if l.InProgress() != nil {
		t.Errorf("a completed login still shows a pending step: %+v", l.InProgress())
	}
	time.Sleep(10 * time.Millisecond)
	if completed.Load() != 1 {
		t.Errorf("onComplete ran %d times, want once", completed.Load())
	}
	proc.mu.Lock()
	defer proc.mu.Unlock()
	if len(proc.seen[0]) != 0 {
		t.Errorf("the process's copy of the PIN was not wiped: %v", proc.seen[0])
	}
}

func TestACallerHangingUpDoesNotCancelTheAnswer(t *testing.T) {
	shortBudget(t, time.Second)
	proc := &slowPINProcess{release: make(chan struct{}), next: completeStep()}
	l := atPIN(proc)
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(20 * time.Millisecond); cancel() }()
	v, err := l.Submit(ctx, map[string]string{"pin": "123456"})
	if err != nil || !v.Working {
		t.Fatalf("a caller who hung up should be told working: %+v, %v", v, err)
	}
	time.Sleep(20 * time.Millisecond)
	if proc.ctxErr != nil {
		t.Fatalf("the hang-up cancelled the answer Meta was processing: %v", proc.ctxErr)
	}
	close(proc.release)
	if done, err := l.Submit(context.Background(), nil); err != nil || done.Type != "complete" {
		t.Fatalf("result after the hang-up: %+v, %v", done, err)
	}
}

func TestAFailureThatLandsWhileNobodyWaitsIsHandedToTheNextPoll(t *testing.T) {
	shortBudget(t, 10*time.Millisecond)
	proc := &slowPINProcess{release: make(chan struct{}), err: errors.New("history limit")}
	l := atPIN(proc)
	if v, _ := l.Submit(context.Background(), map[string]string{"pin": "123456"}); !v.Working {
		t.Fatalf("want working, got %+v", v)
	}
	close(proc.release)
	time.Sleep(20 * time.Millisecond)
	if l.InProgress() != nil {
		t.Errorf("an ended login still shows a pending step")
	}
	_, err := l.Submit(context.Background(), nil)
	if !errors.Is(err, ErrLoginEnded) || !strings.Contains(err.Error(), "history limit") {
		t.Fatalf("the poll should get the ending: %v", err)
	}
	// And an answer typed after it is not taken for a step that is gone.
	if _, err := l.Submit(context.Background(), map[string]string{"pin": "123456"}); !errors.Is(err, ErrNoLoginInProgress) {
		t.Fatalf("got %v, want ErrNoLoginInProgress", err)
	}
	if n := proc.calls.Load(); n != 1 {
		t.Fatalf("calls = %d, want 1", n)
	}
}

func TestAPollSendsNothingOnAnInputStep(t *testing.T) {
	proc := &slowPINProcess{release: make(chan struct{})}
	l := atPIN(proc)
	v, err := l.Submit(context.Background(), map[string]string{})
	if err != nil || v.StepID != historyPINStepID || v.Working {
		t.Fatalf("a no-input call should show the step: %+v, %v", v, err)
	}
	if n := proc.calls.Load(); n != 0 {
		t.Fatalf("a no-input call reached the process %d times; skipping the PIN must be explicit", n)
	}
}

func TestAStoppedAccountEndsThePINStepWithoutSpendingTheAttempt(t *testing.T) {
	proc := &slowPINProcess{release: make(chan struct{})}
	l := atPIN(proc)
	l.deadAccount = func() (status.BridgeState, bool) {
		return status.BridgeState{
			StateEvent: status.StateBadCredentials, Error: "fb-checkpoint-required",
			Message: "Checkpoint required, please check the Facebook website to continue",
		}, true
	}
	_, err := l.Submit(context.Background(), map[string]string{"pin": "123456"})
	if !errors.Is(err, ErrLoginEnded) || !errors.Is(err, ErrAccountStopped) {
		t.Fatalf("got %v, want ErrLoginEnded wrapping ErrAccountStopped", err)
	}
	for _, want := range []string{"NOT sent", "fb-checkpoint-required", "facebook.com", "messenger_login_start"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the error should say %q: %q", want, err)
		}
	}
	if n := proc.calls.Load(); n != 0 {
		t.Fatalf("the PIN reached the process %d times, want 0", n)
	}
	if l.InProgress() != nil || l.process != nil {
		t.Errorf("the stranded PIN step survived: %+v", l.InProgress())
	}

	// A no-input call at a stranded PIN step ends it the same way.
	l2 := atPIN(proc)
	l2.deadAccount = l.deadAccount
	if _, err := l2.Submit(context.Background(), nil); !errors.Is(err, ErrAccountStopped) {
		t.Fatalf("a poll at a stranded PIN step: %v", err)
	}
	if l2.InProgress() != nil {
		t.Errorf("the poll left the stranded PIN step in place")
	}
}

func TestCancelIsRefusedWhileATypedAnswerIsOut(t *testing.T) {
	shortBudget(t, 10*time.Millisecond)
	proc := &slowPINProcess{release: make(chan struct{}), next: completeStep()}
	l := atPIN(proc)
	if v, _ := l.Submit(context.Background(), map[string]string{"pin": "123456"}); !v.Working {
		t.Fatalf("want working, got %+v", v)
	}
	if err := l.Cancel(false); !errors.Is(err, ErrAnswerOut) {
		t.Fatalf("cancel during a typed answer: %v, want ErrAnswerOut", err)
	}
	if loginErrCode(ErrAnswerOut) != 409 {
		t.Errorf("answer-out should be a 409")
	}
	close(proc.release)
	if done, err := l.Submit(context.Background(), nil); err != nil || done.Type != "complete" {
		t.Fatalf("the answer should still land: %+v, %v", done, err)
	}
}

func TestAnApprovalWaitKeepsItsOwnStepWhileWorking(t *testing.T) {
	shortBudget(t, 10*time.Millisecond)
	proc := &waitProcess{release: make(chan struct{})}
	step := &bridgev2.LoginStep{
		Type: bridgev2.LoginStepTypeDisplayAndWait, StepID: "afad_wait", Instructions: "Approve on your phone.",
		DisplayAndWaitParams: &bridgev2.LoginDisplayAndWaitParams{Type: bridgev2.LoginDisplayTypeNothing},
	}
	l := &Login{flow: "android", process: proc, step: step}
	v, err := l.Submit(context.Background(), nil)
	if err != nil || !v.Working || v.Type != string(bridgev2.LoginStepTypeDisplayAndWait) || v.Instructions != "Approve on your phone." {
		t.Fatalf("an approval wait past the budget should keep its own step: %+v, %v", v, err)
	}
	if strings.Contains(v.Instructions, "sent ONCE") {
		t.Errorf("nothing was typed, so nothing was sent: %q", v.Instructions)
	}
	if err := l.Cancel(false); err != nil {
		t.Fatalf("an approval wait can always be cancelled: %v", err)
	}
	if l.InProgress() != nil {
		t.Errorf("a cancelled login still shows a pending step")
	}
}

type waitProcess struct{ release chan struct{} }

func (p *waitProcess) Start(context.Context) (*bridgev2.LoginStep, error) { return nil, nil }
func (p *waitProcess) Cancel()                                            {}
func (p *waitProcess) Wait(ctx context.Context) (*bridgev2.LoginStep, error) {
	select {
	case <-p.release:
		return completeStep(), nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func TestLogoutCancelsEvenATypedAnswer(t *testing.T) {
	shortBudget(t, time.Second)
	proc := &slowPINProcess{release: make(chan struct{}), next: completeStep()}
	l := atPIN(proc)
	var completed atomic.Int32
	l.onComplete = func() { completed.Add(1) }
	errc := make(chan error, 1)
	go func() {
		_, err := l.Submit(context.Background(), map[string]string{"pin": "123456"})
		errc <- err
	}()
	time.Sleep(20 * time.Millisecond)
	if err := l.Cancel(true); err != nil {
		t.Fatalf("a forced cancel: %v", err)
	}
	if err := <-errc; !errors.Is(err, ErrLoginCancelled) {
		t.Fatalf("the waiting caller got %v, want ErrLoginCancelled", err)
	}
	if l.InProgress() != nil {
		t.Errorf("a cancelled login still shows a pending step")
	}
	if _, err := l.Submit(context.Background(), nil); !errors.Is(err, ErrNoLoginInProgress) {
		t.Fatalf("after cancel: %v", err)
	}
	if completed.Load() != 0 {
		t.Errorf("a cancelled answer completed the login")
	}
}

func TestDeadStatesNeedAHuman(t *testing.T) {
	for _, s := range []status.BridgeStateEvent{status.StateBadCredentials, status.StateLoggedOut, status.StateUnknownError} {
		if !deadState(s) {
			t.Errorf("%s should be dead", s)
		}
	}
	for _, s := range []status.BridgeStateEvent{status.StateConnected, status.StateConnecting, status.StateTransientDisconnect, ""} {
		if deadState(s) {
			t.Errorf("%q should not be dead", s)
		}
	}
	if stoppedState(status.StateUnknownError) || !stoppedState(status.StateBadCredentials) || !stoppedState(status.StateLoggedOut) {
		t.Errorf("only BAD_CREDENTIALS and LOGGED_OUT are stopped: UNKNOWN_ERROR reconnects by itself")
	}
	if a := stoppedAdvice(status.BridgeState{Error: "fb-checkpoint-required"}); !strings.Contains(a, "new password") {
		t.Errorf("checkpoint advice: %q", a)
	}
}
