import type { RecipeStatus } from "./runner.js";

/**
 * Router / ISP-box leads. This list is a starting point gathered from public research and is NOT verified:
 * it never contains passwords. `recipe` names the automatic driver (if any); everything else uses the manual guide.
 * `match` are lowercase fragments looked for in the router's login page (title / body / Server header).
 */
export interface RouterEntry {
  id: string;
  vendor: string;
  family: string;
  /** typical LAN address of this kind of box */
  gateway: string[];
  match: string[];
  recipe?: string;
  status: RecipeStatus;
  /** known problem: the box usually hides or locks the DNS setting */
  note?: string;
}

export const ROUTERS: RouterEntry[] = [
  {
    id: "huawei-hilink",
    vendor: "Huawei",
    family: "4G/5G HiLink routers (B310, B315, B535, H122…)",
    gateway: ["192.168.8.1", "192.168.1.1"],
    match: ["hilink", "huawei mobile wifi", "/api/webserver"],
    recipe: "huawei-hilink",
    status: "untested",
  },
  {
    id: "huawei-ont",
    vendor: "Huawei",
    family: "Fiber ONT (HG8145V5, HG8245H…)",
    gateway: ["192.168.100.1"],
    match: ["hg8145", "hg8245", "hg8546", "huawei home gateway"],
    status: "untested",
    note: "Operators often ship these with a locked admin account; the DNS field may be missing.",
  },
  {
    id: "zte-f6xx",
    vendor: "ZTE",
    family: "F660 / F670L / F680 / H188A",
    gateway: ["192.168.1.1"],
    match: ["zte", "f670", "f660", "f680", "h188"],
    status: "untested",
    note: "Operator-customised firmware; DNS is often only editable with a technician account.",
  },
  {
    id: "nokia",
    vendor: "Nokia",
    family: "G-240W / G-2425G-A",
    gateway: ["192.168.1.1"],
    match: ["nokia", "g-240w", "g-2425"],
    status: "untested",
  },
  {
    id: "tplink",
    vendor: "TP-Link",
    family: "Archer / TL-WR",
    gateway: ["192.168.0.1", "tplinkwifi.net"],
    match: ["tp-link", "tplink", "archer"],
    status: "untested",
  },
  {
    id: "mikrotik",
    vendor: "MikroTik",
    family: "RouterOS 7",
    gateway: ["192.168.88.1"],
    match: ["mikrotik", "routeros"],
    recipe: "mikrotik",
    status: "untested",
  },
  {
    id: "openwrt",
    vendor: "OpenWrt",
    family: "OpenWrt / LuCI",
    gateway: ["192.168.1.1"],
    match: ["openwrt", "luci"],
    recipe: "openwrt",
    status: "untested",
  },
  {
    id: "fritzbox",
    vendor: "AVM",
    family: "FRITZ!Box",
    gateway: ["192.168.178.1", "fritz.box"],
    match: ["fritz!box", "fritz.box"],
    status: "untested",
  },
  {
    id: "livebox",
    vendor: "Orange",
    family: "Livebox",
    gateway: ["192.168.1.1"],
    match: ["livebox", "orange"],
    status: "untested",
  },
  {
    id: "xfinity",
    vendor: "Comcast",
    family: "Xfinity gateway",
    gateway: ["10.0.0.1"],
    match: ["xfinity", "xfi"],
    status: "untested",
    note: 'Custom DNS is usually locked in the gateway. Use the "device" scripts, or put your own router behind it.',
  },
  {
    id: "att",
    vendor: "AT&T",
    family: "BGW / NVG gateway",
    gateway: ["192.168.1.254"],
    match: ["bgw", "nvg", "at&t"],
    status: "untested",
    note: 'Custom DNS is usually locked. Use the "device" scripts, or your own router behind it.',
  },
];

export interface Probe {
  gateway: string;
  status?: number;
  server?: string;
  title?: string;
  body?: string;
  /** true when /api/webserver/SesTokInfo (or /token) answered like a HiLink router */
  hilink?: boolean;
}

export interface Detection {
  entry?: RouterEntry;
  confidence: "strong" | "weak" | "none";
  reasons: string[];
}

/** Pure fingerprinting: decides what the login page looks like. */
export function fingerprint(p: Probe): Detection {
  if (p.hilink)
    return {
      entry: ROUTERS.find((r) => r.id === "huawei-hilink"),
      confidence: "strong",
      reasons: ["answers the Huawei HiLink API"],
    };
  const hay =
    `${p.title ?? ""}\n${p.server ?? ""}\n${(p.body ?? "").slice(0, 20_000)}`.toLowerCase();
  let best: { entry: RouterEntry; hits: string[] } | undefined;
  for (const entry of ROUTERS) {
    const hits = entry.match.filter((m) => hay.includes(m));
    if (hits.length && (!best || hits.length > best.hits.length))
      best = { entry, hits };
  }
  if (best)
    return {
      entry: best.entry,
      confidence: best.hits.length > 1 ? "strong" : "weak",
      reasons: best.hits.map((h) => `page mentions "${h}"`),
    };
  return { confidence: "none", reasons: [] };
}

export function parseGateway(
  platform: string,
  output: string,
): string | undefined {
  const ip = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/;
  if (platform === "linux") {
    // /proc/net/route: Iface Destination Gateway ... (hex, little endian)
    for (const line of output.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f[1] === "00000000" && f[2] && f[2] !== "00000000") {
        const n = parseInt(f[2], 16);
        return [
          n & 255,
          (n >> 8) & 255,
          (n >> 16) & 255,
          (n >>> 24) & 255,
        ].join(".");
      }
    }
    return undefined;
  }
  if (platform === "darwin")
    return /^default\s+(\d{1,3}(?:\.\d{1,3}){3})/m.exec(output)?.[1];
  if (platform === "win32") {
    const m = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d{1,3}(?:\.\d{1,3}){3})/m.exec(
      output,
    );
    return (
      m?.[1] ??
      (ip.test(output.trim()) ? ip.exec(output.trim())![1] : undefined)
    );
  }
  return undefined;
}

export function summarize(d: Detection, gateway: string): string[] {
  const out = [`Router address: ${gateway}`];
  if (!d.entry) {
    out.push(
      "Could not recognise this router. Use the manual guide:  npm run router -- setup --router manual",
    );
    return out;
  }
  out.push(
    `Looks like: ${d.entry.vendor} ${d.entry.family} (${d.confidence} match: ${d.reasons.join("; ")})`,
  );
  if (d.entry.recipe)
    out.push(
      `Automatic recipe: ${d.entry.recipe} [${d.entry.status.toUpperCase()}]  ->  npm run router -- setup --router ${d.entry.recipe} --host ${gateway} --dry-run`,
    );
  else
    out.push(
      `No automatic recipe yet. Manual steps with notes for this brand:  npm run router -- setup --router manual --brand ${d.entry.id}`,
    );
  if (d.entry.note) out.push(`Heads-up: ${d.entry.note}`);
  return out;
}
