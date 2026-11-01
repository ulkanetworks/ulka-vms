# Changelog

What changed for people using Ulka VMS, newest first. Each month lists what is new and what was fixed.

## October 2026

### New

- **Video: Ulka VMS is open source.** Upload, encode, encrypt and play video on your own servers, with libraries and folders, private videos with signed links, captions, chapters, covers, MP4 downloads, an embeddable player, a viewer playback check, webhooks, API keys, members and usage. Licensed under the AGPL-3.0.
- **Video: deliver through any CDN.** Video can come straight from your server or through Ulka CDN, Cloudflare, CloudFront, Bunny, Fastly, Akamai or another CDN, with setup steps for each.
- **Video: technical details for every video.** A video's Technical tab shows its source, how it was encoded, the work it took and what is stored.
- **Workspace: install with one command.** `curl -fsSL https://github.com/ulkanetworks/ulka-vms/releases/latest/download/install.sh | sudo bash` asks for your domain and email settings, then installs and starts everything with HTTPS; running it again upgrades.
- **Video: keep video keys off your server.** With `KEY_SERVICE=securedrm`, each video's key is kept by SecureDRM, Ulka Networks' hosted key service, and players fetch it from there with a short-lived signed link.
- **Workspace: change a workspace's limits.** `ulka-vms limits` lists the workspaces, and `ulka-vms limits <workspace id> name=value` sets one's largest upload and encoding minutes a month.
