import { useCallback } from 'react'

// A table whose first column (what the row is) and last column (its ⋯ menu) stay put while the rest scrolls
// sideways. Body cells already have the card's solid background; header cells get the frame's, made solid.
// The divider runs down the body only; the menu column is as narrow as its button. Written out in full for Tailwind.
export const stickyFirst =
  '[&_tr>:first-child]:sticky [&_tr>:first-child]:left-0 [&_tr>:first-child]:z-10 [&_tr>:first-child]:bg-clip-border [&_th:first-child]:[background:linear-gradient(color-mix(in_oklab,var(--muted)_72%,transparent),color-mix(in_oklab,var(--muted)_72%,transparent)),var(--background)] data-overflow:[&_td:first-child]:shadow-[inset_-1px_0_0_var(--border)] [&_tr>:first-child]:max-w-80 [&_td:first-child]:overflow-hidden'
export const stickyLast =
  '[&_tr>:last-child]:sticky [&_tr>:last-child]:right-0 [&_tr>:last-child]:z-10 [&_tr>:last-child]:bg-clip-border [&_th:last-child]:[background:linear-gradient(color-mix(in_oklab,var(--muted)_72%,transparent),color-mix(in_oklab,var(--muted)_72%,transparent)),var(--background)] data-overflow:[&_td:last-child]:shadow-[inset_1px_0_0_var(--border)] [&_tr>:last-child]:w-px'

/** Ref for the table's Frame: marks the table data-overflow while it is wider than its box, so the dividers show. */
export function useOverflow() {
  return useCallback((frame: HTMLElement | null) => {
    const box = frame?.querySelector<HTMLElement>('[data-slot=table-container]')
    const table = box?.querySelector('table')
    if (!box || !table) return
    const check = () => table.toggleAttribute('data-overflow', box.scrollWidth > box.clientWidth + 1)
    const watch = new ResizeObserver(check)
    watch.observe(box)
    watch.observe(table)
    check()
    return () => watch.disconnect()
  }, [])
}
