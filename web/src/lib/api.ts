// One door to the API: every failure becomes an ApiError carrying the API's stable code.

export type Policy = 'public' | 'signed';
export type Rendition = { name: string; width: number; height: number; lane: 'fast' | 'full' };
/** Pieces done of total; partial is how far the ones being encoded now have got (0.5 = half a piece). */
export type LaneProgress = { done: number; total: number; partial: number };
export type AssetStatus = 'waiting' | 'processing' | 'ready' | 'complete' | 'errored';

export type Asset = {
	id: string;
	title: string;
	library_id: string;
	/** null: directly in the library's Home. */
	folder_id: string | null;
	/** Set while the video is in the trash. */
	deleted_at: string | null;
	status: AssetStatus;
	error_code: string | null;
	passthrough: string | null;
	input_url: string | null;
	download: 'preparing' | 'ready' | 'failed' | null;
	duration_seconds: number | null;
	width: number | null;
	height: number | null;
	/** Frames per second, once the video has been read. */
	frame_rate: number | null;
	/** The original file's size, once the video has been read. */
	size_bytes: number | null;
	created_at: string;
	updated_at: string;
	playback_policy: Policy;
	/** The HLS playlist on the player host; a signed video needs a signature in front of the library id. */
	playback_url: string;
	/** The watch page on the player host, for links and iframes. */
	embed_url: string;
	description: string;
	tags: string[];
	/** Your own key/value pairs, like your app's id for the video. */
	metadata: { key: string; value: string }[];
	chapters: Chapter[];
	/** The cover: the default frame, a chosen frame or an uploaded picture, with the frames offered (seconds). */
	poster: { source: 'default' | 'frame' | 'upload'; time: number | null; suggestions: number[] };
	/** Processing steps in order (received, checked, playable, complete), each with when it happened. */
	timeline: { stage: 'received' | 'checked' | 'playable' | 'complete'; state: 'done' | 'running' | 'waiting' | 'failed'; at: string | null }[];
	renditions?: Rendition[];
	progress?: { fast: LaneProgress; full: LaneProgress; audio: LaneProgress };
};

/** A part of the video, shown on the player's timeline. Times are seconds. */
export type Chapter = { title: string; start_time: number; end_time: number };

export type PlayerSettings = {
	accent: string;
	theme: 'dark' | 'light';
	logo_url: string;
	logo_link: string;
	/** Off: no controls at all, for a moving background or a page that drives the player. */
	controls: boolean;
	autoplay: boolean;
	loop: boolean;
	muted: boolean;
	speed: boolean;
	quality: boolean;
	captions: boolean;
	pip: boolean;
	fullscreen: boolean;
	/** Seconds the back and forward buttons move; 0 hides them. */
	skip: 0 | 5 | 10 | 15 | 30;
};
/** GET /v1/player/templates: controls and start for a common use; never the look. */
export type PlayerTemplate = { key: string; name: string; description: string; settings: Omit<PlayerSettings, 'accent' | 'theme' | 'logo_url' | 'logo_link'> };
export type Group = 'player' | 'transcoding' | 'security';
/** GET /v1/video/defaults: what libraries follow per group until customized. */
export type VideoDefaults = { player: PlayerSettings; preset_template: string; mp4_downloads: boolean; allowed_domains: string[]; blocked_domains: string[]; country_mode: 'allow' | 'deny'; countries: string[]; default_playback_policy: Policy };
export type Library = {
	id: string;
	name: string;
	description: string;
	is_default: boolean;
	default_playback_policy: Policy;
	/** The built-in preset new videos use, unless preset_id is set. */
	preset_template: string;
	preset_id: string | null;
	mp4_downloads: boolean;
	/** Websites allowed to embed the player (example.com or *.example.com); empty means any. */
	allowed_domains: string[];
	/** Every website but these; a library uses this or allowed_domains. */
	blocked_domains: string[];
	/** allow: everywhere but countries; deny: only countries. */
	country_mode: 'allow' | 'deny';
	countries: string[];
	/** The groups of settings this library follows from the workspace defaults. */
	inherits: Group[];
	videos: number;
	trashed: number;
	minutes: number;
	/** Size of the originals of the live videos that still have one. */
	storage_bytes: number;
	/** Live videos by state: ready is complete; processing is waiting, processing and playable-but-finishing. */
	by_status: { all: number; ready: number; processing: number; errored: number };
	created_at: string;
	updated_at: string;
};
export type Quality = 'fast' | 'balanced' | 'high';
export type Template = { key: string; name: string; description: string; heights: number[]; quality: Quality };
export type Preset = { id: string; name: string; description: string; heights: number[]; quality: Quality; updated_at: string };
/** GET /v1/libraries/{id}/transcoding */
export type Transcoding = { templates: Template[]; presets: Preset[]; active_template: string; active_preset: string | null };
export type Folder = { id: string; parent_id: string | null; name: string; /** Videos directly in it. */ videos: number; created_at: string; updated_at: string };
/** {player}/[signature/]{library}/{video}/config.json: what the watch page needs; file names are beside it. */
export type PlayerConfig = { settings: PlayerSettings; title: string; policy: Policy; status: string; duration_seconds: number; stream: string; poster: string; storyboard: string; chapters: Chapter[]; watermark: string };
/** POST /v1/signed-urls */
export type SignedURL = { signature: string; expires_at: string; playback_url: string; embed_url: string };

