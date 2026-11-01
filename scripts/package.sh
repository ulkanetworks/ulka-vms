#!/bin/sh
# Builds the release archive install.sh downloads: dist/ulka-vms-linux-<arch>.tar.gz, holding the program, the built
# console and what runs beside them. Usage: scripts/package.sh <version> <amd64|arm64>. Run from the repository root.
set -eu
version=$1 arch=$2
out=dist/ulka-vms-linux-$arch
rm -rf "$out" && mkdir -p "$out/bin" "$out/deploy"
CGO_ENABLED=0 GOOS=linux GOARCH=$arch go build -trimpath -ldflags='-s -w' -o "$out/bin/ulka-vms" ./cmd/ulka-vms
[ -d web/dist ] || (cd web && npm ci && npm run build)
cp -R web/dist "$out/web"
cp compose.yaml .env.example "$out/"
cp -R deploy/clickhouse deploy/clickhouse-config deploy/otel-collector deploy/systemd deploy/Caddyfile "$out/deploy/"
echo "$version" > "$out/VERSION"
tar --no-xattrs -czf "$out.tar.gz" -C "$out" . # no macOS file attributes when made on a Mac
echo "$out.tar.gz"
