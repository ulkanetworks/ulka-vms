import { useMemo } from 'react'
import { ChevronDown } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Section } from '@/components/Section'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { Code } from '@/components/Code'
import { messageFor } from '@/lib/messages'
import { Fields } from './Fields'
import { Text } from './Text'
import { StatusBadge } from '@/components/StatusBadge'
import { resolve, sample, type Operation as Op, type Parameter, type Schema, type Spec } from '@/lib/docs/spec'

const METHOD = { get: 'default', post: 'secondary', put: 'outline', patch: 'outline', delete: 'destructive' } as const
const H4 = 'flex items-center gap-2 text-sm font-medium'

export function Operation({ spec, method, path, op, open = false }: { spec: Spec; method: string; path: string; op: Op; open?: boolean }) {
  const params = (op.parameters ?? []).map((p) => resolve<Parameter>(spec, p))
  // Parameters shown like body fields, with where each one goes.
  const paramSchema: Schema = {
    properties: Object.fromEntries(params.map((p) => [p.name, { ...(p.schema ?? {}), description: p.description }])),
    required: params.filter((p) => p.required || p.in === 'path').map((p) => p.name),
  }
  const where = Object.fromEntries(params.map((p) => [p.name, p.in]))
  const body = op.requestBody?.content?.['application/json']?.schema
  const success = Object.entries(op.responses ?? {})
    .filter(([status]) => status.startsWith('2'))
    .map(([status, r]) => {
      const res = resolve(spec, r)
      return { status, text: res.description, schema: res.content?.['application/json']?.schema }
    })
  const isPublic = Array.isArray(op.security) && op.security.length === 0
  const perm = op['x-ulka-permission']

  // A request to copy: path parameters marked, the key header when one is needed, and a body of the required
  // fields plus any with an example (so "send one of these" bodies aren't empty).
  const curl = useMemo(() => {
    const url = `${location.origin}${path.replace(/\{(\w+)\}/g, (_, n) => `<${n}>`)}`
    const lines = [`curl${method === 'get' ? '' : ` -X ${method.toUpperCase()}`} ${url}`]
    if (!isPublic) lines.push(`-H "Authorization: Bearer $ULKA_KEY"`)
    if (body) {
      const req = resolve(spec, body).required ?? []
      const json = sample(spec, body, (k, f) => req.includes(k) || resolve(spec, f).example !== undefined)
      lines.push(`-H "Content-Type: application/json"`, `-d '${JSON.stringify(json)}'`)
    }
    return lines.join(' \\\n  ')
  }, [spec, method, path, isPublic, body])
  const reply = success.find((s) => s.schema)

  return (
    <Collapsible id={op.operationId} defaultOpen={open} className="scroll-mt-20">
      <Section flush>
        <CollapsibleTrigger className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left">
          <Badge variant={METHOD[method as keyof typeof METHOD] ?? 'outline'} className="font-mono">{method.toUpperCase()}</Badge>
          <code className="text-sm font-medium break-words">{path}</code>
          <span className="ml-auto text-sm text-muted-foreground">{op.summary}</span>
          <ChevronDown />
        </CollapsibleTrigger>

        <CollapsiblePanel>
          <div className="grid gap-6 border-t px-4 py-4">
            {op.description && <div className="grid gap-2 text-sm"><Text text={op.description} /></div>}
            {(isPublic || perm) && (
              <div>
                <StatusBadge variant={isPublic || perm === 'any' ? 'secondary' : 'default'}>{isPublic ? 'No key needed' : perm === 'any' ? 'Any API key' : `Needs ${perm}`}</StatusBadge>
              </div>
            )}

            {params.length > 0 && (
              <section className="grid gap-2">
                <h4 className={H4}>Parameters</h4>
                <Fields spec={spec} schema={paramSchema} where={where} />
              </section>
            )}

            {body && (
              <section className="grid gap-2">
                <h4 className={H4}>Request body <StatusBadge variant="outline">JSON</StatusBadge></h4>
                <Fields spec={spec} schema={body} />
              </section>
            )}

            {success.map((s) => (
              <section key={s.status} className="grid gap-2">
                <h4 className={H4}>Response <Badge>{s.status}</Badge></h4>
                {s.schema ? <Fields spec={spec} schema={s.schema} /> : <p className="text-sm text-muted-foreground">{s.text ?? 'No body.'}</p>}
              </section>
            ))}

            {!!op['x-ulka-errors']?.length && (
              <section className="grid gap-2">
                <h4 className={H4}>Errors</h4>
                <Table>
                  <TableBody>
                    {op['x-ulka-errors'].map((code) => (
                      <TableRow key={code}>
                        <TableCell><code className="font-medium">{code}</code></TableCell>
                        <TableCell className="whitespace-normal text-muted-foreground">{messageFor(code) ?? ''}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </section>
            )}

            <Code label="Request" code={curl} />
            {reply?.schema && <Code label={`Response ${reply.status}`} code={JSON.stringify(sample(spec, reply.schema), null, 2)} />}
          </div>
        </CollapsiblePanel>
      </Section>
    </Collapsible>
  )
}
