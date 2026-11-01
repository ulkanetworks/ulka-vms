# Running Ulka VMS on your own server

Ulka VMS runs on one Ubuntu or Debian server, reachable over HTTPS at three addresses of your own. Videos are kept in
S3-compatible storage you choose (AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO or another), so the server's disk
only holds the database and work in progress.

## Before you start: storage

In your storage provider's dashboard, make a **private** bucket and an access key that may read, write and delete in
it. Nothing needs to be public: Ulka VMS reads the bucket with that key and serves the videos itself. Note four things:
the storage address (S3 endpoint, like `https://s3.eu-central-1.amazonaws.com` or
`https://<account>.r2.cloudflarestorage.com`), the region (`auto` on R2), the bucket name, and the key with its secret.

## The quick way: one command

1. Point three names at your server: `videos.`, `player.` and `origin.` under your domain, each an A record to the
   server's public address.
2. On the server, run:
   ```sh
   curl -fsSL https://github.com/ulkanetworks/ulka-vms/releases/latest/download/install.sh | sudo bash
   ```
   It asks for your domain, your email service's SMTP address and your storage details, checks the bucket works and
   the names point at the server, installs everything, makes every other secret, and starts it with HTTPS. It takes
   about five minutes.
3. Open `https://videos.<your domain>/signup` and create your account.

To upgrade later, run the same command: your settings and videos stay. To install without questions (from a script),
set `DOMAIN`, `SMTP_URL`, `MAIL_FROM` and the five `S3_` settings (`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`) in the environment first.

The rest of this guide does the same by hand, for those who want to see or change each step.

## By hand

Every command runs on the server as a user with `sudo`. It takes about an hour.

### What you need

- **A server** with Ubuntu 24.04, a public IP address, and at least 4 CPU cores, 8 GB of memory and 40 GB of disk.
  Encoding is the heavy part: more cores make videos ready sooner.
- **Storage:** the bucket and key from "Before you start".
- **A domain** where you can add DNS records. The guide uses `example.com`; put your own everywhere.
- **An email service** that can send through SMTP (or a Resend account), for invitations and password resets.

### 1. Point three names at the server

Add three A records (and AAAA records if the server has IPv6), each pointing at the server's address:

| Name | For |
|---|---|
| `videos.example.com` | the console, the guides and the API |
| `player.example.com` | where viewers watch and where embedded players load |
| `origin.example.com` | the video files themselves |

Wait until `dig +short videos.example.com` answers with the server's address before step 8: HTTPS certificates are
issued only for names that already point here.

### 2. Install what it runs on

```sh
sudo apt update && sudo apt upgrade -y
sudo apt install -y git ffmpeg webp curl ufw

# Docker, for Postgres and ClickHouse
curl -fsSL https://get.docker.com | sudo sh

# Shaka Packager, which turns encoded video into streams
sudo curl -fsSL -o /usr/local/bin/packager \
  https://github.com/shaka-project/shaka-packager/releases/download/v3.9.3/packager-linux-x64
sudo chmod 0755 /usr/local/bin/packager

# Caddy, the HTTPS front door (official package)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

# Go and Node, to build Ulka VMS
curl -fsSL https://go.dev/dl/go1.27.3.linux-amd64.tar.gz | sudo tar -C /usr/local -xz
echo 'export PATH=$PATH:/usr/local/go/bin' | sudo tee /etc/profile.d/go.sh && . /etc/profile.d/go.sh
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt install -y nodejs
```

On an ARM server, use `packager-linux-arm64` and `go1.27.3.linux-arm64.tar.gz` instead.

Let only SSH and web traffic in. Docker publishes its ports on 127.0.0.1 only, so the databases stay private:

```sh
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable
```

### 3. Get Ulka VMS

```sh
sudo useradd --system --home /opt/ulka-vms --shell /usr/sbin/nologin ulka-vms
sudo git clone https://github.com/ulkanetworks/ulka-vms.git /opt/ulka-vms
cd /opt/ulka-vms
sudo git checkout v0.1.0          # the latest release: see the repository's Releases page
sudo chown -R "$USER" /opt/ulka-vms
```

