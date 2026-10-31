package transcoder

import (
	"slices"
	"strings"
)

// Quality is how hard the encoder works for each video: sharper and smaller costs more time.
type Quality string

const (
	QualityFast     Quality = "fast"     // publishes soonest, a little softer or larger
	QualityBalanced Quality = "balanced" // the default; measured below
	QualityHigh     Quality = "high"     // sharpest for its size, takes about twice as long
)

// x264 maps a quality to the encoder's speed setting and constant rate factor (lower is sharper and larger).
// Balanced was measured 2026-09-30 (VMAF 97.4 at 1080p on a 60 s sample); the other two have not been measured yet.
func (q Quality) x264() (preset, crf string) {
	switch q {
	case QualityFast:
		return "veryfast", "24"
	case QualityHigh:
		return "medium", "21"
	}
	return x264Preset, x264CRF
}

func (q Quality) Valid() bool { return q == QualityFast || q == QualityBalanced || q == QualityHigh }

// Heights are the picture heights a ladder may hold, smallest first. Nothing taller is offered: 4K costs four times a
// 1080p encode in CPU and storage, and nothing shorter than 240 is readable.
var Heights = []int{240, 360, 480, 720, 1080}

// Preset is what a library asks of the transcoder: which rungs to make and how carefully.
type Preset struct {
	Heights []int   `json:"heights"`
	Quality Quality `json:"quality"`
}

// Clean sorts and de-duplicates the heights and reports whether the preset is usable.
func (p *Preset) Clean() bool {
	slices.Sort(p.Heights)
	p.Heights = slices.Compact(p.Heights)
	return len(p.Heights) > 0 && p.Quality.Valid() && !slices.ContainsFunc(p.Heights, func(h int) bool { return !slices.Contains(Heights, h) })
}

// Template is a ready-made preset with a name and a plain description of who it is for.
type Template struct {
	Key         string `json:"key"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Preset
}

// DefaultTemplate is what a library uses until it chooses another.
const DefaultTemplate = "balanced"

var templates = []Template{
	{"balanced", "Balanced", "Sharp on every screen at a sensible size. A good choice for most videos.", Preset{[]int{360, 480, 720, 1080}, QualityBalanced}},
	{"best", "Best quality", "The sharpest picture. Takes about twice as long to prepare and uses more storage and bandwidth.", Preset{[]int{360, 480, 720, 1080}, QualityHigh}},
	{"courses", "Courses and slides", "Keeps text and slides crisp without paying for full HD. Good for lessons and talks.", Preset{[]int{360, 480, 720}, QualityHigh}},
	{"saver", "Data saver", "Smaller files and lighter streaming. Good when many viewers are on slow or paid connections.", Preset{[]int{240, 360, 480, 720}, QualityFast}},
	{"mobile", "Mobile first", "Small screens only, ready quickly. No HD, so it is cheap to store and play.", Preset{[]int{240, 360, 480}, QualityBalanced}},
}

// Templates lists the ready-made presets.
func Templates() []Template { return slices.Clone(templates) }

// TemplateByKey finds a template; the key is case-insensitive.
func TemplateByKey(key string) (Template, bool) {
	i := slices.IndexFunc(templates, func(t Template) bool { return t.Key == strings.ToLower(key) })
	if i < 0 {
		return Template{}, false
	}
	return templates[i], true
}
