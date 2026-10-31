package e2e

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"testing"

	"github.com/ulkanetworks/ulka-vms/app"
	"github.com/ulkanetworks/ulka-vms/core"
	"golang.org/x/crypto/bcrypt"
)

// mailbox captures stubbed emails so tests can follow their links.
type mailbox struct {
	mu   sync.Mutex
	last map[string]string // address → body
}

var linkRe = regexp.MustCompile(`https?://\S+`)

func captureMail(t *testing.T) *mailbox {
	m := &mailbox{last: map[string]string{}}
	saved := core.SendMail
	core.SendMail = func(_ context.Context, to, _, body string) error {
		m.mu.Lock()
		defer m.mu.Unlock()
		m.last[strings.ToLower(to)] = body
		return nil
	}
	t.Cleanup(func() { core.SendMail = saved })
	return m
}

// token returns the token from the newest link sent to addr.
func (m *mailbox) token(t *testing.T, addr string) string {
	t.Helper()
	m.mu.Lock()
	defer m.mu.Unlock()
	u, err := url.Parse(linkRe.FindString(m.last[strings.ToLower(addr)]))
	if err != nil || u.Query().Get("token") == "" {
		t.Fatalf("no link in mail to %s: %q", addr, m.last[strings.ToLower(addr)])
	}
	return u.Query().Get("token")
}

func newEmail(domain string) string { return strings.ToLower(rand.Text()) + "@" + domain + ".test" }

