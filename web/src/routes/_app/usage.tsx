import { Figure } from "@/components/Figure";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, CircleQuestionMark, Activity } from '@/components/icons'
import { Help as PageHelp } from '@/components/Help'
import { Meta } from "@/components/Meta";
import { PageHeader } from '@/components/PageHeader'
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Frame,
  FramePanel,
  FrameDescription,
  FrameHeader,
  FrameTitle,
} from "@/components/ui/frame";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { AppLink } from "@/components/AppLink";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipPopup,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSetParams } from "@/hooks/use-set-params";
import { size, dt } from '@/lib/format';
import { message } from "@/lib/messages";
import { useGet } from "@/lib/query";
import { FactLabel } from '@/components/Facts'
import { METER_HELP, METERS, showUsage } from "@/lib/usage";
import { stickyFirst, useOverflow } from "@/components/stickyTable";

export const Route = createFileRoute("/_app/usage")({
  validateSearch: (s: Record<string, unknown>) => ({
    month:
      typeof s.month === "string" && /^\d{4}-\d{2}$/.test(s.month)
        ? s.month
        : "",
  }),
  component: Page,
});

type Row = { meter: string; quantity: number };
type Usage = {
  period: { start: string; end: string };
  totals: Row[];
  daily: (Row & { day: string })[];
  by_region: (Row & { region: string })[];
};
type Limits = {
  limits: { max_upload_bytes: number; encode_minutes_monthly: number };
  used: { encode_minutes: number };
};

const byKey = (
  rows: (Row & Record<string, string | number>)[],
  key: string,
) => {
  const out = new Map<string, Record<string, number>>();
  for (const r of rows)
    out.set(r[key] as string, {
      ...out.get(r[key] as string),
      [r.meter]: r.quantity,
    });
  return [...out];
};
const Help = ({ label, children }: { label: string; children: string }) => (
  <Tooltip>
    <TooltipTrigger
      aria-label={`What is ${label}?`}
      className="align-middle text-muted-foreground"
    >
      <CircleQuestionMark size={14} />
    </TooltipTrigger>
    <TooltipPopup className="max-w-64">{children}</TooltipPopup>
  </Tooltip>
);
const dayFormat = dt("en", {
  dateStyle: "medium",
  timeZone: "UTC",
});

