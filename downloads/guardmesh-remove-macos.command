#!/bin/bash
# GuardMesh: remove the filtering DNS on THIS computer.
# Run:  bash this-file.sh   (it asks for your password)
set -e
networksetup -listallnetworkservices | tail -n +2 | grep -v '^\*' | while IFS= read -r svc; do
  sudo networksetup -setdnsservers "$svc" empty
done
sudo dscacheutil -flushcache
sudo killall -HUP mDNSResponder || true
echo "Done."
