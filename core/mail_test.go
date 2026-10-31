package core

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestResendMailer(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer re_test" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		_, _ = w.Write([]byte(`{"id":"1"}`))
	}))
	defer srv.Close()
	saved := resendURL
	resendURL = srv.URL
	defer func() { resendURL = saved }()

	if err := ResendMailer("re_test", "Ulka <a@b.test>")(context.Background(), "c@d.test", "Hi", "Body"); err != nil {
		t.Fatal(err)
	}
	if got["from"] != "Ulka <a@b.test>" || got["subject"] != "Hi" || got["text"] != "Body" || got["to"].([]any)[0] != "c@d.test" {
		t.Fatalf("payload: %v", got)
	}
	if err := ResendMailer("wrong", "a@b.test")(context.Background(), "c@d.test", "Hi", "Body"); err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("refused key: %v", err)
	}
}

func TestSMTPMessage(t *testing.T) {
	msg, err := smtpMessage("Ulka <a@b.test>", "c@d.test", "Welcome to Ulka — ready", "line one\nline two")
	if err != nil {
		t.Fatal(err)
	}
	s := string(msg)
	if !strings.Contains(s, "Subject: =?utf-8?q?") || !strings.HasSuffix(s, "\r\n\r\nline one\r\nline two") {
		t.Fatalf("message:\n%s", s)
	}
	if _, err := smtpMessage("a@b.test", "c@d.test\r\nBcc: x@y.test", "Hi", ""); err == nil {
		t.Fatal("header injection accepted")
	}
}

func TestMailFallback(t *testing.T) {
	var calls []string
	failing := func(name string) Mailer {
		return func(context.Context, string, string, string) error {
			calls = append(calls, name)
			return errors.New(name + " is down")
		}
	}
	working := func(name string) Mailer {
		return func(context.Context, string, string, string) error { calls = append(calls, name); return nil }
	}
	send := func(m Mailer) error { calls = nil; return m(t.Context(), "a@example.com", "s", "b") }

	if err := send(WithFallback(working("one"), working("two"))); err != nil || strings.Join(calls, ",") != "one" {
		t.Errorf("primary works: %v %v", err, calls)
	}
	if err := send(WithFallback(failing("one"), working("two"))); err != nil || strings.Join(calls, ",") != "one,two" {
		t.Errorf("primary down: %v %v", err, calls)
	}
	if err := send(WithFallback(failing("one"), failing("two"))); err == nil || !strings.Contains(err.Error(), "one is down") || !strings.Contains(err.Error(), "two is down") {
		t.Errorf("both down: %v", err)
	}
}
