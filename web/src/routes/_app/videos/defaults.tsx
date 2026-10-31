import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { DeliverySettings } from '@/components/DeliverySettings'
import { Meta } from '@/components/Meta'
import { PageHeader } from '@/components/PageHeader'
import { PlayerTab, SecurityTab } from '@/components/library/Settings'
import { TranscodingTab } from '@/components/library/Transcoding'
import { Tabs, TabsList, TabsTab } from '@/components/ui/tabs'
import { useSetParams } from '@/hooks/use-set-params'

const TABS = [
  { id: 'player', label: 'Player' },
  { id: 'transcoding', label: 'Transcoding' },
  { id: 'security', label: 'Security' },
  { id: 'delivery', label: 'Delivery' },
]

export const Route = createFileRoute('/_app/videos/defaults')({
  validateSearch: (s: Record<string, unknown>) => ({ tab: typeof s.tab === 'string' ? s.tab : '' }),
  component: Page,
})

// What libraries follow until customized (player, transcoding, security), and workspace-wide delivery: a tab each.
function Page() {
  const asked = Route.useSearch().tab
  const setParams = useSetParams()
  const tab = TABS.some((t) => t.id === asked) ? asked : 'player'
  const [actions, setActions] = useState<HTMLDivElement | null>(null) // the Player tab puts Save and Reset here
  return (
    <div className="grid grid-cols-1 gap-6">
      <Meta title="Video defaults" description="The player look, video quality, security and delivery your libraries follow until you customize them." />
      <PageHeader title="Video defaults" actions={<div ref={setActions} className="flex gap-2" />} />
      <Tabs value={tab} onValueChange={(id) => setParams({ tab: id === TABS[0].id ? '' : id })}>
        <TabsList className="h-auto flex-wrap">
          {TABS.map((t) => (
            <TabsTab key={t.id} value={t.id}>
              {t.label}
            </TabsTab>
          ))}
        </TabsList>
      </Tabs>
      {tab === 'player' && <PlayerTab actions={actions} />}
      {tab === 'transcoding' && <TranscodingTab />}
      {tab === 'security' && <SecurityTab />}
      {tab === 'delivery' && <DeliverySettings />}
    </div>
  )
}
