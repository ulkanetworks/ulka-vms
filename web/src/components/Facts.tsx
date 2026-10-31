import type { ReactNode } from 'react'
import { Activity, ArrowRight, Building2, CalendarCheck, Cpu, Eye, FileVideo, Gauge, Globe, HardDrive, Image, Info, KeyRound, Link, List, Lock, Network, Rocket, Server, ShieldCheck, TriangleAlert, Users, type IconComponent } from '@/components/icons'
import { CopyText } from '@/components/CopyText'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'

export type Fact = [label: string, value: ReactNode, icon?: IconComponent]

// The icon a label gets when none is given: by what the label is about.
const ICONS: [RegExp, IconComponent][] = [
  [/header/i, List],
  [/error|fail|stale/i, TriangleAlert],
  [/rules?\b/i, ShieldCheck],
  [/workspace|owner|member|people|person|user/i, Users],
  [/origin|host|address|ip\b|server|node|machine/i, Server],
  [/deploy|version|build/i, Rocket],
  [/domain|distribution|country|region|location/i, Globe],
  [/certificate|https|tls|ssl|secure|signed|key/i, Lock],
  [/security|firewall|rule|access|attack|rate/i, ShieldCheck],
  [/added|created|updated|paused|joined|started|finished|seen|signed in|ends|expires|last|when|date|time/i, CalendarCheck],
  [/image|poster|thumbnail/i, Image],
  [/video|stream|playback|caption|download|asset/i, FileVideo],
  [/redirect|rewrite/i, ArrowRight],
  [/header|log|queue|job|kind|attempt|state|status/i, List],
  [/error|fail|stale/i, TriangleAlert],
  [/cpu|core|thread/i, Cpu],
  [/disk|storage|size|memory|bytes/i, HardDrive],
  [/bandwidth|traffic|request|speed|rate|latency|time to/i, Gauge],
  [/compress|optimi|cache|speed/i, Activity],
  [/network|ping|proxy/i, Network],
  [/token|secret|password|login/i, KeyRound],
  [/link|url|path/i, Link],
  [/view|watch|play/i, Eye],
]
export const factIcon = (label: string): IconComponent => ICONS.find(([re]) => re.test(label))?.[1] ?? (label ? Info : Building2)

/** A row's label with its icon, for tables that are not plain label and value pairs. */
export function FactLabel({ label, icon, strong }: { label: string; icon?: IconComponent; strong?: boolean }) {
  const Glyph = icon ?? factIcon(label)
  return (
    <span className={`flex items-center gap-2.5 ${strong ? 'font-medium text-foreground' : ''}`}>
      <Glyph className="size-4 shrink-0 text-muted-foreground" />
      {label}
    </span>
  )
}

// Values people copy: addresses, domains, hostnames, IDs (a single token; a sentence is never copied).
const COPIED = /\b(address|domain|hostname|ip|id|slug|url|origin)\b/i

/** What a thing is, one fact a row: an icon, what it is, its value. */
export function Facts({ rows }: { rows: Fact[] }) {
  return (
    <Table>
      <TableBody>
        {rows.map(([label, value, icon]) => {
          const Glyph = icon ?? factIcon(label)
          return (
            <TableRow key={label}>
              <TableCell className="w-px text-muted-foreground">
                <span className="flex items-center gap-2.5">
                  <Glyph className="size-4 shrink-0" />
                  {label}
                </span>
              </TableCell>
              <TableCell className="whitespace-normal wrap-anywhere leading-snug">{typeof value === 'string' && value && !/\s/.test(value) && COPIED.test(label) ? <CopyText value={value} what={label.toLowerCase()} wrap /> : value}</TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
