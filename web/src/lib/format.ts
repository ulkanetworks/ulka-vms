// All display formatting goes through Intl.

const two = new Intl.NumberFormat('en', { minimumIntegerDigits: 2, useGrouping: false });
let zone = '';

/** The time zone times are shown in: a person's choice (an IANA name, UTC or GMT), or '' for the browser's own. */
export function setZone(z: string | null | undefined) {
	zone = z ?? '';
}

/** A date formatter that follows the chosen time zone; cheap to call at render. */
export function dt(locale: string | undefined, options: Intl.DateTimeFormatOptions) {
	const made = new Map<string, Intl.DateTimeFormat>();
	return {
		format(d: Date | number) {
			let f = made.get(zone);
			if (!f) made.set(zone, (f = new Intl.DateTimeFormat(locale, zone ? { timeZone: zone, ...options } : options)));
			return f.format(d);
		}
	};
}

/** Chart axis labels: hours up to a week of buckets, days beyond (the API's bucket rule). */
export const hourly = dt('en', { weekday: 'short', hour: 'numeric' })
export const daily = dt('en', { day: 'numeric', month: 'short' })

const date = dt('en', { dateStyle: 'medium', timeStyle: 'short' });
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const percent = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 0 });
const bytes = (unit: string) =>
	new Intl.NumberFormat('en', { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 1 });

/** Video timecode, hours:minutes:seconds. */
export function timecode(seconds: number | null): string {
	if (seconds === null) return '--:--:--';
	const s = Math.round(seconds);
	return `${two.format(Math.floor(s / 3600))}:${two.format(Math.floor(s / 60) % 60)}:${two.format(s % 60)}`;
}

export function when(iso: string): string {
	return date.format(new Date(iso));
}

// Relative time in the largest sensible unit: "just now", "5 minutes ago", "yesterday", "3 weeks ago", "last year".
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
	['year', 365 * 86400],
	['month', 30 * 86400],
	['week', 7 * 86400],
	['day', 86400],
	['hour', 3600],
	['minute', 60]
];

export function ago(iso: string): string {
	const secs = (new Date(iso).getTime() - Date.now()) / 1000;
	if (Math.abs(secs) < 45) return 'just now';
	for (const [unit, size] of UNITS) if (Math.abs(secs) >= size) return relative.format(Math.round(secs / size), unit);
	return relative.format(Math.round(secs / 60), 'minute');
}

export function share(done: number, total: number): string {
	return percent.format(total ? done / total : 0);
}

/** Bytes in the largest unit that keeps a whole number in front: 0 B, 950 kB, 1.3 GB, 2.4 TB. */
export function size(n: number): string {
	for (const [unit, b] of [
		['petabyte', 1e15],
		['terabyte', 1e12],
		['gigabyte', 1e9],
		['megabyte', 1e6],
		['kilobyte', 1e3]
	] as const)
		if (Math.abs(n) >= b) return bytes(unit).format(n / b);
	return `${count.format(n)} B`;
}

/** Bytes exactly, for the hover over a short size: "1,304,090,112 bytes". */
export function exactSize(n: number): string {
	return `${count.format(n)} ${n === 1 ? 'byte' : 'bytes'}`;
}

const short = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** A count, short: 950, 31.5K, 1.3M. */
export function compact(n: number): string {
	return short.format(n);
}

const rate = (unit: string) => new Intl.NumberFormat('en', { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 1 });
const secs = new Intl.NumberFormat('en', { style: 'unit', unit: 'second', unitDisplay: 'short', maximumFractionDigits: 1 });
const count = new Intl.NumberFormat('en');

/** Bits per second, as kb/s or Mb/s. */
export function bitrate(bps: number): string {
	return bps >= 1e6 ? rate('megabit-per-second').format(bps / 1e6) : rate('kilobit-per-second').format(bps / 1e3);
}

/** A duration in seconds, short. */
export function seconds(s: number): string {
	return secs.format(s);
}

export function number(n: number): string {
	return count.format(n);
}

/** A repeating interval in seconds, in the largest whole unit: 1 minute, 15 minutes, 1 hour, 1 day. */
export function interval(s: number): string {
	const [n, u] = s % 86400 === 0 ? [s / 86400, 'day'] : s % 3600 === 0 ? [s / 3600, 'hour'] : [s / 60, 'minute'];
	return new Intl.NumberFormat(undefined, { style: 'unit', unit: u as string, unitDisplay: 'long' }).format(n as number);
}

/** A browser's user agent as a person names it: "Chrome on macOS". */
export function device(ua: string): string {
	const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
	const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
	return [browser, os].filter(Boolean).join(' on ') || 'Unknown device';
}

const unitOf = (unit: string) => new Intl.NumberFormat('en', { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 0 });

/** Time left as "7 sec", "3 min" or "2 hr", rounded up. */
export function remaining(s: number): string {
	if (s < 60) return unitOf('second').format(Math.max(1, Math.ceil(s)));
	if (s < 3600) return unitOf('minute').format(Math.ceil(s / 60));
	return unitOf('hour').format(Math.ceil(s / 3600));
}

const dayCount = new Intl.NumberFormat('en', { style: 'unit', unit: 'day', unitDisplay: 'long' });

/** Whole days until a moment, as people say it: "83 days left", "Ends today", "Ended yesterday". */
export function daysLeft(iso: string): { days: number; text: string } {
	const ms = new Date(iso).getTime() - Date.now();
	const days = Math.floor(ms / 86_400_000);
	if (days > 0) return { days, text: `${dayCount.format(days)} left` };
	if (ms > 0) return { days: 0, text: 'Ends today' };
	return { days, text: `Ended ${relative.format(Math.min(days, -1), 'day')}` };
}
