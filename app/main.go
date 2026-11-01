package app

import (
	"context"
	"encoding/base64"
	"fmt"
	"log/slog"
	"net/netip"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/ulkanetworks/ulka-vms/core"
)

// Main runs the command line: migrate, api, worker, limits, and the extension's own commands.
func Main(ext Extension) {
	if ext.Name == "" {
		ext.Name = "ulka-vms"
	}
	commands := append([]string{"migrate", "api", "worker", "origin", "check-storage", "limits"}, slices.Sorted(func(yield func(string) bool) {
		for name := range ext.Commands {
			if !yield(name) {
				return
			}
		}
	})...)
	usage := "usage: " + ext.Name + " " + strings.Join(commands, "|")
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var err error
	switch cmd := os.Args[1]; {
	case cmd == "migrate":
		err = core.Migrate(ctx, MustEnv("MIGRATE_DATABASE_URL"), ext.migrationSets()...)
	case cmd == "api":
		cfg := newConfig(ext)
		cfg.TrustedProxies = mustProxies()
		var perr error
		// Without the IP country database only libraries' country rules are off; all else serves.
		if path := os.Getenv("GEOIP_DB"); path == "" {
			slog.Warn("country rules are off: GEOIP_DB is not set")
		} else if cfg.Geo, perr = core.OpenGeo(path); perr != nil {
			slog.Warn("country rules are off: cannot open the IP country database", "GEOIP_DB", path, "err", perr)
		}
		err = Serve(ctx, MustEnv("DATABASE_URL"), MustEnv("API_ADDR"), newStorage(), cfg, ext)
	case cmd == "worker":
		queues, qerr := ParseQueues(MustEnv("WORKER_QUEUES"), ext.allQueues())
		if qerr != nil {
			slog.Error("invalid environment variable", "err", qerr)
			os.Exit(1)
		}
		slots, serr := ParseEncodeSlots(MustEnv("WORKER_ENCODE_SLOTS"))
		if serr != nil {
			slog.Error("invalid environment variable", "err", serr)
			os.Exit(1)
		}
		err = RunWorker(ctx, MustEnv("DATABASE_URL"), newStorage(), newConfig(ext), queues, slots, ext)
	case cmd == "origin":
		err = ServeOrigin(ctx, MustEnv("ORIGIN_ADDR"), newStorage(), MustURL("CLICKHOUSE_URL"), mustProxies())
	case cmd == "check-storage":
		cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		if err = newStorage().Check(cctx); err == nil {
			fmt.Println("Storage works: the bucket can be written, read and cleaned up.")
		}
		cancel()
	case cmd == "limits":
		err = SetLimits(ctx, MustEnv("MIGRATE_DATABASE_URL"), core.ExtraLimitDefaults, os.Args[2:])
	case ext.Commands[cmd] != nil:
		err = ext.Commands[cmd](ctx)
	default:
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	if err != nil {
		slog.Error(os.Args[1]+" failed", "err", err)
		os.Exit(1)
	}
}

// MustEnv is a required setting; a missing one stops start-up.
func MustEnv(name string) string {
	v := os.Getenv(name)
	if v == "" {
		slog.Error("missing required environment variable", "name", name)
		os.Exit(1)
	}
	return v
}

// mustProxies is TRUSTED_PROXIES: the proxies whose X-Forwarded-For names the caller.
func mustProxies() []netip.Prefix {
	proxies, err := ParseProxies(MustEnv("TRUSTED_PROXIES"))
	if err != nil {
		slog.Error("invalid environment variable", "err", err)
		os.Exit(1)
	}
	return proxies
}

// MustOneOf is a setting that must name one of choices.
func MustOneOf(name string, choices []string) string {
	v := MustEnv(name)
	if !slices.Contains(choices, v) {
		slog.Error("environment variable names something unsupported", "name", name, "value", v, "supported", strings.Join(choices, ", "))
		os.Exit(1)
	}
	return v
}

// MustURL is an http(s) address with a host, checked at boot so a typo fails here, not in the first job using it.
func MustURL(name string) string {
	v := MustEnv(name)
	if u, err := url.Parse(v); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		slog.Error("environment variable must be an http(s) URL", "name", name)
		os.Exit(1)
	}
	return v
}

// MustSecret is a secret of at least min characters.
func MustSecret(name string, min int) string {
	v := MustEnv(name)
	if len(v) < min {
		slog.Error("environment variable is too short to be a secret", "name", name, "min", min)
		os.Exit(1)
	}
	return v
}

