#!/usr/bin/env bash
# GuardMesh installer for Raspberry Pi OS / Debian / Ubuntu.
# Run from the repo folder:  sudo ./install.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run with sudo:  sudo ./install.sh" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo ">> Installing Docker (official convenience script from get.docker.com)…"
  curl -fsSL https://get.docker.com | sh
fi

# Port 53 is often taken by systemd-resolved's stub listener on Ubuntu/Debian desktops.
if ss -lntu 2>/dev/null | grep -qE '[:.]53\s'; then
  echo ">> Something is already listening on port 53."
  if systemctl is-active --quiet systemd-resolved; then
    echo "   Disabling systemd-resolved's DNS stub listener so AdGuard Home can use port 53…"
    mkdir -p /etc/systemd/resolved.conf.d
    printf '[Resolve]\nDNSStubListener=no\n' > /etc/systemd/resolved.conf.d/guardmesh.conf
    systemctl restart systemd-resolved
  fi
fi

echo ">> Starting GuardMesh…"
docker compose up -d --build

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
cat <<EOF

Done. Open the setup wizard from any phone or laptop on your Wi-Fi:

    http://${IP:-<this-box-ip>}:8080

IMPORTANT before turning the router's DHCP off: give this box a fixed IP address
(a "DHCP reservation" in your router, or a static IP in the Pi's network settings).
EOF
