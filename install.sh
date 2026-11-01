#!/usr/bin/env bash
# Installs Ulka VMS on an Ubuntu or Debian server, or upgrades an existing install to the latest release:
#
#   curl -fsSL https://github.com/ulkanetworks/ulka-vms/releases/latest/download/install.sh | sudo bash
#
# It asks for your domain, email and storage settings (or reads DOMAIN, SMTP_URL, MAIL_FROM and S3_ENDPOINT, S3_REGION,
# S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY from the environment), makes every other secret, and starts
# everything. Videos are kept in your S3-compatible storage, not on this server.
#
# Run it again at any time: it finishes an install that stopped part way, or upgrades a finished one. Your settings
# and videos stay. START_OVER=erase deletes this server's settings and database first and installs afresh (the videos
# in your bucket are left alone). ULKA_VMS_ARCHIVE=/path/to/ulka-vms-linux-<arch>.tar.gz installs from a file.
set -Eeuo pipefail

# Everything runs inside main, called on the last line: bash reads a piped script as it goes, and a command that reads
# its input would otherwise swallow the rest of the script.
main() {

REPO="ulkanetworks/ulka-vms"
APP_DIR="/opt/ulka-vms"
CONFIG_DIR="/etc/ulka-vms"
SETTINGS="$CONFIG_DIR/ulka-vms.env"
WEB_SETTINGS="$CONFIG_DIR/web.env"
INSTALLED="$CONFIG_DIR/installed" # written last: without it, the settings belong to an install that didn't finish
PROJECT="ulka-vms"                # the Docker Compose project, which names the containers and data volumes
PACKAGER_VERSION="v3.9.3"
UNITS="ulka-vms-api ulka-vms-worker ulka-vms-origin"
PORTS="80 443 8096 8092 5434 8124 4318" # HTTPS, API, origin, Postgres, ClickHouse, telemetry
MIN_DISK_GB=10
MIN_MEMORY_GB=4

# --- Output -------------------------------------------------------------------------------------------------------

color() { tput "$@" 2>/dev/null || true; }
bold=$(color bold); dim=$(color dim); reset=$(color sgr0)
cyan=$(color setaf 6); green=$(color setaf 2); yellow=$(color setaf 3)
step() { printf '\n%s%s==>%s %s%s%s\n' "$bold" "$cyan" "$reset" "$bold" "$1" "$reset"; }
note() { printf '    %s\n' "$1"; }
# A question's layout: a numbered title, dimmed hints under it, the prompt, then a check or a problem.
section() { printf '\n  %s%s[%s]%s %s%s%s\n' "$bold" "$cyan" "$1" "$reset" "$bold" "$2" "$reset"; }
hint() { printf '      %s%s%s\n' "$dim" "$1" "$reset"; }
ok() { printf '      %s✓%s %s\n' "$green" "$reset" "$1"; }
problem() { printf '      %s!%s %s\n' "$yellow" "$reset" "$1"; }
# Failures go to fd 3, the terminal's stderr as it was at start: a trap runs inside the redirections of the step it
# interrupts, and a plain >&2 would land in that step's log file.
exec 3>&2
fail() { printf '\n%sCould not finish:%s %s\n' "$bold" "$reset" "$1" >&3; again; exit 1; }
again() { $STARTED && printf '    Fix that, then run the installer again: it picks up where it stopped.\n' >&3; return 0; }
STARTED=false
# Everything a step prints goes to the log; on failure, its last lines say why.
LOG=$(mktemp /tmp/ulka-vms-install.XXXXXX.log)
work=""
trap 'rm -rf "$work"' EXIT
trap 'fail "something went wrong (line $LINENO). The full log is $LOG"' ERR
trap 'printf "\n%sStopped.%s Run the installer again to pick up where it left off.\n" "$bold" "$reset" >&3; exit 130' INT TERM
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
    if [ "$n" -lt 3 ]; then note "The download was interrupted; trying again ($n of 2)."; sleep 3; fi
  done
  quiet "$@"
}

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
  read -r ${SILENT:+-s} -p "      ${bold}›${reset} $question: " answer </dev/tty
  if [ -n "${SILENT:-}" ]; then echo; fi
  printf -v "$var" '%s' "${answer:-$default}"
}
ask_secret() { SILENT=1 ask "$@"; } # typed without showing
has_tty() { { : </dev/tty; } 2>/dev/null; }
# ask_again clears an answer that didn't fit, so the question comes again; a scripted install has no one to ask.
ask_again() { # ask_again VAR "what was wrong"
  has_tty || fail "$2"
  problem "$2 Try again."
  printf -v "$1" '%s' ""
}
# ask_storage asks for the bucket's details until each has the right shape.
ask_storage() {
  until [[ "${S3_ENDPOINT:-}" =~ ^https?://[^/]+$ ]]; do
    [ -z "${S3_ENDPOINT:-}" ] || ask_again S3_ENDPOINT "\"$S3_ENDPOINT\" isn't a storage address, like https://storage.example.com with nothing after the name."
    ask S3_ENDPOINT "Storage address (S3 endpoint)"
    S3_ENDPOINT=${S3_ENDPOINT%/}
  done
  ask S3_REGION "Region" "us-east-1"
  until [[ "${S3_BUCKET:-}" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]]; do
    [ -z "${S3_BUCKET:-}" ] || ask_again S3_BUCKET "\"$S3_BUCKET\" isn't a bucket name: 3 to 63 lowercase letters, digits, dots and dashes."
    ask S3_BUCKET "Bucket name"
  done
  until [ -n "${S3_ACCESS_KEY_ID:-}" ]; do ask S3_ACCESS_KEY_ID "Access key ID"; done
  until [ -n "${S3_SECRET_ACCESS_KEY:-}" ]; do ask_secret S3_SECRET_ACCESS_KEY "Secret access key"; done
}

# What this install left on the server: its containers and data volumes.
our_containers() { command -v docker >/dev/null && docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null || true; }
our_volumes() { command -v docker >/dev/null && docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null || true; }
erase_everything() {
  for unit in $UNITS; do systemctl stop "$unit" 2>/dev/null || true; done
  our_containers | xargs -r docker rm -f >>"$LOG" 2>&1
  our_volumes | xargs -r docker volume rm >>"$LOG" 2>&1
  rm -rf "$CONFIG_DIR"
}

# port_owner names the program listening on a TCP port, or nothing.
port_owner() { { ss -Hltnp "sport = :$1" 2>/dev/null || true; } | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | head -n 1; }

# --- The server ---------------------------------------------------------------------------------------------------

[ "$(id -u)" -eq 0 ] || fail "run it as root: curl -fsSL … | sudo bash"
[ -d /run/systemd/system ] || fail "this server doesn't run systemd, which Ulka VMS's services need. A container isn't enough: use a virtual or real server."
. /etc/os-release 2>/dev/null || true
case "${ID:-}" in
  ubuntu) dpkg --compare-versions "${VERSION_ID:-0}" ge 22.04 || fail "Ubuntu ${VERSION_ID:-} is too old: use 22.04 or newer." ;;
  debian) dpkg --compare-versions "${VERSION_ID:-0}" ge 12 || fail "Debian ${VERSION_ID:-} is too old: use 12 or newer." ;;
  *) fail "this installer supports Ubuntu and Debian. Elsewhere, follow SELF-HOSTING.md." ;;
