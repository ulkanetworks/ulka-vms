type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

/** A job's state as a colour. */
export const jobTone: Record<string, Tone> = {
	available: 'neutral',
	scheduled: 'neutral',
	pending: 'neutral',
	running: 'warning',
	retryable: 'warning',
	completed: 'success',
	cancelled: 'neutral',
	discarded: 'danger'
};

/** A job's state as a person says it. */
export const jobWords: Record<string, string> = {
	available: 'Waiting',
	scheduled: 'Waiting to run',
	pending: 'Waiting',
	running: 'Running',
	retryable: 'Failed, will retry',
	completed: 'Done',
	cancelled: 'Cancelled',
	discarded: 'Failed'
};

/** A job's kind as a person says it. */
export const jobKinds: Record<string, string> = {
	fetch_input: 'Import from URL',
	probe: 'Read source',
	encode_chunk: 'Encode chunk',
	encode_audio: 'Encode audio',
	encode_sweep: 'Check encodes',
	package: 'Package for streaming',
	storyboard: 'Storyboard',
	make_download: 'Make MP4 download',
	delete_prefix: 'Delete files',
	event: 'Fan out event',
	webhook: 'Webhook delivery',
	log_meter: 'Meter delivery',
	storage_meter: 'Meter storage',
	cleanup: 'Hourly cleanup'
};
