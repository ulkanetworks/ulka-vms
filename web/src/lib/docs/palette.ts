import type { Group } from '@/components/CommandPalette'
import { guides, headingId } from '@/lib/guides/guides'
import { METHODS, sectionId, type Spec } from '@/lib/docs/spec'

/** Everything in the docs the command palette finds: guides and their headings, operations, events and error codes. */
export function docsEntries(spec: Spec | undefined): Group[] {
  const sections = guides.flatMap((g) =>
    [...g.body.matchAll(/^#{2,3} (.+)$/gm)].map(([, h], i) => ({ value: `guide-${g.slug}-${i}`, label: h, hint: g.title, href: `/docs/guides/${g.slug}#${headingId(h)}` })),
  )
  const out: Group[] = [
    { value: 'Guides', items: guides.map((g) => ({ value: `guide-${g.slug}`, label: g.title, hint: g.group, keywords: g.summary, href: `/docs/guides/${g.slug}` })) },
    { value: 'In the guides', items: sections },
  ]
  if (!spec) return out
  out.push({
    value: 'API',
    items: Object.entries(spec.paths).flatMap(([path, ops]) =>
      METHODS.filter((m) => ops[m]).map((m) => {
        const op = ops[m], tag = op.tags?.[0] ?? ''
        return { value: `op-${op.operationId}`, label: op.summary ?? path, hint: `${m.toUpperCase()} ${path}`, keywords: `${tag} ${op['x-ulka-group'] ?? ''} ${op.operationId}`, href: `/docs/api?s=${sectionId(tag)}#${op.operationId}` }
      }),
    ),
  })
  out.push({ value: 'Webhook events', items: Object.entries(spec.webhooks ?? {}).map(([name, ops]) => ({ value: `event-${name}`, label: name, hint: ops.post?.summary, href: `/docs/api?s=events#${name}` })) })
  out.push({ value: 'Error codes', items: Object.entries(spec['x-ulka-common-errors'] ?? {}).map(([code, why]) => ({ value: `error-${code}`, label: code, keywords: why, href: '/docs/api?s=errors' })) })
  return out
}
