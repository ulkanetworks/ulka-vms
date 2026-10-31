import { useEffect, useState, type ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useRouter } from "@tanstack/react-router";
import { Check, Ellipsis, LogOut, Plus, Trash2, X } from '@/components/icons'
import * as v from "valibot";
import * as schema from "@/lib/schemas";
import { api, type Member, type Invite, type Role } from "@/lib/api";
import { useGo } from "@/components/AppLink";
import { Meta } from "@/components/Meta";
import { PageHeader } from '@/components/PageHeader'
import { AlertDialog, AlertDialogClose, AlertDialogPopup, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { FormDialog, Wizard } from "@/components/Wizard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Frame, FrameDescription, FrameHeader, FrameTitle } from "@/components/ui/frame";
import {
  Menu,
  MenuPopup,
  MenuItem,
  MenuTrigger,
} from "@/components/ui/menu";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectPopup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ago, when } from "@/lib/format";
import { message } from "@/lib/messages";
import { toast } from "@/lib/toast";
import { dropRows, editRow, queryClient, refresh, usePager } from "@/lib/query";
import { can, rules } from "@/lib/rules";
import { DataTable, type Column } from '@/components/DataTable'
import { ListFilters } from '@/components/ListFilters'
import { useMe } from "@/lib/session";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/members")({
  validateSearch: (s: Record<string, unknown>) => (typeof s.q === "string" && s.q ? { q: s.q } : {}),
  component: Page,
});

const Email = schema.email();

const roleName = (r: Role) => rules.roles.find((x) => x.id === r)?.name ?? r;

type Ask = { icon: ReactNode; label: string; confirm: string; why: string; run: () => unknown };

