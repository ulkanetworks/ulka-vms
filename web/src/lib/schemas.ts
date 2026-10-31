import * as v from 'valibot';
import { say } from './messages';
import { rules } from './rules';

// Quick checks while typing, using the API's own limits and words (by error code), so a form says exactly what the
// API would. The API checks everything again and has the final word.
const l = () => rules.limits;
const words = (code: string) => () => say(code);

export const name = () => v.pipe(v.string(), v.trim(), v.minLength(1, words('invalid_name')), v.maxLength(l().name, words('invalid_name')));
export const optionalName = () => v.pipe(v.string(), v.trim(), v.maxLength(l().name, words('invalid_name')));

export const email = () =>
	v.pipe(v.string(), v.trim(), v.email(words('invalid_email')), v.maxLength(l().email, words('invalid_email')));

// Passwords are limited in bytes (bcrypt reads 72); every other limit counts characters, as the API does.
const bytes = (s: string) => new TextEncoder().encode(s).length;
export const newPassword = () =>
	v.pipe(v.string(), v.check((s) => bytes(s) >= l().password_min && bytes(s) <= l().password_max, words('invalid_password')));

export const currentPassword = v.pipe(v.string(), v.minLength(1, words('invalid_request')));

/** A hostname as the API's core.ValidHostname reads it: lowercase labels, at least one dot, up to 253 characters. */
export const hostnameRe = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
/** One IP address, as the API's netip.ParseAddr takes it (v4 dotted, or v6). */
export const validIP = (s: string) =>
	/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) ? s.split('.').every((n) => Number(n) <= 255) : /^[0-9a-f:.]+$/i.test(s) && s.includes(':');

export const validHostname = (s: string) => s.length <= 253 && hostnameRe.test(s);

/** A customer's own CDN address for delivery: https:// and a host name, nothing after (core.CDNURL). */
export const validCDNURL = (raw: string) => {
	const u = URL.canParse(raw.trim()) ? new URL(raw.trim()) : null;
	return !!u && u.protocol === 'https:' && validHostname(u.hostname) && !u.port && u.pathname === '/' && !u.search && !u.username;
};

const parse = (s: string) => {
	try {
		return new URL(s);
	} catch {
		return null;
	}
};

type Allow = { https?: boolean; path?: boolean; query?: boolean };
/** An address checked the way the API checks that field (code is its error): http(s) unless https, a real host, no
 * user, no fragment; a path and query only where the API takes them. */
export const address = (code: string, allow: Allow = {}) =>
	v.pipe(
		v.string(),
		v.trim(),
		v.maxLength(l().url, words(code)),
		v.check((s) => {
			const u = parse(s);
			return (
				!!u && (u.protocol === 'https:' || (!allow.https && u.protocol === 'http:')) && !u.username && !u.password && !u.hash &&
				(allow.path || u.pathname === '/') && (allow.query || !u.search) && (validHostname(u.hostname) || /^[\d.]+$|^\[/.test(u.hostname))
			);
		}, words(code)),
	);

/** A hostname the API takes (lowercased, at least one dot); empty when optional. */
export const host = (code: string, optional = false) =>
	v.pipe(v.string(), v.trim(), v.toLowerCase(), v.check((s) => (optional && s === '') || validHostname(s.replace(/\.$/, '')), words(code)));

/** Optional text up to max characters. */
export const text = (max: number, code: string) => v.pipe(v.string(), v.trim(), v.maxLength(max, words(code)));

/** First error per field, keyed by field name, for Field's error prop. */
export const problemsOf = (issues: v.BaseIssue<unknown>[]) =>
	Object.fromEntries(issues.map((i) => [String(i.path?.[0]?.key), i.message]));

/** Checks `data` against `schema` and returns the first problem per field, or {} when it is fine. */
export const check = <S extends v.GenericSchema>(schema: S, data: unknown): Record<string, string> => {
	const r = v.safeParse(schema, data);
	return r.success ? {} : problemsOf(r.issues);
};

export { words };
