import type { AssetStatus } from './api';

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

// Plain words for the pipeline's states; "ready" in the API means playable while higher qualities finish.
export const statusBadge: Record<AssetStatus, { tone: Tone; text: string }> = {
	waiting: { tone: 'neutral', text: 'Waiting for upload' },
	processing: { tone: 'warning', text: 'Processing' },
	ready: { tone: 'accent', text: 'Playable, finishing' },
	complete: { tone: 'success', text: 'Ready' },
	errored: { tone: 'danger', text: 'Failed' }
};