// At module level so the page's re-renders (list refreshes) don't remount them and close an open picker or menu.
function RoleSelect({ value, label, roles, onChange, className = "w-36" }: { value: Role; label: string; roles: Role[]; onChange: (r: Role) => void; className?: string }) {
  return (
    <Select items={roles.map((r) => ({ label: roleName(r), value: r }))} value={value} onValueChange={(r) => r && onChange(r as Role)}>
      <SelectTrigger aria-label={label} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {roles.map((r) => (
          <SelectItem key={r} value={r}>
            {roleName(r)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function RowMenu({ label, items, busy, onPick }: { label: string; items: Ask[]; busy: boolean; onPick: (a: Ask) => void }) {
  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={label} disabled={busy} />}>
        <Ellipsis />
      </MenuTrigger>
      <MenuPopup align="end">
        {items.map((i) => (
          <MenuItem key={i.label} variant="destructive" onClick={() => onPick(i)}>
            {i.icon}
            {i.label}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function Page() {
  const me = useMe();
  const router = useRouter();
  const go = useGo();
  const myID = me.user?.id;
  // Who may do what comes from the API: the roles, what each allows, and which ones you may give.
  const canManage = can(me, "members:write");

  const { q = "" } = Route.useSearch();
  const find = q ? `?q=${encodeURIComponent(q)}` : "";
  const memberList = usePager<Member>(`/v1/members${find}`);
  // The invites list is for owners and admins; everyone else would be refused.
  const inviteList = usePager<Invite>(`/v1/invites${find}`, 10, canManage);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<{
    title: string;
    label: string;
    why: string;
    run: () => unknown;
  } | null>(null);

  const [inviting, setInviting] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("member");
  const [emailProblem, setEmailProblem] = useState("");
  const [inviteStep, setInviteStep] = useState(0);
  useEffect(() => {
    if (inviting) setInviteStep(0);
  }, [inviting]);

  const load = () => refresh("/v1/members", "/v1/invites");

  async function run(fn: () => Promise<unknown>, done = "") {
    setBusy(true);
    try {
      await fn();
      if (done) toast(done);
      await load();
    } catch (err) {
      toast(message(err), "danger");
    } finally {
      setBusy(false);
    }
  }

  async function invite() {
    const parsed = v.safeParse(Email, inviteEmail);
    setEmailProblem(parsed.success ? "" : parsed.issues[0].message);
    if (!parsed.success) return;
    setBusy(true);
    try {
      await api("POST", "/v1/invites", {
        email: parsed.output,
        role: inviteRole,
      });
      toast(`Invite sent to ${parsed.output}.`);
      setInviteEmail("");
      setInviting(false);
      await load();
    } catch (err) {
      toast(message(err), 'danger');
    } finally {
      setBusy(false);
    }
  }
  const setRole = (m: Member, role: Role) =>
    (editRow("/v1/members", m.id, { role }),
    run(
      () => api("PATCH", `/v1/members/${m.id}`, { role }),
      `${m.name || m.email} is now ${roleName(role).toLowerCase()}.`,
    ));
  const remove = (m: Member) =>
    (dropRows("/v1/members", [m.id]),
    run(
      () => api("DELETE", `/v1/members/${m.id}`),
      `${m.name || m.email} was removed.`,
    ));
  const revoke = (i: Invite) =>
    (dropRows("/v1/invites", [i.id]),
    run(
      () => api("DELETE", `/v1/invites/${i.id}`),
      `The invite to ${i.email} was cancelled.`,
    ));

  async function leave() {
    setBusy(true);
    try {
      await api("DELETE", `/v1/members/${myID}`);
      queryClient.clear(); // what's cached belongs to the workspace just left
      await router.invalidate();
      go("/");
    } catch (err) {
      toast(message(err), "danger");
      setBusy(false);
    }
  }

  const memberColumns: Column<Member>[] = [
    {
      id: "name",
      header: "Name",
      cell: ({ row: { original: m } }) => (
        <>
          <span className="font-medium">{m.name || m.email.split("@")[0]}</span>{" "}
          {m.id === myID && <Badge variant="secondary">You</Badge>}
          <span className="mt-1 block text-sm text-muted-foreground">{m.email}</span>
        </>
      ),
    },
    {
      id: "role",
      header: "Role",
      cell: ({ row: { original: m } }) =>
        m.can_change ? <RoleSelect label={`Role for ${m.email}`} value={m.role} roles={me.grantable_roles} onChange={(r) => setRole(m, r)} /> : roleName(m.role),
    },
    { id: "joined", header: "Joined", cell: ({ row: { original: m } }) => <span className="text-muted-foreground" title={when(m.joined_at)}>{ago(m.joined_at)}</span> },
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row: { original: m } }) =>
        m.id === myID ? (
          <RowMenu
            label={`Actions for ${m.email}`}
            busy={busy}
            onPick={(i) => setAsking({ title: i.label, label: i.confirm, why: i.why, run: i.run })}
            items={[
              {
                icon: <LogOut />,
                label: "Leave workspace…",
                confirm: "Leave workspace",
                why: "You lose access to this workspace's videos, distributions and keys. To come back, an owner or admin has to invite you again.",
                run: leave,
              },
            ]}
          />
        ) : m.can_change ? (
          <RowMenu
            label={`Actions for ${m.email}`}
            busy={busy}
            onPick={(i) => setAsking({ title: i.label, label: i.confirm, why: i.why, run: i.run })}
            items={[
              {
                icon: <Trash2 />,
                label: "Remove…",
                confirm: "Remove",
                why: `${m.name || m.email} loses access to this workspace straight away. You can invite them again later.`,
                run: () => remove(m),
              },
            ]}
          />
        ) : null,
    },
  ];
  const inviteColumns: Column<Invite>[] = [
    { id: "email", header: "Email", cell: ({ row: { original: i } }) => <span className="font-medium">{i.email}</span> },
    { id: "role", header: "Role", cell: ({ row: { original: i } }) => roleName(i.role) },
    { id: "expires", header: "Expires", cell: ({ row: { original: i } }) => <span className="text-muted-foreground" title={when(i.expires_at)}>{ago(i.expires_at)}</span> },
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row: { original: i } }) => (
        <Menu>
          <MenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${i.email}`} disabled={busy} />}>
            <Ellipsis />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem variant="destructive" onClick={() => revoke(i)}>
              <X />
              Cancel invite
            </MenuItem>
          </MenuPopup>
        </Menu>
      ),
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-6">
      <Meta
        title="Members"
        description="Invite people to your workspace and choose what they can do."
      />
      <PageHeader title="Members" actions={<>
        <ListFilters search="Search by name or email" />
          
          {canManage && <Button onClick={() => setInviting(true)}><Plus />Invite a member</Button>}
      </>} />

      <FormDialog open={inviting} onOpenChange={setInviting} busy={busy} title="Invite a member" description="We'll email them a link to join. It works for 7 days.">
        <Wizard
          steps={[["Who", "The email address we send the invite to."], ["What they can do", "Their role in this workspace."]]}
          step={inviteStep}
          busy={busy}
          finish="Send invite"
          onBack={() => setInviteStep(0)}
          onNext={() => {
            if (inviteStep === 1) return void invite();
            const r = v.safeParse(Email, inviteEmail);
            setEmailProblem(r.success ? "" : r.issues[0].message);
            if (r.success) setInviteStep(1);
          }}
        >
          {inviteStep === 0 ? (
            <Field invalid={!!emailProblem}>
              <FieldLabel htmlFor="invite-email">Email</FieldLabel>
              <Input id="invite-email" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="name@company.com" aria-invalid={!!emailProblem || undefined} />
              {emailProblem ? <FieldError>{emailProblem}</FieldError> : <FieldDescription>We email them a link to join.</FieldDescription>}
            </Field>
          ) : (
            <Field>
              <FieldLabel>What they can do</FieldLabel>
              <RoleSelect label="Role" value={inviteRole} roles={me.grantable_roles} onChange={setInviteRole} className="w-full" />
              <ul className="grid gap-2 pt-2 text-sm" aria-label={`What a ${roleName(inviteRole)} can do`}>
                {rules.capabilities.map((c) => {
                  const yes = c.roles.includes(inviteRole);
                  return (
                    <li key={c.what} className={cn("flex items-start gap-2", !yes && "text-muted-foreground")}>
                      {yes ? <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-label="Can" /> : <X className="mt-0.5 size-4 shrink-0" aria-label="Can't" />}
                      {c.what}
                    </li>
                  );
                })}
              </ul>
              <FieldDescription>If unsure, keep Member: it is enough for everyday work.</FieldDescription>
            </Field>
          )}
        </Wizard>
      </FormDialog>

      <AlertDialog open={!!asking} onOpenChange={(o) => !o && setAsking(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {asking?.title.replace("…", "")}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {asking?.why}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Keep</AlertDialogClose>
            <AlertDialogClose render={<Button
              variant="destructive"
              onClick={() => asking?.run()} />}>
              {asking?.label}
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>


      <DataTable columns={memberColumns} pager={memberList} narrowed={!!q} rowKey={(m) => m.id} empty={null} />

      {canManage && ((inviteList.rows?.length ?? 0) > 0 || inviteList.hasPrev) && (
        <section className="grid min-w-0 grid-cols-1 gap-3">
          <div>
            <h2 className="text-lg font-semibold">Pending invites</h2>
            <p className="text-muted-foreground">People you invited who haven't joined yet. Cancel an invite to make its link stop working.</p>
          </div>
          <DataTable columns={inviteColumns} pager={inviteList} narrowed={false} rowKey={(i) => i.id} empty={null} />
        </section>
      )}

      <Frame>
        <FrameHeader>
          <FrameTitle>What each role can do</FrameTitle>
          <FrameDescription>
            A role is a set of things a person is allowed to do. Give people the smallest role that lets them do their job.
          </FrameDescription>
        </FrameHeader>
        <Table variant="card">
            <TableHeader>
              <TableRow>
                <TableHead />
                {rules.roles.map((r) => (
                  <TableHead key={r.id} className="text-center">
                    {r.name}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.capabilities.map((c) => (
                <TableRow key={c.what}>
                  <TableCell>{c.what}</TableCell>
                  {rules.roles.map((r) => (
                    <TableCell key={r.id} className="text-center">
                      {c.roles.includes(r.id) ? (
                        <Check
                          aria-label="Yes"
                          className="mx-auto size-4"
                        />
                      ) : (
                        <span aria-label="No" className="text-muted-foreground">
                          –
                        </span>
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
      </Frame>
    </div>
  );
}
