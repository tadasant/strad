// Copyright (C) 2026 Tadas Antanavicius
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version. See LICENSE in this directory.

package main

// The authenticator-code (TOTP) screen of the phone-app login, driven the way
// mautrix-meta's login driver drives it (pkg/messagix/bloks/selenium.go, the
// StateTOTPPage case): find the code input and the button holding "Continue",
// fill the input, tap the button. The fixture's Continue handler is wrapped in
// bk.action.callback.Make, in its minified wire form (dyv), which is what
// Messenger's screen sends; the stock interpreter failed that tap locally with
// "unimplemented function bk.action.callback.Make (1 args)". This test is what
// fails if delta D1 in third_party/README.md is dropped by a re-vendor.

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"go.mau.fi/mautrix-meta/pkg/messagix/bloks"
)

func loadTOTPPage(t *testing.T, br *bloks.InterpBridge) *bloks.BloksBundle {
	t.Helper()
	raw, err := os.ReadFile("testdata/totp_continue_page.json")
	if err != nil {
		t.Fatal(err)
	}
	var page bloks.BloksBundle
	if err := json.Unmarshal(raw, &page); err != nil {
		t.Fatalf("parsing the fixture page: %v", err)
	}
	if err := page.SetupInterpreter(context.Background(), br, nil, true); err != nil {
		t.Fatalf("setting up the interpreter: %v", err)
	}
	return &page
}

func TestTOTPContinueTapsThroughCallbackMake(t *testing.T) {
	var rpcName string
	var rpcParams map[string]string
	var result string
	br := &bloks.InterpBridge{
		DoActionRPC: func(_ context.Context, name string, params map[string]string) (*bloks.BloksScriptNode, error) {
			rpcName, rpcParams = name, params
			return &bloks.BloksScriptNode{Content: bloks.BloksLiteralOf("verified")}, nil
		},
		HandleVariableChange: func(_ context.Context, name string, value *bloks.BloksScriptLiteral) error {
			if name == "totp_result" {
				result, _ = value.Value().(string)
			}
			return nil
		},
	}
	page := loadTOTPPage(t, br)

	input := page.FindDescendant(func(c *bloks.BloksTreeComponent) bool {
		return c.ComponentID == "bk.components.TextInput" && c.GetAttribute("type") == "number"
	})
	button := page.FindDescendant(bloks.FilterByAttribute("bk.data.TextSpan", "text", "Continue")).FindContainingButton()
	if input == nil || button == nil {
		t.Fatalf("fixture page lost its input (%v) or its Continue button (%v)", input != nil, button != nil)
	}

	ctx := context.Background()
	if err := input.FillInput(ctx, page.Interpreter, "123456"); err != nil {
		t.Fatalf("filling the code: %v", err)
	}
	if err := button.TapButton(ctx, page.Interpreter); err != nil {
		t.Fatalf("tapping Continue: %v", err)
	}

	if rpcName != "com.bloks.www.two_step_verification.verify_code.async" {
		t.Errorf("Continue called %q, want the verify-code action", rpcName)
	}
	if rpcParams["code"] != "123456" || rpcParams["method"] != "totp" {
		t.Errorf("Continue sent %v, want the typed code and method totp", rpcParams)
	}
	if result != "verified" {
		t.Errorf("the success callback saw %q, want the action's result", result)
	}
}

// Make and its sibling evaluate their callback the same way; a Make with no
// callback is a payload error, not a panic.
func TestCallbackMakeWithoutArgumentIsAnError(t *testing.T) {
	var node bloks.BloksScriptNode
	if _, err := node.ParseAny(`(bk.action.callback.Make)`, 0); err != nil {
		t.Fatal(err)
	}
	_, err := (&bloks.Interpreter{}).Evaluate(context.Background(), &node)
	if err == nil || !strings.Contains(err.Error(), "needs a callback") {
		t.Fatalf("got %v, want a needs-a-callback error", err)
	}
}
