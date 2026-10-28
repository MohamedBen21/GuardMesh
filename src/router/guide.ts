import type { Provider } from './providers.js';

/** Step-by-step instructions for routers that have no API (most ISP routers). */
export function manualGuide(p: Provider): string {
  const v6 = p.v6.length
    ? [
        `4. IPv6 (only if your router has IPv6 DNS fields): enter`,
        ...p.v6.map((a, i) => `     ${i === 0 ? 'Primary  ' : 'Secondary'}  ${a}`),
        `   or turn IPv6 DNS off. Otherwise devices can use your ISP's unfiltered IPv6 DNS and skip the filter.`,
      ]
    : [`4. IPv6: this provider has no IPv6 addresses here. If your router hands out IPv6 DNS, turn that off, otherwise devices can skip the filter.`];
  return [
    `MANUAL ROUTER SETUP — ${p.name}`,
    ``,
    `1. Open your router's admin page in a browser. Common addresses: http://192.168.1.1  http://192.168.0.1  http://192.168.100.1`,
    `   The login is often printed on a sticker on the router.`,
    ``,
    `2. Find the DNS settings. The menu name depends on the brand and firmware. Look under:`,
    `     LAN / DHCP Server / DHCP Settings  ->  "Primary DNS" and "Secondary DNS"`,
    `     Internet / WAN                      ->  "DNS" (often "Use the following DNS servers")`,
    `   Typical places (menus vary by version):`,
    `     TP-Link  : Advanced > Network > DHCP Server, or Internet`,
    `     Huawei   : LAN > DHCP Server Configuration, or WAN`,
    `     ZTE      : Network > LAN > DHCP Server, or WAN`,
    `     ASUS     : LAN > DHCP Server > DNS Server`,
    `   ISP-supplied routers often hide advanced pages behind a different admin account than the sticker one.`,
    ``,
    `3. Enter these values, then save (reboot the router if it asks):`,
    `     Primary DNS  :  ${p.v4[0]}`,
    `     Secondary DNS:  ${p.v4[1] ?? p.v4[0]}`,
    `   If there is both a WAN DNS and a LAN/DHCP DNS field, set BOTH.`,
    ``,
    ...v6,
    ``,
    `5. Make devices pick it up: turn Wi-Fi off and on (or restart) on each device.`,
    ``,
    `6. LOCK IT (the most important step if this is for self-control): ask your PARTNER to set a NEW router admin`,
    `   password and keep it. Without that, anyone at home can undo step 3 in one minute.`,
    ``,
    `7. Check that it works:   npm run router -- verify --provider ${p.id}`,
    ``,
    `Cannot find a DNS setting, or the fields are greyed out? Many ISP routers lock them. Use the per-device scripts`,
    `instead (npm run router -- device) or the box version, which needs no router access except turning DHCP off.`,
  ].join('\n');
}

export function manualUndoGuide(): string {
  return [
    `UNDO (manual router)`,
    ``,
    `Open the router admin page, go back to the same DNS fields, and set them to automatic`,
    `(or clear Primary/Secondary DNS, or enter your ISP's DNS). Save, then restart Wi-Fi on your devices.`,
    ``,
    `If the partner holds the router password, this is where you need them.`,
  ].join('\n');
}