export type Job = {
	id: string;
	asset_id: string;
	type: string;
	status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
	error_code: string | null;
	created_at: string;
	updated_at: string;
};

export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export type Me = {
	tenant: { id: string; name: string; created_at: string };
	user?: { id: string; email: string; name: string | null; phone: string | null; locale: 'en' | 'bn'; timezone: string | null; email_verified_at: string | null; last_login_at: string | null; created_at: string };
	role?: Role;
	/** What the caller may do, e.g. "cdn:write"; the API decides, the console only shows what works. */
	permissions: string[];
	grantable_roles: Role[];
	/** Set when an Ulka admin is using the console as this person. */
	acting?: { admin_name: string; until: string; admin_url?: string };
	/** The largest file this workspace may upload, in bytes. */
	max_upload_bytes: number;
};
/** The API's rules, from GET /v1/meta: roles, what each may do, API key products and field limits. */
export type Meta = {
	roles: { id: Role; name: string; summary: string }[];
	capabilities: { what: string; roles: Role[] }[];
	products: { id: string; name: string; read: string; write: string }[];
	messages: Record<string, string>; // every code's words, from the API
	webhook_events: { type: string; words: string }[];
	/** The player host: videos are watched and streamed at {player_url}/[signature/]{library}/{video}. */
	player_url: string;
	/** Where the console is, to tell the player host apart. */
	console_url: string;
	/** The docs host: the guides, the API reference and the changelog. */
	docs_url: string;
	/** library/video the player host's home shows; "" for none. */
	player_demo: string;
	/** Whether anyone may create a workspace; closed, only invites bring people in. */
	signup_open: boolean;
	limits: Record<'name' | 'email' | 'password_min' | 'password_max' | 'reference' | 'url' | 'key_ips' | 'search' | 'description' | 'caption_bytes' | 'captions' | 'allowed_websites' | 'video_text' | 'tags' | 'tag' | 'metadata' | 'meta_key' | 'meta_value' | 'chapters', number>;
};
export type TenantSummary = { id: string; name: string; role: Role; suspended_at: string | null; joined_at: string };
export type Member = { id: string; email: string; name: string | null; role: Role; joined_at: string; can_change: boolean };
export type Invite = { id: string; email: string; role: Role; created_at: string; expires_at: string };
export type InviteLookup = { tenant_name: string; email: string; role: Role; account_exists: boolean };

export type StreamInfo = {
	codec: string;
	profile?: string;
	pixel_format?: string;
	width?: number;
	height?: number;
	frame_rate?: string;
	field_order?: string;
	color_transfer?: string;
	bit_rate?: number;
	channels?: number;
	channel_layout?: string;
	sample_rate?: number;
};

