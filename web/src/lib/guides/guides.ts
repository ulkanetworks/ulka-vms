// How-to guides for customers. Bodies are a small text format read by Guide.tsx: `## heading`, `### subheading`,
// `- ` and `1. ` lists, ``` code fences, `> ` notes, `![alt](/src)` images, and inline `code`, **bold** and [links](/path). `{origin}` becomes this server's address.

export type Guide = { slug: string; group: string; title: string; summary: string; body: string };

export const guides: Guide[] = [
	{
		slug: 'getting-started',
		group: 'Start here',
		title: 'Getting started',
		summary: 'Your workspace, your team, and your first API call.',
		body: `Ulka VMS turns your videos into streams that play anywhere, keeps them encrypted on your own storage, and plays them in a player you can put on any page. Everything you can do in the console, a developer can also do with the API (a way for programs to talk to Ulka VMS).

## Your workspace
Everything you make lives in a workspace: videos, libraries, keys and people. You can belong to several; switch between them, or make a new one, from the workspace menu at the top of the sidebar.

## Invite your team
Open **Members** and invite people by email. Each person gets a role, which decides what they are allowed to change. See [Team and API keys](/docs/guides/team-and-keys) for what each role allows.

## Make an API key
An API key is a password for your own programs. Open **API keys**, choose **New key**, and pick which products it may use and whether it may only look or also make changes. The key is shown once: copy it somewhere safe.

Send the key with every request:

\`\`\`
curl {origin}/v1/me \\
  -H "Authorization: Bearer $ULKA_KEY"
\`\`\`

## Reading answers
Answers come in JSON, a plain text format programs can read. Lists come as \`{"data": [...]}\`; long lists (videos, API keys) come a page at a time, newest first: they take \`limit\` and return \`next_cursor\`, which you pass back as \`cursor\` for the next page (it's empty on the last).

When something goes wrong you get \`{"error": {"code": "..."}}\`. The code never changes meaning, so check for it rather than for the status or any wording. Every code is listed in the [API reference](/docs/api?s=errors).

## Next
- [Upload a video](/docs/guides/upload-video)
- [Play a video](/docs/guides/play-video)
- [Video delivery](/docs/guides/video-delivery)`
	},
	{
		slug: 'upload-video',
		group: 'Video',
		title: 'Upload a video',
		summary: 'Send a file, or have Ulka VMS fetch one from a link.',
		body: `A video starts as a file you send or a link Ulka VMS fetches. Ulka VMS then prepares it in several qualities so it plays smoothly on any connection.

## From the console
Open **Videos**, choose a library (a group of videos with its own settings) and drop a file on the page, or paste a link to import. You can leave the page while it prepares. See [Libraries and folders](/docs/guides/libraries).

## Send a file with the API
It takes three steps.

1. Ask for an upload:

\`\`\`
curl -X POST {origin}/v1/uploads \\
  -H "Authorization: Bearer $ULKA_KEY"
\`\`\`

The answer has an \`id\`, the \`upload_url\` to send the file to, and the largest file you may send, \`max_size\`.

2. Send the file to that address. From a terminal:

\`\`\`
curl -T video.mp4 "UPLOAD_URL"
\`\`\`

Or in the browser:

\`\`\`
await fetch(upload.upload_url, { method: "PUT", body: file });
\`\`\`

The upload address is the permission here, so your API key never goes to the browser. It works once, and only until \`expires_at\`.

**Large files, or a shaky connection?** Send the file in parts to the same \`upload_url\`. If the connection drops, you carry on from where it stopped instead of starting again. No extra library is needed: any HTTP client can do it.

- Each part is a \`PUT\` with a \`Content-Range\` header saying which bytes it holds and the whole file's size: \`bytes 0-52428799/734003200\` is the first 50 MB of a 700 MB file.
- Send the parts in order. Each answer says how much has arrived: \`{"received": 52428800, "size": 734003200, "complete": false}\`.
- After a break, \`GET\` the \`upload_url\` to learn how much arrived, and send the next part from \`received\`.
- The answer to the last part has \`"complete": true\`, and the video starts processing.

In the browser:

\`\`\`
const PART = 50 * 1024 * 1024;

async function sendFile(file, uploadUrl) {
  let at = (await (await fetch(uploadUrl)).json()).received; // 0 the first time
  while (at < file.size) {
    const end = Math.min(at + PART, file.size);
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Range": \`bytes \${at}-\${end - 1}/\${file.size}\` },
      body: file.slice(at, end),
    });
    if (!res.ok) throw new Error((await res.json()).error.message);
    at = (await res.json()).received;
    console.log(Math.round((at / file.size) * 100) + "%");
  }
}
\`\`\`

If \`sendFile\` fails, call it again: it asks how much arrived and carries on. A part that doesn't start where the upload stopped is refused with \`upload_offset_mismatch\`. A part starting at 0 starts the upload over. Parts can be any size; 10 to 100 MB suits most connections.

3. Turn the upload into a video:

\`\`\`
curl -X POST {origin}/v1/assets \\
  -H "Authorization: Bearer $ULKA_KEY" \\
  -d '{"upload_id": "UPLOAD_ID", "playback_policy": "public"}'
\`\`\`

Three more fields are optional: \`library_id\` and \`folder_id\` say where the video goes, and \`title\` names it. Without them the video goes to your main library, with the file's name as its title.

## Import from a link
If the file is already online, skip the upload:

\`\`\`
curl -X POST {origin}/v1/assets \\
  -H "Authorization: Bearer $ULKA_KEY" \\
  -d '{"input_url": "https://example.com/talk.mp4", "playback_policy": "public"}'
\`\`\`

The link must be public: no username or password in it.

## Deleting
\`DELETE /v1/assets/ASSET_ID\` deletes a video at once, for good. In the console, deleting moves a video to the trash for 30 days first: see [Libraries and folders](/docs/guides/libraries).

## Knowing when it's ready
The video's \`status\` goes \`waiting\`, \`processing\`, then \`ready\`: it plays from here, at lower qualities first. It becomes \`complete\` once every quality is done. Rather than asking over and over, add a [webhook](/docs/guides/webhooks) (Ulka VMS messages your server when something happens) and wait for \`asset.ready\` (or \`asset.errored\`).

Use \`passthrough\` to attach your own reference, like your database id. It comes back with the video and in every event about it.

## Description, tags, metadata and chapters
On a video's **Details** tab, give it a description and tags to find it by; the video list can show one tag's videos. Chapters name parts of the video, like Intro or Questions: viewers see them on the player's timeline and in its menu. Under **Advanced details**, metadata holds your own key and value pairs, like your app's id for the video.

Through the API, \`PATCH /v1/assets/{id}\` takes \`description\`, \`tags\` and \`metadata\` (a list of \`{"key", "value"}\`), and \`PUT /v1/assets/{id}/chapters\` sets the chapters (\`{"chapters": [{"title", "start_time", "end_time"}]}\`, in seconds). Find videos with \`GET /v1/assets?tag=launch\` or \`?metadata_key=order&metadata_value=42\`.

## Next
[Play a video](/docs/guides/play-video)`
	},
	{
		slug: 'libraries',
		group: 'Video',
		title: 'Libraries and folders',
		summary: 'Keep videos organised, and what the trash does.',
		body: `A **library** is a group of videos that share settings: how sharp the picture gets, whether an MP4 download is made, which websites may show the player, and how the player looks. Use one per website, client or project. Every workspace starts with a main library, which videos go to when you don't pick another.

## Folders
Inside a library, folders keep videos tidy, and folders can sit inside folders. Move a video by choosing **Move** on it. Folders only organise: they don't change how a video plays.

## Library settings
Open a library and choose **Settings**:
- **General**: its name, and deleting it. A library can only be deleted when it is empty, and the main library can't be deleted.
- **Player**: how the player looks and what it offers. See [The player](/docs/guides/player).
- **Transcoding**: how new videos are prepared. Pick a ready-made preset (Balanced, Best quality, Courses and slides, Data saver, Mobile first) or make your own: choose the sizes from 240p to 1080p and a quality (Fastest, Balanced, Sharpest). Also here: whether to make an MP4 for every new video. Changes apply to videos uploaded from then on; videos already there keep what they have.
- **Security**: who can watch new uploads (anyone, or only people your server allows) and which websites may show the player. See [The player](/docs/guides/player).

## The trash
Deleting a video in the console moves it to the trash. It stops playing there, and you can restore it for **30 days**. After that it is deleted for good. Open **Trash** in a library to restore a video or delete it right away.

## With the API
Send \`library_id\`, \`folder_id\` and \`title\` when you create a video (all optional), and list a library's videos with \`GET /v1/assets?library_id=LIBRARY_ID\`.`
	},
	{
		slug: 'player',
		group: 'Video',
		title: 'The player',
		summary: 'Make the player match your website, and put it on your page.',
		body: `the player is a ready-made video player you can show on your page with one line of code. Each library has its own look, so every video in it matches.

## Templates
Start from the template that fits, under **Settings → Player**. A template sets which controls show and how the video starts; your colour and logo stay.
- **Standard**: every control. For most videos and lessons.
- **Minimal**: play, the timeline, volume and full screen.
- **Preview**: starts by itself without sound and repeats, with simple controls.
- **Background**: no controls; starts without sound and repeats, for a moving background.

One embed can use another template without changing the library: add \`?template=background\` to its address.

## Make it yours
Open a library, then **Settings → Player**. You can change:
- the accent colour (the progress bar and the big play button) and a light or dark look
- a logo in the corner, and where it links to
- whether it starts by itself (muted, because browsers don't allow sound before a click), repeats, or starts muted
- whether there are controls at all, and which: speed, quality, captions, picture in picture, full screen
- the skip buttons that jump back or forward by 5, 10, 15 or 30 seconds

A live preview shows each change as you make it. It uses your latest video (a public one if there is one), so upload one first. Nothing changes for viewers until you choose **Save**.

## Put it on your page
Every video has its own page on the player's address: the library's ID, then the video's. Paste this where the video should appear (the video's **Share** shows it filled in):

\`\`\`
<iframe src="{player}/LIBRARY_ID/VIDEO_ID"
  style="aspect-ratio: 16/9; width: 100%; border: 0"
  allow="fullscreen; picture-in-picture" allowfullscreen></iframe>
\`\`\`

## Options in the address
Add these to the end of the address to change one embed without touching the library's settings: \`template\` (above), then \`autoplay\`, \`loop\`, \`muted\` and \`controls\` (each \`true\` or \`false\`), \`preload=true\` to start loading before anyone presses play, and \`t=30\` to start 30 seconds in. For example \`{player}/LIBRARY_ID/VIDEO_ID?autoplay=true&muted=true&t=30\`. With \`controls=false\` the player shows no buttons, for a page that drives it itself.

## Control it from your page
The player takes commands from the page it is on through the browser's postMessage, in the same format as docs.ulka.co's Player SDK, so \`@vidinfra/player\` works with it unchanged:

\`\`\`
import { Player } from "@vidinfra/player";

const player = new Player("#my-iframe");
await player.whenReady();
await player.play();
player.on("timeupdate", (s) => console.log(s.currentTime, s.duration));
\`\`\`

Commands: play, pause, togglePlay, seek, setVolume, mute, unmute, setMuted, setPlaybackRate, toggleFullscreen, showControls, hideControls, and the getters (getCurrentTime, getDuration, getPaused, getVolume, getMuted, getPlaybackRate). Events: ready, play, playing, pause, ended, timeupdate, volumechange, seeking, seeked, waiting, canplay, loadedmetadata, durationchange, ratechange, fullscreenchange and error, each with the current time, length, volume and whether it is paused.

## Private videos
A private video needs a signature from your server on the end of its address: \`{player}/LIBRARY_ID/VIDEO_ID?token=SIGNATURE\`. See [Play a video](/docs/guides/play-video) for how to make one.

## Distributions and countries
Under **Settings → Security**, choose which websites may show the player: any website, only the ones you list, or every website except the ones you list. Entries look like \`example.com\` or \`*.example.com\` (the distribution and all its subdomains). Elsewhere, the player says the video can't be played there.

Below it, choose the countries viewers can watch from: everywhere, only the ones you list, or everywhere except them: type a country's name and pick it (the API takes two-letter codes like \`BD\` or \`US\`). The country is found from each viewer's internet address, and the rule holds on the video stream itself too, not only the player. Through the API, a library takes \`allowed_domains\` or \`blocked_domains\`, \`country_mode\` (\`allow\` for everywhere but \`countries\`, \`deny\` for only \`countries\`) and \`countries\`.

> These stop casual copying and keep videos to the places you choose. Someone determined can still reach a public video's address, or use a network that hides their country. To really protect a video, make it signed.`
	},
	{
		slug: 'play-video',
		group: 'Video',
		title: 'Play a video',
		summary: 'Video addresses, the hosted player, and keeping videos private.',
		body: `Every video is watched at one address on the player, made of its library's ID and its own: \`{player}/LIBRARY_ID/VIDEO_ID\`. The IDs never change, so a link you share keeps working. Everything for the video sits beside it, at the same address plus a file name.

## Public or private
- **Public**: anyone with the address can watch.
- **Private**: the address works only with \`?token=\` and a signature your server makes for each viewer. Use this for paid or private videos.

Choose when you create the video (\`playback_policy\`: \`public\` or \`signed\`), or change it later; the address stays the same:

\`\`\`
curl -X PATCH {origin}/v1/assets/VIDEO_ID \\
  -H "Authorization: Bearer $ULKA_KEY" \\
  -d '{"playback_policy": "public"}'
\`\`\`

Every video in the API comes with its \`embed_url\` and \`playback_url\` filled in.

## Use our player
The simplest way: put the player in an iframe. Captions come with it, and you can change how it looks: see [The player](/docs/guides/player).

\`\`\`
<iframe src="{player}/LIBRARY_ID/VIDEO_ID"
  style="aspect-ratio: 16/9; width: 100%; border: 0"
  allow="fullscreen; picture-in-picture" allowfullscreen></iframe>
\`\`\`

## Use your own player
Any player that understands HLS (the common way to stream video) works: Shaka Player, hls.js, and Safari and phones do it themselves.

\`\`\`
{player}/LIBRARY_ID/VIDEO_ID/playlist.m3u8
\`\`\`

Pictures from the video are beside it too (for covers and previews):
- \`poster.webp\`: the thumbnail, the picture shown before playing (\`?width=\` to resize)
- \`thumbnail.jpg?time=30&width=640\`: a frame at 30 seconds
- \`storyboard.vtt\`: previews while scrubbing

### Choose the thumbnail
The thumbnail is a frame a tenth of the way in until you choose another. Open the video and pick one of the frames under **Thumbnail**, or upload a picture of your own (JPEG, PNG, WebP, GIF or HEIF, up to 25 MB). With the API:

\`\`\`
curl -X PUT {origin}/v1/assets/VIDEO_ID/poster \\
  -H "Authorization: Bearer $ULKA_KEY" \\
  -d '{"time": 12.5}'

curl -X PUT {origin}/v1/assets/VIDEO_ID/poster/image \\
  -H "Authorization: Bearer $ULKA_KEY" \\
  --data-binary @cover.jpg
\`\`\`

\`{"time": null}\` goes back to the default. The video's \`poster\` says which is in use and lists the suggested frames. the player and your library show a new choice at once; other places that use the plain \`poster.webp\` address can show the old one for up to five minutes.

## Private videos
A private video plays only from an address with a signature on it. The signature says which video it opens and until when, and only someone who holds your **signing key** can make one. Viewers never see the key, and a copied address stops working when its time runs out.

You need this only when not everyone should watch: paid courses, members-only videos, client work. If all your videos are public, skip this section.

### How it works
1. A visitor opens a page on your website with a private video on it.
2. Your server decides whether they may watch (signed in, paid, and so on). If not, it shows them nothing.
3. If they may, your server makes a signed address for that video, valid for a while, and puts it in the page.
4. The visitor's player loads the video from that address. Ulka VMS checks the signature, then plays it.
5. If someone copies the address and shares it, it stops working once its time is up. Without your key, nobody can make a new one.

A signed address looks like this (the part after \`?token=\` is the signature):

\`\`\`
{player}/LIBRARY_ID/VIDEO_ID?token=exp%3D1767225600~acl%3D%252FLIBRARY_ID%252FVIDEO_ID%252F%252A~kid%3DKEY_ID~hmac%3D3f9a…
\`\`\`

It reads: works until \`exp\` (a time), opens what \`acl\` names (this video), signed with key \`kid\`, and \`hmac\` is the proof only your secret can make. Change any part and Ulka VMS refuses it.

### Three ways to sign
- **Make a signed link** in the console: one link by hand, to send to a reviewer or a client. Nothing to build.
- **Ask Ulka VMS** (\`POST /v1/signed-urls\`): your server calls Ulka VMS with an API key and gets the address back. The simplest for a website.
- **Sign it yourself**: your server makes the signature with the signing key's secret, without calling Ulka VMS. The fastest, and it works even if your server can't reach Ulka VMS.

All three make the same kind of address, and Ulka VMS checks them the same way.

### What a signing key is
A signing key is a secret shared by your server and Ulka VMS, and it has one job: making those signatures. Your server signs with it; Ulka VMS checks each signature against it before playing anything.
- It isn't an **API key**: an API key lets your server call the Ulka VMS API. A signing key never goes in a request; only the signatures it makes do.
- One workspace's keys open every library in it. Public videos ignore them.

Make one under **Video → Video signing keys**, or with \`POST /v1/signing-keys\`. You get a **key ID**, which goes in every signature, and a **secret**, shown once and never again. Keep the secret on your server only, never in a web page or app. Anyone in the workspace who can change videos (members, admins, owners) can make and delete keys.

Until a workspace has a key, its private videos can't play anywhere, and the console can't preview them.

### Several keys, and replacing one
Every key you have works at the same time, so a key can be replaced without a gap:
1. Make a new key and put its ID and secret on your server.
2. Sign with the new one from then on.
3. Delete the old key once links signed with it have run out (the longest time you sign for).

When Ulka VMS signs for you (\`/v1/signed-urls\`, **Make a signed link**), it uses your newest key.

Deleting a key ends every link signed with it at once, even ones still playing. Do it straight away if a secret leaks.

### Share one video now
To share one video with someone now (a reviewer, a client), open it, go to **Playback** and choose **Make a signed link**: pick how long it works, and optionally one viewer's internet address and a watermark.

### Sign for your website
For your website, your server makes one for each viewer. Ask Ulka VMS for a signed address:

\`\`\`
curl -X POST {origin}/v1/signed-urls \\
  -H "Authorization: Bearer $ULKA_KEY" \\
  -d '{"video_id": "VIDEO_ID", "expires_in": 3600}'
\`\`\`

The answer has the \`embed_url\` and \`playback_url\` to use, with the signature already on them as \`?token=\`. Player options go after it (\`&autoplay=true\`). Add \`"scope": "library"\` for one signature that opens every video in the library, or \`"ip"\` to let only one viewer's internet address use it.

\`expires_in\` is in seconds, from 60 to 86400 (24 hours), and is 3600 (an hour) when left out. A watermark is up to 64 characters on one line.

### Sign it yourself
You can also sign without calling Ulka VMS. A signature is these fields joined by \`~\`, each value URL-encoded, then \`~hmac=\` and the HMAC-SHA256 (in hex) of everything before it, made with the key's secret (it's base64; decode it first):
- \`exp\`: when it stops working, in seconds since 1970
- \`acl\`: what it opens: \`/LIBRARY_ID/VIDEO_ID/*\` for one video, \`/LIBRARY_ID/*\` for a library
- \`kid\`: the signing key's ID
- \`ip\` and \`wm\` (optional): one viewer's address, and a watermark

Write a \`~\` inside a value as \`%7E\` (JavaScript's \`encodeURIComponent\` leaves it as it is), or the signature splits in the wrong place.

\`\`\`
import { createHmac } from "node:crypto";

const secret = Buffer.from(process.env.ULKA_SIGNING_SECRET, "base64");
const video = "/LIBRARY_ID/VIDEO_ID";
const exp = Math.floor(Date.now() / 1000) + 3600;
const signed = \`exp=\${exp}~acl=\${encodeURIComponent(video + "/*")}~kid=\${process.env.ULKA_SIGNING_KEY_ID}\`;
const signature = signed + "~hmac=" + createHmac("sha256", secret).update(signed).digest("hex");

const token = "?token=" + encodeURIComponent(signature);
const page = "{player}" + video + token;                    // for the iframe
const stream = "{player}" + video + "/playlist.m3u8" + token;  // for your own player
\`\`\`

### How long should a link last?
The time limit is on the link, not on the viewer: your website makes a new link every time someone it lets in opens the video, so people who paid keep watching. The limit only stops a copied link from working later. Starting a video needs a link that hasn't expired; once it has started, it plays to the end (the video's length plus an hour). A few hours suits most distributions.

### What viewers see
When a link doesn't work, the player says why, in place of the video:
- **"This video needs a signed token to play."** The address has no signature: the page used the plain address of a private video.
- **"The playback token has expired."** The link's time is up. Opening the page again gets a new one, if your website makes one each time.
- **"The playback token is not valid."** The signature was changed, made with the wrong secret or a deleted key, opens a different video, or is limited to another internet address.

To find out which, use **Check a viewer's link** below.

### Common questions
- **Does every viewer need their own link?** No. One link works for anyone who has it until it expires. Making one per page view keeps the time short, so a shared copy dies quickly.
- **Can viewers keep watching past the expiry?** Yes. Expiry only stops a video from starting. Once started, it plays to the end.
- **Do I sign the player's files too?** No. Sign the video once. The player passes the signature on to the playlist, qualities, subtitles and pictures by itself.
- **What if my secret leaks?** Make a new key, switch your server to it, then delete the old one. Links signed with the old key stop at once.
- **Does it work with my own player?** Yes. Sign the \`playlist.m3u8\` address the same way. Only the watermark needs the player.
- **Whose clock counts?** The server's. If your server's clock is wrong, links can arrive already expired: keep it set automatically.

## When a video won't play
Open the video and go to **Troubleshoot**, then choose **Check**. We play it from our server the way a player on your website does and show each part: the player's settings, the playlist, every quality and every subtitle, with what failed and why.

- Enter the page it's embedded on to check your library's list of websites that may show it.
- "Browsers would refuse it" means a server in between sends the wrong sharing header (Access-Control-Allow-Origin): browsers block the video even though a download tool gets it.
- "Doesn't unlock into video" means the files are damaged: process the video again.

> Country rules aren't checked here, since the check runs from our server, not your viewer's country.

### When it plays for some viewers and not others
Use **Check a viewer's link** on the same tab. Paste the address that viewer's player loads (with its \`?token=\`), and if you can, the page and the viewer's IP address. It says which rule refuses it:

- **Expired:** your server signed the address too early, or the page stayed open past its expiry. Sign each address when the page loads.
- **Signing key it names isn't there:** the key was deleted. Sign with a current one.
- **Doesn't match its key:** the secret is wrong, or something changed the address after signing.
- **Signed for something else:** the \`acl\` doesn't include this video.
- **Works only from one IP address:** viewers on phones or VPNs change address. Sign without \`ip\`.
- **Distribution or country:** change the library's **Who can watch**.

### Let the viewer check
When it fails only for one viewer, have them run the **playback check** in their own browser: right-click the player and choose **Troubleshoot playback**, or open \`{player}/check\` and paste the video's address. It runs each step their player takes (their connection, device clock, the link, your library's rules, their browser, the key, our video servers, and five seconds of playback) and says in plain words what to do. It also lists the browsers, phones and TVs the video plays on.

They can send you the results: they get a code like \`UL-7K3M9Q\`, and the report appears under **Viewer reports** on the video's **Troubleshoot** tab, kept 30 days.

## Watermark
To discourage screen recording, sign the address with a watermark (\`"watermark"\` in \`/v1/signed-urls\`, or \`wm\` when you sign), like the viewer's email. the player shows it over the video and moves it around. It is part of the signature, so it can't be edited out.

> A watermark only shows in the player. With your own player, draw it yourself.`
	},
	{
		slug: 'captions-downloads',
		group: 'Video',
		title: 'Captions and downloads',
		summary: 'Add subtitles in any language, and offer an MP4 to save.',
		body: `## Captions
Add a caption file to a video, in WebVTT or SRT (SRT is converted for you), up to 1 MB. A video can have up to 20 tracks.

In the console, open the video and use **Captions**. With the API, send the file itself as the body, and say its language and the name viewers see:

\`\`\`
curl -X POST "{origin}/v1/assets/ASSET_ID/captions?language=en&name=English" \\
  -H "Authorization: Bearer $ULKA_KEY" \\
  --data-binary @english.srt
\`\`\`

Players pick up new tracks straight away, including the player. The language is a code like \`en\`, \`bn\` or \`pt-BR\`.

## MP4 downloads
Streams can't be saved as one file. When viewers need one, for watching offline, ask Ulka VMS to make an MP4:

\`\`\`
curl -X POST {origin}/v1/assets/ASSET_ID/download \\
  -H "Authorization: Bearer $ULKA_KEY"
\`\`\`

or send \`"download": true\` when you create the video. When it's done you get \`asset.download_ready\`, and the file is at:

\`\`\`
{player}/LIBRARY_ID/VIDEO_ID/download.mp4
\`\`\`

It follows the video's rules: a private video needs \`?token=\` with a signature, as for playback. Remove it with \`DELETE /v1/assets/ASSET_ID/download\`.`
	},
	{
		slug: 'video-delivery',
		group: 'Video',
		title: 'Video delivery',
		summary: 'Serve videos straight from this server, or through a CDN.',
		body: `A video is thousands of small files that never change, which is what a CDN (a network of servers close to viewers) is best at. Delivery decides where viewers fetch those files from. Change it under **Video → Defaults → Delivery**. Video addresses don't change, so nothing on your website needs updating.

- **Through a CDN**: Ulka CDN, Cloudflare, CloudFront, Bunny, Fastly, Akamai or another. The Delivery page shows the steps for each, and the address to point it at.
- **Directly from this server**: no CDN. Simplest, and fine while audiences are small.

Playlists and keys always come from this server itself: they're tiny, and they carry each viewer's permission, so signed videos stay protected whichever you choose.

Video sent straight from this server shows on your [usage](/docs/guides/usage); what your CDN sends is counted by the CDN.`
	},
	{
		slug: 'team-and-keys',
		group: 'Workspace',
		title: 'Team and API keys',
		summary: 'Who can do what, and keys that can do only what they need.',
		body: `## Roles
Everyone in a workspace has one role:
- **Viewer**: sees everything, changes nothing.
- **Member**: uploads, changes and deletes videos.
- **Admin**: also manages webhooks, people, API keys and workspace settings.
- **Owner**: everything, including making other owners.

You can only give roles up to your own.

## API keys
Give each key only what it needs. For each product (video, webhooks) a key can have no access, **read**, or **read and write**. A key that lacks a permission is refused with \`insufficient_scope\`, and the API reference lists which permission each operation needs.

Keys can also have:
- an **expiry date**, after which they stop working;
- an **IP allow list**, so they only work from your servers (anyone else gets \`ip_not_allowed\`).

The API keys page shows when each key was last used, so unused ones are easy to spot and remove.

> A key belongs to the workspace, not to the person who made it. It keeps working when they leave; remove it if it should stop.

> API keys call the API. They are not the **video signing keys** that sign private videos' addresses: see [Play a video](/docs/guides/play-video).`
	},
	{
		slug: 'usage',
		group: 'Workspace',
		title: 'Usage and notifications',
		summary: 'What you use, your limits, and what needs your attention.',
		body: `## Usage
**Usage** shows, for each month:
- **processing**: minutes of video prepared for playing;
- **storage**: minutes of video kept, averaged over the month;
- **video delivered**: data this server sent to viewers, and how many requests.

The same numbers are at \`GET /v1/usage?month=2026-09\`. Your workspace's limits, and how much of each is used, are at \`GET /v1/limits\`.

## Notifications
The bell at the top shows what needs your attention: videos that failed, an API key about to expire, or a limit nearly reached. They clear themselves once the problem is fixed. The same list is at \`GET /v1/notices\`.`
	},
	{
		slug: 'webhooks',
		group: 'Developers',
		title: 'Webhooks',
		summary: 'Hear about changes as they happen, and check they came from Ulka VMS.',
		body: `A webhook is a message Ulka VMS sends to your server when something happens, like a video becoming ready, so your server doesn't have to keep asking.

## Add an address
Open **Webhooks** and add an https address on your server, with a name if you like. Choose **every event**, or only the ones your app needs (say, only when a video is ready or fails); you can change that later, and switch an address off without removing it. You get a **secret** (a password only you and Ulka VMS know) once: keep it to check messages.

By API: \`POST /v1/webhook-endpoints\` with \`url\`, an optional \`name\` and \`events\` (empty for every event); \`PATCH /v1/webhook-endpoints/{id}\` changes any of them or sets \`enabled\`. The list of events is \`webhook_events\` in \`GET /v1/meta\`.

Every event is a POST with a JSON body:

\`\`\`
{
  "id": "evt_...",
  "type": "asset.ready",
  "created_at": "2026-09-29T10:00:00Z",
  "data": { ... }
}
\`\`\`

Every event and what's in \`data\` is listed in the [API reference](/docs/api?s=events).

## Check it came from Ulka VMS
Each request has a \`Ulka-Signature\` header like \`t=1790000000,v1=5f2b...\`. \`v1\` is the HMAC-SHA256 (a code made from the secret), in hex, of the time, a dot and the raw body, using your secret as the key. Refuse the request if it doesn't match or if \`t\` is more than a few minutes old.

\`\`\`
import crypto from "node:crypto";

function fromUlka(header, rawBody, secret) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const expected = crypto.createHmac("sha256", secret)
    .update(parts.t + "." + rawBody).digest("hex");
  const got = Buffer.from(parts.v1 ?? "");
  const fresh = Math.abs(Date.now() / 1000 - Number(parts.t)) < 300;
  return fresh && got.length === expected.length && crypto.timingSafeEqual(Buffer.from(expected), got);
}
\`\`\`

Use the body exactly as it arrived: parsing and re-writing the JSON changes it and the check fails.

## Answering
Reply with any 2xx within 15 seconds. Anything else, or no answer, is tried again: after 10 seconds, then twice as long each time up to an hour apart, for up to 24 hours.

An event can arrive more than once, and not always in order. Use its \`id\` to skip ones you've already handled, and fetch the latest state from the API when order matters.`
	}
];

export const groups = [...new Set(guides.map((g) => g.group))];

// A `## heading`'s anchor, shared by the guide and its "On this page" list.
export const headingId = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
