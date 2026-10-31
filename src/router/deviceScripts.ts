import { createHash } from 'node:crypto';

/** Same input, same UUID: reinstalling the profile replaces it instead of adding a second one, and builds are reproducible. */
function stableUuid(seed: string): string {
  const h = createHash('sha1').update('focusguard:' + seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`.toUpperCase();
}
import type { Provider } from './providers.js';

export type Os = 'windows' | 'macos' | 'linux';
export interface GeneratedScript {
  filename: string;
  content: string;
}

/**
 * Scripts that set the filtering DNS on ONE computer (useful when the router cannot be changed, or for a laptop
 * that joins other Wi-Fi networks). Each OS gets an "apply" and an "undo" script.
 */
export function deviceScript(os: Os, p: Provider, action: 'apply' | 'undo'): GeneratedScript {
  const v4 = p.v4.join(' ');
  const all = [...p.v4, ...p.v6].join(' ');
  const header = `FocusGuard: ${action === 'apply' ? `set the filtering DNS (${p.name})` : 'remove the filtering DNS'} on THIS computer.`;

  if (os === 'windows') {
    const ps4 = p.v4.map((a) => `'${a}'`).join(',');
    const ps6 = p.v6.map((a) => `'${a}'`).join(',');
    const body =
      action === 'apply'
        ? [
            `$v4 = @(${ps4})`,
            `$v6 = @(${ps6})`,
            `Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | ForEach-Object {`,
            `  $idx = $_.ifIndex`,
            `  try { Set-DnsClientServerAddress -InterfaceIndex $idx -ServerAddresses ($v4 + $v6) -ErrorAction Stop }`,
            `  catch { Set-DnsClientServerAddress -InterfaceIndex $idx -ServerAddresses $v4 }`,
            `}`,
            `Clear-DnsClientCache`,
            `Write-Host 'Done. Filtering DNS is now set on this computer.'`,
          ]
        : [
            `Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | ForEach-Object {`,
            `  Set-DnsClientServerAddress -InterfaceIndex $_.ifIndex -ResetServerAddresses`,
            `}`,
            `Clear-DnsClientCache`,
            `Write-Host 'Done. DNS is back to automatic.'`,
          ];
    return {
      filename: `focusguard-dns-windows-${action}.ps1`,
      content: [`# ${header}`, `# Run in PowerShell AS ADMINISTRATOR.`, `$ErrorActionPreference = 'Stop'`, ...body, ''].join('\n'),
    };
  }

  if (os === 'macos') {
    const set =
      action === 'apply'
        ? `sudo networksetup -setdnsservers "$svc" ${all}`
        : `sudo networksetup -setdnsservers "$svc" empty`;
    return {
      filename: `focusguard-dns-macos-${action}.sh`,
      content: [
        '#!/bin/bash',
        `# ${header}`,
        '# Run:  bash this-file.sh   (it asks for your password)',
        'set -e',
        `networksetup -listallnetworkservices | tail -n +2 | grep -v '^\\*' | while IFS= read -r svc; do`,
        `  ${set}`,
        'done',
        'sudo dscacheutil -flushcache',
        'sudo killall -HUP mDNSResponder || true',
        `echo "Done."`,
        '',
      ].join('\n'),
    };
  }

  // linux (NetworkManager, e.g. Ubuntu desktop)
  const modify =
    action === 'apply'
      ? `nmcli connection modify "$name" ipv4.dns "${v4}" ipv4.ignore-auto-dns yes ipv6.dns "${p.v6.join(' ')}" ipv6.ignore-auto-dns ${p.v6.length ? 'yes' : 'no'}`
      : `nmcli connection modify "$name" ipv4.dns "" ipv4.ignore-auto-dns no ipv6.dns "" ipv6.ignore-auto-dns no`;
  return {
    filename: `focusguard-dns-linux-${action}.sh`,
    content: [
      '#!/usr/bin/env bash',
      `# ${header}`,
      '# For systems that use NetworkManager (most desktop Linux). Run:  bash this-file.sh',
      'set -e',
      `nmcli -t -f NAME,TYPE connection show --active | while IFS=: read -r name type; do`,
      `  case "$type" in *ethernet|*wireless) ;; *) continue ;; esac`,
      `  ${modify}`,
      `  nmcli connection up "$name" >/dev/null`,
      'done',
      `echo "Done."`,
      '',
    ].join('\n'),
  };
}

