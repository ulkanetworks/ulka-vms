package e2e

import (
	"context"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ulkanetworks/ulka-vms/app"
	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/transcoder"
	videodb "github.com/ulkanetworks/ulka-vms/video/db"
)

// A 60 fps source keeps 60 fps at 720p and is encoded at 30 below it: half the frames, same keyframe moments.
func TestSmallRungsAtHalfFrameRate(t *testing.T) {
	h := newHarness(t)
	worker, err := app.NewWorkerClient(h.pool, h.store, h.cfg, app.Queues, app.Extension{})
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { worker.Stop(context.Background()) })

	video := filepath.Join(t.TempDir(), "in.mp4")
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=60", "-t", "8",
		"-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", video).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v %s", err, out)
	}
	body, _ := os.ReadFile(video)
	_, key := h.signup("fps")
	c := h.client()
	up := h.call(c, "POST", "/v1/uploads", key, "", 201)
	h.sendUpload(up, body, http.StatusOK)
	asset := h.call(c, "POST", "/v1/assets", key, `{"upload_id":"`+up["id"].(string)+`"}`, 201)
	id := asset["id"].(string)
	for start := time.Now(); asset["status"] != "complete" && time.Since(start) < time.Minute; time.Sleep(300 * time.Millisecond) {
		asset = h.call(c, "GET", "/v1/assets/"+id, key, "", 200)
	}
	if asset["status"] != "complete" {
		t.Fatalf("asset: %v", asset)
	}

	var tid, aid pgtype.UUID
	tid.Scan(h.call(c, "GET", "/v1/me", key, "", 200)["tenant"].(map[string]any)["id"].(string))
	aid.Scan(id)
	var aesKey, iv []byte
	if err := core.InTenant(t.Context(), h.pool, tid, func(q core.TenantTx) error {
		w, err := videodb.New(q.Tx).GetAssetWork(t.Context(), aid)
		if err != nil {
			return err
		}
		iv = w.EncryptionIv
		aesKey, err = core.Open(testSealKey, w.EncryptionKey)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	get := func(name string) []byte {
		t.Helper()
		obj, err := h.store.S3.GetObject(t.Context(), &s3.GetObjectInput{Bucket: &h.store.Bucket, Key: aws.String(tid.String() + "/" + id + "/" + name)})
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		defer obj.Body.Close()
		b, _ := io.ReadAll(obj.Body)
		return b
	}
	// The frames in a rendition's first piece, decrypted and joined to its start, as a player would see them.
	frames := func(rung string) int {
		t.Helper()
		seg, err := transcoder.DecryptSegment(get(rung+"/1.m4s"), aesKey, iv)
		if err != nil {
			t.Fatalf("%s: %v", rung, err)
		}
		file := filepath.Join(t.TempDir(), rung+".mp4")
		os.WriteFile(file, append(get(rung+"/init.mp4"), seg...), 0o644)
		out, err := exec.Command("ffprobe", "-v", "error", "-count_frames", "-select_streams", "v", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file).Output()
		n, _ := strconv.Atoi(strings.TrimSpace(string(out)))
		if err != nil || n == 0 {
			t.Fatalf("%s: ffprobe %v %q", rung, err, out)
		}
		return n
	}
	full, small, mid := frames("720p"), frames("360p"), frames("480p")
	if full != 2*small || full != 2*mid {
		t.Fatalf("frames in the first piece: 720p %d, 480p %d, 360p %d; want the smaller ones at half", full, mid, small)
	}
}