### 4. Write the settings

```sh
sudo mkdir -p /etc/ulka-vms
sudo cp /opt/ulka-vms/.env.example /etc/ulka-vms/ulka-vms.env
sudo chown root:ulka-vms /etc/ulka-vms/ulka-vms.env && sudo chmod 640 /etc/ulka-vms/ulka-vms.env
sudo nano /etc/ulka-vms/ulka-vms.env
```

Change these, and leave the rest as they are:

| Setting | Value |
|---|---|
| `POSTGRES_PASSWORD`, `ULKA_APP_PASSWORD`, `CLICKHOUSE_PASSWORD` | each a new random value: `openssl rand -hex 24` |
| `SEAL_KEY` | `openssl rand -base64 32`. It encrypts every video's key: **copy it somewhere safe off the server**. Without it, stored videos can't be played. |
| `PUBLIC_URL`, `DOCS_URL` | `https://videos.example.com` |
| `PLAYER_URL` | `https://player.example.com` |
| `ORIGIN_URL` | `https://origin.example.com/s` |
| `MAIL_PROVIDER`, `MAIL_FROM`, `SMTP_URL` | `smtp`, a sender like `Videos <videos@example.com>`, and `smtp://user:password@smtp.example.com:587` (or `resend` with `RESEND_API_KEY`) |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | your storage details |

Delete the `COMPOSE_FILE` line (it adds development's stand-in storage) and the `# Tests` lines at the end.

Start-up checks these settings. Anything that only works on a laptop, such as a `localhost` address, `MAIL_PROVIDER=log`
or an `example.com` address, stops it with a message saying which setting to fix.

### 5. Start the data services

```sh
cd /opt/ulka-vms
sudo docker compose --env-file /etc/ulka-vms/ulka-vms.env up -d
```

### 6. Build, check the storage and prepare the database

```sh
cd /opt/ulka-vms
go build -o bin/ulka-vms ./cmd/ulka-vms
(cd web && npm ci && npm run build)
sudo sh -c 'set -a; . /etc/ulka-vms/ulka-vms.env; set +a; exec /opt/ulka-vms/bin/ulka-vms check-storage'
sudo sh -c 'set -a; . /etc/ulka-vms/ulka-vms.env; set +a; exec /opt/ulka-vms/bin/ulka-vms migrate'
sudo chown -R ulka-vms:ulka-vms /opt/ulka-vms
```

`check-storage` writes, reads back and deletes a small file in the bucket; if it fails, its message says which.

### 7. Run the API, the worker and the origin as services

```sh
sudo cp /opt/ulka-vms/deploy/systemd/ulka-vms-{api,worker,origin}.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ulka-vms-api ulka-vms-worker ulka-vms-origin
systemctl status ulka-vms-api ulka-vms-worker ulka-vms-origin --no-pager
```

All three should say `active (running)`. If one doesn't, `journalctl -u ulka-vms-api -n 50` (or `-worker`, `-origin`)
says why. The origin serves the video files from your bucket at `origin.example.com`.

### 8. Put HTTPS in front

```sh
sudo cp /opt/ulka-vms/deploy/Caddyfile /etc/caddy/Caddyfile
sudo cp /opt/ulka-vms/deploy/caddy.env.example /etc/ulka-vms/caddy.env
sudo nano /etc/ulka-vms/caddy.env          # your three names; WEB_ROOT=/opt/ulka-vms/web/dist
sudo mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=/etc/ulka-vms/caddy.env\n' | sudo tee /etc/systemd/system/caddy.service.d/ulka-vms.conf
sudo systemctl daemon-reload && sudo systemctl restart caddy
```

Caddy gets a certificate for each name by itself. `journalctl -u caddy -n 50` shows any problem, usually a name that
doesn't point at the server yet.

### 9. Make your account, then close sign-up

1. Open `https://videos.example.com/signup` and create your account. Your workspace is made with it.
2. Upload a short video under **Video → Libraries**, wait until it says **Ready**, and play it.
3. Stop strangers from signing up: set `SIGNUP=closed` in `/etc/ulka-vms/ulka-vms.env`, then
   `sudo systemctl restart ulka-vms-api`. Bring people in with **Members → Invite**.

Each workspace has limits: the largest upload (5 GB) and encoding minutes a month (600). To raise them:

```sh
sudo sh -c 'set -a; . /etc/ulka-vms/ulka-vms.env; set +a; exec /opt/ulka-vms/bin/ulka-vms limits <workspace id> encode_minutes_monthly=6000 max_upload_bytes=21474836480'
```

The same command with nothing after `limits` lists every workspace with its id.

## Optional: country rules

Libraries can allow or block countries. They need an IP-to-country database: DB-IP's free one (CC BY 4.0, credit
DB-IP on your website) is updated monthly:

