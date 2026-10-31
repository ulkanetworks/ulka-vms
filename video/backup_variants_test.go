package video

import (
	"strings"
	"testing"
)

// Behind a CDN every quality appears twice, the second from the origin; everything else in the playlist stays.
func TestWithBackupVariants(t *testing.T) {
	master := "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"a.m3u8\"\n" +
		"#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n/v/p/360p.m3u8?token=t\n" +
		"#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\n/v/p/720p.m3u8?token=t\n"
	got := string(withBackupVariants([]byte(master), func(u string) string { return u + queryJoin(u) + "via=origin" }))
	want := "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"a.m3u8\"\n" +
		"#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n/v/p/360p.m3u8?token=t\n" +
		"#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n/v/p/360p.m3u8?token=t&via=origin\n" +
		"#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\n/v/p/720p.m3u8?token=t\n" +
		"#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\n/v/p/720p.m3u8?token=t&via=origin\n"
	if got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
	// Without a token the parameter starts the query.
	if got := string(withBackupVariants([]byte("#EXT-X-STREAM-INF:BANDWIDTH=1\n/v/p/360p.m3u8\n"), func(u string) string { return u + queryJoin(u) + "via=origin" })); !strings.HasSuffix(got, "/v/p/360p.m3u8?via=origin\n") {
		t.Errorf("no token: %q", got)
	}
}
