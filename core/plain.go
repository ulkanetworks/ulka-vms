package core

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
)

// A failure that a screen will show is stored and sent as one of these sentences, never as the error's own text.
// The raw error goes to the log (LogFailure); Plain turns anything not written here back into FailOurs.
var sentences = map[string]bool{}

// Sentence registers a plain sentence a feature may store or send, and returns it.
func Sentence(s string) string {
	sentences[s] = true
	return s
}

var (
	FailTimeout  = Sentence("The provider didn't answer in time.")
	FailUnusable = Sentence("The provider answered something we couldn't use.")
	FailAccess   = Sentence("The provider didn't accept our access.")
	FailUnreach  = Sentence("The provider couldn't be reached.")
	FailTheirs   = Sentence("The provider had a problem on its side.")
	FailOurs     = Sentence("Something on our side needs a look.")
)

// StatusError is a provider's HTTP answer that wasn't a success. Its text is for logs only.
type StatusError struct {
	Status int
	Msg    string
}

func (e *StatusError) Error() string { return e.Msg }

// PlainError carries the sentence to show beside the cause to log, for a feature that knows better than the type does.
type PlainError struct {
	Sentence string
	Cause    error
}

func (e *PlainError) Error() string { return e.Sentence + ": " + e.Cause.Error() }
func (e *PlainError) Unwrap() error { return e.Cause }

// HasStatus reports whether err is a provider answer with that status.
func HasStatus(err error, status int) bool {
	var se *StatusError
	return errors.As(err, &se) && se.Status == status
}

// PlainFailure picks the sentence for err by its type: never by its text.
func PlainFailure(err error) string {
	var pe *PlainError
	var se *StatusError
	var ne net.Error
	var syn *json.SyntaxError
	var typ *json.UnmarshalTypeError
	switch {
	case err == nil:
		return ""
	case errors.As(err, &pe):
		return pe.Sentence
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &ne) && ne.Timeout():
		return FailTimeout
	case errors.As(err, &se):
		switch {
		case se.Status == http.StatusUnauthorized || se.Status == http.StatusForbidden:
			return FailAccess
		case se.Status >= 500:
			return FailTheirs
		}
		return FailUnusable
	case errors.As(err, &ne):
		return FailUnreach
	case errors.As(err, &syn), errors.As(err, &typ):
		return FailUnusable
	}
	return FailOurs
}

// LogFailure writes err to the log with its context (key, value pairs) and returns the sentence to store or send.
func LogFailure(ctx context.Context, err error, what string, args ...any) string {
	slog.ErrorContext(ctx, what, append(args, "err", err)...)
	return PlainFailure(err)
}

// Plain returns s when it is one of the registered sentences (or empty), and FailOurs for anything else.
func Plain(s string) string {
	if s == "" || sentences[s] {
		return s
	}
	return FailOurs
}
