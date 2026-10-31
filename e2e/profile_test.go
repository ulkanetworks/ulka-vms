package e2e

import "testing"

// Phone numbers from any country, stored in international form; the language; where you're signed in.
func TestProfileAndSessions(t *testing.T) {
	h := newHarness(t)
	c, _ := h.signup("profile")
	for in, want := range map[string]string{
		"+44 20 7946 0958": "+442079460958", "+1 (415) 555-0100": "+14155550100", "+880 1712-345678": "+8801712345678", "+81 3-1234-5678": "+81312345678",
	} {
		me := h.call(c, "PATCH", "/v1/me", "", `{"name":"P","phone":"`+in+`"}`, 200)
		if got := me["user"].(map[string]any)["phone"]; got != want {
			t.Errorf("%q: got %v, want %s", in, got, want)
		}
	}
	for _, bad := range []string{"01712345678", "+0 123", "+44 abc", "+1234567890123456", "+1 123 456 7890"} { // the last looked right to a pattern; no US area code starts with 1
		e := h.call(c, "PATCH", "/v1/me", "", `{"name":"P","phone":"`+bad+`"}`, 400)["error"].(map[string]any)
		if e["code"] != "invalid_phone" || e["message"] == "" {
			t.Errorf("%q: %v", bad, e)
		}
	}
	me := h.call(c, "PATCH", "/v1/me", "", `{"name":"P","phone":"","locale":"bn"}`, 200)["user"].(map[string]any)
	if me["phone"] != nil || me["locale"] != "bn" || me["last_login_at"] == nil {
		t.Fatalf("cleared phone, locale, sign-in time: %v", me)
	}
	h.call(c, "PATCH", "/v1/me", "", `{"name":"P","locale":"fr"}`, 400)

	sessions := h.call(c, "GET", "/v1/me/sessions", "", "", 200)["data"].([]any)
	if len(sessions) != 1 || sessions[0].(map[string]any)["current"] != true || sessions[0].(map[string]any)["ip"] == "" {
		t.Fatalf("sessions: %v", sessions)
	}
	if _, leaked := sessions[0].(map[string]any)["token_hash"]; leaked {
		t.Fatal("the session list shows a token")
	}
}
