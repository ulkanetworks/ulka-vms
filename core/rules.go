package core

// Field rules the API enforces. GET /v1/meta publishes them, so the console checks forms against these same numbers.
// Text limits count characters (utf8.RuneCountInString), except passwords, which bcrypt reads in bytes.
const (
	MaxDescription     = 500     // a library's description
	MaxName            = 100     // names of workspaces, people, keys, libraries
	MaxEmail           = 254     // email addresses
	MinPassword        = 12      // passwords, in bytes
	MaxPassword        = 72      // bcrypt reads no further
	MaxReference       = 255     // a video's reference (passthrough)
	MaxURL             = 2048    // webhook addresses, CDN addresses, paths
	MaxKeyIPs          = 50      // addresses on one API key
	MaxSearch          = 100     // a list search
	MaxCaptionBytes    = 1 << 20 // one caption file, WebVTT or SRT
	MaxCaptions        = 20      // caption tracks on one video
	MaxAllowedWebsites = 50      // websites a library's player may be shown on
	MaxVideoText       = 2000    // a video's description
	MaxTags            = 20      // tags on one video
	MaxTag             = 40      // one tag
	MaxMetadata        = 20      // key/value pairs on one video
	MaxMetaKey         = 40      // one metadata key
	MaxMetaValue       = 500     // one metadata value
	MaxChapters        = 100     // chapters in one video
)

// FieldRules is the rules /v1/meta publishes, by the names the console reads. An application built on ulka-vms adds
// its own at start.
var FieldRules = map[string]int{
	"name": MaxName, "email": MaxEmail, "password_min": MinPassword, "password_max": MaxPassword, "reference": MaxReference,
	"url": MaxURL, "key_ips": MaxKeyIPs, "search": MaxSearch, "description": MaxDescription, "caption_bytes": MaxCaptionBytes,
	"captions": MaxCaptions, "allowed_websites": MaxAllowedWebsites, "video_text": MaxVideoText, "tags": MaxTags, "tag": MaxTag,
	"metadata": MaxMetadata, "meta_key": MaxMetaKey, "meta_value": MaxMetaValue, "chapters": MaxChapters,
}