esac
case "$(uname -m)" in
  x86_64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) fail "the processor of this server ($(uname -m)) is not supported: x86-64 and ARM64 are." ;;
esac
exec 9>/var/lock/ulka-vms-install.lock
flock -n 9 || fail "the installer is already running on this server. Wait for it to finish."

free_gb=$(( $(df -Pk / | awk 'NR==2 {print $4}') / 1024 / 1024 ))
[ "$free_gb" -ge "$MIN_DISK_GB" ] || fail "only ${free_gb} GB of disk is free; Ulka VMS needs at least $MIN_DISK_GB GB for its database and work in progress."
memory_gb=$(awk '/^MemTotal:/ {printf "%d", $2 / 1024 / 1024 + 0.5}' /proc/meminfo)

# Fresh: nothing here yet. Resume: settings from a run that stopped part way. Upgrade: a finished install.
if [ "${START_OVER:-}" = "erase" ]; then
  printf '%sUlka VMS%s: starting over, as START_OVER=erase asks.\n' "$bold" "$reset"
  erase_everything
  unset START_OVER
fi
STATE=fresh
if [ -f "$SETTINGS" ]; then STATE=resume; [ -f "$INSTALLED" ] && STATE=upgrade; fi

printf '%sUlka VMS%s: video hosting on your own server.\n' "$bold" "$reset"
case $STATE in
  upgrade) note "Found an existing install: upgrading it. Your settings and videos stay." ;;
  resume) note "Found an install that didn't finish: picking it up with the settings it saved." ;;
