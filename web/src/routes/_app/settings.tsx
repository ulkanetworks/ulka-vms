import { useState, type FormEvent, type ReactNode } from "react";
import { isValidPhoneNumber } from "libphonenumber-js/max";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import * as v from "valibot";
import * as schema from "@/lib/schemas";
import { can, rules } from "@/lib/rules";
import { toast } from "@/lib/toast";
import { api } from "@/lib/api";
import { useGo } from "@/components/AppLink";
import { Meta } from "@/components/Meta";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Frame,
  FramePanel,
  FrameDescription,
  FrameHeader,
  FrameTitle,
} from "@/components/ui/frame";
import { Spinner } from "@/components/ui/spinner";
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
  SelectButton,
} from "@/components/ui/select";
import { Combobox, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList, ComboboxPopup, ComboboxTrigger, ComboboxValue } from "@/components/ui/combobox";
import { Skeleton } from "@/components/ui/skeleton";
import { InlineAdd } from "@/components/InlineAdd";
import { Tabs, TabsPanel, TabsList, TabsTab } from "@/components/ui/tabs";
import { useSetParams } from "@/hooks/use-set-params";
import { message, say } from "@/lib/messages";
import { queryClient, refresh, useGet } from "@/lib/query";
import { useMe } from "@/lib/session";
import { ago, when, device } from "@/lib/format";
import { Search } from '@/components/icons'
import { Plus } from '@/components/icons'

export const Route = createFileRoute("/_app/settings")({
  validateSearch: (s: Record<string, unknown>) => ({
    tab: typeof s.tab === "string" ? s.tab : "",
    new: s.new === undefined ? undefined : "",
  }),
  component: Page,
});

type Session = {
  created_at: string;
  last_seen_at: string;
  ip: string;
  user_agent: string;
  current: boolean;
  ulka_admin?: string;
};

// Times follow this: the browser's own, UTC, GMT, or any named zone.
const BROWSER = "__browser";
const ZONES = (() => {
  const offset = (zone: string) => {
    const name = new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName: "shortOffset" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
    const m = name.match(/GMT([+-]?)(\d+)(?::(\d+))?/);
    return { text: name === "GMT" ? "GMT+0" : name, minutes: (m?.[1] === "-" ? -1 : 1) * (Number(m?.[2] ?? 0) * 60 + Number(m?.[3] ?? 0)) };
  };
  const named = Intl.supportedValuesOf("timeZone")
    .filter((z) => z !== "UTC" && z !== "GMT")
    .map((z) => ({ value: z, ...offset(z) }))
    .sort((x, y) => x.minutes - y.minutes)
    .map((z) => ({ value: z.value, label: `(${z.text}) ${z.value.replaceAll("_", " ")}` }));
  return [
    { value: BROWSER, label: "Same as this browser" },
    { value: "UTC", label: "(GMT+0) UTC, Coordinated Universal Time" },
    { value: "GMT", label: "(GMT+0) GMT, Greenwich Mean Time" },
    ...named,
  ];
})();

const LANGUAGES = [
  { label: "English", value: "en" },
  { label: "বাংলা (Bangla)", value: "bn" },
]
const tabs = [
  { id: "profile", label: "Profile" },
  { id: "security", label: "Security" },
  { id: "workspace", label: "Workspace" },
];

const Name = (required: boolean) =>
  required ? schema.name() : schema.optionalName();
const Email = schema.email();
const NewPassword = schema.newPassword();
const Required = schema.currentPassword;

// One small form state per card: its values, field problems, result and busy flag.
type Form = {
  values: Record<string, string>;
  saved: Record<string, string>; // what was last loaded or saved: Save stays off until the values differ
  problems: Record<string, string>;
  busy: boolean;
};
function useForm(values: Record<string, string>) {
  const [f, set] = useState<Form>({
    values,
    saved: values,
    problems: {},
    busy: false,
  });
  // Values set by the page (loaded, or cleared after saving) are the new starting point.
  const patch = (p: Partial<Form>) => set((s) => ({ ...s, ...p, ...(p.values ? { saved: p.values } : {}) }));
  const dirty = Object.keys({ ...f.values, ...f.saved }).some((k) => (f.values[k] ?? "") !== (f.saved[k] ?? ""));
  // A change the person makes; unlike patch, it doesn't move the starting point.
  const setValue = (k: string, value: string) => set((s) => ({ ...s, values: { ...s.values, [k]: value } }));
  const bind = (k: string) => ({
    value: f.values[k],
    onChange: (e: { target: { value: string } }) =>
      set((s) => ({ ...s, values: { ...s.values, [k]: e.target.value } })),
  });
  async function submit(
    schema: v.GenericSchema,
    send: (input: never) => Promise<unknown>,
    done: string,
    after?: () => Promise<unknown> | void,
  ) {
    const parsed = v.safeParse(schema, f.values);
    patch({ problems: parsed.success ? {} : schema_problems(parsed.issues) });
    if (!parsed.success) return;
    patch({ busy: true });
    try {
      await send(parsed.output as never);
      set((s) => ({ ...s, saved: s.values }));
      if (done) toast(done);
      await after?.();
    } catch (err) {
      toast(message(err), 'danger');
    } finally {
      patch({ busy: false });
    }
  }
  return { ...f, dirty, bind, patch, setValue, submit };
}
const schema_problems = schema.problemsOf;

