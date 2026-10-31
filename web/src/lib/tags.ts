import { isCountry } from '@/lib/countries'
import * as v from 'valibot';
import { validHostname, words } from './schemas';

// Format checks for TagInput entries. The API applies its rules again (which ranges it accepts, how many)
// and its error codes have the final word.
export type Check = (raw: string) => { value: string } | { problem: string };

const check =
	(schema: v.GenericSchema<string, string>): Check =>
	(raw) => {
		const r = v.safeParse(schema, raw);
		return r.success ? { value: r.output } : { problem: r.issues[0].message };
	};

/** An address, or a range like 198.51.100.0/24: /1 to /32 for IPv4, /1 to /128 for IPv6 (the API refuses /0). code is
 * the API's error for the form it's in. */
export const ipRange = (code: string) =>
	check(
		v.pipe(
			v.string(),
			v.toLowerCase(),
			v.check((s) => {
				const [addr, bits, extra] = s.split('/');
				const max = addr.includes(':') ? 128 : 32;
				return extra === undefined && v.is(v.pipe(v.string(), v.ip()), addr) && (bits === undefined || (/^\d{1,3}$/.test(bits) && +bits >= 1 && +bits <= max));
			}, words(code))
		)
	);
export const ipOrRange = ipRange('invalid_cidr');
/** A path prefix like /admin/: starts with /, no query, fragment or spaces (the API's ValidPath). */
export const pathPrefix = check(v.pipe(v.string(), v.trim(), v.check((p) => p.startsWith('/') && p.length <= 1024 && !/[?#\s\0]/.test(p), 'Start the path with /, like /admin/. No spaces or ?.')));

export const country = check(v.pipe(v.string(), v.toUpperCase(), v.check(isCountry, words('invalid_country'))));

export const hostname = check(
	v.pipe(
		v.string(),
		v.toLowerCase(),
		v.transform((s) => s.replace(/^https?:\/\//, '').replace(/\/.*$/, '')),
		v.check(validHostname, words('invalid_referer'))
	)
);

// Headers the CDN owns, as the API's reservedHeaders: they can't be set or removed.
const reserved = ['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'x-forwarded-for', 'set-cookie'];
export const validHeaderName = (s: string) => /^[A-Za-z0-9!#$%&'*+.^_|~-]{1,64}$/.test(s) && !reserved.includes(s.toLowerCase());
// Removing from responses refuses only what the visitor needs to read the answer, as the API's framingHeaders.
export const removableHeaderName = (s: string) => /^[A-Za-z0-9!#$%&'*+.^_|~-]{1,64}$/.test(s) && !['content-length', 'transfer-encoding', 'connection'].includes(s.toLowerCase());
export const httpMethod = check(v.pipe(v.string(), v.trim(), v.toUpperCase(), v.picklist(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], words('invalid_cors_methods'))));
export const headerName = check(v.pipe(v.string(), v.trim(), v.check(validHeaderName, words('invalid_header'))));
export const removableHeader = check(v.pipe(v.string(), v.trim(), v.check(removableHeaderName, words('invalid_header'))));

/** A file type like jpg; a leading dot and capitals are dropped. */
export const fileType = check(v.pipe(v.string(), v.toLowerCase(), v.transform((s) => s.replace(/^\./, '')), v.regex(/^[a-z0-9]{1,10}$/, words('invalid_rules'))));

/** A query parameter or cookie name. */
export const token = check(v.pipe(v.string(), v.regex(/^[A-Za-z0-9_.\-[\]]{1,64}$/, words('invalid_rules'))));

/** A video's tag: up to 40 characters, no commas. */
export const videoTag = check(v.pipe(v.string(), v.trim(), v.minLength(1, words('invalid_tags')), v.maxLength(40, words('invalid_tags')), v.regex(/^[^,]*$/, words('invalid_tags'))));
