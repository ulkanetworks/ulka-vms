import { number, size } from './format';

/** What each usage meter counts, in words. */
export const METERS: Record<string, string> = {
	video_minutes_encoded: 'Video minutes processed',
	video_minutes_stored: 'Video minutes stored (average)',
	video_delivery_bytes: 'Video delivered from this server',
	video_delivery_requests: 'Video requests',
};

/** What each meter counts, in plain words, for the ? beside it. */
export const METER_HELP: Record<string, string> = {
	video_minutes_encoded: 'Minutes of video we prepared for playing on any screen this month, counted once per upload.',
	video_minutes_stored: 'How many minutes of video you kept, averaged over the month.',
	video_delivery_bytes: 'Video data this server sent to your viewers directly.',
	video_delivery_requests: 'Pieces of video your viewers asked this server for; a video plays as many small pieces.',
};

/** A meter's quantity in its unit: bytes as sizes, minutes to one decimal, counts as counts. */
export const showUsage = (meter: string, q: number) =>
	meter.endsWith('_bytes') ? size(q) : meter.startsWith('video_minutes') ? number(Math.round(q * 10) / 10) : number(q);