// A form card: title, optional description, fields and a save button.
function FormCard({
  title,
  description,
  form,
  label,
  onSubmit,
  children,
  hideSave,
  columns,
}: {
  title: string;
  description?: string;
  form: { busy: boolean; dirty: boolean };
  label: string;
  onSubmit: () => void;
  children: ReactNode;
  hideSave?: boolean;
  /** Short, related fields side by side (they stack on phones). */
  columns?: boolean;
}) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  return (
    <Frame>
      <form onSubmit={submit} noValidate>
        <FrameHeader className="flex-row items-start justify-between gap-4">
          <div>
            <FrameTitle>{title}</FrameTitle>
            {description && <FrameDescription>{description}</FrameDescription>}
          </div>
          {!hideSave && (
            <Button type="submit" size="sm" disabled={form.busy || !form.dirty}>
              {form.busy && <Spinner />}
              {label}
            </Button>
          )}
        </FrameHeader>
        <FramePanel className="grid gap-4">
          <div className={columns ? "grid items-start gap-4 sm:grid-cols-2" : "flex flex-col gap-4"}>{children}</div>
        </FramePanel>
      </form>
    </Frame>
  );
}

function Text({
  id,
  label,
  problem,
  hint,
  ...input
}: {
  id: string;
  label: string;
  problem?: string;
  hint?: string;
} & React.ComponentProps<typeof Input>) {
  return (
    <Field invalid={!!problem}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} aria-invalid={(!!problem) ? true : undefined} {...input} />
      {hint && <FieldDescription>{hint}</FieldDescription>}
      <FieldError>{problem}</FieldError>
    </Field>
  );
}

