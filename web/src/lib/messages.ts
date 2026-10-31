import { ApiError } from './api';
import { rules } from './rules';

// Words come from the API: with each error, and all of them at GET /v1/meta. The console only says what the API
// can't: that it couldn't be reached, or (before /v1/meta loaded) that something went wrong.
const unreachable = "Can't reach the server. Check your connection and try again.";
/** Said when a request failed in the browser while the server answers: something between them stopped it. */
export const blocked = "That request was stopped before it reached us, though the server is answering. A browser extension, a privacy setting or a flaky connection can do this; try again, and allow this distribution in any blocker.";
const fallback = 'Something went wrong. Try again in a minute.';

export function message(err: unknown): string {
	if (err instanceof ApiError && err.code === 'network') return unreachable;
	if (err instanceof ApiError) return err.message || rules.messages[err.code] || rules.messages.internal || fallback;
	return rules.messages.internal ?? fallback; // any other error (a TypeError, a parse error): never its own text
}

/** Why a video or job failed, from its error_code. */
export const videoProblem = (code: string | null): string =>
	(code && rules.messages[code]) || rules.messages.processing_failed || fallback;

/** The API's words for a code, for checks the console makes before asking the API. */
export const say = (code: string): string => rules.messages[code] ?? rules.messages.invalid_request ?? fallback;

/** The API's words for a code, or null; the API reference shows them beside each code. */
export const messageFor = (code: string): string | null => rules.messages[code] ?? null;
