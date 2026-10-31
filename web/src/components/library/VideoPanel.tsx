import { useEffect, useEffectEvent, useState } from "react";
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Copy,
  FolderMove,
  Folder,
  Link,
  RefreshCw,
  Trash2,
  Video,
} from "@/components/icons";
import { CopyText } from "@/components/CopyText";
import { Facts } from "@/components/Facts";
import { InlineEdit } from "@/components/InlineEdit";
import { PRIVACY, PrivacyMenu, embedOf } from "./Privacy";
import { usePreview } from "@/lib/preview";
import { Player } from "@/components/player/Player";
import { StatusBadge } from "@/components/StatusBadge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type Asset } from "@/lib/api";
import { copy } from "@/lib/copy";
import { size, timecode, when } from "@/lib/format";
import { message, videoProblem } from "@/lib/messages";
import { editRow, refresh } from "@/lib/query";
import { statusBadge } from "@/lib/status";
import { toast } from "@/lib/toast";
import { retryVideo } from "@/lib/retry";
import { badgeVariant } from "@/lib/tone";
import { titleOf, type VideoActions } from "./VideoCard";

type Props = VideoActions & {
  open: boolean;
  /** Undefined while it loads. */
  asset?: Asset;
  problem?: unknown;
  trash: boolean;
  folderName: string;
  prev?: string;
  next?: string;
  onGo: (id: string) => void;
  onClose: () => void;
};