/** Private DNS on Android 9+: no script, just one setting. */
export function androidSteps(p: Provider): string {
  if (!p.dotHost) return `${p.name} has no Private DNS hostname. Pick Cloudflare for Families or CleanBrowsing instead.`;
  return [
    `Android 9 or newer:`,
    `  1. Settings → Network & internet (or Connections) → Private DNS.`,
    `  2. Choose "Private DNS provider hostname".`,
    `  3. Type:  ${p.dotHost}`,
    `  4. Save. It now applies on Wi-Fi AND mobile data.`,
    `To undo: set Private DNS back to "Automatic".`,
    `Note: a determined user can change this setting; it is friction, not a lock. Ask your partner to keep a note of it.`,
  ].join('\n');
}

/** Configuration profile for iPhone / iPad / Mac (DNS over HTTPS). Tested on a real iPhone by the author. */
export function iosProfile(p: Provider): GeneratedScript {
  if (!p.dohUrl) throw new Error(`${p.name} has no DNS-over-HTTPS address, so it cannot be used as a profile. Choose another provider.`);
  const name = `FocusGuard DNS (${p.id})`;
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>DNSSettings</key>
      <dict>
        <key>DNSProtocol</key><string>HTTPS</string>
        <key>ServerURL</key><string>${p.dohUrl}</string>
      </dict>
      <key>PayloadDescription</key><string>Uses a family-safe DNS service.</string>
      <key>PayloadDisplayName</key><string>${name}</string>
      <key>PayloadIdentifier</key><string>com.focusguard.dns.payload.${p.id}</string>
      <key>PayloadType</key><string>com.apple.dnsSettings.managed</string>
      <key>PayloadUUID</key><string>${stableUuid(p.id + ':payload')}</string>
      <key>PayloadVersion</key><integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key><string>Family-safe DNS for this device.</string>
  <key>PayloadDisplayName</key><string>${name}</string>
  <key>PayloadIdentifier</key><string>com.focusguard.dns.${p.id}</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${stableUuid(p.id + ':profile')}</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>
</plist>
`;
  return { filename: `focusguard-dns-${p.id}.mobileconfig`, content };
}

export const IOS_STEPS = [
  'iPhone / iPad:',
  '  1. Send the .mobileconfig file to the device (AirDrop, email, or open it in Safari from a link).',
  '  2. Settings → "Profile Downloaded" → Install → enter the passcode.',
  '  3. Settings → General → VPN, DNS & Device Management → DNS → select the FocusGuard profile.',
  'To undo: remove the profile in Settings → General → VPN, DNS & Device Management.',
  'Note: the person can remove it again, so ask your partner to check it from time to time. Tested on a real iPhone by the author.',
].join('\n');

/**
 * Windows launcher: ONE double-clickable .cmd that asks for administrator permission by itself (the normal Windows
 * "Do you want to allow this app to make changes?" window) and then runs the PowerShell script above.
 * The PowerShell code is embedded (-EncodedCommand), so there is a single file to download.
 */
export function windowsLauncher(p: Provider, action: 'apply' | 'undo'): GeneratedScript {
  const ps = deviceScript('windows', p, action).content;
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  const what = action === 'apply' ? 'turn filtering ON for this computer' : 'turn filtering OFF again for this computer';
  const content = [
    '@echo off',
    `rem FocusGuard: ${what} (${action === 'apply' ? p.name : 'back to automatic DNS'}).`,
    'rem Source: the same PowerShell script as focusguard-dns-windows-' + action + '.ps1 (embedded below).',
    'net session >nul 2>&1',
    'if %errorlevel% neq 0 (',
    '  echo Asking Windows for administrator permission...',
    `  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"`,
    '  exit /b',
    ')',
    `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
    'echo.',
    'pause',
    '',
  ].join('\r\n');
  return { filename: `focusguard-${action === 'apply' ? 'protect' : 'remove'}-windows.cmd`, content };
}

export type DownloadOs = 'windows' | 'macos' | 'linux' | 'ios';
export const DOWNLOAD_OS: DownloadOs[] = ['windows', 'macos', 'linux', 'ios'];

/** The file a "Protect this computer" / "Remove protection" button downloads. */
export function deviceDownload(os: DownloadOs, p: Provider, action: 'apply' | 'undo'): GeneratedScript & { mime: string } {
  if (os === 'windows') return { ...windowsLauncher(p, action), mime: 'application/octet-stream' };
  if (os === 'ios') {
    if (action === 'undo') throw new Error('On iPhone/iPad, remove the profile in Settings → General → VPN, DNS & Device Management.');
    return { ...iosProfile(p), mime: 'application/x-apple-aspen-config' };
  }
  const s = deviceScript(os, p, action);
  const filename = `focusguard-${action === 'apply' ? 'protect' : 'remove'}-${os}.${os === 'macos' ? 'command' : 'sh'}`;
  return { filename, content: s.content, mime: 'application/octet-stream' };
}
