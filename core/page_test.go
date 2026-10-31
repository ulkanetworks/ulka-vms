package core

import (
	"net/http/httptest"
	"testing"
	"time"
)

func TestCursorRoundTrip(t *testing.T) {
	at := time.Date(2026, 9, 30, 5, 1, 2, 345678000, time.UTC)
	c := Cursor{Limit: 2}
	rows := []string{"a", "b", "c"} // fetched Fetch() = 3: a next page exists
	out := Paged(rows, c, func(s string) (time.Time, string) { return at, "id-" + s })
	if len(out["data"].([]string)) != 2 || out["next_cursor"] == "" {
		t.Fatalf("page %v", out)
	}
	back, err := ParseCursor(httptest.NewRequest("GET", "/?limit=2&cursor="+out["next_cursor"].(string), nil))
	if err != nil || !back.At.Valid || !back.At.Time.Equal(at) || back.ID != "id-b" {
		t.Fatalf("cursor %+v %v", back, err)
	}
	if last := Paged(rows[:2], c, func(s string) (time.Time, string) { return at, s }); last["next_cursor"] != "" {
		t.Fatalf("a short page is the last: %v", last)
	}
	for _, bad := range []string{"?cursor=!!", "?cursor=bm90LWEtY3Vyc29y", "?limit=0", "?limit=101"} {
		if _, err := ParseCursor(httptest.NewRequest("GET", "/"+bad, nil)); err == nil {
			t.Errorf("%s accepted", bad)
		}
	}
}