esac
if [ "$STATE" != fresh ] && [ -n "${DOMAIN:-}${S3_BUCKET:-}${SMTP_URL:-}" ]; then
  note "Settings in the environment are ignored: this server's are in $SETTINGS. To change them, edit that file."
fi
if [ "$memory_gb" -lt "$MIN_MEMORY_GB" ]; then
  note "This server has ${memory_gb} GB of memory; $MIN_MEMORY_GB GB or more is recommended, or encoding will be slow."
fi

# Another program on a port Ulka VMS needs would only show up later, as a service that won't start.
busy=()
for port in $PORTS; do
  owner=$(port_owner "$port")
  case "$owner" in
    ""|caddy|ulka-vms) ;;
    docker-proxy) [ -n "$(our_containers)" ] || busy+=("$port (a Docker container)") ;;
    *) busy+=("$port ($owner)") ;;
  esac
done
if [ ${#busy[@]} -gt 0 ]; then
  fail "these ports are in use by other programs: ${busy[*]}. Stop or move them (for a web server: sudo systemctl disable --now <name>), then run the installer again."
fi
STARTED=true

# --- Questions (first install only) -------------------------------------------------------------------------------

if [ "$STATE" = fresh ]; then
  step "A few questions"
  public_ip=$(curl -fsS4 --max-time 10 https://api.ipify.org || true)

  section 1/3 "Your domain"
  hint "A domain you own, like example.com, or a part of one, like vms.example.com."
  hint "Ulka VMS answers on three addresses under it; each needs an A record in your DNS."
  while true; do
    ask DOMAIN "Domain"
    typed=$DOMAIN
    # Forgiving of what people paste: a URL, one of the three names, or all three.
    DOMAIN=${DOMAIN#https://}; DOMAIN=${DOMAIN#http://}; DOMAIN=${DOMAIN%%[,/ ]*}
    case "$DOMAIN" in videos.*|player.*|origin.*) DOMAIN=${DOMAIN#*.} ;; esac
    [[ "$DOMAIN" =~ ^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]] && break
    ask_again DOMAIN "\"$typed\" isn't a domain, like example.com."
  done
  CONSOLE_HOST="videos.$DOMAIN"; PLAYER_HOST="player.$DOMAIN"; ORIGIN_HOST="origin.$DOMAIN"
  ok "$DOMAIN"
  hint "Point each of these at ${public_ip:-the public IP address of this server} (A records; you can add them while this runs):"
  hint "  $CONSOLE_HOST   the console"
  hint "  $PLAYER_HOST   where viewers watch"
  hint "  $ORIGIN_HOST   the video files"

  section 2/3 "Email (optional)"
  hint "For invitations and password resets: your email service's SMTP address,"
  hint "like smtp://user:password@smtp.example.com:587. Press Enter to skip; until it's set, emails"
  hint "are only written to the server's log, and you can add it later in $SETTINGS."
  while true; do
    ask SMTP_URL "SMTP address" "skip"
    [ "$SMTP_URL" = skip ] || [[ "$SMTP_URL" =~ ^smtps?://[^/]+ ]] && break
    ask_again SMTP_URL "An SMTP address starts with smtp:// or smtps://."
  done
  if [ "$SMTP_URL" = skip ]; then
    ok "Skipped: emails go to the log for now."
  else
    ask MAIL_FROM "Send email as" "Videos <videos@$DOMAIN>"
    ok "Email is sent as $MAIL_FROM."
  fi

  section 3/3 "Storage for your videos"
  hint "Any S3-compatible storage: AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO or another."
  hint "Make a private bucket there and a key that may read, write and delete in it."
  hint "Nothing needs to be public. On R2 the address is https://<account id>.r2.cloudflarestorage.com, region auto."
  ask_storage
  ok "Bucket $S3_BUCKET at $S3_ENDPOINT (checked once the program is downloaded)."
fi

# --- DNS ----------------------------------------------------------------------------------------------------------

if [ "$STATE" = fresh ]; then
  step "Checking your domain points here"
  preset=${CONTINUE:-} # CONTINUE=skip in the environment goes on without the check
  while true; do
    missing=()
    for host in "$CONSOLE_HOST" "$PLAYER_HOST" "$ORIGIN_HOST"; do
      resolved=$(getent ahostsv4 "$host" | awk 'NR==1 {print $1}' || true)
      if [ -z "$public_ip" ] || [ "$resolved" != "$public_ip" ]; then missing+=("$host"); fi
    done
    if [ ${#missing[@]} -eq 0 ]; then note "All three names point here."; break; fi
    proxied=()
    for host in "${missing[@]}"; do
      curl -sI --max-time 5 "http://$host/" 2>/dev/null | grep -qi '^server: cloudflare' && proxied+=("$host")
    done
    if [ ${#proxied[@]} -gt 0 ]; then
      note "These names go through Cloudflare's proxy (the orange cloud): ${proxied[*]}"
      note "In Cloudflare's DNS, set each to DNS only (the grey cloud), so visitors and certificates reach this server."
    fi
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
# A fresh server often runs its own updates first: wait for them rather than fail on the package lock.
apt_get() { apt-get -o DPkg::Lock::Timeout=900 "$@"; }
note "If the server is installing its own updates, this waits for them."
# Finishes a package install an earlier run (or anything else) left half done; dpkg itself doesn't wait for the lock.
for _ in $(seq 1 180); do
  if out=$(dpkg --configure -a 2>&1); then break; fi
  grep -q 'lock' <<<"$out" || { echo "$out" >&2; fail "the server's package manager is in a broken state (above)."; }
  sleep 5
done
echo "${out:-}" >>"$LOG"
retry apt_get update
quiet apt_get install -y ca-certificates curl gnupg ffmpeg webp iproute2 debian-keyring debian-archive-keyring apt-transport-https
timedatectl set-ntp true >>"$LOG" 2>&1 || true # storage refuses requests from a clock that is minutes off
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  retry sh -c 'curl -fsSL https://get.docker.com | sh'
fi
quiet systemctl enable --now docker
if ! command -v packager >/dev/null || ! packager --version 2>/dev/null | grep -q "$PACKAGER_VERSION"; then
  retry curl -fsSL -o /usr/local/bin/packager.download \
    "https://github.com/shaka-project/shaka-packager/releases/download/$PACKAGER_VERSION/packager-linux-$([ "$ARCH" = amd64 ] && echo x64 || echo arm64)"
  chmod 0755 /usr/local/bin/packager.download && mv /usr/local/bin/packager.download /usr/local/bin/packager
fi
if ! command -v caddy >/dev/null; then
  retry curl -fsSL -o /tmp/caddy.gpg https://dl.cloudsmith.io/public/caddy/stable/gpg.key
  gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg /tmp/caddy.gpg && rm -f /tmp/caddy.gpg
  retry curl -fsSL -o /etc/apt/sources.list.d/caddy-stable.list https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt
  retry apt_get update
  quiet apt_get install -y caddy
fi
note "Done."

# --- Data from an earlier attempt ---------------------------------------------------------------------------------

# Its database was made with passwords that are gone with its settings, so it can't be reused.
if [ "$STATE" = fresh ] && [ -n "$(our_volumes)" ]; then
  step "Found data from an earlier install"
  note "This server holds a database from an earlier install whose settings are gone, so it can't be used again."
  note "To keep it, put the settings file back at $SETTINGS and run the installer again."
  note "Starting over deletes that database here. Videos in your bucket are not touched."
  ask START_OVER "Type erase to delete it and start fresh, or press Enter to stop" "stop"
  [ "$START_OVER" = "erase" ] || { STARTED=false; fail "stopped, nothing was changed. Run it again with START_OVER=erase to start fresh."; }
  erase_everything
  note "Deleted."
fi

# --- Ulka VMS -----------------------------------------------------------------------------------------------------

step "Getting Ulka VMS"
work=$(mktemp -d)
if [ -n "${ULKA_VMS_ARCHIVE:-}" ]; then
  [ -f "$ULKA_VMS_ARCHIVE" ] || fail "ULKA_VMS_ARCHIVE names $ULKA_VMS_ARCHIVE, which doesn't exist."
  cp "$ULKA_VMS_ARCHIVE" "$work/release.tar.gz"
else
  retry curl -fsSL -o "$work/release.tar.gz" "https://github.com/$REPO/releases/latest/download/ulka-vms-linux-$ARCH.tar.gz"
fi
mkdir -p "$work/release"
tar -xzf "$work/release.tar.gz" -C "$work/release" 2>>"$LOG" && [ -x "$work/release/bin/ulka-vms" ] ||
  fail "the downloaded release is incomplete, probably cut off on the way."
note "Version $(cat "$work/release/VERSION")."

# --- Storage ------------------------------------------------------------------------------------------------------

# Checked with the new release before anything on the server changes, so a bad bucket stops an upgrade harmlessly.
step "Checking your storage"
if [ "$STATE" != fresh ] && grep -q '^COMPOSE_PROFILES=seaweedfs' "$SETTINGS"; then
  fail "this install keeps videos in storage on this server, which this release no longer runs. Copy the bucket to S3-compatible storage, set S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY in $SETTINGS to it, delete the S3_PUBLIC_URL and COMPOSE_PROFILES lines, and run the installer again."
fi
if [ "$STATE" = fresh ]; then
  # On a first install, details that don't work are asked again here rather than ending the install.
  while true; do
    checked=$(S3_ENDPOINT=$S3_ENDPOINT S3_REGION=$S3_REGION S3_BUCKET=$S3_BUCKET S3_ACCESS_KEY_ID=$S3_ACCESS_KEY_ID \
      S3_SECRET_ACCESS_KEY=$S3_SECRET_ACCESS_KEY "$work/release/bin/ulka-vms" check-storage 2>&1) && break
    echo "$checked" >>"$LOG"
    reason=$(head -n 1 <<<"$checked")
    has_tty || fail "the bucket can't be used with these details: $reason"
    problem "The bucket can't be used with these details: $reason"
    hint "Enter them again; press Enter to keep an answer. (The storage's own reply is in $LOG.)"
    for pair in "S3_ENDPOINT:Storage address (S3 endpoint)" "S3_REGION:Region" "S3_BUCKET:Bucket name" "S3_ACCESS_KEY_ID:Access key ID"; do
      var=${pair%%:*}; old=${!var}; printf -v "$var" '%s' ""; ask "$var" "${pair#*:}" "$old"
    done
    S3_ENDPOINT=${S3_ENDPOINT%/}
    old=$S3_SECRET_ACCESS_KEY; S3_SECRET_ACCESS_KEY=""; ask_secret S3_SECRET_ACCESS_KEY "Secret access key (Enter keeps it)"
    S3_SECRET_ACCESS_KEY=${S3_SECRET_ACCESS_KEY:-$old}
    ask_storage # the shapes again, for whatever was changed
  done
else
  checked=$(sh -c "set -a; . '$SETTINGS'; set +a; exec '$work/release/bin/ulka-vms' check-storage" 2>&1) || {
    echo "$checked" >>"$LOG"
    fail "the bucket in $SETTINGS can't be used: $(head -n 1 <<<"$checked") Nothing on the server was changed; fix the S3_ settings there. (The storage's own reply is in $LOG.)"
  }
fi
echo "$checked" >>"$LOG"
ok "The bucket works."

id ulka-vms >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin ulka-vms
mkdir -p "$APP_DIR"
# The new release replaces the old one's files; data lives in Docker volumes and the settings in $CONFIG_DIR.
rm -rf "${APP_DIR:?}/bin" "${APP_DIR:?}/web" "${APP_DIR:?}/deploy"
cp -a "$work/release/." "$APP_DIR/"
chown -R ulka-vms:ulka-vms "$APP_DIR"

# --- Settings -----------------------------------------------------------------------------------------------------

if [ "$STATE" = fresh ]; then
  step "Writing the settings"
  mkdir -p "$CONFIG_DIR"
  secret() { openssl rand -hex 24; }
  q() { printf '%q' "$1"; } # quoted for the sh that reads the file: names and passwords may hold spaces or <>
  sed -e '/^# Tests/,$d' -e '/^SMTP_URL=/d' -e '/^MAIL_FROM=/d' -e '/^MAIL_PROVIDER=/d' -e '/^S3_/d' -e '/^COMPOSE_FILE=/d' \
      -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(secret)|" \
      -e "s|^ULKA_APP_PASSWORD=.*|ULKA_APP_PASSWORD=$(secret)|" \
      -e "s|^CLICKHOUSE_PASSWORD=.*|CLICKHOUSE_PASSWORD=$(secret)|" \
      -e "s|^SEAL_KEY=.*|SEAL_KEY=$(openssl rand -base64 32)|" \
      -e "s|^PUBLIC_URL=.*|PUBLIC_URL=https://$CONSOLE_HOST|" \
      -e "s|^DOCS_URL=.*|DOCS_URL=https://$CONSOLE_HOST|" \
      -e "s|^PLAYER_URL=.*|PLAYER_URL=https://$PLAYER_HOST|" \
      -e "s|^ORIGIN_URL=.*|ORIGIN_URL=https://$ORIGIN_HOST/s|" \
      "$APP_DIR/.env.example" > "$SETTINGS.new"
  # Email values may hold spaces, <> or quotes: written by the shell, quoted for the shell that reads the file.
  { echo; echo "# Email, set by the installer. Without an SMTP address emails are only logged: to send them, set"
    echo "# MAIL_PROVIDER=smtp and SMTP_URL (and MAIL_FROM), then: sudo systemctl restart ulka-vms-api ulka-vms-worker"
    if [ "$SMTP_URL" = skip ]; then
      echo "MAIL_PROVIDER=log"; echo "SMTP_URL="; echo "MAIL_FROM=$(q "Videos <videos@$DOMAIN>")"
    else
      echo "MAIL_PROVIDER=smtp"; echo "SMTP_URL=$(q "$SMTP_URL")"; echo "MAIL_FROM=$(q "$MAIL_FROM")"
    fi
    echo; echo "# Storage, set by the installer"; echo "S3_ENDPOINT=$(q "$S3_ENDPOINT")"; echo "S3_REGION=$(q "$S3_REGION")"
    echo "S3_BUCKET=$(q "$S3_BUCKET")"; echo "S3_ACCESS_KEY_ID=$(q "$S3_ACCESS_KEY_ID")"; echo "S3_SECRET_ACCESS_KEY=$(q "$S3_SECRET_ACCESS_KEY")"; } >> "$SETTINGS.new"
  chown root:ulka-vms "$SETTINGS.new"; chmod 640 "$SETTINGS.new"
  cat > "$WEB_SETTINGS" <<EOF
CONSOLE_HOST=$CONSOLE_HOST
PLAYER_HOST=$PLAYER_HOST
ORIGIN_HOST=$ORIGIN_HOST
API_ADDR=127.0.0.1:8096
ORIGIN_UPSTREAM=127.0.0.1:8092
WEB_ROOT=$APP_DIR/web
EOF
  mv "$SETTINGS.new" "$SETTINGS" # last and in one step: a run cut off before this starts over cleanly
  note "Saved in $SETTINGS. It holds the key your videos are encrypted with (SEAL_KEY): keep a copy somewhere safe."
else
  [ -f "$WEB_SETTINGS" ] || fail "$WEB_SETTINGS is missing: it names the three host names. Put it back, or start over with START_OVER=erase."
  # Settings this release added get their defaults, so an upgrade starts without editing the file.
  added=$(sed -e '/^# Tests/,$d' -e '/^COMPOSE_FILE=/d' "$APP_DIR/.env.example" | grep -E '^[A-Z0-9_]+=' | while IFS= read -r line; do
    grep -q "^${line%%=*}=" "$SETTINGS" || echo "$line"
  done)
  if [ -n "$added" ]; then
    { echo; echo "# Added by the upgrade to $(cat "$APP_DIR/VERSION")"; echo "$added"; } >> "$SETTINGS"
    note "New settings, with their defaults, added to $SETTINGS: $(echo "$added" | cut -d= -f1 | tr '\n' ' ')"
  fi
fi

# --- Services -----------------------------------------------------------------------------------------------------

compose() { (cd "$APP_DIR" && docker compose -p "$PROJECT" --env-file "$SETTINGS" "$@"); }
run() { sh -c "set -a; . '$SETTINGS'; set +a; exec $APP_DIR/bin/ulka-vms $*"; }
# wait_for tries a check once a second for up to n seconds.
wait_for() { local n=$1; shift; for _ in $(seq 1 "$n"); do if "$@" >/dev/null 2>&1; then return 0; fi; sleep 1; done; return 1; }

step "Starting the database"
retry compose pull --quiet
quiet compose up -d --remove-orphans # also stops what an earlier release ran and this one doesn't
wait_for 120 compose exec -T postgres pg_isready -U postgres -q </dev/null ||
  { compose logs --tail 20 postgres >&2; fail "the database didn't start; its last messages are above."; }
wait_for 120 curl -fs http://127.0.0.1:8124/ping ||
  { compose logs --tail 20 clickhouse >&2; fail "ClickHouse, which keeps usage, didn't start; its last messages are above."; }
quiet run migrate
note "Done."

step "Starting the video server"
for unit in $UNITS; do cp "$APP_DIR/deploy/systemd/$unit.service" /etc/systemd/system/; done
systemctl daemon-reload
# shellcheck disable=SC2086 # one word per unit
quiet systemctl enable $UNITS
# shellcheck disable=SC2086
quiet systemctl restart $UNITS
origin_up() { [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8092/)" = 404 ]; }
wait_for 60 curl -fs -o /dev/null http://127.0.0.1:8096/v1/meta ||
  { journalctl -u ulka-vms-api -n 20 --no-pager >&2; fail "the server didn't start; its last messages are above."; }
wait_for 30 origin_up ||
  { journalctl -u ulka-vms-origin -n 20 --no-pager >&2; fail "the video origin didn't start; its last messages are above."; }
sleep 3
systemctl is-active --quiet ulka-vms-worker ||
  { journalctl -u ulka-vms-worker -n 20 --no-pager >&2; fail "the worker, which encodes videos, didn't start; its last messages are above."; }
note "Done."

step "Turning on HTTPS"
# A Caddyfile that isn't ours is kept beside it, so a site this server already served can be moved over.
if [ -f /etc/caddy/Caddyfile ] && ! grep -q 'ORIGIN_UPSTREAM' /etc/caddy/Caddyfile && [ ! -f /etc/caddy/Caddyfile.before-ulka-vms ]; then
  cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.before-ulka-vms
  note "The server's earlier Caddy settings are kept in /etc/caddy/Caddyfile.before-ulka-vms."
fi
cp "$APP_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=%s\n' "$WEB_SETTINGS" > /etc/systemd/system/caddy.service.d/ulka-vms.conf
quiet sh -c "set -a; . '$WEB_SETTINGS'; set +a; caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile"
systemctl daemon-reload
quiet systemctl enable caddy
quiet systemctl restart caddy
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then quiet ufw allow 80; quiet ufw allow 443; fi
note "Done. Certificates are issued in the background; the first visit may take a few seconds."

cat "$APP_DIR/VERSION" > "$INSTALLED"
console=$(sh -c ". '$SETTINGS'; echo \$PUBLIC_URL")
printf '\n%sUlka VMS is running.%s\n' "$bold" "$reset"
if [ "$STATE" = upgrade ]; then
  note "Open $console"
else
  note "Open $console/signup and create your account: you'll own the first workspace."
  note "Then close sign-up to strangers: set SIGNUP=closed in $SETTINGS and run"
  note "  sudo systemctl restart ulka-vms-api"
  note "If the page doesn't open, check your server provider's firewall lets in ports 80 and 443."
  if grep -q '^MAIL_PROVIDER=log' "$SETTINGS"; then
    note "Email is off: invitations and password resets are written to the log (sudo journalctl -u ulka-vms-api)."
    note "To send them, set MAIL_PROVIDER=smtp and SMTP_URL in $SETTINGS, then restart ulka-vms-api and ulka-vms-worker."
  fi
fi
note "Settings: $SETTINGS   Upgrade: run this installer again."
printf '%s    Install log: %s%s\n' "$dim" "$LOG" "$reset"
}

main "$@"
