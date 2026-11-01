package app

import (
	"context"
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/securedrm"
)

// keyService is KEY_SERVICE: local (keys sealed in the database, served by the player host) or securedrm
// (SECUREDRM_*, the credentials SecureDRM issued for this server).
func keyService() core.KeyStore {
	if MustOneOf("KEY_SERVICE", []string{"local", "securedrm"}) == "local" {
		return nil
	}
	secret, err := base64.StdEncoding.DecodeString(MustEnv("SECUREDRM_TOKEN_SECRET"))
	if err != nil || len(secret) != 32 {
		slog.Error("SECUREDRM_TOKEN_SECRET must be the 32-byte base64 token secret SecureDRM showed for this server")
		os.Exit(1)
	}
	k := &securedrm.Client{URL: strings.TrimSuffix(MustURL("SECUREDRM_URL"), "/"), APIKey: MustSecret("SECUREDRM_API_KEY", 32),
		TokenKid: MustEnv("SECUREDRM_TOKEN_KID"), TokenSecret: secret, Client: &http.Client{Timeout: 10 * time.Second}}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// A refused key stops start-up; an outage only warns, so the server still starts and recovers when it answers.
	switch err := k.Ping(ctx); {
	case errors.Is(err, securedrm.ErrKeyRefused):
		slog.Error("SecureDRM refused SECUREDRM_API_KEY", "url", k.URL)
		os.Exit(1)
	case err != nil:
		slog.Warn("SecureDRM is unreachable; videos can't be encrypted or played until it answers", "url", k.URL, "err", err)
	}
	return k
}
