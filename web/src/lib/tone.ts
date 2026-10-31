type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

/** A status tone for StatusBadge (kept as a function so call distributions read the same as before). */
export const badgeVariant = (tone: Tone | undefined): string => tone ?? 'neutral'
