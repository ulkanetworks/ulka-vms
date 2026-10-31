package app

import (
	"maps"
	"strings"
	"testing"
)

func TestCheckEnv(t *testing.T) {
	good := map[string]string{
		"PUBLIC_URL": "https://videos.acme.co", "ORIGIN_URL": "https://origin.acme.co/s", "PLAYER_URL": "https://player.acme.co",
		"DOCS_URL": "https://docs.acme.co", "MAIL_PROVIDER": "smtp", "MAIL_FROM": "Acme <hello@acme.co>",
	}
	run := func(over map[string]string) []string {
		env := maps.Clone(good)
		maps.Copy(env, over)
		errs, _ := CheckEnv(func(k string) string { return env[k] })
		return errs
	}
	if errs := run(nil); len(errs) != 0 {
		t.Fatalf("a good deployment is refused: %v", errs)
	}
	for name, c := range map[string]struct {
		over map[string]string
		want string
	}{
		"http":         {map[string]string{"PUBLIC_URL": "http://videos.acme.co"}, "must be https"},
		"local origin": {map[string]string{"ORIGIN_URL": "http://localhost:8092/s"}, "ORIGIN_URL"},
		"example url":  {map[string]string{"PLAYER_URL": "https://player.example.com"}, "PLAYER_URL"},
		"log mail":     {map[string]string{"MAIL_PROVIDER": "log"}, "MAIL_PROVIDER"},
		"log fallback": {map[string]string{"MAIL_FALLBACK": "log"}, "MAIL_FALLBACK"},
		"example from": {map[string]string{"MAIL_FROM": "Acme <hello@example.com>"}, "MAIL_FROM"},
	} {
		if errs := run(c.over); len(errs) == 0 || !strings.Contains(strings.Join(errs, "\n"), c.want) {
			t.Errorf("%s: got %v, want one mentioning %q", name, errs, c.want)
		}
	}
	if errs, _ := CheckEnv(func(k string) string {
		return map[string]string{"PUBLIC_URL": "http://localhost:8096", "MAIL_PROVIDER": "log"}[k]
	}); len(errs) != 0 {
		t.Fatalf("development is refused: %v", errs)
	}
}