// IsLocal reports whether a URL points at this machine (localhost, 127.0.0.1, *.localhost, *.test).
func IsLocal(raw string) bool {
	u, _ := url.Parse(raw)
	h := u.Hostname()
	return h == "localhost" || h == "127.0.0.1" || h == "::1" || strings.HasSuffix(h, ".localhost") || strings.HasSuffix(h, ".test")
}

func newStorage() core.Storage {
	return core.Storage{
		S3: s3.New(s3.Options{
			Region:       MustEnv("S3_REGION"),
			BaseEndpoint: aws.String(MustEnv("S3_ENDPOINT")),
			UsePathStyle: true,
			Credentials:  credentials.NewStaticCredentialsProvider(MustEnv("S3_ACCESS_KEY_ID"), MustEnv("S3_SECRET_ACCESS_KEY"), ""),
		}),
		Bucket: MustEnv("S3_BUCKET"),
	}
}

func newConfig(ext Extension) Config {
	// All the problems at once, so one restart is enough to fix them.
	errs, warns := CheckEnv(os.Getenv)
	if ext.CheckEnv != nil {
		e, w := ext.CheckEnv(os.Getenv)
		errs, warns = append(errs, e...), append(warns, w...)
	}
	for _, w := range warns {
		slog.Warn(w)
	}
	if len(errs) > 0 {
		for _, e := range errs {
			slog.Error("unsafe configuration", "problem", e)
		}
		os.Exit(1)
	}
	core.SendMail = newMailer()
	// Read by the OpenTelemetry exporters themselves; checked here so a missing one stops start-up, not telemetry.
	MustURL("OTEL_EXPORTER_OTLP_ENDPOINT")
	cfg := Config{
		PublicURL:     MustURL("PUBLIC_URL"),
		SealKey:       mustSealKey(),
		OriginURL:     strings.TrimSuffix(MustURL("ORIGIN_URL"), "/"),
		PlayerURL:     strings.TrimSuffix(MustURL("PLAYER_URL"), "/"),
		DocsURL:       strings.TrimSuffix(MustURL("DOCS_URL"), "/"),
		PlayerDemo:    playerDemo(),
		SignupOpen:    MustOneOf("SIGNUP", []string{"open", "closed"}) == "open",
		ClickHouseURL: MustURL("CLICKHOUSE_URL"),
	}
	cfg.Keys = keyService()
	if ext.Configure != nil {
		ext.Configure(&cfg)
	}
	return cfg
}

// newMailer is MAIL_PROVIDER: resend (RESEND_API_KEY), smtp (SMTP_URL), or log (development: emails are only logged).
func newMailer() core.Mailer {
	m := mailerFor(MustEnv("MAIL_PROVIDER"))
	// Optional: a second provider that takes over when the first fails (the other of resend and smtp).
	if f := os.Getenv("MAIL_FALLBACK"); f != "" {
		return core.WithFallback(m, mailerFor(f))
	}
	return m
}

func mailerFor(provider string) core.Mailer {
	switch provider {
	case "log":
		return core.LogMail
	case "resend":
		return core.ResendMailer(MustEnv("RESEND_API_KEY"), MustEnv("MAIL_FROM"))
	case "smtp":
		u, err := url.Parse(MustEnv("SMTP_URL"))
		var m core.Mailer
		if err == nil {
			m, err = core.SMTPMailer(u, MustEnv("MAIL_FROM"))
		}
		if err != nil {
			slog.Error("invalid environment variable", "err", err)
			os.Exit(1)
		}
		return m
	default:
		slog.Error("MAIL_PROVIDER and MAIL_FALLBACK must be resend, smtp or log", "got", provider)
		os.Exit(1)
		return nil
	}
}

// playerDemo is PLAYER_DEMO: none, or <library>/<video> (two ids) for the player host's home to show.
func playerDemo() string {
	v := MustEnv("PLAYER_DEMO")
	if v == "none" {
		return ""
	}
	if !regexp.MustCompile(`^[0-9a-f-]{36}/[0-9a-f-]{36}$`).MatchString(v) {
		slog.Error("PLAYER_DEMO must be none or <library id>/<video id>")
		os.Exit(1)
	}
	return v
}

// mustSealKey is SEAL_KEY: 32 bytes, base64. It seals secrets at rest; losing it makes them unreadable.
func mustSealKey() []byte {
	key, err := base64.StdEncoding.DecodeString(MustEnv("SEAL_KEY"))
	if err != nil || len(key) != 32 {
		slog.Error("SEAL_KEY must be 32 bytes, base64: openssl rand -base64 32")
		os.Exit(1)
	}
	return key
}
