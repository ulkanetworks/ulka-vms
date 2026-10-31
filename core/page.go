package core

import (
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

var ErrInvalidPage = APIError{Status: http.StatusBadRequest, Code: "invalid_page"}

// Cursor is a list request paged by position rather than count (?q=&limit=&cursor=): newest first by
// (created_at, id), continuing after the row the cursor names. Pages stay right while rows are added.
type Cursor struct {
	Q     string
	Limit int32
	At    pgtype.Timestamptz // the last row seen; not Valid on the first page
	ID    string
}

// ParseCursor reads a cursor list request; limit is 1 to 100 (25 when absent).
func ParseCursor(r *http.Request) (Cursor, error) {
	v := r.URL.Query()
	c := Cursor{Q: strings.TrimSpace(v.Get("q")), Limit: 25}
	if s := v.Get("limit"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 || n > 100 {
			return c, ErrInvalidPage
		}
		c.Limit = int32(n)
	}
	if len(c.Q) > MaxSearch {
		return c, ErrInvalidPage
	}
	if s := v.Get("cursor"); s != "" {
		raw, err := base64.RawURLEncoding.DecodeString(s)
		at, id, ok := strings.Cut(string(raw), "|")
		t, terr := time.Parse(time.RFC3339Nano, at)
		if err != nil || !ok || terr != nil || id == "" {
			return c, ErrInvalidPage
		}
		c.At, c.ID = pgtype.Timestamptz{Time: t, Valid: true}, id
	}
	return c, nil
}

// Like is the search as an ILIKE pattern matching anywhere, with % and _ in it taken literally.
func (c Cursor) Like() string {
	return "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(c.Q) + "%"
}

// Fetch is how many rows to ask for: one more than a page, to know whether another follows.
func (c Cursor) Fetch() int32 { return c.Limit + 1 }

// Paged is a cursor list response: {data, next_cursor}, next_cursor empty on the last page. rows were fetched
// with Fetch(); key gives a row's position.
func Paged[T any](rows []T, c Cursor, key func(T) (time.Time, string)) map[string]any {
	next := ""
	if int32(len(rows)) > c.Limit {
		rows = rows[:c.Limit]
		at, id := key(rows[len(rows)-1])
		next = base64.RawURLEncoding.EncodeToString([]byte(at.UTC().Format(time.RFC3339Nano) + "|" + id))
	}
	if rows == nil {
		rows = []T{}
	}
	return map[string]any{"data": rows, "next_cursor": next}
}

// PagedTotal is Paged plus how many rows match the whole request (its filters, not the cursor), for "1-10 of 57".
func PagedTotal[T any](rows []T, c Cursor, key func(T) (time.Time, string), total int64) map[string]any {
	out := Paged(rows, c, key)
	out["total"] = total
	return out
}

// AfterUUID is the cursor's row id for lists keyed by uuid; not Valid on the first page, invalid_page if malformed.
func (c Cursor) AfterUUID() (pgtype.UUID, error) {
	var id pgtype.UUID
	if c.At.Valid && id.Scan(c.ID) != nil {
		return id, ErrInvalidPage
	}
	return id, nil
}