func TestAccounts(t *testing.T) {
	h := newHarness(t)
	mail := captureMail(t)
	call := h.call
	const pw = `"correct horse battery"`

	// Sign-up sends a verification link; following it verifies the address.
	owner, ownerEmail := h.client(), newEmail("acme")
	me := call(owner, "POST", "/v1/signup", "", `{"email":"`+ownerEmail+`","password":`+pw+`,"tenant_name":"Acme"}`, 201)
	if me["role"] != "owner" || me["user"].(map[string]any)["email_verified_at"] != nil {
		t.Fatalf("after sign-up: %v", me)
	}
	call(h.client(), "POST", "/v1/verify-email", "", `{"token":"nope","kind":"verify_email"}`, 400)
	call(h.client(), "POST", "/v1/verify-email", "", `{"token":"`+mail.token(t, ownerEmail)+`","kind":"verify_email"}`, 204)
	if me = call(owner, "GET", "/v1/me", "", "", 200); me["user"].(map[string]any)["email_verified_at"] == nil {
		t.Fatalf("not verified: %v", me)
	}
	acmeID := me["tenant"].(map[string]any)["id"].(string)

	// Invite a brand-new person as admin: they set a password on acceptance and land in Acme.
	adminEmail := newEmail("acme")
	call(owner, "POST", "/v1/invites", "", `{"email":"`+adminEmail+`","role":"admin"}`, 201)
	adminToken := mail.token(t, adminEmail)
	look := call(h.client(), "GET", "/v1/invites/lookup?token="+adminToken, "", "", 200)
	if look["tenant_name"] != "Acme" || look["account_exists"] != false {
		t.Fatalf("lookup: %v", look)
	}
	admin := h.client()
	me = call(admin, "POST", "/v1/invites/accept", "", `{"token":"`+adminToken+`","name":"Ada","password":`+pw+`}`, 201)
	if me["role"] != "admin" || me["tenant"].(map[string]any)["id"] != acmeID {
		t.Fatalf("accepted admin: %v", me)
	}
	call(h.client(), "POST", "/v1/invites/accept", "", `{"token":"`+adminToken+`","password":`+pw+`}`, 400) // used up
	adminID := me["user"].(map[string]any)["id"].(string)

	// An existing account elsewhere must sign in as the invited address to accept.
	other, otherEmail := h.client(), newEmail("globex")
	call(other, "POST", "/v1/signup", "", `{"email":"`+otherEmail+`","password":`+pw+`,"tenant_name":"Globex"}`, 201)
	globexID := call(other, "GET", "/v1/me", "", "", 200)["tenant"].(map[string]any)["id"].(string)
	call(admin, "POST", "/v1/invites", "", `{"email":"`+otherEmail+`","role":"owner"}`, 403)  // admins cannot make owners
	call(admin, "POST", "/v1/invites", "", `{"email":"`+adminEmail+`","role":"member"}`, 409) // already a member
	call(admin, "POST", "/v1/invites", "", `{"email":"`+otherEmail+`","role":"member"}`, 201)
	memberToken := mail.token(t, otherEmail)
	call(h.client(), "POST", "/v1/invites/accept", "", `{"token":"`+memberToken+`","password":`+pw+`}`, 409) // login_required
	call(admin, "POST", "/v1/invites/accept", "", `{"token":"`+memberToken+`"}`, 403)                        // wrong person
	if me = call(other, "POST", "/v1/invites/accept", "", `{"token":"`+memberToken+`"}`, 200); me["tenant"].(map[string]any)["id"] != acmeID || me["role"] != "member" {
		t.Fatalf("existing user accepted: %v", me)
	}
	memberID := me["user"].(map[string]any)["id"].(string)

	// They now belong to two tenants and can switch; a tenant they're not in is refused.
	if ts := call(other, "GET", "/v1/tenants", "", "", 200)["data"].([]any); len(ts) != 2 {
		t.Fatalf("tenants: %v", ts)
	}
	call(other, "POST", "/v1/tenants/"+globexID+"/switch", "", "", 200)
	call(admin, "POST", "/v1/tenants/"+globexID+"/switch", "", "", 404)
	call(other, "POST", "/v1/tenants/"+acmeID+"/switch", "", "", 200)

	// Members use the product but cannot manage people or keys.
	call(other, "GET", "/v1/members", "", "", 200)
	call(other, "POST", "/v1/invites", "", `{"email":"`+newEmail("x")+`","role":"member"}`, 403)
	call(other, "POST", "/v1/api-keys", "", `{"name":"nope","scopes":["video:read"]}`, 403)
	call(other, "PATCH", "/v1/members/"+adminID, "", `{"role":"member"}`, 403)
	call(other, "PATCH", "/v1/members/"+memberID, "", `{"role":"admin"}`, 403) // no self-promotion
	call(admin, "PATCH", "/v1/members/"+adminID, "", `{"role":"owner"}`, 403)
	call(admin, "POST", "/v1/api-keys", "", `{"name":"ok","scopes":["video:read"]}`, 201)

	// Members use every product but webhooks; viewers only look.
	call(other, "POST", "/v1/uploads", "", "", 201)
	call(other, "POST", "/v1/webhook-endpoints", "", `{"url":"https://example.com/hook"}`, 403)
	call(owner, "PATCH", "/v1/members/"+memberID, "", `{"role":"viewer"}`, 204)
	call(other, "GET", "/v1/assets", "", "", 200)
	call(other, "POST", "/v1/uploads", "", "", 403)
	call(other, "GET", "/v1/api-keys", "", "", 403) // keys are listed only to those who manage them
	call(admin, "GET", "/v1/api-keys", "", "", 200)
	if me := call(other, "GET", "/v1/me", "", "", 200); fmt.Sprint(me["permissions"]) != "[video:read webhooks:read members:read workspace:read]" ||
		len(me["grantable_roles"].([]any)) != 0 {
		t.Fatalf("viewer's permissions: %v %v", me["permissions"], me["grantable_roles"])
	}
	call(owner, "PATCH", "/v1/members/"+memberID, "", `{"role":"member"}`, 204)
	meta := call(other, "GET", "/v1/meta", "", "", 200)
	if caps := meta["capabilities"].([]any); fmt.Sprint(caps[len(caps)-1]) != "map[roles:[owner] what:Make or remove owners]" {
		t.Fatalf("capabilities: %v", caps)
	}
	if _, ok := meta["limits"].(map[string]any)["chapters"]; !ok {
		t.Fatalf("meta limits: %v", meta["limits"])
	}
	if g := call(admin, "GET", "/v1/me", "", "", 200)["grantable_roles"]; fmt.Sprint(g) != "[viewer member admin]" {
		t.Fatalf("admin may grant %v", g)
	}

	// Owner rules: admins can't touch owners; the last owner can't step down or leave.
	ownerID := call(owner, "GET", "/v1/me", "", "", 200)["user"].(map[string]any)["id"].(string)
	call(admin, "PATCH", "/v1/members/"+ownerID, "", `{"role":"member"}`, 403)
	call(owner, "PATCH", "/v1/members/"+ownerID, "", `{"role":"admin"}`, 409)
	call(owner, "DELETE", "/v1/members/"+ownerID, "", "", 409)
	call(owner, "PATCH", "/v1/members/"+memberID, "", `{"role":"boss"}`, 400)
	call(owner, "PATCH", "/v1/members/"+memberID, "", `{"role":"admin"}`, 204)

	// Removing someone ends their sessions in that tenant; leaving moves you to your next tenant.
	call(admin, "DELETE", "/v1/members/"+memberID, "", "", 204)
	call(other, "GET", "/v1/me", "", "", 401)
	call(other, "POST", "/v1/login", "", `{"email":"`+otherEmail+`","password":`+pw+`}`, 200)
	if me = call(other, "GET", "/v1/me", "", "", 200); me["tenant"].(map[string]any)["id"] != globexID {
		t.Fatalf("after removal lands in %v", me["tenant"])
	}
	if me = call(admin, "DELETE", "/v1/members/"+adminID, "", "", 200); me["role"] != "owner" || me["tenant"].(map[string]any)["id"] == acmeID {
		t.Fatalf("after leaving: %v", me)
	}

	// Isolation: Globex's owner sees only Globex's members.
	for _, m := range call(other, "GET", "/v1/members", "", "", 200)["data"].([]any) {
		if m.(map[string]any)["id"] != memberID {
			t.Fatalf("globex sees %v", m)
		}
	}

	// Password change needs the current one and signs out other sessions.
	second := h.client()
	call(second, "POST", "/v1/login", "", `{"email":"`+ownerEmail+`","password":`+pw+`}`, 200)
	call(owner, "POST", "/v1/me/password", "", `{"current_password":"wrong password here","new_password":"another good passphrase"}`, 400)
	call(owner, "POST", "/v1/me/password", "", `{"current_password":`+pw+`,"new_password":"another good passphrase"}`, 204)
	call(second, "GET", "/v1/me", "", "", 401)
	call(owner, "GET", "/v1/me", "", "", 200)

	// Reset: unknown addresses get the same answer; the link sets a password and ends every session.
	call(h.client(), "POST", "/v1/password-reset", "", `{"email":"`+newEmail("nobody")+`"}`, 202)
	call(h.client(), "POST", "/v1/password-reset", "", `{"email":"`+strings.ToUpper(ownerEmail)+`"}`, 202)
	resetToken := mail.token(t, ownerEmail)
	call(h.client(), "POST", "/v1/password-reset/confirm", "", `{"token":"`+resetToken+`","password":"short"}`, 400)
	call(h.client(), "POST", "/v1/password-reset/confirm", "", `{"token":"`+resetToken+`","password":"a brand new passphrase"}`, 204)
	call(h.client(), "POST", "/v1/password-reset/confirm", "", `{"token":"`+resetToken+`","password":"a brand new passphrase"}`, 400)
	call(owner, "GET", "/v1/me", "", "", 401)
	call(owner, "POST", "/v1/login", "", `{"email":"`+ownerEmail+`","password":"a brand new passphrase"}`, 200)

	// Email change takes effect only from the new address's link; a taken address is refused.
	call(owner, "POST", "/v1/me/email", "", `{"email":"`+otherEmail+`","password":"a brand new passphrase"}`, 409)
	newAddr := newEmail("acme")
	call(owner, "POST", "/v1/me/email", "", `{"email":"`+newAddr+`","password":"a brand new passphrase"}`, 202)
	call(h.client(), "POST", "/v1/verify-email", "", `{"token":"`+mail.token(t, newAddr)+`","kind":"change_email"}`, 204)
	if me = call(owner, "GET", "/v1/me", "", "", 200); me["user"].(map[string]any)["email"] != newAddr {
		t.Fatalf("email not changed: %v", me["user"])
	}

	// A new tenant makes you its owner and moves the session there.
	if me = call(owner, "POST", "/v1/tenants", "", `{"name":"Acme Labs"}`, 201); me["role"] != "owner" || me["tenant"].(map[string]any)["name"] != "Acme Labs" {
		t.Fatalf("new tenant: %v", me)
	}
}