```sh
sudo mkdir -p /opt/ulka-vms/data/geo
curl -fsSL "https://download.db-ip.com/free/dbip-country-lite-$(date -u +%Y-%m).mmdb.gz" | gunzip | sudo tee /opt/ulka-vms/data/geo/country.mmdb >/dev/null
```

Set `GEOIP_DB=/opt/ulka-vms/data/geo/country.mmdb` and restart the API.

## Optional: keep video keys off your server

Every video is encrypted with its own key. By default (`KEY_SERVICE=local`) the keys are sealed in your database and
your player host hands them to viewers. If you'd rather not hold keys yourself, SecureDRM, Ulka Networks' hosted key
service, can keep them: the server asks it for each video's key, and players fetch the key from SecureDRM with a
short-lived link the server signs.

Ask Ulka Networks for a SecureDRM account, then set the four values it gives you and restart the API and the worker:

```sh
KEY_SERVICE=securedrm
SECUREDRM_URL=https://b.securedrm.link
SECUREDRM_API_KEY=...
SECUREDRM_TOKEN_KID=...
SECUREDRM_TOKEN_SECRET=...
```

Switch before uploading: videos encrypted with database keys keep playing only while `KEY_SERVICE=local`.

## Backups

What to keep, and how:

- **`SEAL_KEY` and the settings file**, off the server, in a password manager. They never change.
- **The database**, every night, copied off the server:
  ```sh
  cd /opt/ulka-vms && sudo sh -c '. /etc/ulka-vms/ulka-vms.env; docker compose --env-file /etc/ulka-vms/ulka-vms.env exec -T postgres pg_dump -U postgres -Fc "$POSTGRES_DB"' > ulka-vms-$(date +%F).dump
  ```
- **The videos**: in your storage provider. Turn on its versioning or replication, or copy the bucket to another
  store with any S3 tool, such as `rclone sync`.

Test a restore before you need one.

## Updating

Read [CHANGELOG.md](CHANGELOG.md) first. If you installed with the one command, run it again: it also adds
settings a new release needs, with their defaults. By hand, copy any setting in `.env.example` that your settings file
lacks, then:

```sh
cd /opt/ulka-vms
sudo git fetch --tags && sudo git checkout v0.2.0          # the new release
sudo chown -R "$USER" /opt/ulka-vms
go build -o bin/ulka-vms ./cmd/ulka-vms && (cd web && npm ci && npm run build)
sudo docker compose --env-file /etc/ulka-vms/ulka-vms.env up -d
sudo sh -c 'set -a; . /etc/ulka-vms/ulka-vms.env; set +a; exec /opt/ulka-vms/bin/ulka-vms migrate'
sudo chown -R ulka-vms:ulka-vms /opt/ulka-vms
sudo systemctl restart ulka-vms-api ulka-vms-worker
```

## When it grows

- **More encoding:** run more workers on other machines. Each needs the same settings, with the database and
  ClickHouse reachable from it over a private network, and only `ulka-vms-worker` running.
- **More viewers:** put a CDN in front of the origin under **Video → Defaults → Delivery**. The page has the steps
  for each CDN, Ulka CDN among them.
