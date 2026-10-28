# FocusGuard Network

A network-level adult-content filter for the home, built to survive "a moment of weakness".

The browser extension ([FocusGuard](../focusguard)) can be turned off with one click. This project moves the enforcement
into a small always-on box (Raspberry Pi or any mini PC) that filters DNS for **every device on the Wi-Fi**, and makes
turning it off **slow, visible and vetoable**, not impossible.

## How it works

```
 phone / laptop / TV ──► Wi-Fi router ──► internet
        │   (router's DHCP is OFF; the box hands out addresses instead)
        ▼
  ┌───────────── the box ─────────────┐
  │ AdGuard Home   DNS filter + DHCP   │  sees every device's MAC address
  │ guardian       wizard + watchdog   │  talks to AdGuard's API
  └────────────────────────────────────┘
```

- **Strict by default.** Every device, including brand-new ones and ones that randomise their MAC, is filtered. Only
  devices explicitly marked *trusted* are exempt.
- **Devices are identified by MAC address**, so rules survive reconnects. Discovered from DHCP leases, so users tick names
  from a list instead of typing addresses.
- **Weakening protection is a request, not a switch.** "Pause protection" and "exempt this device" start only after the
  waiting period (default 24 h), your partner is notified immediately, anyone can cancel, and pauses auto-expire.
  Restoring protection is always instant.
- **Partner key.** Generated at setup, sent straight to the partner (Telegram/webhook) or shown once; only a hash is
  stored. The partner can approve a request early or change settings. Five wrong keys lock the check for 15 minutes.
- **The AdGuard admin password is random and never shown to anyone**, and AdGuard's own UI only listens on the box itself.
- **Tamper watchdog (every 30 s).** If protection is found off outside an approved window, or an unapproved exemption
  appears, it is reverted and the partner is alerted. A reboot/unplug sends a "box restarted" alert; an optional
  heartbeat URL (e.g. healthchecks.io) alerts the partner when the box goes silent.
- **DoH bypass rules** block well-known DNS-over-HTTPS resolvers and the Firefox DoH canary domain.

## Install

On a Raspberry Pi (Raspberry Pi OS) or any Debian/Ubuntu machine:

```bash
git clone <this-repo> focusguard-network && cd focusguard-network
sudo ./install.sh
```

Then open `http://<box-ip>:8080` from a phone and follow the 5-step wizard. Before step 4, give the box a fixed IP
(DHCP reservation in the router is the easiest way).

Development: `npm install && npm test` (the logic is tested against a fake AdGuard; no network needed).

## What this does NOT stop (be honest with users)

- Mobile data, other Wi-Fi networks, VPNs, Tor, a different DNS typed into a device, or a factory-reset router with its
  old DHCP back on. Mitigations: partner holds the router admin password; the watchdog and heartbeat make a bypass
  visible to the partner. A determined person with physical access wins, so this is friction plus accountability.
- Sites missing from the blocklists, and adult content on mainstream platforms.
- Off-network devices need a companion (FocusGuard extension, Android Private DNS, iOS profile) in a later version.

Intended for consenting adults who want it (with a partner they chose) and for parents of minors. Show people what is
filtered on their own devices.

## Status: v0.1, not yet tested against a real AdGuard Home

The guardian logic (delays, approval, tamper revert, discovery, auth) is unit-tested. The AdGuard HTTP calls in
`src/adguard.ts` follow AdGuard Home's v0.107 API but have **not been run against a live instance yet**; expect to adjust
field names on first real run. DHCP auto-setup assumes a /24 home network.

## Roadmap

1. Run on a real Pi, fix API drift, add integration tests against an AdGuard container.
2. Prebuilt Pi image (pi-gen) so there is nothing to install.
3. Wizard translations (Arabic, French).
4. nftables rules on the box: block DoT (853), known DoH IPs, and optionally VPN protocols.
5. Router drivers (OpenWrt, MikroTik) as an alternative to DHCP takeover.
6. Companion profiles for phones off the home network; FocusGuard extension integration.
7. Partner web view (read-only log, approve/deny from anywhere).
