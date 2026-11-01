#!/usr/bin/env bash
# Installs Ulka VMS on an Ubuntu or Debian server, or upgrades an existing install to the latest release:
#
#   curl -fsSL https://github.com/ulkanetworks/ulka-vms/releases/latest/download/install.sh | sudo bash
#
# It asks for your domain and email settings (or reads DOMAIN, SMTP_URL and MAIL_FROM from the environment), makes
# every secret, and starts everything. Run it again to upgrade: your settings and videos stay.
# ULKA_VMS_ARCHIVE=/path/to/ulka-vms-linux-<arch>.tar.gz installs from a file instead of downloading.
set -euo pipefail

# Everything runs inside main, called on the last line: bash reads a piped script as it goes, and a command that reads
# its input would otherwise swallow the rest of the script.
main() {

REPO="ulkanetworks/ulka-vms"
APP_DIR="/opt/ulka-vms"
CONFIG_DIR="/etc/ulka-vms"
SETTINGS="$CONFIG_DIR/ulka-vms.env"
PACKAGER_VERSION="v3.9.3"

# --- Output -------------------------------------------------------------------------------------------------------

bold=$(tput bold 2>/dev/null || true); dim=$(tput dim 2>/dev/null || true); reset=$(tput sgr0 2>/dev/null || true)
step() { printf '\n%s==> %s%s\n' "$bold" "$1" "$reset"; }
note() { printf '    %s\n' "$1"; }
fail() { printf '\n%sCould not finish:%s %s\n' "$bold" "$reset" "$1" >&2; exit 1; }
# Everything a step prints goes to the log; on failure, its last lines say why.
LOG=$(mktemp /tmp/ulka-vms-install.XXXXXX.log)
quiet() {
  local out; out=$(mktemp)
  if "$@" >"$out" 2>&1; then cat "$out" >>"$LOG"; rm -f "$out"; return; fi
  cat "$out" >>"$LOG"; tail -n 15 "$out" >&2; rm -f "$out"
  fail "the step above failed. The full log is $LOG"
}
# retry runs a download that a slow or flaky network may cut off, up to three times.
retry() {
  local n
  for n in 1 2 3; do
    if "$@" >>"$LOG" 2>&1; then return; fi
    [ "$n" -lt 3 ] && note "The download was interrupted; trying again ($n of 2)."
  done
  quiet "$@"
}
trap 'fail "something went wrong. The full log is $LOG"' ERR

# Questions read from the terminal, so they work when this script itself comes through a pipe.
ask() { # ask VAR "question" [default]
  local var=$1 question=$2 default=${3:-} answer
  if [ -n "${!var:-}" ]; then return; fi
  if ! { : </dev/tty; } 2>/dev/null; then # no terminal: a scripted install
    [ -n "$default" ] || fail "$var isn't set and there is no terminal to ask on. Set it in the environment."
    printf -v "$var" '%s' "$default"
    return
  fi
  if [ -n "$default" ]; then question="$question [$default]"; fi
  read -r -p "    $question: " answer </dev/tty
  printf -v "$var" '%s' "${answer:-$default}"
}

# --- Checks -------------------------------------------------------------------------------------------------------

[ "$(id -u)" -eq 0 ] || fail "run it as root: curl -fsSL … | sudo bash"
. /etc/os-release 2>/dev/null || true
case "${ID:-}" in ubuntu|debian) ;; *) fail "this installer supports Ubuntu and Debian. Elsewhere, follow SELF-HOSTING.md." ;; esac
case "$(uname -m)" in
  x86_64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) fail "the processor of this server ($(uname -m)) is not supported: x86-64 and ARM64 are." ;;
esac
UPGRADE=false; [ -f "$SETTINGS" ] && UPGRADE=true

printf '%sUlka VMS%s: video hosting on your own server.\n' "$bold" "$reset"
if $UPGRADE; then note "Found an existing install: upgrading it. Your settings and videos stay."; fi

# --- Questions (first install only) -------------------------------------------------------------------------------

