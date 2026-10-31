---
paths:
  - "transcoder/**"
  - "e2e/{encode,scheduler,framerate,presets}_test.go"
---
# Encoding (`transcoder`)
- Imports only `core`. The owner of the videos implements `transcoder.Hooks` (`video.Hooks`); `video` starts work
  with `transcoder.Start` and reads progress through `ProgressOf` and `Tasks`. The one database link out is
  `encode_tasks` → `assets`.
- Anything that opens a customer's file goes through `sandboxed` and `fromUpload`: empty environment, `ulimit` caps,
  and a protocol and format whitelist that refuses playlists and concat lists. Never run ffmpeg any other way. Not
  isolated: network and filesystem.
- Probe only inserts `encode_tasks` rows (no River job per piece). Nodes claim pieces with `scheduler_claim`
  (workspaces take turns, a cap per workspace, fast lane first, one lease per piece), renew their leases, give
  failures back with `scheduler_release` and record progress with `scheduler_progress` (shown only for leased pieces,
  so a failed try shows nothing). A lapsed lease is just a waiting task; `encode_sweep` fails videos whose tasks ran
  out of tries. A node's capacity is `WORKER_ENCODE_SLOTS`.
- Code a node runs uses its own `core.Deps` with `River` set; never `river.ClientFromContext`. Probe, package and
  storyboard stay River jobs.
- A preset (built-in template or the workspace's own) is applied at probe by `MakePlan` and recorded in the plan;
  plans made earlier keep what they recorded.
- Above 30 fps, rungs below 720p encode at half the frame rate (a `Rung`'s `Half`), only when the GOP has an even frame
  count so keyframes stay on the same moments (`TestSmallRungsAtHalfFrameRate`).
- Encoded pieces are deleted when a video completes: anything built later works from the published HLS (fMP4; media
  segments AES-128-CBC with the asset's key and IV, init segments clear; `DecryptSegment`).
