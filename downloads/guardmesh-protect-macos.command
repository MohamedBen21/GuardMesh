#!/bin/bash
# GuardMesh: set the filtering DNS (Cloudflare for Families (security + adult filter)) on THIS computer.
# Run:  bash this-file.sh   (it asks for your password)
set -e
networksetup -listallnetworkservices | tail -n +2 | grep -v '^\*' | while IFS= read -r svc; do
  sudo networksetup -setdnsservers "$svc" 1.1.1.3 1.0.0.3 2606:4700:4700::1113 2606:4700:4700::1003
done
sudo dscacheutil -flushcache
sudo killall -HUP mDNSResponder || true
echo "Done."
