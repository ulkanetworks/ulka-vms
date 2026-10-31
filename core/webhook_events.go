package core

// WebhookEvent is one kind of event ulka-vms sends to webhook endpoints, with its words for people.
type WebhookEvent struct {
	Type  string `json:"type"`
	Words string `json:"words"`
}

// WebhookEvents is every event an endpoint can receive or choose. Published at GET /v1/meta; a new core.Emit type
// goes here too (TestWebhookEventsMatchSpec keeps it and api/openapi.json's webhooks in step).
// An application built on ulka-vms appends its own at start.
var WebhookEvents = []WebhookEvent{
	{"asset.created", "A video was created"},
	{"upload.completed", "Its file finished uploading"},
	{"job.started", "Processing started"},
	{"asset.ready", "It can be played (720p and 360p)"},
	{"asset.complete", "Every quality is ready"},
	{"job.completed", "Processing finished"},
	{"asset.errored", "It couldn't be processed"},
	{"job.failed", "Processing failed"},
	{"upload.errored", "The upload didn't finish in time"},
	{"asset.download_ready", "Its MP4 download is ready"},
	{"asset.download_failed", "Its MP4 download couldn't be made"},
	{"asset.deleted", "It was deleted"},
}

// IsWebhookEvent reports whether t is one of WebhookEvents.
func IsWebhookEvent(t string) bool {
	for _, e := range WebhookEvents {
		if e.Type == t {
			return true
		}
	}
	return false
}
