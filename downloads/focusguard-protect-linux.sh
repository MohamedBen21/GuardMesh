#!/usr/bin/env bash
# FocusGuard: set the filtering DNS (Cloudflare for Families (security + adult filter)) on THIS computer.
# For systems that use NetworkManager (most desktop Linux). Run:  bash this-file.sh
set -e
nmcli -t -f NAME,TYPE connection show --active | while IFS=: read -r name type; do
  case "$type" in *ethernet|*wireless) ;; *) continue ;; esac
  nmcli connection modify "$name" ipv4.dns "1.1.1.3 1.0.0.3" ipv4.ignore-auto-dns yes ipv6.dns "2606:4700:4700::1113 2606:4700:4700::1003" ipv6.ignore-auto-dns yes
  nmcli connection up "$name" >/dev/null
done
echo "Done."
