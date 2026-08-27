#!/usr/bin/env bash
#
# Provisions a fresh Ubuntu 24.04 host to run the Outsmart harness.
# Idempotent: safe to re-run.
#
# Usage:  sudo ./deploy/setup.sh
#
set -euo pipefail

RUN_USER="${SUDO_USER:-ubuntu}"
INSTALL_DIR="/opt/outsmart"
TRUEFORGE_VERSION="0.1.4"

log() { printf '\n==> %s\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo." >&2
  exit 1
fi

log "Installing host packages"
apt-get update -qq
# bubblewrap  - namespace isolation for the sandbox
# socat       - bridges the sandbox's proxy socket across the namespace boundary
# ripgrep     - the search primitive the agent uses inside the sandbox
# python3-venv- the sandbox bootstraps a venv on first use
apt-get install -y -qq curl ca-certificates bubblewrap socat ripgrep python3-venv debian-keyring debian-archive-keyring apt-transport-https

log "Installing Node.js 22"
if ! command -v node >/dev/null || [[ "$(node -v)" != v22.* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
node -v

log "Enabling unprivileged user namespaces (required by bubblewrap)"
# Ubuntu 23.10+ restricts unprivileged userns via AppArmor. bwrap needs it.
if [[ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]]; then
  sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
  echo 'kernel.apparmor_restrict_unprivileged_userns=0' > /etc/sysctl.d/60-outsmart-userns.conf
fi
sysctl -w kernel.unprivileged_userns_clone=1 2>/dev/null || true

log "Verifying bubblewrap can create a namespace"
if ! sudo -u "$RUN_USER" bwrap --ro-bind / / --unshare-all true; then
  echo "bubblewrap cannot create namespaces on this host." >&2
  echo "Managed container platforms (Render, Fly, App Runner) block this - use a real VM." >&2
  exit 1
fi

log "Adding swap (sandboxes and npm installs are memory-hungry)"
if [[ ! -f /swapfile ]]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

log "Installing TrueForge ${TRUEFORGE_VERSION} into ${INSTALL_DIR}"
mkdir -p "$INSTALL_DIR"
chown "$RUN_USER":"$RUN_USER" "$INSTALL_DIR"
sudo -u "$RUN_USER" bash -c "cd '$INSTALL_DIR' && [ -f package.json ] || npm init -y >/dev/null"
sudo -u "$RUN_USER" bash -c "cd '$INSTALL_DIR' && npm install --no-audit --no-fund '@truefoundry/trueforge@${TRUEFORGE_VERSION}'"

log "Patching the sandbox network allowlist"
sudo -u "$RUN_USER" node "$(dirname "$(readlink -f "$0")")/patch-allowlist.mjs" "$INSTALL_DIR"

log "Installing Caddy (TLS + auth at the edge)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

log "Done. Next: install the systemd unit and Caddyfile (see deploy/README.md)"