export type Technical = {
	source: { container: string; size_bytes: number; bit_rate: number; video: StreamInfo | null; audio: StreamInfo | null; stream_count: number } | null;
	plan: {
		fps: string;
		gop: number;
		chunk_frames: number;
		chunks: number;
		deinterlace: boolean;
		audio: boolean;
		rungs: { name: string; width: number; height: number; maxrate_k: number; lane: 'fast' | 'full' }[];
		encoder?: { codec: string; preset: string; crf: string; profile: string; segment_seconds: number; encryption: string };
	} | null;
	encryption_iv?: string;
	tasks: {
		lane: 'fast' | 'full' | 'audio';
		chunk: number;
		done: boolean;
		state: 'done' | 'running' | 'retrying' | 'queued' | 'failed';
		node?: string;
		attempts: number;
		progress: number;
		error?: string;
		queued_at: string;
		started_at: string | null;
		done_at: string | null;
	}[];
	pipeline: {
		id: number;
		kind: string;
		queue: string;
		state: string;
		attempt: number;
		max_attempts: number;
		lane?: string;
		chunk?: number;
		stage?: string;
		worker?: string;
		last_error?: string;
		created_at: string;
		attempted_at: string | null;
		finalized_at: string | null;
	}[];
	storage: { name: string; objects: number; bytes: number }[];
	source_deleted_at: string | null;
	timeline: Asset['timeline'];
};

// Something that needs attention, decided by the API: its kind and severity, with values the console words it from.
export type Notice = { id: string; kind: string; severity: 'danger' | 'warning' | 'info'; subject?: string; name?: string; at: string; data?: Record<string, any> };

// An error from the API: code for programs, message (the API's own words) for people.
export class ApiError extends Error {
	code: string;
	status: number;
	/** The form field a refusal is about, when the API names one. */
	field?: string;
	constructor(code: string, status: number, message = '', field?: string) {
		super(message);
		this.code = code;
		this.status = status;
		this.field = field;
	}
}

/** Set by the query cache: called after every change (success or failure) so what is on screen is read again;
 *  `gone` is the path a DELETE just removed. */
export const afterChange: { run?: (gone?: string) => void } = {};

export async function api<T = unknown>(method: string, path: string, body?: unknown, fetcher = fetch): Promise<T> {
	let gone: string | undefined;
	try {
		const out = await send<T>(method, path, body, fetcher);
		if (method === 'DELETE') gone = path;
		return out;
	} finally {
		if (method !== 'GET') afterChange.run?.(gone);
	}
}

/** A read that needs a body (an estimate): POSTed, but changes nothing, so nothing on screen is read again. */
export const postRead = <T,>(path: string, body: unknown) => send<T>('POST', path, body, fetch);

async function send<T>(method: string, path: string, body: unknown, fetcher: typeof fetch): Promise<T> {
	let res: Response;
	try {
		// A file (captions) goes as it is; anything else as JSON.
		const file = body instanceof Blob;
		res = await fetcher(path, {
			method,
			credentials: 'same-origin',
			headers: body === undefined ? undefined : { 'Content-Type': file ? body.type || 'text/plain' : 'application/json' },
			body: body === undefined ? undefined : file ? body : JSON.stringify(body)
		});
	} catch {
		throw new ApiError('network', 0);
	}
	if (res.status === 204) return undefined as T;
	const data = await res.json().catch(() => null);
	if (!res.ok) throw new ApiError(data?.error?.code ?? 'internal', res.status, data?.error?.message ?? '', data?.error?.field);
	return data as T;
}

/** An API key as its owner sees it: never the secret, only its first characters. */
export type ApiKey = { id: string; name: string; prefix: string; scopes: string[]; allowed_ips: string[]; expires_at: string | null; last_used_at: string | null; created_at: string }


export type Caption = { id: string; asset_id: string; language: string; name: string; created_at: string };

