---
paths:
  - "web/**"
---
# Console (`web/`)
Use the `coss` skill for components. Look in `components/` before drawing anything.

## Building blocks
- coss ui as it comes (`components/ui`, added with the shadcn CLI from the coss registry): no hand-built tables,
  badges, buttons, alerts, inputs, cards or radio cards; no custom colours (only the coss tokens in `index.css`:
  monochrome, green only for success) and no CSS overrides of its components. Base UI names: `render={<X />}`, not
  shadcn's asChild; `*Popup`/`*Panel` not `*Content`; menus use `onClick`; selects take `items`; state attributes are
  `data-open`, `data-checked`, `data-popup-open`.
- A shape drawn twice becomes one component used everywhere. Every card is `Section` (side by side: `Sections`; only
  `Section.tsx` imports `ui/frame`). `StatTile` in `StatTiles`, four to a row at most. Charts over time use
  `ChartContainer` (`ui/chart`): pass every bucket of the period, and each series names a theme token. A count or size standing alone is
  `Figure`. Others to reuse: `PageHeader`, `DataTable`, `TablePager`, `ListFilters`, `StatusBadge` (`busy` while work
  runs), `StatusTabs`, `CopyText`, `InlineAdd`, `InlineEdit`, `Wizard`, `FormDialog`, `SaveBar`,
  `LoadError`, `Empty`, `RowDialog`, `Notice`, `HelpTip`.
- Icons only from `@/components/icons` (add a mapping there; switch a copied coss file's lucide import to it).
  Formatting only through `Intl`; dates through `dt()`, which follows the person's time zone, never a bare
  `Intl.DateTimeFormat`. Validation: Valibot. Countries are picked with `CountryPicker`, never typed as codes. Code
  samples go through `lib/code-highlight.ts` (register a new language there).
- Trap: coss field parts (`FieldLabel`, `FieldDescription`, `FieldError`) only work inside a `<Field>`. Outside one the
  route crashes at runtime (Base UI error #28) while tsc and React Doctor pass. A switch row is a `<Field>` holding
  the label block and the `Switch` side by side.
- Textareas cap their height (`[&_textarea]:max-h-*`): coss grows them without limit.

## Pages
- A page is a `gap-6` stack under a header row (title, muted description, actions at the right). When content grows
  long, split it into tabs (`?tab=`) so the page's main answer fits one screen.
- Action buttons (Save, Add, Create, Delete) sit at the top right of what they act on: the page header or the card's
  `action`; never at the bottom of a card (dialog footers and empty states excepted). Labels are generic ("Add",
  "Save"): the title says what. Hidden things that keep their space (`SaveBar`, a spinner) sit left of the visible
  buttons. What a setting is doing right now is an info `Alert` at the top of its section.
- Every field spans its card's width; short related fields pair in `grid sm:grid-cols-2`; never cap a lone field.
  Technical values (paths, hostnames, header names, IPs, keys) are `font-mono`; names and prose are not.
- A field's label is the trade's term, with plain words under it in a `FieldDescription`; a term that can't be avoided
  gets a `?` (`PreviewCard`).
- Two or more actions of one kind side by side become one split button (`components/ui/group.tsx`).
- No placeholder UI: no "Coming soon", disabled stand-ins or cards for features with no API behind them.

## Forms and dialogs
- One field: inline (`InlineAdd`/`InlineEdit`; renames always inline). Two or more, or creating a named thing: a
  `Wizard` (steps as `[title, hint]`, listed down a rail) in `FormDialog`; edit wizards pass `unchanged`. Long forms
  get their own page. A card or page that saves in place uses `SaveBar`, shown only while something differs.
- Confirmations in `ui/alert-dialog` (never a sheet: sheets are for filters and detail panels). Results and failures
  as toasts (`lib/toast`).
- Every form checks the API's rules before sending, with the API's words (`say`): `lib/schemas.ts`, `lib/tags.ts`.
  Text limits count characters, as the API does; passwords count bytes.
  Phone numbers use `libphonenumber-js/max`, imported only by the settings route (it is large).

## Lists
- One pattern: a header with the `ListFilters` button at the right (search inside its sheet), a `DataTable` in its
  frame, `TablePager` in the foot, pages by `usePager` over `{data, next_cursor, total}`. No "Load more". Empty lists are `Empty` with an icon.
- Wide tables keep the first column and the ⋯ column fixed (`stickyFirst`, `stickyLast`); a row's checkbox stays in
  the first column.
- A row click opens that thing's own page (or the page it belongs to); rows with nothing more to show have none; log
  lines and firewall events open a `RowDialog`. Row actions sit behind a ⋯ `Menu`; a destructive one confirms.

## Reading data
- Reads go through `useGet`/`usePages`/`usePager` (`lib/query`; the API path is the key), then `refresh` with the API
  path's prefix after a change. Never fetch in a `useEffect`; a bare `useQuery` escapes the page's loading gate.
- One loading state per page: `PageLoading` (the `Diamond`, never the logo) until the page's code and first reads
  arrive, then the whole page (`Gate`). Never a diamond and then skeletons. Skeletons only for content that changes
  inside a page already shown; paging and filters keep the old rows until new ones arrive.
- `error` comes only when there is nothing to show: a read that gates a skeleton checks it first and shows
  `LoadError`, or the skeleton spins forever. A failed refresh keeps the rows and toasts once; a 401 goes to sign-in.
  After a DELETE, `api` drops the removed path's reads (`afterChange`), so its page closing never toasts "doesn't exist".
- Slow actions show real state and poll only while busy (`useWhile`, `Working`).
- Never swallow an error: show it or report it. A crashed page reports itself (`lib/report.ts`) and shows a reference
  that finds it in the API's log.

## Routing and the rest
- File-based TanStack Router in `routes/`: layouts `_app` (console) and `_auth`. Never write an
  empty route file while the dev server runs: the plugin fills it with a stub.
- View transitions cross-fade only `<main>`; in-place changes (filters, periods) go through `useSetParams`, which
  turns them off. `html` keeps `scrollbar-gutter: stable`, or a scrollbar appearing aborts the transition.
- Opening a library swaps the sidebar; `useCrumb` builds the trail.
- Customer guides are `lib/guides/guides.ts` (read by `components/Guide.tsx`): short sections, split long ones;
  watch addresses are written `{player}`.
- The command palette (`CommandPalette`) takes pages from the menu; a new searchable kind needs a source. In the docs it
  searches a fixed list instead (`docsEntries`: guides and their headings, operations, events, error codes).
- Bump the favicons' `?v=` in `index.html` when they change.
