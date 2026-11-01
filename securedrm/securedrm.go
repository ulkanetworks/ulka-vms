// Package securedrm is the client of SecureDRM, Ulka Networks' hosted key service: it keeps each video's key and
// hands it only to players carrying a token this server signed. Without it (KEY_SERVICE=local) keys stay in the
// database.
package securedrm

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/ulkanetworks/ulka-vms/core"
)

// Client is a core.KeyStore kept by SecureDRM.
type Client struct {
	URL         string // e.g. https://b.securedrm.link
	APIKey      string
	TokenKid    string
	TokenSecret []byte
	Client      *http.Client
}

var (
	ErrNoKey      = errors.New("key service has no key for this video")
	ErrKeyRefused = errors.New("key service refused the API key")
)

type serviceKey struct {
	Key string `json:"key"`
	IV  string `json:"iv"`
}

// Create returns the video's key, made on first call; asking again returns the same one.
func (k *Client) Create(ctx context.Context, contentID string) (key, iv []byte, err error) {
	body, _ := json.Marshal(map[string]string{"content_id": contentID})
	return k.keyCall(ctx, http.MethodPost, "/v1/keys", body)
}

func (k *Client) Get(ctx context.Context, contentID string) (key, iv []byte, err error) {
	return k.keyCall(ctx, http.MethodGet, "/v1/keys/"+contentID, nil)
}

// Delete forgets a video's key; one already gone is not an error.
func (k *Client) Delete(ctx context.Context, contentID string) error {
	_, _, err := k.keyCall(ctx, http.MethodDelete, "/v1/keys/"+contentID, nil)
	if errors.Is(err, ErrNoKey) {
		return nil
	}
	return err
}

func (k *Client) keyCall(ctx context.Context, method, path string, body []byte) (key, iv []byte, err error) {
	req, err := http.NewRequestWithContext(ctx, method, k.URL+path, bytes.NewReader(body))
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+k.APIKey)
	req.Header.Set("Content-Type", "application/json")
	res, err := k.Client.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("key service: %w", err)
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	switch {
	case err != nil:
		return nil, nil, fmt.Errorf("key service: %w", err)
	case res.StatusCode == http.StatusNotFound:
		return nil, nil, ErrNoKey
	case res.StatusCode == http.StatusUnauthorized:
		return nil, nil, ErrKeyRefused
	case res.StatusCode == http.StatusNoContent:
		return nil, nil, nil
	case res.StatusCode != http.StatusOK:
		return nil, nil, fmt.Errorf("key service: %s %s answered %d: %s", method, path, res.StatusCode, b)
	}
	var v serviceKey
	if err := json.Unmarshal(b, &v); err != nil {
		return nil, nil, fmt.Errorf("key service: %w", err)
	}
	key, err1 := hex.DecodeString(v.Key)
	iv, err2 := hex.DecodeString(v.IV)
	if err1 != nil || err2 != nil || len(key) != 16 || len(iv) != 16 {
		return nil, nil, errors.New("key service: malformed key")
	}
	return key, iv, nil
}

// PlayerURL is where a player fetches the video's key: a token for this video until exp, signed HS256.
func (k *Client) PlayerURL(contentID string, exp time.Time) string {
	h, _ := json.Marshal(map[string]string{"alg": "HS256", "typ": "JWT", "kid": k.TokenKid})
	c, _ := json.Marshal(map[string]any{"sub": contentID, "exp": exp.Unix()})
	signed := base64.RawURLEncoding.EncodeToString(h) + "." + base64.RawURLEncoding.EncodeToString(c)
	mac := hmac.New(sha256.New, k.TokenSecret)
	mac.Write([]byte(signed))
	return k.URL + "/v1/key/" + contentID + "?token=" + signed + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// Ping checks the service answers and accepts the API key, at start.
func (k *Client) Ping(ctx context.Context) error {
	_, _, err := k.Get(ctx, "start-check")
	if errors.Is(err, ErrNoKey) {
		return nil
	}
	return err
}

var _ core.KeyStore = (*Client)(nil)
