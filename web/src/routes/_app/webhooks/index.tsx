import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronDown, CircleCheck, Copy, Ellipsis, Pencil, Plus, Trash2, Webhook } from '@/components/icons'
import { Switch } from '@/components/ui/switch'
import { WebhookForm, eventGroups, type Endpoint } from '@/components/WebhookForm'
import { api } from "@/lib/api";
import { Timeline } from "@/components/Timeline";
import { Code } from "@/components/Code";
import { useGo } from '@/components/AppLink'
import { Help } from '@/components/Help'
import { Meta } from "@/components/Meta";
import { PageHeader } from '@/components/PageHeader'
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogClose, AlertDialogPopup, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from "@/components/ui/button";
import {
  Frame,
  FramePanel,
  FrameDescription,
  FrameHeader,
  FrameTitle,
} from "@/components/ui/frame";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle, EmptyMedia } from "@/components/ui/empty";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "@/components/ui/preview-card";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { ago, when } from "@/lib/format";
import { message } from "@/lib/messages";
import { copy } from "@/lib/copy";
import { toast } from "@/lib/toast";
import { rules } from "@/lib/rules";
import { dropRows, refresh, usePager } from "@/lib/query";
import { DataTable, type Column } from '@/components/DataTable'
import { ListFilters } from '@/components/ListFilters'

export const Route = createFileRoute("/_app/webhooks/")({
  validateSearch: (s: Record<string, unknown>) => (typeof s.q === "string" && s.q ? { q: s.q } : {}),
  component: Page,
});



const sample = `import { createHmac, timingSafeEqual } from 'node:crypto';

// header: the Ulka-Signature header; body: the raw request body, unparsed.
function fromUlka(header, body, secret) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // older than 5 minutes: a replay
  const want = createHmac('sha256', secret).update(t + '.' + body).digest('hex');
  return v1?.length === want.length && timingSafeEqual(Buffer.from(v1), Buffer.from(want));
}`;

