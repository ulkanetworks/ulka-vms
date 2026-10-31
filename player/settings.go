// Package player is Ulka's video player: the look and controls a library chooses (settings), and what the
// embedded player fetches to render itself. The player is Shaka Player in the console's web app; this module is its
// service. It reads libraries and playback ids only through video's Go functions.
package player

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"slices"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/video"
)

var (
	errNotFound      = core.APIError{Status: http.StatusNotFound, Code: "not_found"}
	errInvalidPlayer = core.APIError{Status: http.StatusBadRequest, Code: "invalid_player"}
	hexColor         = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
)

// Settings is how a library's videos look when played with Ulka's player (Shaka Player underneath). One
// document per library; the console edits it and the embedded player reads it.
type Settings struct {
	Accent   string `json:"accent"` // #rrggbb: the progress bar, buttons and the play button
	Theme    string `json:"theme"`  // dark or light controls
	LogoURL  string `json:"logo_url"`
	LogoLink string `json:"logo_link"`
	Behaviour
}

// Behaviour is which controls show and how playback starts: the part a template sets.
type Behaviour struct {
	Controls   bool `json:"controls"` // off: no controls at all, for a page that drives the player or a background
	Autoplay   bool `json:"autoplay"` // browsers only allow it with the sound off
	Loop       bool `json:"loop"`
	Muted      bool `json:"muted"`
	Speed      bool `json:"speed"`
	Quality    bool `json:"quality"`
	Captions   bool `json:"captions"`
	Pip        bool `json:"pip"`
	Fullscreen bool `json:"fullscreen"`
	Skip       int  `json:"skip"` // seconds the back and forward buttons move; 0 hides them
}

// Template is a ready-made Behaviour for a common use; a library applies one, or an embed picks one with ?template=.
type Template struct {
	Key         string    `json:"key"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Settings    Behaviour `json:"settings"`
}

var standard = Behaviour{Controls: true, Speed: true, Quality: true, Captions: true, Pip: true, Fullscreen: true, Skip: 10}

// Templates are the uses most videos fall into, first the default.
var Templates = []Template{
	{"standard", "Standard", "Every control: speed, quality, captions, picture in picture, full screen and 10-second skips. For most videos and lessons.", standard},
	{"minimal", "Minimal", "Play, the timeline, volume and full screen; nothing else. For product videos and short clips.",
		Behaviour{Controls: true, Captions: true, Fullscreen: true}},
	{"preview", "Preview", "Starts by itself without sound and repeats, with simple controls to unmute or watch. For teasers and previews.",
		Behaviour{Controls: true, Autoplay: true, Muted: true, Loop: true, Captions: true, Fullscreen: true}},
	{"background", "Background", "No controls; starts by itself without sound and repeats. For a moving background on a website.",
		Behaviour{Autoplay: true, Muted: true, Loop: true}},
}

func template(key string) (Behaviour, bool) {
	for _, t := range Templates {
		if t.Key == key {
			return t.Settings, true
		}
	}
	return Behaviour{}, false
}

func defaults() Settings {
	return Settings{Accent: "#10b981", Theme: "dark", Behaviour: standard}
}

// settingsOf reads a stored document over the defaults, so a library that never set one still plays.
func settingsOf(raw []byte) Settings {
	p := defaults()
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &p) // a damaged document leaves the defaults
	}
	return p
}

// Docs is what the video module needs to store and show a workspace's default player settings.
var Docs = video.PlayerDocs{
	Clean: func(raw []byte) ([]byte, error) {
		in := defaults()
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&in); err != nil {
			return nil, errInvalidPlayer
		}
		if err := in.validate(); err != nil {
			return nil, err
		}
		return json.Marshal(in)
	},
	View:   func(stored []byte) any { return settingsOf(stored) },
	Config: serveConfig,
}

func (p Settings) validate() error {
	if !hexColor.MatchString(p.Accent) || !slices.Contains([]string{"dark", "light"}, p.Theme) || !slices.Contains([]int{0, 5, 10, 15, 30}, p.Skip) {
		return errInvalidPlayer
	}
	for _, u := range []string{p.LogoURL, p.LogoLink} {
		if u == "" {
			continue
		}
		if parsed, err := url.Parse(u); err != nil || parsed.Scheme != "https" || parsed.Host == "" || len(u) > core.MaxURL {
			return errInvalidPlayer
		}
	}
	return nil
}