function Page() {
  const set = useSetParams();
  const daysRef = useOverflow();
  // The month lives in the address; calendar months in UTC.
  const month = Route.useSearch().month || new Date().toISOString().slice(0, 7);
  const label = dt("en", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(month + "-01T00:00:00Z"));
  const shift = (by: number) => {
    const d = new Date(month + "-01T00:00:00Z");
    d.setUTCMonth(d.getUTCMonth() + by);
    set({ month: d.toISOString().slice(0, 7) });
  };

  const now = new Date();
  const resets = dayFormat.format(
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  );
  const limitsQ = useGet<Limits>("/v1/limits");
  const limits = limitsQ.data ?? null;
  const meters = limits
    ? [
        {
          label: "Video processing minutes this month",
          used: limits.used.encode_minutes,
          of: limits.limits.encode_minutes_monthly,
          show: (n: number) => <Figure n={Math.round(n)} />,
        },
      ]
    : [];
  const usageQuery = useGet<Usage>(`/v1/usage?month=${month}`);
  const usage = usageQuery.data ?? null;
  const problem = usageQuery.error ? message(usageQuery.error) : "";

  const days = byKey((usage?.daily ?? []) as never, "day").reverse();
  const usedMeters = Object.keys(METERS).filter((m) =>
    days.some(([, d]) => d[m]),
  );

  return (
    <TooltipProvider>
      <div className="grid grid-cols-1 gap-6">
        <Meta
          title="Usage"
          description="How much of your plan you have used, and what you used each month."
        />
        <PageHeader title="Usage" actions={<>
            <PageHelp label="How months are counted">Months run from the 1st to the last day (UTC time). The last few hours may still go up as the numbers come in.</PageHelp>
            <Button
              variant="outline"
              size="icon"
              aria-label="Previous month"
              onClick={() => shift(-1)}
            >
              <ChevronLeft />
            </Button>
            <span className="min-w-34 text-center">{label}</span>
            <Button
              variant="outline"
              size="icon"
              aria-label="Next month"
              onClick={() => shift(1)}
            >
              <ChevronRight />
            </Button>
        </>} />

        {problem && (
          <Alert variant="error">
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        )}
        {limitsQ.error && (
          <Alert variant="error">
            <AlertDescription>Your limits couldn't load: {message(limitsQ.error)}</AlertDescription>
          </Alert>
        )}
        {limits && (
          <Frame>
            <FrameHeader>
              <FrameTitle>Your limits</FrameTitle>
              <FrameDescription>
                What your workspace may use. Video processing minutes start again on {resets}.
                The largest single video you can upload is {size(limits.limits.max_upload_bytes)}.
                Getting close to a limit? Whoever runs this server can raise it.
              </FrameDescription>
            </FrameHeader>
            <FramePanel className="grid gap-4">
              {meters.map((m) => {
                const share = m.of > 0 ? Math.min(1, m.used / m.of) : 1;
                return (
                  <div key={m.label} className="grid gap-2 text-sm">
                    <div className="flex justify-between gap-4">
                      <span>{m.label}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {m.show(m.used)} of {m.show(m.of)}
                      </span>
                    </div>
                    <Progress value={share * 100} aria-label={m.label} />
                  </div>
                );
              })}
            </FramePanel>
          </Frame>
        )}
        {!usage && !problem ? (
          <div className="grid gap-2" aria-label="Loading usage">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        ) : usage ? (
          <>
            <Frame>
              <FrameHeader>
                <FrameTitle>Used in {label}</FrameTitle>
                <FrameDescription>
                  Totals for the month. Use the arrows at the top to look at another month.
                </FrameDescription>
              </FrameHeader>
              <Table variant="card">
                  <TableBody>
                    {Object.keys(METERS).map((meter) => (
                      <TableRow key={meter}>
                        <TableCell>
                          <span className="flex items-center gap-2.5">
                            <FactLabel label={METERS[meter]} />
                            <Help label={METERS[meter]}>{METER_HELP[meter]}</Help>
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {showUsage(
                            meter,
                            usage.totals.find((t) => t.meter === meter)
                              ?.quantity ?? 0,
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
            </Frame>

            <Frame ref={daysRef}>
              <FrameHeader>
                <FrameTitle>By day</FrameTitle>
                <FrameDescription>The same totals, one row per day.</FrameDescription>
              </FrameHeader>
                {days.length === 0 ? (
                  <FramePanel>
                  <Empty>
                    <EmptyHeader><EmptyMedia variant="icon"><Activity /></EmptyMedia><EmptyTitle>Nothing used this month</EmptyTitle>
                    <EmptyDescription>
                      Upload a video and your daily use appears here.
                    </EmptyDescription></EmptyHeader>
                    <EmptyContent>
                      <Button variant="outline" render={<AppLink href="/videos" />}>Go to videos</Button>
                    </EmptyContent>
                  </Empty>
                  </FramePanel>
                ) : (
                  <Table variant="card" className={stickyFirst}>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Day</TableHead>
                        {usedMeters.map((m) => (
                          <TableHead key={m} className="text-right">
                            {METERS[m]}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {days.map(([day, m]) => (
                        <TableRow key={day}>
                          <TableCell>
                            {dayFormat.format(new Date(day + "T00:00:00Z"))}
                          </TableCell>
                          {usedMeters.map((meter) => (
                            <TableCell
                              key={meter}
                              className="text-right tabular-nums"
                            >
                              {showUsage(meter, m[meter] ?? 0)}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
            </Frame>
          </>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
