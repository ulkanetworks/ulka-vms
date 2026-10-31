# React Doctor findings checked and rejected

Each holds only while its predicate does; re-check when the code it names changes.

- **jsx-key** on `[label, value]` fact rows (`routes/_admin/admin/jobs/$id.tsx`, `routes/_admin/admin/jobs/index.tsx`):
  the element is the single `value` of a row tuple, not a sibling in a list. `Facts` (`components/Facts.tsx`) maps the
  rows and keys each one itself.
- **effect-needs-cleanup** on `player.addEventListener('error', …)` (`components/player/Player.tsx`): the listener is on the
  Shaka player, and the effect's cleanup calls `overlay.destroy()`, which destroys that player and its listeners.
- **no-create-object-url-without-revoke** (`components/player/Player.tsx`): the chapters URL is revoked in the same cleanup.
- **media-has-caption** (`components/player/Player.tsx`): captions are added by Shaka from the stream, not as `<track>` children.
- **anchor-has-content** (`routes/_app/videos/$id.tsx`, `routes/docs.tsx`): the `<a>` is a `Button`'s `render`
  element; the button's children are its content.
- **no-static-element-interactions** (`routes/_app/cdn/certificates.tsx`): the span only stops a rename's clicks from
  opening the row; it isn't a control.
- **no-loading-flag-reset-outside-finally** where the success path closes the dialog or navigates away (NewDistribution,
  NewFolder, certificates, distribution delete, leave workspace, trash a video, new library, act as): the button stays busy
  on purpose until the page changes; failures reset it in `catch`. Where `save` (`lib/save.ts`) is awaited it never
  throws.
- **no-derived-useState** on edit drafts keyed by their saved data (SecurityEditor, TranscodingEditor, AboutVideo,
  VideoMetadata, library General): the key remounts the draft when the saved value changes.
- **components/ui/***: coss components, used as they come (.claude/rules/console.md); findings there are not changed here.
- **no-layout-property-animation** (`components/player/skin/menu.ts`, `components/player/player.css`): the settings
  card's morph between pages and the volume slider sliding out animate width and height on purpose; both are a few
  elements for 150–250 ms.
