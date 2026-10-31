import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Ellipsis, Pencil, Trash2 } from "@/components/icons";
import { api, ApiError } from "@/lib/api";
import { useGo } from "@/components/AppLink";
import { Facts } from "@/components/Facts";
import { LoadMore } from "@/components/LoadMore";
import { Meta } from "@/components/Meta";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/Section";
import { StatusBadge } from "@/components/StatusBadge";
import { NotFound, Unavailable } from "@/components/ErrorPage";
import { Timeline, type TimelineTone } from "@/components/Timeline";
import { WebhookForm, type Endpoint } from "@/components/WebhookForm";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ago, dt, when } from "@/lib/format";
import { message } from "@/lib/messages";
import { refresh, useGet, usePages, useWhile } from "@/lib/query";
import { can, rules } from "@/lib/rules";
import { useMe } from "@/lib/session";
import { toast } from "@/lib/toast";
import { useCrumb } from "@/lib/crumb";

export const Route = createFileRoute("/_app/webhooks/$id")({ component: Page });

type Delivery = { id: string; event: string; status: "pending" | "retrying" | "done" | "failed"; status_code: number | null; attempts: number; failure: string; created_at: string; attempted_at: string | null; next_attempt_at: string | null };

const clock = dt(undefined, { timeStyle: "short" });
const OUTCOME: Record<string, TimelineTone> = { done: "success", failed: "danger", retrying: "warning", pending: "neutral" };

/** What was sent to one address, newest first by day, with a way to send a failed one again. */
function Deliveries({ endpoint, canRetry }: { endpoint: string; canRetry: boolean }) {
  const path = `/v1/webhook-endpoints/${endpoint}/deliveries`;
  const list = usePages<Delivery>(path, 10);
  const [sending, setSending] = useState("");
  useWhile(!!list.rows?.some((d) => d.status === "pending" || d.status === "retrying"), path, 4000);
  async function retry(id: string) {
    setSending(id);
    try {
      await api("POST", `${path}/${id}/retry`);
      toast("Sending it again.");
      await refresh(path);
    } catch (err) {
      toast(message(err), "danger");
    } finally {
      setSending("");
    }
  }
  return (
    <div className="grid gap-3">
      {list.error ? (
        <p className="text-sm text-destructive">{message(list.error)}</p>
      ) : !list.rows ? (
        <Skeleton className="h-16 w-full" aria-label="Loading deliveries" />
      ) : list.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing has been sent to this address yet. Messages appear here as videos and distributions change.</p>
      ) : (
        <>
          <Timeline
            byDay
            items={list.rows.map((d) => ({
              key: d.id,
              at: d.created_at,
              tone: OUTCOME[d.status] ?? "neutral",
              title: rules.webhook_events.find((e) => e.type === d.event)?.words ?? d.event,
              time: <span title={when(d.created_at)}>{clock.format(new Date(d.created_at))}</span>,
              children: (
                <>
                  <span className={d.status === "failed" ? "text-destructive" : "text-muted-foreground"}>
                    {d.status === "done" && `Delivered ${ago(d.attempted_at ?? d.created_at)}${d.status_code ? ` (your address answered ${d.status_code})` : ""}`}
                    {d.status === "pending" && "Waiting to be sent."}
                    {d.status === "retrying" && `${d.failure} Will try again ${d.next_attempt_at && Date.parse(d.next_attempt_at) - Date.now() > 45_000 ? ago(d.next_attempt_at) : "in a moment"}.`}
                    {d.status === "failed" && (d.failure || "We stopped trying.")}
                  </span>
                  {d.status === "failed" && canRetry && (
                    <span>
                      <Button size="xs" variant="outline" disabled={sending === d.id} onClick={() => void retry(d.id)}>
                        {sending === d.id ? "Sending…" : "Send again"}
                      </Button>
                    </span>
                  )}
                </>
              ),
            }))}
          />
          <LoadMore more={!!list.hasMore} loading={list.loadingMore} onClick={list.more} />
        </>
      )}
    </div>
  );
}

function Page() {
  const { id } = Route.useParams();
  const go = useGo();
  const me = useMe();
  const path = `/v1/webhook-endpoints/${id}`;
  const q = useGet<Endpoint>(path);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  useCrumb(q.data ? q.data.name || q.data.url : "");
  if (q.error) return q.error instanceof ApiError && q.error.status === 404 ? <NotFound /> : <Unavailable error={q.error} />;
  const ep = q.data;
  if (!ep) return null; // the shell shows the diamond until this has arrived
  const write = can(me, "webhooks:write");

  async function act(method: string, body: unknown, done: string) {
    setBusy(true);
    try {
      await api(method, path, body);
      toast(done);
      await refresh("/v1/webhook-endpoints");
      return true;
    } catch (err) {
      toast(message(err), "danger");
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Meta title={ep.name || "Webhook"} description="A webhook address: the events it gets and what was sent to it." />
      <PageHeader
        title={<span className="flex min-w-0 items-center gap-3"><span className="truncate">{ep.name || ep.url}</span><StatusBadge variant={ep.enabled ? "success" : "secondary"}>{ep.enabled ? "On" : "Off"}</StatusBadge></span>}
        actions={write && (
          <>
            <Switch checked={ep.enabled} disabled={busy} aria-label={ep.enabled ? "Switch off" : "Switch on"} onCheckedChange={(on) => void act("PATCH", { enabled: on }, on ? "Switched on. It gets messages again." : "Switched off. It gets no messages until you switch it on.")} />
            <Menu>
              <MenuTrigger render={<Button variant="outline" size="icon" aria-label="Webhook actions" />}><Ellipsis /></MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => setEditing(true)}><Pencil />Edit</MenuItem>
                <MenuItem variant="destructive" onClick={() => setRemoving(true)}><Trash2 />Remove</MenuItem>
              </MenuPopup>
            </Menu>
          </>
        )}
      />
      {editing && <WebhookForm open onOpenChange={(o) => !o && setEditing(false)} editing={ep} onCreated={() => {}} />}
      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this address?</AlertDialogTitle>
            <AlertDialogDescription>{ep.url} will stop getting messages about your videos and distributions.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Keep</AlertDialogClose>
            <AlertDialogClose render={<Button variant="destructive" onClick={() => void act("DELETE", undefined, "The address was removed. It will get no more messages from us.").then((ok) => ok && go("/webhooks"))} />}>Remove</AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <Section title="Details">
        <Facts
          rows={[
            ["Address", ep.url],
            ["Events", ep.events.length ? ep.events.map((t) => rules.webhook_events.find((e) => e.type === t)?.words ?? t).join(", ") : "All events"],
            ["Added", when(ep.created_at)],
          ]}
        />
      </Section>
      <Section title="Deliveries" description="What was sent to this address, newest first.">
        <Deliveries endpoint={ep.id} canRetry={write} />
      </Section>
    </div>
  );
}
