// The address as the browser loaded it, kept before the router re-encodes it: a signature's HMAC covers its exact
// text. main.tsx imports this first, so it runs before the router starts.
export const loadedPath = location.pathname
/** ?token= exactly as written (the API also takes it URL-encoded once more). */
export const loadedToken = location.search.match(/[?&]token=([^&]*)/)?.[1] ?? ''
