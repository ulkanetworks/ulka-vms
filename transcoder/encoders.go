package transcoder

import (
	"os/exec"
	"slices"
	"strings"
)

// Encoders is the video formats this machine's ffmpeg can produce: h264, hevc, av1. Empty without ffmpeg.
func Encoders() []string {
	out, err := exec.Command("ffmpeg", "-hide_banner", "-encoders").Output()
	if err != nil {
		return []string{}
	}
	return videoEncoders(out)
}

// videoEncoders reads `ffmpeg -encoders` output for the video formats it can produce, sorted.
func videoEncoders(out []byte) []string {
	found := []string{}
	for _, line := range strings.Split(string(out), "\n") {
		// Encoder lines read " V..... libx264   ...": a video flag, then the name.
		fields := strings.Fields(line)
		if len(fields) < 2 || !strings.HasPrefix(fields[0], "V") {
			continue
		}
		for format, prefixes := range videoFormats {
			if !slices.Contains(found, format) && slices.ContainsFunc(prefixes, func(p string) bool { return strings.HasPrefix(fields[1], p) }) {
				found = append(found, format)
			}
		}
	}
	slices.Sort(found)
	return found
}

// videoFormats maps a format to the ffmpeg encoder names that produce it, software or hardware.
var videoFormats = map[string][]string{"h264": {"libx264", "h264_"}, "hevc": {"libx265", "hevc_"}, "av1": {"libsvtav1", "libaom-av1", "librav1e", "av1_"}}
