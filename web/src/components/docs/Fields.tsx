import { Text } from './Text'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { refName, resolve, typeLabel, type Schema, type Spec } from '@/lib/docs/spec'

function limits(s: Schema): string {
  const out: string[] = []
  if (s.enum) out.push(`one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`)
  if (s.minimum !== undefined && s.maximum !== undefined) out.push(`${s.minimum} to ${s.maximum}`)
  else if (s.minimum !== undefined) out.push(`at least ${s.minimum}`)
  else if (s.maximum !== undefined) out.push(`up to ${s.maximum}`)
  if (s.maxLength) out.push(`up to ${s.maxLength} characters`)
  if (s.maxItems) out.push(`up to ${s.maxItems} items`)
  if (s.default !== undefined) out.push(`default ${JSON.stringify(s.default)}`)
  return out.join(' · ')
}

// An object's fields as a table: name, type, whether required, limits and meaning. Nested objects open in place.
// `where` marks a parameter's place (path, query, header).
export function Fields({ spec, schema, depth = 0, where }: { spec: Spec; schema: Schema; depth?: number; where?: Record<string, string> }) {
  const shape = resolve(spec, schema)
  const inner = (s: Schema): Schema | null => {
    const r = resolve(spec, s.items ? s.items : s)
    return r.properties && depth < 4 ? r : null
  }
  if (!shape.properties) {
    return (
      <p className="text-sm text-muted-foreground">
        {typeLabel(spec, schema)}
        {shape.description ? ` · ${shape.description}` : ''}
      </p>
    )
  }
  return (
    <Table>
      <TableBody>
        {Object.entries(shape.properties).map(([name, raw]) => {
          const f = resolve(spec, raw)
          const sub = inner(raw)
          const lim = limits(f)
          return (
            <TableRow key={name}>
              <TableCell className="align-top whitespace-normal">
                <code className="font-medium">{name}</code>
                <div className="mt-1 flex flex-wrap gap-1">
                  <Badge variant="outline">{typeLabel(spec, raw)}</Badge>
                  {where?.[name] && <Badge variant="secondary">{where[name]}</Badge>}
                  {shape.required?.includes(name) && <Badge>required</Badge>}
                </div>
              </TableCell>
              <TableCell className="grid gap-1 align-top whitespace-normal text-muted-foreground">
                {(f.description || raw.description) && <Text text={raw.description ?? f.description} />}
                {lim && <p>{lim}</p>}
                {f.example !== undefined && <p>Example: <code>{JSON.stringify(f.example)}</code></p>}
                {sub && (
                  <Collapsible>
                    <CollapsibleTrigger className="text-primary hover:underline">{refName(raw.items?.$ref ?? raw.$ref) || 'Fields'}</CollapsibleTrigger>
                    <CollapsiblePanel><Fields spec={spec} schema={sub} depth={depth + 1} /></CollapsiblePanel>
                  </Collapsible>
                )}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