func TestLoginThrottle(t *testing.T) {
	h := newHarness(t)
	mail := captureMail(t)
	email, other := newEmail("throttle"), newEmail("throttle")
	for _, e := range []string{email, other} {
		h.call(h.client(), "POST", "/v1/signup", "", `{"email":"`+e+`","password":"correct horse battery","tenant_name":"T"}`, 201)
	}
	wrong := `{"email":"` + strings.ToUpper(email) + `","password":"wrong password here"}`
	for range 10 {
		h.call(h.client(), "POST", "/v1/login", "", wrong, 401)
	}
	// Locked, even with the right password; other addresses are untouched.
	h.call(h.client(), "POST", "/v1/login", "", `{"email":"`+email+`","password":"correct horse battery"}`, 429)
	h.call(h.client(), "POST", "/v1/login", "", `{"email":"`+other+`","password":"correct horse battery"}`, 200)
	// Addresses without an account lock the same way, so the limit reveals nothing.
	ghost := `{"email":"` + newEmail("nobody") + `","password":"wrong password here"}`
	for range 10 {
		h.call(h.client(), "POST", "/v1/login", "", ghost, 401)
	}
	h.call(h.client(), "POST", "/v1/login", "", ghost, 429)
	// Resetting the password proves ownership and lifts the lock.
	h.call(h.client(), "POST", "/v1/password-reset", "", `{"email":"`+email+`"}`, 202)
	h.call(h.client(), "POST", "/v1/password-reset/confirm", "", `{"token":"`+mail.token(t, email)+`","password":"a new passphrase here"}`, 204)
	h.call(h.client(), "POST", "/v1/login", "", `{"email":"`+email+`","password":"a new passphrase here"}`, 200)
}

