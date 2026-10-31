import { useEffect, useEffectEvent, useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { LoadError } from '@/components/LoadError'
import {
  CloudUpload,
  FolderPlus,
  LayoutGrid,
  List,
  Trash2,
  Search,
  FolderOpen,
  Link,
  ChevronDown,
  X,
  RefreshCw,
  FolderMove,
} from "@/components/icons";
import * as v from "valibot";
import { useGo } from "@/components/AppLink";
import { FolderPicker } from "@/components/library/FolderPicker";
import { FolderRow, FolderTile } from "@/components/library/FolderTile";
import { startDrag } from "@/components/library/dnd";
import { VideoTable } from "@/components/library/VideoTable";
import { pathTo } from "@/components/library/FolderTree";
import { VideoCard, type VideoActions } from "@/components/library/VideoCard";
import { VideoPanel } from "@/components/library/VideoPanel";
import { Meta } from "@/components/Meta";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogPopup,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Group, GroupSeparator } from '@/components/ui/group'
import { Button } from "@/components/ui/button";
import {
  Frame,
  FramePanel,
} from "@/components/ui/frame";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Menu,
  MenuPopup,
  MenuItem,
  MenuTrigger,
} from "@/components/ui/menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyContent,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { FormDialog, Wizard } from "@/components/Wizard";
import { FolderSchema, NewFolder } from "@/components/library/NewFolder";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api, type Asset, type Folder, type Library } from "@/lib/api";
import { number, size } from "@/lib/format";
import { useCrumb } from "@/lib/crumb";
import { message } from "@/lib/messages";
import * as schema from "@/lib/schemas";
import { dropRows, refresh, useGet, usePages } from "@/lib/query";
import { toast } from "@/lib/toast";
import { ListFilters } from "@/components/ListFilters";
import { useSetParams } from "@/hooks/use-set-params";
import { LoadMore } from "@/components/LoadMore";
import { InlineEdit } from '@/components/InlineEdit'
import { PageHeader } from '@/components/PageHeader'
import { addUploads, uploads } from "@/lib/uploads";
import { rules } from "@/lib/rules";

export const Route = createFileRoute("/_app/videos/library/$lib/")({
  validateSearch: (s: Record<string, unknown>) => ({
    folder: typeof s.folder === "string" ? s.folder : "",
    view: s.view === "trash" ? ("trash" as const) : ("" as const),
    ...(typeof s.video === "string" && s.video ? { video: s.video } : {}),
    ...(typeof s.q === "string" && s.q ? { q: s.q } : {}),
    ...(typeof s.status === "string" && Object.hasOwn(CHIPS, s.status) ? { status: s.status as ChipKey } : {}),
    ...(s.privacy === "public" || s.privacy === "signed" ? { privacy: s.privacy } : {}),
  }),
  component: Page,
});

const ImportSchema = v.object({
  input_url: schema.address("invalid_input_url", { path: true, query: true }),
  title: v.pipe(
    v.string(),
    v.trim(),
    v.maxLength(200, "Titles can be up to 200 characters."),
  ),
});

const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, val: string) => {
  try {
    localStorage.setItem(k, val);
  } catch {
    // Not remembered; the page works without it.
  }
};

type Confirm = {
  title: string;
  text: string;
  label: string;
  run: () => Promise<void>;
};
// The status chips: what the URL says, the states the API is asked for, and which count the library reports.
const CHIPS = {
  ready: { label: "Ready", api: "complete", count: "ready" },
  processing: { label: "Processing", api: "waiting,processing,ready", count: "processing" },
  failed: { label: "Failed", api: "errored", count: "errored" },
} as const;
type ChipKey = keyof typeof CHIPS;
// Status options with the library's counts (a folder has none).
const STATUSES = (lib: Library, inFolder: boolean) => [
  { value: "all", label: "Any status" },
  ...(Object.keys(CHIPS) as ChipKey[]).map((k) => ({
    value: k,
    label: inFolder ? CHIPS[k].label : `${CHIPS[k].label} (${number(lib.by_status[CHIPS[k].count])})`,
  })),
];
const PRIVACIES = [
  { value: "all", label: "Any privacy" },
  { value: "public", label: "Public" },
  { value: "signed", label: "Private" },
];
const SORTS = [
  { label: "Newest first", value: "newest" },
  { label: "Oldest first", value: "oldest" },
];

