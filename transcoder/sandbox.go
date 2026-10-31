package transcoder

import (
	"context"
	"os"
	"os/exec"
	"strconv"

	"github.com/ulkanetworks/ulka-vms/core"
)

// An uploaded file is hostile until proven otherwise. ffmpeg and ffprobe run with an empty environment (no database
// password, storage keys or seal key to read), no core dumps, and caps on CPU time and file size, so a file that
// crashes or loops the decoder costs one job, not the node.
// ponytail: no network or filesystem isolation (that needs root, namespaces or a container); add when workers run untrusted at scale.
const (
	sandboxCPUSeconds = 8 * int(core.JobTimeout/1e9) // eight threads busy for the whole job timeout
	sandboxFileBlocks = 8 << 21                      // 8 GiB, in the 512-byte blocks `ulimit -f` counts
)

// sandboxed builds the command: sh applies the limits, then replaces itself with the program.
func sandboxed(ctx context.Context, program string, args ...string) *exec.Cmd {
	script := `ulimit -c 0; ulimit -t "$1"; ulimit -f "$2"; shift 2; exec "$@"`
	argv := append([]string{"-c", script, "sh", strconv.Itoa(sandboxCPUSeconds), strconv.Itoa(sandboxFileBlocks), program}, args...)
	cmd := exec.CommandContext(ctx, "sh", argv...)
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "TMPDIR=" + os.TempDir()}
	return cmd
}

// Only plain media files and plain network reads: a playlist, concat list or other "container" that names further
// inputs is how a crafted upload makes ffmpeg read this machine's files or call its internal addresses.
var untrustedInput = []string{
	"-protocol_whitelist", "http,https,tcp,tls,crypto",
	"-format_whitelist", "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpegts,flv,mpeg,asf,ogg,mxf,gxf",
}

// fromUpload is `-i url` for something a customer uploaded.
func fromUpload(url string) []string { return append(append([]string{}, untrustedInput...), "-i", url) }