// TestAccountListsPaged: keys, members and invites page by cursor, newest first, and search on the server.
func TestAccountListsPaged(t *testing.T) {
	h := newHarness(t)
	mail := captureMail(t)
	owner := h.client()
	h.call(owner, "POST", "/v1/signup", "", `{"email":"`+newEmail("paged")+`","password":"correct horse battery","tenant_name":"Paged"}`, 201)

	run := strings.ToLower(rand.Text())[:8] // the test database keeps earlier runs' people
	invitee := func(i int) string { return fmt.Sprintf("invitee-%d-%s@paged.test", i, run) }
	for i := 1; i <= 5; i++ {
		h.call(owner, "POST", "/v1/api-keys", "", fmt.Sprintf(`{"name":"key-%d","scopes":["video:read"]}`, i), 201)
		h.call(owner, "POST", "/v1/invites", "", `{"email":"`+invitee(i)+`","role":"member"}`, 201)
	}
	// Five keys and five invites, three per page: 3 then 2, newest first, nothing repeated or skipped.
	for _, c := range []struct{ path, field, first, last string }{
		{"/v1/api-keys", "name", "key-5", "key-1"},
		{"/v1/invites", "email", invitee(5), invitee(1)},
	} {
		var got []string
		cursor := ""
		for pages := 0; pages < 3; pages++ {
			out := h.call(owner, "GET", c.path+"?limit=3&cursor="+cursor, "", "", 200)
			for _, r := range out["data"].([]any) {
				got = append(got, r.(map[string]any)[c.field].(string))
			}
			if cursor = out["next_cursor"].(string); cursor == "" {
				break
			}
		}
		if len(got) != 5 || got[0] != c.first || got[4] != c.last {
			t.Errorf("%s paged: %v", c.path, got)
		}
		if out := h.call(owner, "GET", c.path+"?limit=3", "", "", 200); out["total"] != 5.0 {
			t.Errorf("%s total %v, want 5", c.path, out["total"])
		}
		h.call(owner, "GET", c.path+"?limit=0", "", "", 400)
		h.call(owner, "GET", c.path+"?cursor=junk", "", "", 400)
	}
	if rows := h.call(owner, "GET", "/v1/api-keys?q=KEY-3", "", "", 200)["data"].([]any); len(rows) != 1 || rows[0].(map[string]any)["name"] != "key-3" {
		t.Errorf("key search: %v", rows)
	}
	if rows := h.call(owner, "GET", "/v1/invites?q=invitee-2-"+run, "", "", 200)["data"].([]any); len(rows) != 1 {
		t.Errorf("invite search: %v", rows)
	}
	if rows := h.call(owner, "GET", "/v1/invites?q=%25", "", "", 200)["data"].([]any); len(rows) != 0 {
		t.Errorf("a percent sign matched %d invites, want it taken literally", len(rows))
	}

	// Members: invite and accept four people, then page and search.
	for i := 1; i <= 4; i++ {
		email := invitee(i)
		tok := mail.token(t, email)
		h.call(h.client(), "POST", "/v1/invites/accept", "", `{"token":"`+tok+`","name":"Person `+fmt.Sprint(i)+`","password":"correct horse battery"}`, 201)
	}
	var got []string
	cursor := ""
	for pages := 0; pages < 4; pages++ {
		out := h.call(owner, "GET", "/v1/members?limit=2&cursor="+cursor, "", "", 200)
		for _, r := range out["data"].([]any) {
			got = append(got, r.(map[string]any)["email"].(string))
		}
		if cursor = out["next_cursor"].(string); cursor == "" {
			break
		}
	}
	if len(got) != 5 || got[0] != invitee(4) {
		t.Errorf("members paged: %v", got)
	}
	if out := h.call(owner, "GET", "/v1/members?limit=2", "", "", 200); out["total"] != 5.0 {
		t.Errorf("members total %v, want 5", out["total"])
	}
	if rows := h.call(owner, "GET", "/v1/members?q=person%202", "", "", 200)["data"].([]any); len(rows) != 1 {
		t.Errorf("member search by name: %v", rows)
	}
}

