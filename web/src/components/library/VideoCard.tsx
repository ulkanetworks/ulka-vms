import type { DragEvent, ReactNode } from "react";
import {
  Ellipsis,
  FolderMove,
  Link,
  Play,
  RefreshCw,
  Share,
  Trash2,
} from "@/components/icons";
import { AppLink } from "@/components/AppLink";
import { retryVideo } from "@/lib/retry";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import type { Asset } from "@/lib/api";
import { ago, timecode } from "@/lib/format";
import { copy } from "@/lib/copy";
import { statusBadge } from "@/lib/status";
import { StatusBadge } from "@/components/StatusBadge";
import { badgeVariant } from "@/lib/tone";
import { PrivacyBadge, ShareDialog } from "./Privacy";
import { VideoThumb } from "./VideoThumb";
import { cn } from "@/lib/utils";

export const titleOf = (a: Asset) =>
  a.title || a.passthrough || "Untitled video";

export const playable = (a: Asset) =>
  !a.deleted_at && (a.status === "ready" || a.status === "complete");

export const posterOf = (a: Asset, width = 640) => {
  // Public videos show their thumbnail; private ones keep the placeholder. v skips the 5-minute cache after a change.
  return a.playback_policy === "public" && playable(a) ? `${a.embed_url}/poster.webp?width=${width}&v=${encodeURIComponent(a.updated_at)}` : null;
};

// "1280×720": nothing until the video has been read.
export const specs = (a: Asset) => (a.width && a.height ? `${a.width}×${a.height}` : "");

export type VideoActions = {
  onOpen: () => void;
  onMove: () => void;
  onTrash: () => void;
  onRestore: () => void;
  onPurge: () => void;
};

type Item = typeof MenuItem | typeof ContextMenuItem;
type Sep = typeof MenuSeparator | typeof ContextMenuSeparator;

/** The actions of one video, as items of a dropdown or of the right-click menu. */
export function videoItems(
  _a: Asset,
  trash: boolean,
  act: VideoActions,
  Item: Item,
  Sep: Sep,
): ReactNode {
  return trash ? (
    <>
      <Item onClick={act.onRestore}>
        <RefreshCw />
        Restore
      </Item>
      <Sep />
      <Item variant="destructive" onClick={act.onPurge}>
        <Trash2 />
        Delete forever
      </Item>
    </>
  ) : (
    <>
      <Item onClick={act.onOpen}>
        <Play />
        Open
      </Item>
      <Item onClick={act.onMove}>
        <FolderMove />
        Move to…
      </Item>
      {_a.status === "errored" && (
        <Item onClick={() => void retryVideo(_a.id)}>
          <RefreshCw />
          Try again
        </Item>
      )}
      <Sep />
      <Item variant="destructive" onClick={act.onTrash}>
        <Trash2 />
        Move to trash
      </Item>
    </>
  );
}

type Props = VideoActions & {
  asset: Asset;
  selected: boolean;
  /** Its side panel is open. */
  active?: boolean;
  onPeek: () => void;
  trash: boolean;
  list?: boolean;
  onSelect: (on: boolean) => void;
  onDragStart: (e: DragEvent) => void;
};

// What sits on the thumbnail: the same quiet pill for privacy and length.
const pill = "bg-background/90 shadow-xs backdrop-blur-sm";

/** A video as a card: a clean thumbnail with its privacy and length, then its name. Drag it onto a folder, click the thumbnail for the side panel, double-click to open, right-click for actions. */
export function VideoCard({
  asset,
  selected,
  active,
  onPeek,
  trash,
  onSelect,
  onDragStart,
  ...act
}: Props) {
  const badge = statusBadge[asset.status];
  const title = titleOf(asset);
  const ready = playable(asset);
  const image = <VideoThumb asset={asset} width={640} className="w-full" icon="size-6" />;
  const name = trash ? (
    <span className="block truncate text-sm font-medium" title={title}>
      {title}
    </span>
  ) : (
    <AppLink
      href={`/videos/${asset.id}`}
      draggable={false}
      title={title}
      className="block truncate text-sm font-medium hover:underline"
    >
      {title}
    </AppLink>
  );
  // Appear on hover or focus; phones use the side panel instead.
  const reveal = "transition-opacity sm:opacity-0 sm:group-hover/card:opacity-100 sm:group-focus-within/card:opacity-100";
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<li />}
        draggable
        onDragStart={onDragStart}
        onDoubleClick={() => !trash && act.onOpen()}
      >
        <div className="group/card min-w-0">
          <div
            className={cn(
              "relative overflow-hidden rounded-xl ring-1 ring-border transition-shadow",
              selected && "ring-2 ring-primary",
              active && !selected && "ring-2 ring-ring",
            )}
          >
            <button
              type="button"
              onClick={onPeek}
              aria-label={trash ? `Preview ${title}` : `Open ${title}`}
              className="block w-full cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              {image}
            </button>
            <Checkbox
              checked={selected}
              onCheckedChange={(c) => onSelect(c === true)}
              aria-label={`Select ${title}`}
              className="absolute top-2 left-2 bg-background shadow-sm transition-opacity data-checked:opacity-100 sm:opacity-0 sm:group-hover/card:opacity-100 sm:focus-visible:opacity-100"
            />
            {!trash && (
              <div className={cn("absolute top-2 right-2 hidden gap-0.5 rounded-lg bg-background p-0.5 shadow-xs empty:hidden sm:flex", reveal)}>
                {ready && (
                  <ShareDialog
                    asset={asset}
                    trigger={<Button size="icon-xs" variant="ghost" aria-label={`Share ${title}`} />}
                  >
                    <Share />
                  </ShareDialog>
                )}
                {ready && asset.playback_policy === "public" && (
                  <Button size="icon-xs" variant="ghost" aria-label={`Copy link to ${title}`} onClick={() => void copy(asset.embed_url, "Link")}>
                    <Link />
                  </Button>
                )}
              </div>
            )}
            {!trash && <PrivacyBadge policy={asset.playback_policy} className={cn("absolute bottom-2 left-2", pill)} />}
            {asset.duration_seconds ? (
              <Badge variant="outline" className={cn("absolute right-2 bottom-2 tabular-nums", pill)}>
                {timecode(asset.duration_seconds)}
              </Badge>
            ) : null}
          </div>
          <div className="flex items-start gap-1 pt-2">
            <div className="grid min-w-0 flex-1 gap-0.5">
              {name}
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {asset.status !== "complete" && (
                  <StatusBadge variant={badgeVariant(badge.tone)}>{badge.text}</StatusBadge>
                )}
                <span className="truncate tabular-nums">{ago(asset.created_at)}</span>
              </div>
            </div>
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Actions for ${title}`}
                  />
                }
              >
                <Ellipsis />
              </MenuTrigger>
              <MenuPopup align="end">
                {videoItems(asset, trash, act, MenuItem, MenuSeparator)}
              </MenuPopup>
            </Menu>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuPopup>
        {videoItems(asset, trash, act, ContextMenuItem, ContextMenuSeparator)}
      </ContextMenuPopup>
    </ContextMenu>
  );
}
