package transcoder

import (
	"slices"
	"strings"
	"testing"
)

func TestMakePlan(t *testing.T) {
	p := MakePlan(Source{Duration: 3725, Width: 1080, Height: 1920, FPSNum: 30000, FPSDen: 1001}, balancedPreset)
	if p.GOP != 60 || p.ChunkFrames != 1800 || p.Chunks != 62 {
		t.Fatalf("chunking: %+v", p)
	}
	if len(p.Rungs) != 4 || p.Rungs[0] != (Rung{Name: "1080p", Width: 1080, Height: 1920, MaxrateK: 5000, Lane: "full"}) || p.Rungs[3] != (Rung{Name: "360p", Width: 360, Height: 640, MaxrateK: 800, Lane: "fast"}) {
		t.Fatalf("portrait ladder: %+v", p.Rungs)
	}
	if p := MakePlan(Source{Duration: 90, Width: 320, Height: 240, FPSNum: 120, FPSDen: 1}, balancedPreset); p.FPS != "120/2" || p.GOP != 120 || p.Chunks != 1 ||
		len(p.Rungs) != 1 || p.Rungs[0] != (Rung{Name: "360p", Width: 320, Height: 240, MaxrateK: 800, Lane: "fast", Half: true}) {
		t.Fatalf("small source: %+v", p)
	}
	// 120.01 s leaves a sliver past the second chunk; it folds into that chunk.
	if p := MakePlan(Source{Duration: 120.01, Width: 1920, Height: 1080, FPSNum: 25, FPSDen: 1}, balancedPreset); p.Chunks != 2 {
		t.Fatalf("tail chunk: %+v", p)
	}
}

// Above 30 fps, rungs below 720p encode at half the rate; 720p and up keep it.
func TestMakePlanHalvesSmallRungs(t *testing.T) {
	halves := func(p Plan) string {
		var n []string
		for _, r := range p.Rungs {
			if r.Half {
				n = append(n, r.Name)
			}
		}
		return strings.Join(n, " ")
	}
	sixty := MakePlan(Source{Duration: 60, Width: 1920, Height: 1080, FPSNum: 60, FPSDen: 1}, balancedPreset)
	if got := halves(sixty); got != "480p 360p" || sixty.GOP != 120 {
		t.Fatalf("60 fps: halves %q, gop %d", got, sixty.GOP)
	}
	if got := halves(MakePlan(Source{Duration: 60, Width: 1920, Height: 1080, FPSNum: 30000, FPSDen: 1001}, balancedPreset)); got != "" {
		t.Fatalf("29.97 fps halves %q", got)
	}
	if got := halves(MakePlan(Source{Duration: 60, Width: 1080, Height: 1920, FPSNum: 50, FPSDen: 1}, balancedPreset)); got != "480p 360p" {
		t.Fatalf("50 fps portrait halves %q", got)
	}
}

// A library can cap quality: a 1080p source in a library limited to 720p gets no 1080p rung.
func TestMakePlanPresets(t *testing.T) {
	src := Source{Duration: 60, Width: 1920, Height: 1080, FPSNum: 25, FPSDen: 1}
	names := func(p Plan) string {
		var n []string
		for _, r := range p.Rungs {
			n = append(n, r.Name+":"+r.Lane)
		}
		return strings.Join(n, " ")
	}
	// Only the chosen heights, largest first; a ladder with no fast rung makes its smallest one fast.
	if got := names(MakePlan(src, Preset{[]int{480, 1080}, QualityBalanced})); got != "1080p:full 480p:fast" {
		t.Fatalf("1080 and 480: %s", got)
	}
	// Heights the source can't fill are dropped; a source below every choice keeps its own size.
	if got := names(MakePlan(Source{Duration: 60, Width: 640, Height: 360, FPSNum: 25, FPSDen: 1}, Preset{[]int{720, 1080}, QualityBalanced})); got != "1080p:full" && got != "720p:fast" {
		t.Fatalf("small source: %s", got)
	}
	// Presets: unknown heights or quality are refused, heights are sorted and de-duplicated.
	bad := []Preset{{nil, QualityBalanced}, {[]int{1440}, QualityBalanced}, {[]int{720}, "ultra"}}
	for _, p := range bad {
		if p.Clean() {
			t.Fatalf("%+v should be refused", p)
		}
	}
	p := Preset{[]int{720, 360, 720}, QualityHigh}
	if !p.Clean() || !slices.Equal(p.Heights, []int{360, 720}) {
		t.Fatalf("clean: %+v", p)
	}
	for _, tpl := range Templates() {
		if c := tpl.Preset; !c.Clean() {
			t.Fatalf("template %s is not a valid preset", tpl.Key)
		}
	}
}

var balancedPreset = Preset{[]int{360, 480, 720, 1080}, QualityBalanced}
