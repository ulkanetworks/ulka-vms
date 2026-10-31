package e2e

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/riverqueue/river"

	"github.com/ulkanetworks/ulka-vms/app"
	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/usage"
	"github.com/ulkanetworks/ulka-vms/video"
)

func TestImportFromURL(t *testing.T) {
	h := newHarness(t)

	src := filepath.Join(t.TempDir(), "in.mp4")
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-f", "lavfi", "-i", "sine=frequency=440",
		"-t", "4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", src).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v %s", err, out)
	}
	files := httptest.NewServer(http.FileServer(http.Dir(filepath.Dir(src))))
	t.Cleanup(files.Close)
	// The API refuses private addresses, and the real client refuses to dial them; this one sends any public-looking
	// name to the local file server.
	was := video.FetchClient
	video.FetchClient = &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, files.Listener.Addr().String())
	}}}
	t.Cleanup(func() { video.FetchClient = was })
	const base = "http://media.example.test"

	w, err := app.NewWorkerClient(h.pool, h.store, h.cfg, map[string]river.QueueConfig{
		"interactive": app.Queues["interactive"], "standard": app.Queues["standard"], "maintenance": {MaxWorkers: 1}}, app.Extension{})
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { w.Stop(context.Background()) })

	acct, key := h.signup("import")
	tenant := h.call(acct, "GET", "/v1/me", "", "", 200)["tenant"].(map[string]any)["id"].(string)
	c := h.client()
	for _, bad := range []string{`{"input_url":"ftp://example.com/a.mp4"}`, `{"input_url":"http://10.0.0.1/a.mp4"}`,
		`{"input_url":"https://user:pw@example.com/a.mp4"}`, `{"input_url":"https://example.com/a.mp4","upload_id":"x"}`} {
		h.call(c, "POST", "/v1/assets", key, bad, 400)
	}

	asset := h.call(c, "POST", "/v1/assets", key, `{"input_url":"`+base+`/in.mp4","passthrough":"imported","download":true,"playback_policy":"public"}`, 201)
	missing := h.call(c, "POST", "/v1/assets", key, `{"input_url":"`+base+`/nope.mp4"}`, 201)
	if asset["input_url"] != base+"/in.mp4" || asset["status"] != "waiting" {
		t.Fatalf("created: %v", asset)
	}
	status := func(a map[string]any) string {
		return h.call(c, "GET", "/v1/assets/"+a["id"].(string), key, "", 200)["status"].(string)
	}
	eventually(t, "imported video complete", func() bool { return status(asset) == "complete" })
	eventually(t, "missing file fails", func() bool { return status(missing) == "errored" })

	// Asked for at creation, the MP4 download is made from the published renditions once processing ends.
	eventually(t, "download ready", func() bool {
		return h.call(c, "GET", "/v1/assets/"+asset["id"].(string), key, "", 200)["download"] == "ready"
	})
	page := h.playPath(h.call(c, "GET", "/v1/assets/"+asset["id"].(string), key, "", 200))
	file, err := h.client().Get(h.ts.URL + page + "/download.mp4")
	if err != nil || file.StatusCode != 200 || !strings.Contains(file.Header.Get("Content-Disposition"), "imported.mp4") {
		t.Fatalf("download file: %v %v", err, file)
	}
	mp4 := filepath.Join(t.TempDir(), "d.mp4")
	body, _ := io.ReadAll(file.Body)
	os.WriteFile(mp4, body, 0o644)
	// The whole file is one line of the origin's access log, so Usage counts downloads like segments.
	eventually(t, "download metered", func() bool {
		var n struct{ Bytes int64 }
		err := core.ClickHouseQuery(t.Context(), h.cfg.ClickHouseURL, `SELECT sum(body_bytes) AS Bytes FROM origin_access_logs
			WHERE uri = {u:String} AND status = 200 FORMAT JSONEachRow`, map[string]string{"u": "/s/" + tenant + "/" + asset["id"].(string) + "/download.mp4"},
			func(b []byte) error { return json.Unmarshal(b, &n) })
		return err == nil && n.Bytes == int64(len(body))
	})
	// Resuming: a range answers 206 with just that part.
	req, _ := http.NewRequest("GET", h.ts.URL+page+"/download.mp4", nil)
	req.Header.Set("Range", "bytes=0-9")
	if part, err := h.client().Do(req); err != nil || part.StatusCode != http.StatusPartialContent || part.Header.Get("Content-Length") != "10" {
		t.Fatalf("ranged download: %v %v", err, part)
	}
	probe, err := exec.Command("ffprobe", "-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "csv=p=0", mp4).Output()
	if err != nil || !strings.Contains(string(probe), "video") || !strings.Contains(string(probe), "audio") || !strings.Contains(string(probe), "4.0") {
		t.Fatalf("download isn't the 4 s video with sound: %v %s", err, probe)
	}

	// Captions: SRT in, WebVTT out, listed in the master playlist for every quality.
	srt := "1\n00:00:01,000 --> 00:00:02,000\nHello\n"
	h.call(c, "POST", "/v1/assets/"+asset["id"].(string)+"/captions?language=xx-&name=Bad", key, srt, 400)
	h.call(c, "POST", "/v1/assets/"+asset["id"].(string)+"/captions?language=en&name=English", key, "no timings here", 400)
	capt := h.call(c, "POST", "/v1/assets/"+asset["id"].(string)+"/captions?language=en&name=English", key, srt, 201)
	fetch := func(path string) string {
		res, err := h.client().Get(h.ts.URL + path)
		if err != nil || res.StatusCode != 200 {
			t.Fatalf("GET %s: %v %v", path, err, res)
		}
		b, _ := io.ReadAll(res.Body)
		return string(b)
	}
	master := fetch(page + "/playlist.m3u8")
	if !strings.Contains(master, `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en"`) || !strings.Contains(master, `SUBTITLES="subs"`) {
		t.Fatalf("master without captions:\n%s", master)
	}
	track := fetch(page + "/captions_" + capt["id"].(string) + ".m3u8")
	vttPath := page + "/captions/" + capt["id"].(string) + ".vtt"
	if !strings.Contains(track, "\ncaptions/"+capt["id"].(string)+".vtt\n") {
		t.Fatalf("caption playlist:\n%s", track)
	}
	if vtt := fetch(vttPath); !strings.HasPrefix(vtt, "WEBVTT") || !strings.Contains(vtt, "00:00:01.000 --> 00:00:02.000") {
		t.Fatalf("caption file:\n%s", vtt)
	}
	h.call(c, "DELETE", "/v1/assets/"+asset["id"].(string)+"/captions/"+capt["id"].(string), key, "", 204)
	if strings.Contains(fetch(page+"/playlist.m3u8"), "SUBTITLES") {
		t.Fatal("deleted captions still listed")
	}
	// At most 20 tracks per video, checked in the same statement that adds one.
	for i := range 20 {
		h.call(c, "POST", "/v1/assets/"+asset["id"].(string)+"/captions?language=en&name=Track"+strconv.Itoa(i), key, srt, 201)
	}
	h.call(c, "POST", "/v1/assets/"+asset["id"].(string)+"/captions?language=en&name=One+too+many", key, srt, 409)
	if n := len(h.call(c, "GET", "/v1/assets/"+asset["id"].(string)+"/captions", key, "", 200)["data"].([]any)); n != 20 {
		t.Fatalf("%d captions, want 20", n)
	}

	// Turned off, the file goes and the address says so.
	h.call(c, "DELETE", "/v1/assets/"+asset["id"].(string)+"/download", key, "", 204)
	h.call(h.client(), "GET", page+"/download.mp4", "", "", 404)
	// Asked for later, on a finished video, it's rebuilt from what's published.
	if d := h.call(c, "POST", "/v1/assets/"+asset["id"].(string)+"/download", key, "", 202)["download"]; d != "preparing" {
		t.Fatalf("requested download: %v", d)
	}
	eventually(t, "download rebuilt", func() bool {
		return h.call(c, "GET", "/v1/assets/"+asset["id"].(string), key, "", 200)["download"] == "ready"
	})
	h.call(c, "POST", "/v1/assets/"+missing["id"].(string)+"/download", key, "", 409) // a failed video has nothing to download
	if code := h.call(c, "GET", "/v1/assets/"+missing["id"].(string), key, "", 200)["error_code"]; code != "input_unreachable" {
		t.Fatalf("missing file: error %v", code)
	}

	// Under a minute stored must still read back (it once came out as an integer and failed).
	if st := h.call(c, "GET", "/v1/video/stats", key, "", 200); fmt.Sprintf("%.3f", st["minutes"]) != "0.067" {
		t.Fatalf("stats: %v", st)
	}

	// Stored minutes: 4 seconds of video, spread over the month's hours, recorded for this hour.
	if _, err := w.Insert(t.Context(), usage.StorageMeterArgs{}, nil); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	month := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	want := fmt.Sprintf("%.4f", 4.0/60/month.AddDate(0, 1, 0).Sub(month).Hours())
	eventually(t, "stored minutes metered", func() bool {
		for _, r := range h.call(c, "GET", "/v1/usage", key, "", 200)["totals"].([]any) {
			if m := r.(map[string]any); m["meter"] == "video_minutes_stored" {
				return fmt.Sprintf("%.4f", m["quantity"].(float64)) == want
			}
		}
		return false
	})
	_ = os.Remove(src)
}