const columns = (busy: boolean, edit: (ep: Endpoint) => void, remove: (ep: Endpoint) => void, toggle: (ep: Endpoint, on: boolean) => void): Column<Endpoint>[] => [
  {
    id: 'endpoint',
    header: 'Address',
    cell: ({ row: { original: ep } }) => (
      <div className="grid gap-1 whitespace-normal">
        <span className="font-medium">{ep.name || 'Webhook'}</span>
        <span className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{ep.url}</span>
      </div>
    ),
  },
  { id: 'events', header: 'Events', cell: ({ row: { original: ep } }) => (ep.events.length ? `${ep.events.length} chosen` : 'All events') },
  {
    id: 'on',
    header: 'On',
    cell: ({ row: { original: ep } }) => <Switch checked={ep.enabled} disabled={busy} aria-label={`${ep.enabled ? 'Switch off' : 'Switch on'} ${ep.name || ep.url}`} onCheckedChange={(on) => toggle(ep, on)} />,
  },
  { id: 'added', header: 'Added', cell: ({ row: { original: ep } }) => <span className="text-muted-foreground" title={when(ep.created_at)}>{ago(ep.created_at)}</span> },
  {
    id: 'actions',
    header: () => <span className="sr-only">Actions</span>,
    cell: ({ row: { original: ep } }) => (
      <Menu>
        <MenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${ep.name || ep.url}`} disabled={busy} />}>
          <Ellipsis />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={() => edit(ep)}>
            <Pencil />
            Edit…
          </MenuItem>
          <MenuItem variant="destructive" onClick={() => remove(ep)}>
            <Trash2 />
            Remove…
          </MenuItem>
        </MenuPopup>
      </Menu>
    ),
  },
];

function Page() {
  const { q = "" } = Route.useSearch();
  const list = usePager<Endpoint>(q ? `/v1/webhook-endpoints?q=${encodeURIComponent(q)}` : "/v1/webhook-endpoints");
  const [form, setForm] = useState<{ editing: Endpoint | null } | null>(null);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<Endpoint | null>(null);
  const go = useGo();

  const load = () => refresh("/v1/webhook-endpoints");

  async function toggle(ep: Endpoint, enabled: boolean) {
    setBusy(true);
    try {
      await api("PATCH", `/v1/webhook-endpoints/${ep.id}`, { enabled });
      toast(enabled ? "Switched on. It gets messages again." : "Switched off. It gets no messages until you switch it on.");
      await load();
    } catch (err) {
      toast(message(err), "danger");
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    setBusy(true);
    dropRows("/v1/webhook-endpoints", [id]);
    try {
      await api("DELETE", `/v1/webhook-endpoints/${id}`);
      toast("The address was removed. It will get no more messages from us.");
      await load();
    } catch (err) {
      toast(message(err), "danger");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6">
      <Meta
        title="Webhooks"
        description="Get a message sent to your own website the moment a video is ready, a CDN change is live, or something fails."
      />
      <PageHeader title="Webhooks" actions={<>
        <Help label="What is a webhook?">Ulka VMS sends a message to a web address you choose whenever something happens to a video, so your own app never has to keep asking. Most people don't need this; add one only if you want your app to react automatically.</Help>
        <ListFilters search="Search by address" />
          
          <Button onClick={() => setForm({ editing: null })}><Plus />Add</Button>
      </>} />

      {form && <WebhookForm key={form.editing?.id ?? "new"} open onOpenChange={(o) => !o && setForm(null)} editing={form.editing} onCreated={setSecret} />}

      <AlertDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this address?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.url} will stop getting messages about your videos and
              distributions. Your app won't be told when something finishes or fails.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Keep</AlertDialogClose>
            <AlertDialogClose render={<Button
              variant="destructive"
              onClick={() => removing && remove(removing.id)} />}>
              Remove address
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      {secret && (
        <Alert variant="success">
          <CircleCheck />
          <AlertTitle>Address added</AlertTitle>
          <AlertDescription className="grid w-full gap-3">
            <p>Your app checks our messages are genuine with this secret password.</p>
            <InputGroup>
              <InputGroupInput readOnly value={secret} aria-label="Secret password" className="font-mono" />
              <InputGroupAddon align="inline-end">
                <Button type="button" size="icon-sm" variant="ghost" aria-label="Copy secret password" onClick={() => void copy(secret, "Secret password")}>
                  <Copy />
                </Button>
              </InputGroupAddon>
            </InputGroup>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs">Shown only now. If you lose it, remove the address and add it again.</span>
              <Button size="sm" variant="outline" onClick={() => setSecret("")}>Done</Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      <DataTable
        columns={columns(busy, (ep) => setForm({ editing: ep }), setRemoving, toggle)}
        pager={list}
        narrowed={!!q}
        rowKey={(ep) => ep.id}
        onRowClick={(ep) => go(`/webhooks/${ep.id}`)}
        rowLabel={(ep) => `Open ${ep.name || ep.url}`}
        empty={
          <Frame><FramePanel><Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon"><Webhook /></EmptyMedia>
              <EmptyTitle>No addresses yet</EmptyTitle>
              <EmptyDescription>Add the address of your app to hear about videos and CDN changes the moment they happen.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={() => setForm({ editing: null })}><Plus />Add</Button>
            </EmptyContent>
          </Empty></FramePanel></Frame>
        }
      />

      <Collapsible>
        <Frame>
          <FrameHeader className="flex-row items-start justify-between gap-4">
            <div>
              <FrameTitle>What we tell you about</FrameTitle>
              <FrameDescription>
                {rules.webhook_events.length} things we can tell you about. An address gets every one, or only those it chose. You only need this list if you are building the receiving side.
              </FrameDescription>
            </div>
            <CollapsibleTrigger render={<Button variant="outline" size="sm" className="shrink-0" />}>
              Show the list <ChevronDown />
            </CollapsibleTrigger>
          </FrameHeader>
          <CollapsiblePanel>
            <FramePanel className="grid gap-6 sm:grid-cols-2">
              {eventGroups().map((g) => (
                <section key={g.label} className="grid content-start gap-3">
                  <h3 className="text-sm font-medium">{g.label}</h3>
                  <Timeline items={g.events.map((e) => ({ key: e.type, tone: e.type.includes("fail") || e.type.includes("error") || e.type.endsWith("high") ? "danger" : "neutral", title: e.words, children: <code className="text-xs text-muted-foreground">{e.type}</code> }))} />
                </section>
              ))}
            </FramePanel>
          </CollapsiblePanel>
        </Frame>
      </Collapsible>

      <Frame>
        <FrameHeader>
          <FrameTitle>
            Check a message came from Ulka VMS{" "}
            <PreviewCard>
              <PreviewCardTrigger render={<button type="button" aria-label="What is this?" className="text-muted-foreground" />}>?</PreviewCardTrigger>
              <PreviewCardPopup>
                Anyone could post to your address pretending to be us. Each of
                our messages carries a stamp (a signature) made with your
                secret password; only we and you can make a matching one.
              </PreviewCardPopup>
            </PreviewCard>
          </FrameTitle>
          <FrameDescription>
            For developers: this code, run on your server, tells a real
            message from a fake one. Hand it to whoever builds your app.
          </FrameDescription>
        </FrameHeader>
        <FramePanel className="grid gap-3">
          <Code label="Your server (Node.js)" code={sample} />
          <p className="text-sm text-muted-foreground">
            Reply "OK" (any 2xx code) within 15 seconds. Anything else is retried
            for 24 hours, so the same message can arrive twice and messages can
            arrive out of order: use each one's <code>id</code> to skip
            duplicates. The stamp is in the <code>Ulka-Signature</code>{" "}
            header.
          </p>
        </FramePanel>
      </Frame>
    </div>
  );
}
