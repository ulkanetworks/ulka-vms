package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestPlainFailureNeverLeaksRawText(t *testing.T) {
	var typ error = json.Unmarshal([]byte(`{"a":1}`), new(string))
	secret := "SECRET-vendor-text SELECT * FROM x"
	cases := map[string]struct {
		err  error
		want string
	}{
		"json":    {fmt.Errorf("edge GET /x: %w", typ), FailUnusable},
		"timeout": {fmt.Errorf("%s: %w", secret, context.DeadlineExceeded), FailTimeout},
		"refused": {&net.OpError{Op: "dial", Err: errors.New(secret)}, FailUnreach},
		"denied":  {&StatusError{Status: http.StatusForbidden, Msg: secret}, FailAccess},
		"theirs":  {&StatusError{Status: http.StatusBadGateway, Msg: secret}, FailTheirs},
		"odd":     {&StatusError{Status: http.StatusTeapot, Msg: secret}, FailUnusable},
		"sql":     {&pgconn.PgError{Message: secret}, FailOurs},
		"plain":   {errors.New(secret), FailOurs},
	}
	for name, c := range cases {
		got := PlainFailure(c.err)
		if got != c.want || strings.Contains(got, "SECRET") || strings.Contains(got, "json:") {
			t.Errorf("%s: got %q, want %q", name, got, c.want)
		}
		if Plain(got) != got {
			t.Errorf("%s: %q is not registered", name, got)
		}
	}
	if PlainFailure(nil) != "" || Plain("json: cannot unmarshal object into Go value of type string") != FailOurs {
		t.Error("nil must stay empty and unknown text must be replaced")
	}
}