if ! $UPGRADE; then
  step "A few questions"
  ask DOMAIN "Your domain (videos., player. and origin. will be made under it)"
  DOMAIN=${DOMAIN#https://}; DOMAIN=${DOMAIN#http://}; DOMAIN=${DOMAIN%/}
  [[ "$DOMAIN" =~ ^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]] || fail "\"$DOMAIN\" isn't a domain, like example.com."
  CONSOLE_HOST="videos.$DOMAIN"; PLAYER_HOST="player.$DOMAIN"; ORIGIN_HOST="origin.$DOMAIN"
  note "Email is how people get invitations and password resets. Give your email service's SMTP address,"
  note "like smtp://user:password@smtp.example.com:587"
  ask SMTP_URL "SMTP address"
  [[ "$SMTP_URL" =~ ^smtps?:// ]] || fail "the SMTP address must start with smtp:// or smtps://."
  ask MAIL_FROM "Send email as" "Videos <videos@$DOMAIN>"
fi

# --- DNS ----------------------------------------------------------------------------------------------------------

if ! $UPGRADE; then
  step "Checking your domain points here"
  public_ip=$(curl -fsS4 --max-time 10 https://api.ipify.org || true)
  preset=${CONTINUE:-} # CONTINUE=skip in the environment goes on without the check
  while true; do
    missing=()
    for host in "$CONSOLE_HOST" "$PLAYER_HOST" "$ORIGIN_HOST"; do
      resolved=$(getent ahostsv4 "$host" | awk 'NR==1 {print $1}' || true)
      if [ -z "$public_ip" ] || [ "$resolved" != "$public_ip" ]; then missing+=("$host"); fi
    done
    if [ ${#missing[@]} -eq 0 ]; then note "All three names point here."; break; fi
    note "These names must point at this server for HTTPS to work. Add an A record for each:"
    for host in "${missing[@]}"; do note "  $host  ->  ${public_ip:-the public address of this server}"; done
    CONTINUE=$preset
    ask CONTINUE "Press Enter to check again once they're added, or type skip to go on anyway"
    [ "$CONTINUE" = "skip" ] && break
  done
fi

# --- Software -----------------------------------------------------------------------------------------------------

step "Installing what it runs on"
export DEBIAN_FRONTEND=noninteractive
quiet apt-get update
quiet apt-get install -y ca-certificates curl gnupg ffmpeg webp debian-keyring debian-archive-keyring apt-transport-https
if ! command -v docker >/dev/null; then quiet sh -c 'curl -fsSL https://get.docker.com | sh'; fi
if ! command -v packager >/dev/null || ! packager --version 2>/dev/null | grep -q "$PACKAGER_VERSION"; then
  quiet curl -fsSL -o /usr/local/bin/packager \
    "https://github.com/shaka-project/shaka-packager/releases/download/$PACKAGER_VERSION/packager-linux-$([ "$ARCH" = amd64 ] && echo x64 || echo arm64)"
  chmod 0755 /usr/local/bin/packager
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  quiet apt-get update
  quiet apt-get install -y caddy
fi
note "Done."

# --- Ulka VMS -----------------------------------------------------------------------------------------------------

step "Getting Ulka VMS"
work=$(mktemp -d)
if [ -n "${ULKA_VMS_ARCHIVE:-}" ]; then
  cp "$ULKA_VMS_ARCHIVE" "$work/release.tar.gz"
else
  retry curl -fsSL -o "$work/release.tar.gz" "https://github.com/$REPO/releases/latest/download/ulka-vms-linux-$ARCH.tar.gz"
fi
mkdir -p "$work/release" && tar -xzf "$work/release.tar.gz" -C "$work/release"
id ulka-vms >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin ulka-vms
mkdir -p "$APP_DIR"
# The new release replaces the old one's files; data lives in Docker volumes and the settings in $CONFIG_DIR.
rm -rf "${APP_DIR:?}/bin" "${APP_DIR:?}/web" "${APP_DIR:?}/deploy"
cp -a "$work/release/." "$APP_DIR/"
chown -R ulka-vms:ulka-vms "$APP_DIR"
note "Version $(cat "$APP_DIR/VERSION")."

# --- Settings (first install only) --------------------------------------------------------------------------------

if ! $UPGRADE; then
  step "Writing the settings"
  mkdir -p "$CONFIG_DIR"
  secret() { openssl rand -hex 24; }
  q() { printf '%q' "$1"; } # quoted for the sh that reads the file: names and passwords may hold spaces or <>
  sed -e '/^# Tests/,$d' -e '/^SMTP_URL=/d' -e '/^MAIL_FROM=/d' -e '/^MAIL_PROVIDER=/d' \
      -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(secret)|" \
      -e "s|^ULKA_APP_PASSWORD=.*|ULKA_APP_PASSWORD=$(secret)|" \
      -e "s|^S3_ACCESS_KEY_ID=.*|S3_ACCESS_KEY_ID=$(secret)|" \
      -e "s|^S3_SECRET_ACCESS_KEY=.*|S3_SECRET_ACCESS_KEY=$(secret)|" \
      -e "s|^CLICKHOUSE_PASSWORD=.*|CLICKHOUSE_PASSWORD=$(secret)|" \
      -e "s|^SEAL_KEY=.*|SEAL_KEY=$(openssl rand -base64 32)|" \
      -e "s|^PUBLIC_URL=.*|PUBLIC_URL=https://$CONSOLE_HOST|" \
      -e "s|^DOCS_URL=.*|DOCS_URL=https://$CONSOLE_HOST|" \
      -e "s|^PLAYER_URL=.*|PLAYER_URL=https://$PLAYER_HOST|" \
      -e "s|^ORIGIN_URL=.*|ORIGIN_URL=https://$ORIGIN_HOST/s|" \
      -e "s|^S3_BUCKET=.*|S3_BUCKET=videos|" \
      "$APP_DIR/.env.example" > "$SETTINGS"
  # Email values may hold spaces, <> or quotes: written by the shell, quoted for the shell that reads the file.
  { echo; echo "# Email, set by the installer"; echo "MAIL_PROVIDER=smtp"; echo "SMTP_URL=$(q "$SMTP_URL")"; echo "MAIL_FROM=$(q "$MAIL_FROM")"; } >> "$SETTINGS"
  chown root:ulka-vms "$SETTINGS"; chmod 640 "$SETTINGS"
  cat > "$CONFIG_DIR/web.env" <<EOF
CONSOLE_HOST=$CONSOLE_HOST
PLAYER_HOST=$PLAYER_HOST
ORIGIN_HOST=$ORIGIN_HOST
API_ADDR=127.0.0.1:8096
ORIGIN_UPSTREAM=127.0.0.1:8092
WEB_ROOT=$APP_DIR/web
EOF
  note "Saved in $SETTINGS. It holds the key your videos are encrypted with (SEAL_KEY): keep a copy somewhere safe."
else
  # Settings this release added get their defaults, so an upgrade starts without editing the file.
  added=$(sed -e '/^# Tests/,$d' "$APP_DIR/.env.example" | grep -E '^[A-Z0-9_]+=' | while IFS= read -r line; do
    grep -q "^${line%%=*}=" "$SETTINGS" || echo "$line"
  done)
  if [ -n "$added" ]; then
    { echo; echo "# Added by the upgrade to $(cat "$APP_DIR/VERSION")"; echo "$added"; } >> "$SETTINGS"
    note "New settings, with their defaults, added to $SETTINGS: $(echo "$added" | cut -d= -f1 | tr '\n' ' ')"
  fi
fi

# --- Services -----------------------------------------------------------------------------------------------------

compose() { (cd "$APP_DIR" && docker compose --env-file "$SETTINGS" "$@"); }
run() { sh -c "set -a; . '$SETTINGS'; set +a; exec $APP_DIR/bin/ulka-vms $*"; }

step "Starting the database and storage"
retry compose pull --quiet
quiet compose up -d
for _ in $(seq 1 60); do compose exec -T postgres pg_isready -U postgres -q </dev/null >/dev/null 2>&1 && break; sleep 2; done
for _ in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:8334/ && break; sleep 2; done
bucket=$(sh -c ". '$SETTINGS'; echo \$S3_BUCKET")
for _ in $(seq 1 15); do
  echo "s3.bucket.create -name $bucket" | compose exec -T seaweedfs weed shell >>"$LOG" 2>&1 && break; sleep 2
done
quiet run migrate
note "Done."

step "Starting the video server"
cp "$APP_DIR/deploy/systemd/ulka-vms-api.service" "$APP_DIR/deploy/systemd/ulka-vms-worker.service" /etc/systemd/system/
systemctl daemon-reload
quiet systemctl enable ulka-vms-api ulka-vms-worker
quiet systemctl restart ulka-vms-api ulka-vms-worker
for _ in $(seq 1 30); do curl -fs -o /dev/null http://127.0.0.1:8096/v1/meta && break; sleep 1; done
curl -fs -o /dev/null http://127.0.0.1:8096/v1/meta || { journalctl -u ulka-vms-api -n 20 --no-pager >&2; fail "the server didn't start; its last messages are above."; }
note "Done."

step "Turning on HTTPS"
cp "$APP_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=%s/web.env\n' "$CONFIG_DIR" > /etc/systemd/system/caddy.service.d/ulka-vms.conf
systemctl daemon-reload
quiet systemctl restart caddy
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then quiet ufw allow 80; quiet ufw allow 443; fi
note "Done. Certificates are issued in the background; the first visit may take a few seconds."

console=$(sh -c ". '$SETTINGS'; echo \$PUBLIC_URL")
printf '\n%sUlka VMS is running.%s\n' "$bold" "$reset"
if $UPGRADE; then
  note "Open $console"
else
  note "Open $console/signup and create your account: you'll own the first workspace."
  note "Then close sign-up to strangers: set SIGNUP=closed in $SETTINGS and run"
  note "  sudo systemctl restart ulka-vms-api"
fi
note "Settings: $SETTINGS   Upgrade: run this installer again."
printf '%s    Install log: %s%s\n' "$dim" "$LOG" "$reset"
}

main "$@"