// TestTimezone: a person's time zone is stored on the server, UTC and GMT are choices, "" clears it, a made-up name is refused.
func TestTimezone(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.call(c, "POST", "/v1/signup", "", `{"email":"`+newEmail("zone")+`","password":"correct horse battery","tenant_name":"Zone"}`, 201)
	zone := func() any { return h.call(c, "GET", "/v1/me", "", "", 200)["user"].(map[string]any)["timezone"] }
	if zone() != nil {
		t.Fatalf("a new account has a zone: %v", zone())
	}
	for _, z := range []string{"Asia/Dhaka", "UTC", "GMT"} {
		h.call(c, "PATCH", "/v1/me", "", `{"name":"Z","timezone":"`+z+`"}`, 200)
		if zone() != z {
			t.Fatalf("zone is %v, want %s", zone(), z)
		}
	}
	h.call(c, "PATCH", "/v1/me", "", `{"name":"Z","phone":"+14155550100"}`, 200)
	if zone() != "GMT" {
		t.Fatalf("saving the phone changed the zone: %v", zone())
	}
	h.call(c, "PATCH", "/v1/me", "", `{"name":"Z","timezone":"Mars/Olympus"}`, 400)
	h.call(c, "PATCH", "/v1/me", "", `{"name":"Z","timezone":"Local"}`, 400)
	h.call(c, "PATCH", "/v1/me", "", `{"name":"Z","timezone":""}`, 200)
	if zone() != nil {
		t.Fatalf("clearing left %v", zone())
	}
}

// A sign-up whose confirmation email can't be sent still creates the account and signs in; resending works later.
func TestSignupWhenMailFails(t *testing.T) {
	h := newHarness(t)
	saved := core.SendMail
	core.SendMail = func(context.Context, string, string, string) error { return errors.New("mail provider refused") }
	t.Cleanup(func() { core.SendMail = saved })
	c, email := h.client(), newEmail("nomail")
	me := h.call(c, "POST", "/v1/signup", "", `{"email":"`+email+`","password":"correct horse battery","tenant_name":"No Mail"}`, 201)
	if me["role"] != "owner" {
		t.Fatalf("signup: %v", me)
	}
	h.call(c, "GET", "/v1/me", "", "", 200)
}

// With SIGNUP=closed no one can create a workspace, and /v1/meta tells the console so.
func TestSignupClosed(t *testing.T) {
	h := newHarnessWith(t, func(c *app.Config) { c.SignupOpen = false })
	c := h.client()
	if meta := h.call(c, "GET", "/v1/meta", "", "", 200); meta["signup_open"] != false {
		t.Fatalf("meta: signup_open = %v", meta["signup_open"])
	}
	out := h.call(c, "POST", "/v1/signup", "", `{"email":"`+newEmail("closed")+`","password":"correct horse battery","tenant_name":"Closed"}`, 403)
	if code := out["error"].(map[string]any)["code"]; code != "signup_closed" {
		t.Fatalf("signup: %v", out)
	}
	// A signed-in person can't open a workspace of their own either: that is a sign-up by another door.
	email := newEmail("closed")
	hash, _ := bcrypt.GenerateFromPassword([]byte("correct horse battery"), bcrypt.MinCost)
	if _, err := h.pool.Exec(t.Context(), "SELECT signup($1, $2, 'Invited', '')", email, string(hash)); err != nil {
		t.Fatal(err)
	}
	h.call(c, "POST", "/v1/login", "", `{"email":"`+email+`","password":"correct horse battery"}`, 200)
	h.call(c, "POST", "/v1/tenants", "", `{"name":"Second"}`, 403)
}
