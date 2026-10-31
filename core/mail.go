package core

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/mail"
	"net/smtp"
	"net/url"
	"strings"
	"time"
)

// Mailer delivers one plain-text email.
type Mailer func(ctx context.Context, to, subject, body string) error

// SendMail is how Ulka sends email; the ulka command sets it at boot from MAIL_PROVIDER.
var SendMail Mailer = LogMail

// LogMail only logs the email: MAIL_PROVIDER=log, for development.
func LogMail(ctx context.Context, to, subject, body string) error {
	slog.InfoContext(ctx, "email (not sent: MAIL_PROVIDER=log)", "to", to, "subject", subject, "body", body)
	return nil
}

// WithFallback sends through primary and, when that fails, through backup, so a provider outage doesn't stop
// password resets and invitations. When both fail the error names both.
func WithFallback(primary, backup Mailer) Mailer {
	return func(ctx context.Context, to, subject, body string) error {
		err := primary(ctx, to, subject, body)
		if err == nil {
			return nil
		}
		slog.WarnContext(ctx, "email provider failed, trying the backup", "err", err)
		if berr := backup(ctx, to, subject, body); berr != nil {
			return errors.Join(err, berr)
		}
		return nil
	}
}

var resendURL = "https://api.resend.com/emails"

// ResendMailer sends through Resend's API with an API key.
func ResendMailer(key, from string) Mailer {
	return func(ctx context.Context, to, subject, body string) error {
		payload, err := json.Marshal(map[string]any{"from": from, "to": []string{to}, "subject": subject, "text": body})
		if err != nil {
			return err
		}
		ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, resendURL, bytes.NewReader(payload))
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			return err
		}
		defer res.Body.Close()
		if res.StatusCode/100 != 2 {
			msg, _ := io.ReadAll(io.LimitReader(res.Body, 500))
			return fmt.Errorf("resend: %s: %s", res.Status, msg)
		}
		return nil
	}
}

// SMTPMailer sends through an SMTP server: smtp://user:pass@host:587 (STARTTLS, required unless the host is local)
// or smtps://user:pass@host:465 (TLS from the start).
func SMTPMailer(u *url.URL, from string) (Mailer, error) {
	if (u.Scheme != "smtp" && u.Scheme != "smtps") || u.Hostname() == "" || u.Port() == "" {
		return nil, errors.New("SMTP_URL must look like smtp://user:pass@host:587 or smtps://user:pass@host:465")
	}
	addr, err := mail.ParseAddress(from)
	if err != nil {
		return nil, errors.New("MAIL_FROM must be an address, like Ulka <hello@example.com>")
	}
	return func(ctx context.Context, to, subject, body string) error {
		msg, err := smtpMessage(from, to, subject, body)
		if err != nil {
			return err
		}
		d := net.Dialer{Timeout: 15 * time.Second}
		var conn net.Conn
		tlsConf := &tls.Config{ServerName: u.Hostname()}
		if u.Scheme == "smtps" {
			conn, err = (&tls.Dialer{NetDialer: &d, Config: tlsConf}).DialContext(ctx, "tcp", u.Host)
		} else {
			conn, err = d.DialContext(ctx, "tcp", u.Host)
		}
		if err != nil {
			return err
		}
		if dl, ok := ctx.Deadline(); ok {
			_ = conn.SetDeadline(dl) // best effort; the dial already honoured ctx
		} else {
			_ = conn.SetDeadline(time.Now().Add(time.Minute))
		}
		c, err := smtp.NewClient(conn, u.Hostname())
		if err != nil {
			conn.Close()
			return err
		}
		defer c.Close()
		if ok, _ := c.Extension("STARTTLS"); ok && u.Scheme == "smtp" {
			if err := c.StartTLS(tlsConf); err != nil {
				return err
			}
		}
		if u.User != nil {
			pass, _ := u.User.Password()
			// PlainAuth refuses to send the password without TLS, except to a local server.
			if err := c.Auth(smtp.PlainAuth("", u.User.Username(), pass, u.Hostname())); err != nil {
				return err
			}
		}
		if err := c.Mail(addr.Address); err != nil {
			return err
		}
		if err := c.Rcpt(to); err != nil {
			return err
		}
		w, err := c.Data()
		if err != nil {
			return err
		}
		if _, err := w.Write(msg); err != nil {
			return err
		}
		if err := w.Close(); err != nil {
			return err
		}
		return c.Quit()
	}, nil
}

// smtpMessage is a plain-text UTF-8 message; a line break in an address or subject would inject headers, so it's refused.
func smtpMessage(from, to, subject, body string) ([]byte, error) {
	if strings.ContainsAny(from+to+subject, "\r\n") {
		return nil, errors.New("line break in an email header")
	}
	var b strings.Builder
	for _, h := range [][2]string{{"From", from}, {"To", to}, {"Subject", mime.QEncoding.Encode("utf-8", subject)},
		{"Date", time.Now().Format(time.RFC1123Z)}, {"MIME-Version", "1.0"},
		{"Content-Type", "text/plain; charset=utf-8"}, {"Content-Transfer-Encoding", "8bit"}} {
		b.WriteString(h[0] + ": " + h[1] + "\r\n")
	}
	b.WriteString("\r\n")
	b.WriteString(strings.ReplaceAll(strings.ReplaceAll(body, "\r\n", "\n"), "\n", "\r\n"))
	return []byte(b.String()), nil
}
