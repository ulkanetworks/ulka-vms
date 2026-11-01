package core

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"testing"

	"github.com/aws/smithy-go"
)

func TestStorageProblem(t *testing.T) {
	api := func(code string) error {
		return fmt.Errorf("writing a file: %w", &smithy.GenericAPIError{Code: code, Message: "provider words"})
	}
	for _, c := range []struct {
		err  error
		want string
	}{
		{api("SignatureDoesNotMatch"), "secret"},
		{api("InvalidAccessKeyId"), "access key ID"},
		{api("NoSuchBucket"), "no bucket"},
		{api("AccessDenied"), "isn't allowed"},
		{api("AuthorizationHeaderMalformed"), "region"},
		{api("RequestTimeTooSkewed"), "clock"},
		{&net.OpError{Op: "dial", Err: errors.New("connection refused")}, "couldn't reach"},
		{context.DeadlineExceeded, "didn't answer"},
		{api("SomethingElse"), "SomethingElse"}, // an unknown answer is passed on, not hidden
	} {
		if got := StorageProblem(c.err); !strings.Contains(got, c.want) {
			t.Errorf("%v: %q, want it to mention %q", c.err, got, c.want)
		}
	}
}
