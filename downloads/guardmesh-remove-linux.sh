#!/usr/bin/env bash
# GuardMesh: remove the filtering DNS on THIS computer.
# For systems that use NetworkManager (most desktop Linux). Run:  bash this-file.sh
set -e
nmcli -t -f NAME,TYPE connection show --active | while IFS=: read -r name type; do
  case "$type" in *ethernet|*wireless) ;; *) continue ;; esac
  nmcli connection modify "$name" ipv4.dns "" ipv4.ignore-auto-dns no ipv6.dns "" ipv6.ignore-auto-dns no
  nmcli connection up "$name" >/dev/null
done
echo "Done."
