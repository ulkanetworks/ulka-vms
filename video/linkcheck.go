package video

import (
	"context"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/video/db"
)

// linkFinding is one rule a viewer's address meets or breaks; a note is something to know that isn't a failure.
type linkFinding struct {
	Kind    string `json:"kind"`  // video, signature, expiry, ip, page, country
	State   string `json:"state"` // ok, problem, note
	Message string `json:"message"`
}

var videoInPath = regexp.MustCompile(`([0-9a-f-]{36})/([0-9a-f-]{36})(?:/(.+))?$`)

// linkCheck explains whether the address a viewer used would play this video, and why not: which video it names, its
// signature (format, key, match, what it covers, expiry, address), and the library's website and country rules.
func (s *module) linkCheck(w http.ResponseWriter, r *http.Request, pr core.Principal) {
	var in struct {
		URL  string `json:"url"`  // the watch page, playlist or file address the viewer used, or the bare signature
		Page string `json:"page"` // the page it's embedded on
		IP   string `json:"ip"`   // the viewer's internet address
	}
	if !core.Decode(w, r, &in) {
		return
	}
	in.URL, in.Page, in.IP = strings.TrimSpace(in.URL), strings.TrimSpace(in.Page), strings.TrimSpace(in.IP)
	if in.URL == "" || len(in.URL) > core.MaxURL {
		core.RespondError(w, r, core.APIError{Status: http.StatusBadRequest, Code: "invalid_request"})
		return
	}
	if in.Page != "" && !validPage(in.Page) {
		core.RespondError(w, r, errInvalidURL)
		return
	}
	var viewer *netip.Addr
	if in.IP != "" {
		a, err := netip.ParseAddr(in.IP)
		if err != nil {
			core.WriteError(w, http.StatusBadRequest, "invalid_ip")
			return
		}
		viewer = &a
	}
	var asset db.Asset
	var access Access
	err := withPathID(s.Deps, r, pr, func(q tx, id pgtype.UUID) (err error) {
		if asset, err = q.GetAsset(r.Context(), id); err != nil {
			return err
		}
		lib, err := q.PlayerLibrary(r.Context(), id)
		access = Access{AllowedDomains: lib.AllowedDomains, BlockedDomains: lib.BlockedDomains, CountryMode: lib.CountryMode, Countries: lib.Countries}
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}

	out, sig, country, err := s.explainLink(r.Context(), asset, access, in.URL, in.Page, viewer)
	if err != nil {
		core.InternalError(w, r, err)
		return
	}
	resp := map[string]any{"data": out, "country": country, "signature": nil}
	if sig != nil {
		resp["signature"] = map[string]any{"expires_at": time.Unix(sig.exp, 0).UTC(), "key_id": sig.kid, "acl": sig.acl, "ip": sig.ip, "watermark": sig.watermark}
	}
	resp["plays"] = !slices.ContainsFunc(out, func(f linkFinding) bool { return f.State == "problem" })
	core.WriteJSON(w, http.StatusOK, resp)
}

// explainLink says whether rawURL (an address a viewer used, or a bare signature) would play asset, rule by rule.
func (s *module) explainLink(ctx context.Context, asset db.Asset, access Access, rawURL, page string, viewer *netip.Addr) (out []linkFinding, sig *signature, country string, err error) {
	out = []linkFinding{}
	add := func(kind, state, msg string) { out = append(out, linkFinding{kind, state, msg}) }
	lib, vid := asset.LibraryID.String(), asset.ID.String()
	file := "playlist.m3u8" // a watch page starts by fetching the playlist
	sigs := []string{rawURL}
	if u, err := url.Parse(rawURL); err == nil && (u.Host != "" || strings.HasPrefix(rawURL, "/")) {
		sigs = tokensIn(u.RawQuery)
		if m := videoInPath.FindStringSubmatch(strings.TrimSuffix(u.Path, "/")); m != nil {
			if m[2] != vid {
				add("video", "problem", "This address is for another video ("+m[2]+"), not this one.")
			} else if m[3] != "" {
				file = m[3]
			}
		}
	}
	switch {
	case asset.Status == "errored":
		add("video", "problem", "This video failed to process, so nothing plays. Process it again.")
	case asset.Status != "ready" && asset.Status != "complete":
		add("video", "problem", "This video is still processing.")
	case asset.DeletedAt.Valid:
		add("video", "problem", "This video is in the trash, so it doesn't play.")
	}

	path := "/" + lib + "/" + vid + "/" + file
	if len(sigs) == 0 {
		if asset.PlaybackPolicy == "signed" {
			add("signature", "problem", "This video is private, and the address has no signature (?token=…). Your server must sign each viewer's address.")
		} else {
			add("signature", "ok", "This video is public, so it plays without a signature.")
		}
	} else {
		why := ""
		for i, cand := range sigs {
			t, reason, err := s.checkSignature(ctx, asset.TenantID, cand, path, viewer)
			if err != nil {
				return nil, nil, "", err
			}
			if i == 0 || reason == "" {
				why, sig = reason, &t
			}
			if reason == "" {
				break
			}
		}
		if why != "" {
			add("signature", "problem", why)
			sig = nil
		} else {
			add("signature", "ok", "The signature is genuine and covers this video.")
			if !time.Now().Before(time.Unix(sig.exp, 0)) {
				add("expiry", "problem", "It has expired, so playback can't start. Sign each address when the page loads, not in advance.")
			} else {
				add("expiry", "ok", "It hasn't expired.")
			}
			if sig.ip != "" && viewer == nil {
				add("ip", "note", "It works only from "+sig.ip+". Viewers whose address changes (phones, VPNs) are refused.")
			}
		}
	}

	if page != "" {
		if access.WebsiteAllowed(page) != nil {
			add("page", "problem", "The library doesn't let this website show its videos. Add it under the library's Settings → Who can watch.")
		} else {
			add("page", "ok", "The library lets this website show it.")
		}
	} else if len(access.AllowedDomains) > 0 {
		add("page", "note", "The library lets only listed websites show it. Enter the page to check it.")
	}
	hasCountryRule := access.CountryMode == "deny" || len(access.Countries) > 0
	switch {
	case viewer != nil && s.Geo == nil:
		add("country", "note", "Country rules are off: this server has no country database, so every country is let in.")
	case viewer != nil:
		country = s.Geo.Country(*viewer)
		if access.CountryAllowed(s.Geo, *viewer) != nil {
			add("country", "problem", "The library doesn't let viewers in this country watch.")
		} else if hasCountryRule {
			add("country", "ok", "The library lets viewers in this country watch.")
		}
	case hasCountryRule:
		add("country", "note", "The library has country rules. Enter the viewer's IP address to check them.")
	}

	return out, sig, country, nil
}