type Moving = { kind: "videos" } | { kind: "folder"; folder: Folder };

const noActions: VideoActions = { onOpen() {}, onMove() {}, onTrash() {}, onRestore() {}, onPurge() {} };

function Page() {
  const go = useGo();
  const { lib } = Route.useParams();
  const { folder: folderParam, view, q = "", status, privacy, video } = Route.useSearch();
  const navigate = useNavigate();
  const setParams = useSetParams();
  const trash = view === "trash";
  const libQ = useGet<Library>(`/v1/libraries/${lib}`);
  const foldersQ = useGet<{ data: Folder[] }>(`/v1/libraries/${lib}/folders`);
  const libsQ = useGet<{ data: Library[] }>("/v1/libraries?limit=100");
  const library = libQ.data;
  const folders = foldersQ.data?.data ?? [];
  // A folder that no longer exists (deleted, bad link) shows Home.
  const folder =
    foldersQ.data && folders.some((f) => f.id === folderParam)
      ? folderParam
      : null;
  const here = folders.filter((f) => f.parent_id === folder);

  const [list, setList] = useState(() => read("library-view") !== "grid");
  const [sort, setSort] = useState<"newest" | "oldest">(() =>
    read("library-sort") === "oldest" ? "oldest" : "newest",
  );

  // A search or a status chip looks across the whole library, as the chip counts do.
  const path = `/v1/assets?library_id=${lib}${trash ? "&trashed=true" : q || status || privacy ? "" : `&folder_id=${folder ?? "root"}`}${q ? `&q=${encodeURIComponent(q)}` : ""}${status ? `&status=${CHIPS[status].api}` : ""}${privacy ? `&policy=${privacy}` : ""}${sort === "oldest" ? "&sort=oldest" : ""}`;
  const pages = usePages<Asset>(path, 24);
  const rows = pages.rows;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => setSelected(new Set()), [lib, folder, trash, q, status, privacy]);

  const queue = uploads.use();
  const unsettled =
    !!rows?.some(
      (a) =>
        a.status === "waiting" ||
        a.status === "processing" ||
        a.status === "ready",
    ) || queue.some((u) => u.state === "uploading");
  useEffect(() => {
    if (!unsettled || trash) return;
    const t = setInterval(
      () => void refresh("/v1/assets", "/v1/libraries"),
      3000,
    );
    return () => clearInterval(t);
  }, [unsettled, trash]);
  const changed = () => refresh("/v1/assets", "/v1/libraries");

  // The side panel lives in the URL (?video=): opening adds a history step so Back closes it; moving between videos replaces it.
  const showVideo = (id: string, replace = false) =>
    void navigate({
      to: ".",
      replace,
      resetScroll: false,
      search: ((prev: Record<string, unknown>) => {
        const { video: _, ...rest } = prev;
        return id ? { ...rest, video: id } : rest;
      }) as never,
    });
  // A click opens the video's own page; only the trash, which has no video pages, shows the side panel.
  const openVideo = (id: string) => (trash ? showVideo(id) : go(`/videos/${id}`));
  const at = rows?.findIndex((a) => a.id === video) ?? -1;
  const inList = rows?.[at];
  const loneQ = useGet<Asset>(video && rows && !inList ? `/v1/assets/${video}` : null, 3000);
  const panelAsset = inList ?? (loneQ.data?.id === video ? loneQ.data : undefined);
  // A video that is not in this view (a link from elsewhere) shows from its own read, with no neighbours.
  const neighbour = (i: number) => (at >= 0 ? rows?.[i]?.id : undefined);

  // One runner for every change: refresh, say it worked, or show the API's own words.
  // `gone` are videos that leave this view: they vanish at once, and come back if the change fails.
  async function run(
    fn: () => Promise<unknown>,
    done: string,
    gone: string[] = [],
  ) {
    if (gone.length) dropRows("/v1/assets", gone);
    // The open video leaves this view: show the one after it (or before), else close the panel.
    if (video && gone.includes(video)) showVideo((neighbour(at + 1) ?? neighbour(at - 1)) || "", true);
    try {
      await fn();
      await changed();
      setSelected(new Set());
      toast(done);
    } catch (err) {
      toast(message(err), "danger");
    }
  }
  const ids = [...selected];
  const count = (n: number) => `${number(n)} ${n === 1 ? "video" : "videos"}`;

  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [moving, setMoving] = useState<Moving | null>(null);

  // Upload and import land in the folder being looked at, with the library's default for who can watch.
  const policy = library?.default_playback_policy ?? "signed";
  const picker = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);
  const [dragging, setDragging] = useState(false);
  function add(files: FileList | null) {
    if (!library || trash) return;
    addUploads([...(files ?? [])], {
      policy,
      libraryId: lib,
      library: library.name,
      folderId: folder,
      folder: folder ? (crumbs.at(-1)?.name ?? null) : null,
    });
  }
  const addDropped = useEffectEvent((files: FileList | null) => add(files)); // the latest add, for the window listener below
  useEffect(() => {
    const over = (e: globalThis.DragEvent) =>
      e.dataTransfer?.types.includes("Files") &&
      (e.preventDefault(), setDragging(true));
    const leave = (e: globalThis.DragEvent) =>
      !e.relatedTarget && setDragging(false);
    const drop = (e: globalThis.DragEvent) =>
      e.dataTransfer?.types.includes("Files") &&
      (e.preventDefault(),
      setDragging(false),
      addDropped(e.dataTransfer?.files ?? null));
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => (
      window.removeEventListener("dragover", over),
      window.removeEventListener("dragleave", leave),
      window.removeEventListener("drop", drop)
    );
  }, []);

  const [importURL, setImportURL] = useState("");
  const [importTitle, setImportTitle] = useState("");
  const [importDownload, setImportDownload] = useState(false);
  const [importProblems, setImportProblems] = useState<Record<string, string>>(
    {},
  );
  const [importProblem, setImportProblem] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importStep, setImportStep] = useState(0);
  useEffect(() => {
    if (adding) setImportStep(0);
  }, [adding]);
  async function importVideo() {
    const parsed = v.safeParse(ImportSchema, {
      input_url: importURL,
      title: importTitle,
    });
    setImportProblems(parsed.success ? {} : schema.problemsOf(parsed.issues));
    if (!parsed.success) return;
    setImportBusy(true);
    setImportProblem("");
    try {
      const { input_url, title } = parsed.output;
      await api("POST", "/v1/assets", {
        input_url,
        playback_policy: policy,
        download: importDownload,
        library_id: lib,
        folder_id: folder ?? "root",
        ...(title ? { title } : {}),
      });
      toast(
        "Importing. We're downloading the video now. It appears below and can be watched once it has been processed, usually within minutes.",
      );
      setAdding(false);
      setImportURL("");
      setImportTitle("");
      await changed();
    } catch (err) {
      setImportProblem(message(err));
    } finally {
      setImportBusy(false);
    }
  }

  const [newFolder, setNewFolder] = useState(false);
  // A folder is renamed where its name is shown; the problem comes back to that field.
  async function renameFolder(id: string, name: string) {
    const parsed = v.safeParse(FolderSchema, { name });
    if (!parsed.success) return parsed.issues[0].message;
    try {
      await api("PATCH", `/v1/folders/${id}`, { name: parsed.output.name });
      await refresh("/v1/libraries");
      toast("Folder renamed.");
    } catch (err) {
      return message(err);
    }
  }

  async function emptyTrash() {
    // Each round takes up to 100 trashed videos and removes them for good, until none are left.
    for (;;) {
      const r = await api<{ data: Asset[] }>(
        "GET",
        `/v1/assets?library_id=${lib}&trashed=true&limit=100`,
      );
      if (r.data.length === 0) return;
      await api("POST", "/v1/assets/purge", { ids: r.data.map((a) => a.id) });
    }
  }

  const crumbs = pathTo(folders, folder);
  useCrumb(
    library?.name ?? "",
    "",
    trash
      ? [{ label: "Trash" }]
      : crumbs.map((f, i) => ({ label: f.name, href: i === crumbs.length - 1 ? undefined : `/videos/library/${lib}?folder=${f.id}` })),
  );

  if (libQ.error || foldersQ.error)
    return (
      <Alert variant="error">
        <AlertDescription>
          {message(libQ.error ?? foldersQ.error)}
        </AlertDescription>
      </Alert>
    );

  // Move videos into a folder (or Home) by dropping them on it or from a picker.
  const moveVideos = (moved: string[], to: string | null) => {
    if (to === folder) return;
    void run(
      () =>
        api("POST", "/v1/assets/move", {
          ids: moved,
          library_id: lib,
          folder_id: to ?? "root",
        }),
      "Moved.",
      moved,
    );
  };
  const actionsFor = (a: Asset): VideoActions => ({
    onOpen: () => go(`/videos/${a.id}`),
    onMove: () => (setSelected(new Set([a.id])), setMoving({ kind: "videos" })),
    onTrash: () =>
      void run(
        () => api("POST", "/v1/assets/trash", { ids: [a.id] }),
        "Moved to the trash. You can restore it for 30 days.",
        [a.id],
      ),
    onRestore: () =>
      void run(
        () => api("POST", "/v1/assets/restore", { ids: [a.id] }),
        "Restored.",
        [a.id],
      ),
    onPurge: () =>
      setConfirm({
        title: "Delete forever?",
        text: "This video will be deleted for good, with its links. This cannot be undone.",
        label: "Delete forever",
        run: () =>
          run(
            () => api("POST", "/v1/assets/purge", { ids: [a.id] }),
            "Deleted.",
            [a.id],
          ),
      }),
  });
  const folderNameOf = (a: Asset) => (a.folder_id ? (folders.find((f) => f.id === a.folder_id)?.name ?? "Home") : "Home");
  const folderProps = (f: Folder) => ({
    folder: f,
    href: `/videos/library/${lib}?folder=${f.id}`,
    onSaveName: (name: string) => renameFolder(f.id, name),
    onMove: () => setMoving({ kind: "folder", folder: f }),
    onDelete: () =>
      setConfirm({
        title: `Delete ${f.name}?`,
        text: "The videos in this folder, and in the folders inside it, go to the trash. You can restore them for 30 days.",
        label: "Delete folder",
        run: () => (
          dropRows(`/v1/libraries/${lib}/folders`, [f.id]),
          run(() => api("DELETE", `/v1/folders/${f.id}`), "Folder deleted.")
        ),
      }),
    onDropVideos: (moved: string[]) => moveVideos(moved, f.id),
  });
  const changeSort = (to: "newest" | "oldest") => (setSort(to), write("library-sort", to));
  // Dragging a selected video takes the whole selection with it.
  const dragStart = (e: React.DragEvent, a: Asset) =>
    startDrag(e, selected.has(a.id) ? [...selected] : [a.id]);
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => (on ? new Set(s).add(id) : (s.delete(id), new Set(s))));
  // Folders show on Home or inside a folder, but not while a search or a chip looks across the library.
  const folderRows = trash || status || privacy ? [] : here.filter((f) => !q || f.name.toLowerCase().includes(q.toLowerCase()));
  const more = (
    <LoadMore
      more={!!pages.hasMore}
      loading={pages.loadingMore}
      onClick={pages.more}
    />
  );
  const nothing = rows?.length === 0 && folderRows.length === 0;
  const firstRun = !!rows && nothing && !trash && !folder && !q && !status && !privacy && !pages.error;
  const here_ = folder ? (folders.find((f) => f.id === folder)?.videos ?? 0) : 0;
  const subtitle = trash
    ? `${count(library?.trashed ?? 0)} · removed for good after 30 days`
    : folder
      ? `${count(here_)} here${here.length ? ` · ${number(here.length)} ${here.length === 1 ? "folder" : "folders"}` : ""}`
      : (library?.description ||
        (library && !firstRun
          ? [`${count(library.videos)}`, `${number(Math.round(library.minutes))} min`, library.storage_bytes > 0 ? size(library.storage_bytes) : ""].filter(Boolean).join(" · ")
          : ""));
  const picking = () => picker.current?.click();
  // One button: Upload, and a chevron for the other ways to add.
  const split = (
    <Group aria-label="Add videos">
      <Button onClick={picking}>
        <CloudUpload />
        Upload
      </Button>
      <GroupSeparator className="bg-primary/72" />
      <Menu>
        <MenuTrigger render={<Button size="icon" aria-label="More ways to add" />}>
          <ChevronDown />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={() => setNewFolder(true)}>
            <FolderPlus />
            New folder
          </MenuItem>
          <MenuItem onClick={() => setAdding(true)}>
            <Link />
            Import from a link
          </MenuItem>
        </MenuPopup>
      </Menu>
    </Group>
  );

  return (
    <div className="grid grid-cols-1 gap-4">
      <Meta
        title={library ? `${library.name} videos` : "Videos"}
        description="Upload videos, organise them in folders and get links to share."
      />

      {library && (
        <PageHeader
          title={
            trash ? (
              "Trash"
            ) : (
              <InlineEdit
                key={folder ?? "library"}
                label="Name"
                max={rules.limits.name}
                value={folder ? (crumbs.at(-1)?.name ?? "") : library.name}
                onSave={async (name) => {
                  try {
                    await api(
                      "PATCH",
                      folder ? `/v1/folders/${folder}` : `/v1/libraries/${lib}`,
                      { name },
                    );
                    toast(folder ? "Folder renamed." : "Library renamed.");
                  } catch (err) {
                    return message(err);
                  }
                }}
              />
            )
          }
          actions={
            !trash && split
          }
        />
      )}
      {library && subtitle && (
        <p className="-mt-2 truncate text-muted-foreground">{subtitle}</p>
      )}
      <NewFolder open={newFolder} onOpenChange={setNewFolder} lib={lib} parent={folder ?? null} />

      <input
        ref={picker}
        type="file"
        accept="video/*"
        multiple
        hidden
        onChange={(e) => (add(e.currentTarget.files), (e.currentTarget.value = ""))}
      />

      {library && !firstRun && (
        <div className="flex flex-wrap items-center gap-2">
          {!list && rows && rows.length > 0 && (
            <Checkbox
              checked={rows.every((a) => selected.has(a.id))}
              indeterminate={selected.size > 0 && !rows.every((a) => selected.has(a.id))}
              onCheckedChange={(c) => setSelected(c === true ? new Set(rows.map((a) => a.id)) : new Set())}
              aria-label="Select all"
            />
          )}
          <p className="mr-1 text-sm text-muted-foreground tabular-nums" aria-live="polite">
            {pages.total !== undefined ? count(pages.total) : ""}
          </p>
          {!trash && (
            <>
              <Select
                items={STATUSES(library, !!folder)}
                value={status ?? "all"}
                onValueChange={(c) => setParams({ status: c && c !== "all" ? c : "" })}
              >
                <SelectTrigger size="sm" className="w-auto" aria-label="Filter by status">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {STATUSES(library, !!folder).map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Select
                items={PRIVACIES}
                value={privacy ?? "all"}
                onValueChange={(c) => setParams({ privacy: c && c !== "all" ? c : "" })}
              >
                <SelectTrigger size="sm" className="w-auto" aria-label="Filter by privacy">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {PRIVACIES.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <ListFilters search="Search by title" />
            <Select
              items={SORTS}
              value={sort}
              onValueChange={(v) =>
                v &&
                (setSort(v as "newest" | "oldest"), write("library-sort", v))
              }
            >
              <SelectTrigger size="sm" className="w-36" aria-label="Sort videos">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {SORTS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <ToggleGroup
              variant="outline"
              size="sm"
              value={[list ? "list" : "grid"]}
              onValueChange={([m]) =>
                m && (setList(m === "list"), write("library-view", m))
              }
              aria-label="Layout"
            >
              <ToggleGroupItem value="grid" aria-label="Grid">
                <LayoutGrid />
              </ToggleGroupItem>
              <ToggleGroupItem value="list" aria-label="List">
                <List />
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>
      )}

      <FormDialog open={adding} onOpenChange={setAdding} busy={importBusy} title="Import from a link" description={`It is added to ${folder ? `the folder ${folders.find((f) => f.id === folder)?.name ?? ""}` : "Home"}. We download the file from its address.`}>
        <Wizard
          steps={[["Video address", "A link to the video file we should fetch."], ["Details", "Optional: a title, and whether to make a download."]]}
          step={importStep}
          busy={importBusy}
          finish="Import video"
          onBack={() => setImportStep(0)}
          onNext={() => {
            if (importStep === 0) {
              const p = schema.check(ImportSchema, { input_url: importURL, title: "" });
              setImportProblems(p);
              if (!p.input_url) setImportStep(1);
            } else void importVideo();
          }}
        >
          {importProblem && (
            <Alert variant="error">
              <AlertDescription>{importProblem}</AlertDescription>
            </Alert>
          )}
          {importStep === 0 && (
            <Field invalid={!!importProblems.input_url}>
              <FieldLabel htmlFor="import-url">Video address</FieldLabel>
              <Input id="import-url" type="url" inputMode="url" value={importURL} onChange={(e) => setImportURL(e.target.value)} placeholder="https://example.com/video.mp4" aria-invalid={!!importProblems.input_url || undefined} />
              {importProblems.input_url ? <FieldError>{importProblems.input_url}</FieldError> : <FieldDescription>It must open without signing in.</FieldDescription>}
            </Field>
          )}
          {importStep === 1 && (
            <>
              <Field invalid={!!importProblems.title}>
                <FieldLabel htmlFor="import-title">Title (optional)</FieldLabel>
                <Input id="import-title" value={importTitle} onChange={(e) => setImportTitle(e.target.value)} placeholder="Launch video" aria-invalid={!!importProblems.title || undefined} />
                {importProblems.title && <FieldError>{importProblems.title}</FieldError>}
              </Field>
              <Field className="flex-row items-start gap-3">
                <Checkbox id="import-download" checked={importDownload} onCheckedChange={(c) => setImportDownload(c === true)} />
                <FieldLabel htmlFor="import-download" className="font-normal">Also make a file people can download and save (MP4)</FieldLabel>
              </Field>
            </>
          )}
        </Wizard>
      </FormDialog>

      {moving && (
        <FolderPicker
          title={
            moving.kind === "videos"
              ? `Move ${count(ids.length)}`
              : `Move ${moving.folder.name}`
          }
          libraryId={lib}
          libraries={moving.kind === "videos" ? libsQ.data?.data : undefined}
          exclude={moving.kind === "folder" ? moving.folder.id : undefined}
          onClose={() => setMoving(null)}
          onPick={async (toLib, toFolder) => {
            if (moving.kind === "videos")
              await api("POST", "/v1/assets/move", {
                ids,
                library_id: toLib,
                folder_id: toFolder ?? "root",
              });
            else
              await api("PATCH", `/v1/folders/${moving.folder.id}`, {
                parent_id: toFolder ?? "root",
              });
            // Moved out of this view: the panel goes to the next video, as it does for the trash.
            if (moving.kind === "videos" && video && ids.includes(video) && (toLib !== lib || (toFolder ?? null) !== folder))
              showVideo((neighbour(at + 1) ?? neighbour(at - 1)) || "", true);
            await changed();
            setSelected(new Set());
            toast("Moved.");
          }}
        />
      )}

      {video && (
        <VideoPanel
          // The picker and the confirmation take the screen; the panel waits behind them.
          open={!moving && !confirm}
          asset={panelAsset}
          problem={loneQ.error}
          trash={trash}
          folderName={panelAsset ? folderNameOf(panelAsset) : ""}
          prev={neighbour(at - 1)}
          next={neighbour(at + 1)}
          onGo={(id) => showVideo(id, true)}
          onClose={() => showVideo("", true)}
          {...(panelAsset ? actionsFor(panelAsset) : noActions)}
        />
      )}

      <AlertDialog
        open={!!confirm}
        onOpenChange={(o) => !o && !confirming && setConfirm(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.text}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              render={<Button variant="ghost" disabled={confirming} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={confirming}
              onClick={() => {
                setConfirming(true);
                void confirm!
                  .run()
                  .finally(() => (setConfirming(false), setConfirm(null)));
              }}
            >
              {confirming && <Spinner />}
              {confirm?.label}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      {dragging && !trash && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-3 z-30 grid place-items-center rounded-2xl border-2 border-dashed border-primary bg-background/85 backdrop-blur-sm"
        >
          <div className="grid justify-items-center gap-2">
            <CloudUpload className="size-10 text-primary" />
            <p className="text-2xl font-semibold">Drop to upload</p>
            <p className="text-muted-foreground">
              Into {folder ? (crumbs.at(-1)?.name ?? "this folder") : "Home"}
            </p>
          </div>
        </div>
      )}

      <div className="grid min-w-0 content-start gap-4">
        {trash && (
          <Alert>
            <Trash2 />
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              Videos in the trash are removed for good after 30 days. Restore a
              video to bring it back.
              {!!library?.trashed && (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() =>
                    setConfirm({
                      title: "Empty the trash?",
                      text: `${count(library.trashed)} will be deleted for good, with their links. This cannot be undone.`,
                      label: "Empty trash",
                      run: () => run(emptyTrash, "Trash emptied."),
                    })
                  }
                >
                  <Trash2 />
                  Empty trash
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}

        {selected.size > 0 ? (
          <div className="flex flex-wrap items-center gap-2 rounded-xl bg-muted px-2 py-1.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Clear selection"
              onClick={() => setSelected(new Set())}
            >
              <X />
            </Button>
            <span className="text-sm font-medium tabular-nums">
              {number(selected.size)} selected
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {trash ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void run(
                        () => api("POST", "/v1/assets/restore", { ids }),
                        "Restored.",
                        ids,
                      )
                    }
                  >
                    <RefreshCw />
                    Restore
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive-outline"
                    onClick={() =>
                      setConfirm({
                        title: "Delete forever?",
                        text: `${count(ids.length)} will be deleted for good, with their links. This cannot be undone.`,
                        label: "Delete forever",
                        run: () =>
                          run(
                            () => api("POST", "/v1/assets/purge", { ids }),
                            "Deleted.",
                            ids,
                          ),
                      })
                    }
                  >
                    <Trash2 />
                    Delete forever
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setMoving({ kind: "videos" })}
                  >
                    <FolderMove />
                    Move to…
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive-outline"
                    onClick={() =>
                      void run(
                        () => api("POST", "/v1/assets/trash", { ids }),
                        "Moved to the trash. You can restore it for 30 days.",
                        ids,
                      )
                    }
                  >
                    <Trash2 />
                    Move to trash
                  </Button>
                </>
              )}
            </div>
          </div>
        ) : null}

        {pages.error ? (
          <LoadError error={pages.error} retry={pages.refetch} />
        ) : !rows ? (
          list ? (
            <Frame>
              <FramePanel className="grid gap-3">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </FramePanel>
            </Frame>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-4">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="aspect-video w-full" />
              ))}
            </div>
          )
        ) : firstRun ? (
          <div className="grid justify-items-center gap-8 rounded-2xl border-2 border-dashed px-6 py-14 text-center">
            <div className="grid justify-items-center gap-3">
              <span className="grid size-12 place-items-center rounded-xl bg-muted text-muted-foreground">
                <CloudUpload className="size-6" />
              </span>
              <h2 className="text-lg font-semibold">Drop your first video here</h2>
              <p className="max-w-md text-muted-foreground">
                Drag a video file onto this page, or choose one from your computer.
              </p>
              {split}
            </div>
            <ol className="grid w-full max-w-3xl gap-6 text-left sm:grid-cols-3">
              {[
                ["Upload", "Drop a video file here or choose one."],
                ["Wait about a minute", "We prepare it for every screen."],
                ["Copy the embed code", "Paste it on your website and the player shows up."],
              ].map(([title, text], i) => (
                <li key={title} className="flex gap-3">
                  <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted font-mono text-xs tabular-nums">
                    {i + 1}
                  </span>
                  <span className="grid gap-0.5">
                    <span className="text-sm font-medium">{title}</span>
                    <span className="text-sm text-muted-foreground">{text}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ) : nothing ? (
          <Frame>
            <FramePanel>
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    {trash ? (
                      <Trash2 />
                    ) : q || status || privacy ? (
                      <Search />
                    ) : (
                      <FolderOpen />
                    )}
                  </EmptyMedia>
                  <EmptyTitle>
                    {trash
                      ? "The trash is empty"
                      : q
                        ? `No ${status ? CHIPS[status].label.toLowerCase() + " " : ""}${privacy ? (PRIVACIES.find((p) => p.value === privacy)?.label ?? "").toLowerCase() + " " : ""}videos match “${q}”`
                        : status || privacy
                          ? `No ${[status && CHIPS[status].label, privacy && (PRIVACIES.find((p) => p.value === privacy)?.label ?? "")].filter(Boolean).join(" ").toLowerCase()} videos`
                          : "This folder is empty"}
                  </EmptyTitle>
                  <EmptyDescription>
                    {trash
                      ? "Videos you remove wait here for 30 days."
                      : q
                        ? "Try a different word, or search by part of the title."
                        : status || privacy
                          ? "Choose Any status and Any privacy to see every video."
                          : "Upload a video, or drop files anywhere on this page. We prepare each one for every screen; it can be watched within minutes."}
                  </EmptyDescription>
                </EmptyHeader>
                {!trash && !q && !status && !privacy && (
                  <EmptyContent className="flex-row justify-center">
                    {split}
                  </EmptyContent>
                )}
              </Empty>
            </FramePanel>
          </Frame>
        ) : list ? (
          <div className="grid grid-cols-1 gap-4">
            <VideoTable
              rows={rows}
              trash={trash}
              selected={selected}
              onSelect={toggle}
              onSelectAll={(on) =>
                setSelected(on ? new Set(rows.map((a) => a.id)) : new Set())
              }
              actions={actionsFor}
              active={video}
              onPeek={(a) => openVideo(a.id)}
              onDragStart={dragStart}
              sort={sort}
              onSort={changeSort}
              folders={folderRows.map((f) => (
                <FolderRow key={f.id} {...folderProps(f)} />
              ))}
            />
            {more}
          </div>
        ) : (
          <>
            {folderRows.length > 0 && (
              <section className="grid gap-2">
                <h2 className="text-sm font-medium text-muted-foreground">
                  Folders
                </h2>
                <ul className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-4">
                  {folderRows.map((f) => (
                    <FolderTile key={f.id} {...folderProps(f)} />
                  ))}
                </ul>
              </section>
            )}
            {rows.length > 0 && (
              <section className="grid gap-2">
                <h2 className="text-sm font-medium text-muted-foreground">
                  Videos
                </h2>
                <ul className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-4">
                  {rows.map((a) => (
                    <VideoCard
                      key={a.id}
                      asset={a}
                      trash={trash}
                      selected={selected.has(a.id)}
                      active={video === a.id}
                      onPeek={() => openVideo(a.id)}
                      onSelect={(on) => toggle(a.id, on)}
                      onDragStart={(e) => dragStart(e, a)}
                      {...actionsFor(a)}
                    />
                  ))}
                </ul>
                <div className="pt-2">{more}</div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
