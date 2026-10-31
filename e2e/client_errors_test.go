package e2e

import (
	"strings"
	"testing"
)

// A page that breaks in the browser reports itself, signed in or not, so the crash isn't silent.
func TestClientErrorReports(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.call(c, "POST", "/v1/client-errors", "", `{"ref":"a1b2c3d4","message":"Cannot read properties of null (reading 'slice')","stack":"at Overview (index.tsx:175)","path":"/admin","build":"9c2cb48"}`, 204)
	h.call(c, "POST", "/v1/client-errors", "", `{"ref":"a1b2c3d4","message":"`+strings.Repeat("x", 5000)+`","path":"/"}`, 204) // long text is cut, not refused
	h.call(c, "POST", "/v1/client-errors", "", `{"ref":"not hex!","message":"x","path":"/"}`, 400)
	h.call(c, "POST", "/v1/client-errors", "", `{"message":"x","path":"/"}`, 400)
	h.call(c, "POST", "/v1/client-errors", "", `{"ref":"a1b2c3d4","message":"x","path":"/","extra":1}`, 400)
}