function Page() {
  const me = useMe();
  const router = useRouter();
  const go = useGo();
  const search = Route.useSearch();
  const canManage = can(me, "workspace:write");
  const tab = tabs.some((t) => t.id === search.tab) ? search.tab : "profile";

  const profile = useForm({
    name: me.user?.name ?? "",
    phone: me.user?.phone ?? "",
    locale: me.user?.locale ?? "en",
    timezone: me.user?.timezone ?? BROWSER,
  });
  const emailForm = useForm({ email: "", password: "" });
  const password = useForm({ current_password: "", new_password: "" });
  const sessions = useForm({});
  const sessionList = useGet<{ data: Session[] }>(
    tab === "security" ? "/v1/me/sessions" : null,
  );
  const workspace = useForm({ name: me.tenant.name });
  // The workspace switcher links here with ?new to start a workspace straight away.
  const [creating, setCreating] = useState(search.new !== undefined);
  async function createWorkspace(text: string) {
    const parsed = v.safeParse(v.object({ name: Name(true) }), { name: text });
    if (!parsed.success) return parsed.issues[0].message;
    try {
      await api("POST", "/v1/tenants", parsed.output);
      queryClient.clear();
      await router.invalidate();
      go("/");
    } catch (err) {
      return message(err);
    }
  }

  const set = useSetParams();
  return (
    <div className="grid grid-cols-1 gap-6">
      <Meta
        title="Settings"
        description="Your own details, your password and sign-in safety, and your workspace's name."
      />
      <header>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-muted-foreground">
          Change your own details and password, and manage the {me.tenant.name} workspace (the shared space your team works in).
        </p>
      </header>

      <Tabs
        value={tab}
        onValueChange={(t) => set({ tab: t === "profile" ? "" : t })}
      >
        <TabsList className="max-w-full justify-start overflow-x-auto">
          {tabs.map((t) => (
            <TabsTab key={t.id} value={t.id}>
              {t.label}
            </TabsTab>
          ))}
        </TabsList>

        <TabsPanel value="profile" className="grid gap-6">
          <FormCard
            columns
            title="Profile"
            description="How your name shows to your teammates, the language this console uses, and the time zone times are shown in."
            form={profile}
            label="Save"
            onSubmit={() =>
              profile.submit(
                v.object({
                  name: Name(false),
                  // The API's cleanPhone: an international number libphonenumber's full rules call valid (max metadata, as the API's).
                  phone: v.pipe(v.string(), v.trim(), v.check((p) => p === "" || (p.startsWith("+") && isValidPhoneNumber(p)), say("invalid_phone"))),
                  locale: v.picklist(["en", "bn"]),
                  timezone: v.string(),
                }),
                (b: { timezone: string }) => api("PATCH", "/v1/me", { ...b, timezone: b.timezone === BROWSER ? "" : b.timezone }),
                "Your profile was saved.",
                () => router.invalidate(),
              )
            }
          >
            <Text
              id="name"
              label="Your name"
              problem={profile.problems.name}
              autoComplete="name"
              {...profile.bind("name")}
            />
            <Text
              id="phone"
              label="Phone (optional)"
              problem={profile.problems.phone}
              hint="So we can reach you if needed. Start with the country code, like +44 20 7946 0958 or +880 1712 345678."
              type="tel"
              autoComplete="tel"
              inputMode="tel"
              {...profile.bind("phone")}
              placeholder="+880 1712 345678"
            />
            <Field invalid={!!profile.problems.locale}>
              <FieldLabel>Language</FieldLabel>
              <Select
                items={LANGUAGES}
                value={profile.values.locale}
                onValueChange={(l) =>
                  l && profile.setValue("locale", l)
                }
              >
                <SelectTrigger aria-label="Language" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {LANGUAGES.map((l) => (
                    <SelectItem key={l.value} value={l.value}>
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <FieldError>{profile.problems.locale}</FieldError>
            </Field>
            <Field invalid={!!profile.problems.timezone}>
              <FieldLabel>Time zone</FieldLabel>
              <Combobox
                autoHighlight
                items={ZONES}
                value={ZONES.find((z) => z.value === profile.values.timezone) ?? null}
                onValueChange={(z) => z && profile.setValue("timezone", z.value)}
              >
                <ComboboxTrigger render={<SelectButton aria-label="Time zone" className="w-full" />}>
                  <ComboboxValue placeholder="Select a time zone" />
                </ComboboxTrigger>
                <ComboboxPopup aria-label="Select a time zone">
                  <div className="border-b p-2">
                    <ComboboxInput className="rounded-md" placeholder="e.g. Asia/Dhaka" showTrigger={false} startAddon={<Search />} />
                  </div>
                  <ComboboxEmpty>No time zone found.</ComboboxEmpty>
                  <ComboboxList>
                    {(z: (typeof ZONES)[number]) => (
                      <ComboboxItem key={z.value} value={z}>
                        {z.label}
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                </ComboboxPopup>
              </Combobox>
              <FieldDescription>Times in the console and in your logs are shown in this zone.</FieldDescription>
              <FieldError>{profile.problems.timezone}</FieldError>
            </Field>
          </FormCard>

          <FormCard
            columns
            title="Email address"
            description={`You sign in with ${me.user?.email}. We'll send a link to the new address; the change happens when you open it.`}
            form={emailForm}
            label="Change email"
            onSubmit={() =>
              emailForm.submit(
                v.object({ email: Email, password: Required }),
                (b) => api("POST", "/v1/me/email", b),
                `Check ${emailForm.values.email.trim()} for a confirmation link.`,
              )
            }
          >
            <Text
              id="new-email"
              label="New email"
              problem={emailForm.problems.email}
              type="email"
              autoComplete="email"
              {...emailForm.bind("email")}
            />
            <Text
              id="email-password"
              label="Current password"
              problem={emailForm.problems.password}
              type="password"
              autoComplete="current-password"
              {...emailForm.bind("password")}
            />
          </FormCard>
        </TabsPanel>

        <TabsPanel value="security" className="grid gap-6">
          <FormCard
            columns
            title="Password"
            description="Choose a new one if you think someone else knows it. Changing it signs you out on every other device."
            form={password}
            label="Change password"
            onSubmit={() =>
              password.submit(
                v.object({
                  current_password: Required,
                  new_password: NewPassword,
                }),
                (b) => api("POST", "/v1/me/password", b),
                "Your password was changed, and you were signed out everywhere else. Use the new one next time you sign in.",
                async () => {
                  password.patch({
                    values: { current_password: "", new_password: "" },
                  });
                  await refresh("/v1/me/sessions");
                },
              )
            }
          >
            <Text
              id="current-password"
              label="Current password"
              problem={password.problems.current_password}
              type="password"
              autoComplete="current-password"
              {...password.bind("current_password")}
            />
            <Text
              id="new-password"
              label="New password"
              problem={password.problems.new_password}
              hint="12 to 72 characters. A few unrelated words work well."
              type="password"
              autoComplete="new-password"
              {...password.bind("new_password")}
            />
          </FormCard>

          <Frame>
            <FrameHeader className="flex-row items-start justify-between gap-4">
<div>
              <FrameTitle>Where you're signed in</FrameTitle>
              <FrameDescription>
                Every browser and device that is signed in to your account, most recently used
                first. If one looks unfamiliar, sign out the others and change your password.
              </FrameDescription>
            </div>
              <Button
                variant="secondary" size="sm"
                disabled={sessions.busy}
                onClick={() =>
                  sessions.submit(
                    v.object({}),
                    async () => {
                      const r = await api<{ revoked: number }>(
                        "POST",
                        "/v1/me/sessions/revoke-others",
                      );
                      toast(
                        r.revoked === 1
                          ? "Signed out 1 other device. This one stays signed in."
                          : `Signed out ${r.revoked} other devices. This one stays signed in.`,
                      );
                      await refresh("/v1/me/sessions");
                    },
                    "",
                  )
                }
              >
                {sessions.busy && <Spinner />}Sign out everywhere else
              </Button>
            </FrameHeader>
            <FramePanel className="grid gap-4">
              {sessionList.data ? (
                <ul className="grid gap-3">
                  {sessionList.data.data.map((s) => (
                    <li
                      key={s.created_at + s.ip}
                      className="grid gap-0.5 text-sm"
                    >
                      <span>
                        {s.ulka_admin
                          ? `Support (${s.ulka_admin}), using your account`
                          : device(s.user_agent)}
                        {s.current && <strong> (this one)</strong>}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {s.ip || "Unknown address"} · last used{" "}
                        {ago(s.last_seen_at)} · signed in {when(s.created_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : sessionList.error ? (
                <Alert variant="error">
                  <AlertDescription>
                    {message(sessionList.error)}
                  </AlertDescription>
                </Alert>
              ) : (
                <div className="grid gap-2" aria-label="Loading sessions">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              )}
            </FramePanel>
            
          </Frame>
        </TabsPanel>

        <TabsPanel value="workspace" className="grid gap-6">
          <FormCard
            title="Workspace name"
            description={
              canManage
                ? "Everyone in the workspace sees this name, for example when they switch workspaces."
                : "Only owners and admins can rename the workspace."
            }
            form={workspace}
            label="Save"
            hideSave={!canManage}
            onSubmit={() =>
              workspace.submit(
                v.object({ name: Name(true) }),
                (b) => api("PATCH", "/v1/tenant", b),
                "The workspace was renamed. Everyone sees the new name now.",
                () =>
                  Promise.all([router.invalidate(), refresh("/v1/tenants")]),
              )
            }
          >
            <Text
              id="workspace-name"
              label="Name"
              problem={workspace.problems.name}
              {...workspace.bind("name")}
              disabled={!canManage}
            />
          </FormCard>
          {rules.signup_open && (
            <Frame>
              <FrameHeader className="flex-row items-start justify-between gap-4">
                <div>
                <FrameTitle>Another workspace</FrameTitle>
                <FrameDescription>
                  Run a second project or company on its own: separate videos, distributions, keys and
                  members, with nothing shared. You'll be its owner. Your current workspace stays as it is.
                </FrameDescription>
              </div>
                <Button variant="secondary" size="sm" onClick={() => setCreating(true)}><Plus />
                  New workspace
                </Button>
              </FrameHeader>
              {creating && (
                <FramePanel>
                  <InlineAdd label="Workspace name" placeholder="Acme Labs" button="Create workspace" onAdd={createWorkspace} onCancel={() => setCreating(false)} hint="You switch to it straight away." />
                </FramePanel>
              )}
            </Frame>
          )}
        </TabsPanel>
      </Tabs>
    </div>
  );
}