/** One video beside the library: preview, name, facts, sharing and the actions. Left and Right go to the neighbours. */
export function VideoPanel({
  open,
  asset,
  problem,
  trash,
  folderName,
  prev,
  next,
  onGo,
  onClose,
  ...act
}: Props) {
  const { preview, problem: previewProblem, playable } = usePreview(asset);

  const goTo = useEffectEvent((id: string) => onGo(id)); // the latest onGo, without re-adding the key listener
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      const go =
        e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? prev
          : e.key === "ArrowRight" || e.key === "ArrowDown"
            ? next
            : undefined;
      // Typing, and the player's own seek keys, keep the arrows.
      if (
        !go ||
        e.defaultPrevented ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        (e.target as HTMLElement).closest(
          "input,textarea,select,[contenteditable],[role=slider],.shaka-video-container",
        )
      )
        return;
      e.preventDefault();
      goTo(go);
    };
    // Captured: the dialog stops the arrow keys before they bubble up to the window.
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [open, prev, next]);

  async function rename(title: string) {
    if (!asset) return;
    editRow("/v1/assets", asset.id, { title });
    try {
      await api("PATCH", `/v1/assets/${asset.id}`, { title });
      toast("Video renamed.");
    } catch (err) {
      return message(err);
    } finally {
      void refresh("/v1/assets");
    }
  }

  const badge = asset && statusBadge[asset.status];
  const embed = asset ? embedOf(asset) : "";
  const [changing, setChanging] = useState(false);
  async function setPolicy(policy: "public" | "signed") {
    if (!asset) return;
    setChanging(true);
    try {
      await api("PATCH", `/v1/assets/${asset.id}`, { playback_policy: policy });
      await refresh("/v1/assets");
      toast(
        policy === "public"
          ? "Now public. Anyone with the link can watch."
          : "Now private. Links and embeds that do not carry a signed token stop playing.",
      );
    } catch (err) {
      toast(message(err), "danger");
    } finally {
      setChanging(false);
    }
  }
  const facts = asset
    ? ([
        [
          "Length",
          asset.duration_seconds ? timecode(asset.duration_seconds) : "—",
        ],
        [
          "Resolution",
          asset.width && asset.height ? `${asset.width}×${asset.height}` : "—",
        ],
        ["Size", asset.size_bytes ? size(asset.size_bytes) : "—"],
        ["Added", when(asset.created_at)],
        [
          "ID",
          <CopyText
            key="id"
            value={asset.id}
            what="ID"
            className="text-xs"
          >{`${asset.id.slice(0, 8)}…${asset.id.slice(-4)}`}</CopyText>,
        ],
        ["Folder", folderName, Folder],
      ] as Parameters<typeof Facts>[0]["rows"])
    : [];

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetPopup className="max-sm:w-full" showCloseButton>
        <SheetHeader className="pe-14">
          <div className="flex items-start gap-2">
            <SheetTitle className="min-w-0 flex-1 text-lg leading-snug">
              {asset ? (
                <InlineEdit
                  label="Title"
                  value={titleOf(asset)}
                  onSave={rename}
                  disabled={trash}
                  className="font-semibold"
                />
              ) : (
                <Skeleton className="h-6 w-48" />
              )}
            </SheetTitle>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Previous video"
              disabled={!prev}
              onClick={() => prev && onGo(prev)}
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Next video"
              disabled={!next}
              onClick={() => next && onGo(next)}
            >
              <ChevronRight />
            </Button>
          </div>
          <SheetDescription render={<div />}>
            {badge && (
              <StatusBadge variant={badgeVariant(badge.tone)}>
                {badge.text}
              </StatusBadge>
            )}
          </SheetDescription>
        </SheetHeader>

        <SheetPanel className="grid content-start gap-5">
          {problem ? (
            <Alert variant="error">
              <AlertDescription>{message(problem)}</AlertDescription>
            </Alert>
          ) : !asset ? (
            <>
              <Skeleton className="aspect-video w-full" />
              <Skeleton className="h-40 w-full" />
            </>
          ) : (
            <>
              {preview ? (
                <Player src={preview.src} poster={preview.poster} storyboard={preview.storyboard} />
              ) : (
                <div className="grid aspect-video place-items-center gap-2 rounded-lg bg-muted p-6 text-center text-sm text-muted-foreground">
                  <div className="grid justify-items-center gap-2">
                    <Video className="size-6" />
                    <p>
                      {previewProblem ||
                        (asset.deleted_at
                          ? "It is in the trash. Restore it to watch."
                          : asset.status === "errored"
                            ? videoProblem(asset.error_code)
                            : playable
                                ? "Getting the preview ready…"
                                : asset.status === "waiting"
                                  ? "Waiting for the upload to finish."
                                  : "It's still being prepared. You can watch it here in a few minutes.")}
                    </p>
                    {!previewProblem && !asset.deleted_at && asset.status === "errored" && (
                      <Button size="sm" onClick={() => void retryVideo(asset.id)}>Try again</Button>
                    )}
                  </div>
                </div>
              )}

              <Facts rows={facts} />

              {!trash && (
                <section className="grid gap-2">
                  <h3 className="text-sm font-medium">Share</h3>
                  {playable ? (
                    <div className="flex flex-wrap gap-2">
                      {asset.playback_policy === "public" && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            void copy(
                              asset.embed_url,
                              "Link",
                            )
                          }
                        >
                          <Link />
                          Copy link
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void copy(embed, "Embed code")}
                      >
                        <Copy />
                        Copy embed code
                      </Button>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      You can share it once it is ready.
                    </p>
                  )}
                </section>
              )}
              {!trash && (
                <section className="grid gap-2">
                  <h3 className="text-sm font-medium">Privacy</h3>
                  <PrivacyMenu value={asset.playback_policy} onChange={(p) => void setPolicy(p)} disabled={changing} confirm />
                  <p className="text-sm text-muted-foreground">
                    {PRIVACY[asset.playback_policy].help}.
                  </p>
                </section>
              )}
            </>
          )}
        </SheetPanel>

        {asset && (
          <SheetFooter className="flex-wrap">
            {trash ? (
              <>
                <Button
                  size="sm"
                  variant="destructive-outline"
                  onClick={act.onPurge}
                >
                  <Trash2 />
                  Delete forever
                </Button>
                <Button size="sm" onClick={act.onRestore}>
                  <RefreshCw />
                  Restore
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="outline" onClick={act.onMove}>
                  <FolderMove />
                  Move to…
                </Button>
                <Button
                  size="sm"
                  variant="destructive-outline"
                  onClick={act.onTrash}
                >
                  <Trash2 />
                  Move to trash
                </Button>
                <Button size="sm" onClick={act.onOpen}>
                  Open full page
                  <ArrowUpRight />
                </Button>
              </>
            )}
          </SheetFooter>
        )}
      </SheetPopup>
    </Sheet>
  );
}
