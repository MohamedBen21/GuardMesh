/**
 * Brand-specific hints for the manual router guide. UNVERIFIED: written from general knowledge of these product
 * families, not checked on real devices. Menu names change with firmware and with the ISP's customisation, so every
 * hint is phrased as "usually". Improve them by sending corrections (model, firmware, exact menu path; never passwords).
 */
export interface BrandGuide {
  id: string;
  name: string;
  address: string;
  /** where the DNS fields usually are */
  where: string[];
  /** login / account notes */
  account: string;
  /** known traps */
  traps: string[];
  /** true when the DNS field is commonly locked by the ISP */
  oftenLocked: boolean;
}

export const BRAND_GUIDES: BrandGuide[] = [
  {
    id: 'zte-f6xx', name: 'ZTE (F660 / F670L / F680 / H188A and similar)', address: 'http://192.168.1.1',
    where: ['Network > LAN > DHCP Server (look for "DNS" or "Primary / Secondary DNS")', 'Network > WAN > WAN Connection > DNS fields (for the internet connection itself)'],
    account: 'Many ISPs give customers a limited account; the advanced menus may only show with a different account that the ISP controls. Do not guess passwords: ask the ISP, or use the locked-DNS options.',
    traps: ['Set both the LAN/DHCP DNS and the WAN DNS if both exist.', 'The ISP can push its own settings back (remote management) and undo your change after a reboot: run verify again the next day.'],
    oftenLocked: true,
  },
  {
    id: 'huawei-ont', name: 'Huawei fiber box (HG8145V5 / HG8245H / HG8546 and similar)', address: 'http://192.168.100.1 (sometimes 192.168.1.1)',
    where: ['LAN > DHCP Server Configuration (DNS fields for devices)', 'WAN > WAN Configuration (DNS of the internet connection, if shown)'],
    account: 'The sticker login is often a limited user. A fuller menu may need an ISP-controlled account.',
    traps: ['On many ISP builds the DHCP DNS field is missing or fixed to the box itself.', 'If the box hands out its own address as DNS, changing WAN DNS alone will not filter anything: the check will tell.'],
    oftenLocked: true,
  },
  {
    id: 'nokia', name: 'Nokia (G-240W / G-2425G-A and similar)', address: 'http://192.168.1.1',
    where: ['Network (or Home Networking) > LAN > DHCP Server', 'Network > WAN (DNS of the connection)'],
    account: 'Often a limited user login; some ISP firmware hides the DHCP DNS fields entirely.',
    traps: ['If no DNS field exists, this box cannot do it: use the locked-DNS options.'],
    oftenLocked: true,
  },
  {
    id: 'tplink', name: 'TP-Link (Archer / TL-WR and similar)', address: 'http://192.168.0.1 or http://tplinkwifi.net',
    where: ['Advanced > Network > DHCP Server: "Primary DNS" and "Secondary DNS"', 'Advanced > Network > Internet > Advanced: "Use the following DNS addresses"'],
    account: 'You usually set the admin password yourself on first setup, so this is the easiest brand: your partner can simply set a new one.',
    traps: ['Set both places. Old-style menus: DHCP > DHCP Settings.', 'If the router sits behind an ISP box, devices may still use the ISP box DHCP: check which router hands out addresses.'],
    oftenLocked: false,
  },
  {
    id: 'fritzbox', name: 'AVM FRITZ!Box', address: 'http://fritz.box or http://192.168.178.1',
    where: ['Home Network > Network > Network Settings > IPv4 Addresses: "Local DNS server"', 'Internet > Account Information > DNS Server (needs "Expert view")'],
    account: 'You set the admin password yourself.',
    traps: ['Enable the Expert view to see the fields. Set IPv6 DNS too.'],
    oftenLocked: false,
  },
  {
    id: 'livebox', name: 'Orange Livebox', address: 'http://192.168.1.1',
    where: ['Advanced settings > Network > DHCP / DNS (names vary by model)'],
    account: 'The Livebox password is printed on the box; some models hide DNS settings.',
    traps: ['If DNS cannot be changed, use the locked-DNS options.'],
    oftenLocked: true,
  },
  {
    id: 'att', name: 'AT&T gateways (BGW / NVG)', address: 'http://192.168.1.254',
    where: ['Custom DNS is usually not offered on these gateways.'],
    account: 'The ISP app or a limited admin page.',
    traps: ['Use the locked-DNS options instead.'],
    oftenLocked: true,
  },
  {
    id: 'xfinity', name: 'Xfinity / Spectrum gateways', address: 'varies (10.0.0.1, 192.168.1.254)',
    where: ['Custom DNS is usually not offered on these gateways.'],
    account: 'The ISP app or a limited admin page.',
    traps: ['Use the locked-DNS options instead.'],
    oftenLocked: true,
  },
];

export function getBrand(id: string): BrandGuide | undefined {
  return BRAND_GUIDES.find((b) => b.id === id);
}

export function brandGuideText(b: BrandGuide): string {
  return [
    `BRAND NOTES — ${b.name}  [UNVERIFIED: written from general knowledge, menus differ by firmware and ISP]`,
    ``,
    `Admin page : ${b.address}`,
    `DNS fields usually here:`,
    ...b.where.map((w) => `  - ${w}`),
    `Login      : ${b.account}`,
    ...b.traps.map((t) => `Watch out  : ${t}`),
    ...(b.oftenLocked ? [`This brand is OFTEN LOCKED by ISPs. If you cannot find or edit the fields, see:  npm run router -- setup --router manual --brand locked`] : []),
  ].join('\n');
}

export function lockedGuideText(): string {
  return [
    `MY ROUTER WON'T LET ME CHANGE DNS — your options, best first`,
    ``,
    `1. Put your OWN router behind the ISP box (about the price of a cheap router).`,
    `   Plug its WAN port into the ISP box, turn the ISP box's Wi-Fi off, use your router for Wi-Fi, set DNS on it`,
    `   (see the TP-Link notes: npm run router -- setup --router manual --brand tplink). Your partner sets its admin password. This is the`,
    `   most reliable way to protect the whole home.`,
    ``,
    `2. Use the box version (Raspberry Pi / old PC) and turn DHCP off on the ISP box, if its menu allows that.`,
    ``,
    `3. Protect each device with a script or profile:  npm run router -- device`,
    `   Works on any router, one device at a time. It does not cover guests or a new phone until you set it up there.`,
    ``,
    `4. Ask the ISP for custom DNS or a family filter option. Some offer one; support may say it is not possible.`,
    ``,
    `Also: ISP boxes can reset your changes when they update. Run  npm run router -- verify  now and then.`,
  ].join('\n');
}
