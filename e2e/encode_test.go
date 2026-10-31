package e2e

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	videodb "github.com/ulkanetworks/ulka-vms/video/db"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"

	"github.com/ulkanetworks/ulka-vms/app"
	"github.com/ulkanetworks/ulka-vms/core"
)

func TestEncodeLadder(t *testing.T) {
	h := newHarness(t)
	// Packaging runs on the River queue; the pieces are encoded by the harness's node.
	w, err := app.NewWorkerClient(h.pool, h.store, h.cfg, map[string]river.QueueConfig{"interactive": app.Queues["interactive"], "standard": app.Queues["standard"]}, app.Extension{})
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { w.Stop(context.Background()) })

	video := filepath.Join(t.TempDir(), "in.mp4")
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25", "-f", "lavfi", "-i", "sine=frequency=440",
		"-t", "150", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", video).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v %s", err, out)
	}
	body, _ := os.ReadFile(video)

	_, key := h.signup("enc")
	c := h.client()
	up := h.call(c, "POST", "/v1/uploads", key, "", 201)
	h.sendUpload(up, body, http.StatusOK)
	asset := h.call(c, "POST", "/v1/assets", key, `{"upload_id":"`+up["id"].(string)+`"}`, 201)
	path := "/v1/assets/" + asset["id"].(string)

	// Hold the full lane back (as if its pieces were waiting out a retry), so the asset must become playable before
	// the full ladder exists.
	tenantID := h.call(c, "GET", "/v1/me", key, "", 200)["tenant"].(map[string]any)["id"].(string)
	var tid pgtype.UUID
	tid.Scan(tenantID)
	holdFull := func(until string) (held int64) {
		t.Helper()
		if err := core.InTenant(t.Context(), h.pool, tid, func(q core.TenantTx) error {
			tag, err := q.Tx.Exec(t.Context(), "UPDATE encode_tasks SET leased_until = "+until+" WHERE lane = 'full' AND node_id IS NULL AND NOT done")
			held = tag.RowsAffected()
			return err
		}); err != nil {
			t.Fatal(err)
		}
		return held
	}
	for held, begun := int64(0), time.Now(); held < 3; time.Sleep(50 * time.Millisecond) { // the three pieces appear once the video is read
		if time.Since(begun) > time.Minute {
			t.Fatal("the full lane's pieces never appeared")
		}
		held = holdFull("now() + interval '1 hour'")
	}
	start := time.Now()
	waitStatus := func(want string) {
		t.Helper()
		for time.Since(start) < 3*time.Minute {
			if asset = h.call(c, "GET", path, key, "", 200); asset["status"] == want || asset["status"] == "errored" {
				break
			}
			time.Sleep(500 * time.Millisecond)
		}
		if asset["status"] != want {
			t.Fatalf("want %s, asset: %v", want, asset)
		}
	}
	prefix := tenantID + "/" + asset["id"].(string) + "/"
	get := func(name string) []byte {
		t.Helper()
		obj, err := h.store.S3.GetObject(t.Context(), &s3.GetObjectInput{Bucket: &h.store.Bucket, Key: aws.String(prefix + name)})
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		defer obj.Body.Close()
		b, _ := io.ReadAll(obj.Body)
		return b
	}

	waitStatus("ready")
	t.Logf("playable after %s", time.Since(start).Round(time.Second))
	if master := string(get("master.m3u8")); !strings.Contains(master, "720p.m3u8") || !strings.Contains(master, "360p.m3u8") || strings.Contains(master, "480p") {
		t.Fatalf("ready master should hold the fast rungs only:\n%s", master)
	}
	// The full lane is held back, so it has done nothing.
	if fast, full := progressOf(asset, "fast"), progressOf(asset, "full"); fast != [2]float64{3, 3} || full != [2]float64{0, 3} {
		t.Fatalf("ready asset progress: fast %v, full %v", fast, full)
	}
	holdFull("NULL")
	waitStatus("complete")
	t.Logf("150 s source complete after %s", time.Since(start).Round(time.Second))
	var names []string
	for _, r := range asset["renditions"].([]any) {
		names = append(names, r.(map[string]any)["name"].(string))
	}
	if strings.Join(names, ",") != "720p,480p,360p" {
		t.Fatalf("renditions: %v", asset["renditions"])
	}
	for lane, total := range map[string]float64{"fast": 3, "full": 3, "audio": 1} {
		if p := progressOf(asset, lane); p != [2]float64{total, total} {
			t.Fatalf("%s progress %v, want %v done of %v", lane, p, total, total)
		}
	}
	if listed := h.call(c, "GET", "/v1/assets", key, "", 200)["data"].([]any)[0].(map[string]any); len(listed["renditions"].([]any)) != 3 || progressOf(listed, "full") != [2]float64{3, 3} {
		t.Fatalf("listed asset: %v", listed)
	}
	if job := h.call(c, "GET", path+"/jobs", key, "", 200)["data"].([]any)[0].(map[string]any); job["status"] != "completed" {
		t.Fatalf("ingest job: %v", job)
	}
	// The completed asset is recorded once as encoded minutes: a 150 s source is 2.5.
	if totals := h.call(c, "GET", "/v1/usage", key, "", 200)["totals"].([]any); len(totals) != 1 ||
		totals[0].(map[string]any)["meter"] != "video_minutes_encoded" || totals[0].(map[string]any)["quantity"].(float64) != 2.5 {
		t.Fatalf("usage after encode: %v", totals)
	}

	master := string(get("master.m3u8"))
	for _, want := range []string{"720p.m3u8", "480p.m3u8", "360p.m3u8", "audio.m3u8", "RESOLUTION=1280x720", "RESOLUTION=854x480", "RESOLUTION=640x360"} {
		if !strings.Contains(master, want) {
			t.Fatalf("master lacks %s:\n%s", want, master)
		}
	}
	if strings.Contains(master, "1080p") {
		t.Fatalf("1080p rung taller than a 720p source:\n%s", master)
	}

	// Play the published 720p rendition through ffmpeg's own HLS decryption, key served from a local file.
	var assetID pgtype.UUID
	assetID.Scan(asset["id"])
	var aesKey []byte
	if err := core.InTenant(t.Context(), h.pool, tid, func(q core.TenantTx) error {
		w, err := videodb.New(q.Tx).GetAssetWork(t.Context(), assetID)
		if err != nil {
			return err
		}
		aesKey, err = core.Open(testSealKey, w.EncryptionKey) // stored sealed, never as it is
		return err
	}); err != nil {
		t.Fatal(err)
	}
	playlist := string(get("720p.m3u8"))
	keyURI := `URI="/keys/` + asset["id"].(string) + `"`
	if !strings.Contains(playlist, keyURI) || strings.Count(playlist, "#EXT-X-KEY:METHOD=AES-128") != 1 {
		t.Fatalf("key tag:\n%s", playlist)
	}
	local := t.TempDir()
	os.MkdirAll(filepath.Join(local, "720p"), 0o755)
	os.WriteFile(filepath.Join(local, "key.bin"), aesKey, 0o644)
	os.WriteFile(filepath.Join(local, "720p.m3u8"), []byte(strings.Replace(playlist, keyURI, `URI="key.bin"`, 1)), 0o644)
	os.WriteFile(filepath.Join(local, "720p", "init.mp4"), get("720p/init.mp4"), 0o644)
	for _, line := range strings.Split(playlist, "\n") {
		if line != "" && !strings.HasPrefix(line, "#") {
			if seg := get(line); bytes.HasPrefix(seg[4:], []byte("styp")) {
				t.Fatalf("%s is not encrypted", line)
			} else {
				os.WriteFile(filepath.Join(local, line), seg, 0o644)
			}
		}
	}
	stats, _ := exec.Command("ffmpeg", "-hide_banner", "-allowed_extensions", "ALL", "-i", filepath.Join(local, "720p.m3u8"), "-f", "null", "-").CombinedOutput()
	frames := regexp.MustCompile(`frame=\s*(\d+)`).FindAllStringSubmatch(string(stats), -1)
	if len(frames) == 0 {
		t.Fatalf("ffmpeg could not decode the 720p rendition:\n%s", stats)
	}
	if n, _ := strconv.Atoi(frames[len(frames)-1][1]); n != 150*25 {
		t.Fatalf("decrypted 720p decodes to %d frames, want %d", n, 150*25)
	}

	var packages int
	if err := h.pool.QueryRow(t.Context(), "SELECT count(*) FROM river.river_job WHERE kind = 'package' AND state = 'completed' AND args->>'asset_id' = $1", asset["id"]).Scan(&packages); err != nil || packages != 2 {
		t.Fatalf("want a ready and a complete package job, got %d (err %v)", packages, err)
	}
	left, err := h.store.S3.ListObjectsV2(t.Context(), &s3.ListObjectsV2Input{Bucket: &h.store.Bucket, Prefix: aws.String(prefix + "work/")})
	if err != nil || len(left.Contents) != 0 {
		t.Fatalf("chunk files left behind: %d (err %v)", len(left.Contents), err)
	}
}

// progressOf reads an asset view's progress for one lane as {done, total}.
func progressOf(asset map[string]any, lane string) [2]float64 {
	p := asset["progress"].(map[string]any)[lane].(map[string]any)
	return [2]float64{p["done"].(float64), p["total"].(float64)}
}
