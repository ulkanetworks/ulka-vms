package transcoder

import (
	"fmt"
	"math"
	"slices"
)

const (
	gopSeconds = 2
	chunkGOPs  = 30 // 60 s chunks
)

// The fast lane is encoded first so a video plays as soon as possible; the full lane follows.
var ladder = []struct {
	name            string
	short, maxrateK int
	lane            string
}{
	{"1080p", 1080, 5000, "full"},
	{"720p", 720, 3000, "fast"},
	{"480p", 480, 1200, "full"},
	{"360p", 360, 800, "fast"},
	{"240p", 240, 400, "fast"},
}

type Rung struct {
	Name     string `json:"name"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	MaxrateK int    `json:"maxrate_k"`
	Lane     string `json:"lane"`
	// Half encodes at half the source's frame rate: below 720p a frame rate above 30 costs double for nothing seen.
	Half bool `json:"half,omitempty"`
}

// Plan is fixed at probe time and stored on the asset, so every retry encodes the same thing.
type Plan struct {
	FPS         string `json:"fps"`
	GOP         int    `json:"gop"`
	ChunkFrames int    `json:"chunk_frames"`
	Chunks      int    `json:"chunks"`
	Deinterlace bool   `json:"deinterlace"`
	Audio       bool   `json:"audio"`
	Rungs       []Rung `json:"rungs"`
	// Recorded at probe time so a later change to the defaults never misreports how this video was made.
	Encoder *Encoder `json:"encoder,omitempty"`
}

type Encoder struct {
	Codec          string `json:"codec"`
	Preset         string `json:"preset"`
	CRF            string `json:"crf"`
	Profile        string `json:"profile"`
	SegmentSeconds int    `json:"segment_seconds"`
	Encryption     string `json:"encryption"`
}

// MakePlan decides the encode for src from the library's preset: the preset's heights that the source can fill, and
// at least one rung. A ladder with no fast rung makes its smallest one fast, so the video still plays early.
func MakePlan(src Source, preset Preset) Plan {
	num, den := src.FPSNum, src.FPSDen
	for num > 60*den {
		den *= 2
	}
	fps := float64(num) / float64(den)
	gop := max(1, int(math.Round(fps*gopSeconds)))
	p := Plan{FPS: fmt.Sprintf("%d/%d", num, den), GOP: gop, ChunkFrames: gop * chunkGOPs, Chunks: 1, Deinterlace: src.Interlaced, Audio: src.HasAudio}
	if src.Duration >= 120 {
		// A tail shorter than one GOP folds into the chunk before it.
		p.Chunks = max(1, (int(math.Ceil(src.Duration*fps))+p.ChunkFrames-gop)/p.ChunkFrames)
	}
	short, long := min(src.Width, src.Height), max(src.Width, src.Height)
	landscape := src.Width >= src.Height
	for _, r := range ladder {
		if r.short <= short && slices.Contains(preset.Heights, r.short) {
			p.Rungs = append(p.Rungs, scaledRung(r.name, r.short, r.maxrateK, r.lane, short, long, landscape))
		}
	}
	if len(p.Rungs) == 0 {
		// A source smaller than every chosen height still gets its own size, at the smallest chosen rung's rate.
		last := ladder[len(ladder)-1]
		for _, r := range ladder {
			if slices.Contains(preset.Heights, r.short) {
				last = r
			}
		}
		p.Rungs = []Rung{scaledRung(last.name, Even(float64(short)), last.maxrateK, last.lane, short, long, landscape)}
	}
	if len(p.Lane("fast")) == 0 {
		p.Rungs[len(p.Rungs)-1].Lane = "fast"
	}
	// Halving keeps every keyframe only when the GOP has an even number of frames.
	if fps > 30 && gop%2 == 0 {
		for i := range p.Rungs {
			p.Rungs[i].Half = min(p.Rungs[i].Width, p.Rungs[i].Height) < 720
		}
	}
	return p
}

func scaledRung(name string, short, maxrateK int, lane string, srcShort, srcLong int, landscape bool) Rung {
	long := Even(float64(srcLong) * float64(short) / float64(srcShort))
	if landscape {
		return Rung{Name: name, Width: long, Height: short, MaxrateK: maxrateK, Lane: lane}
	}
	return Rung{Name: name, Width: short, Height: long, MaxrateK: maxrateK, Lane: lane}
}

func Even(x float64) int { return max(2, int(math.Round(x/2))*2) }

func (p Plan) Lane(lane string) []Rung {
	var out []Rung
	for _, r := range p.Rungs {
		if r.Lane == lane {
			out = append(out, r)
		}
	}
	return out
}

type Task struct {
	Lane  string
	Chunk int
}

func (p Plan) Tasks() []Task {
	var out []Task
	for _, lane := range []string{"fast", "full"} {
		if len(p.Lane(lane)) > 0 {
			for i := range p.Chunks {
				out = append(out, Task{lane, i})
			}
		}
	}
	if p.Audio {
		out = append(out, Task{"audio", 0})
	}
	return out
}

type Source struct {
	Duration       float64
	Width, Height  int
	FPSNum, FPSDen int
	Interlaced     bool
	HasAudio       bool
	Raw            []byte
}
