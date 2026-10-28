import { normMac } from './util.js';

export interface Lease {
  mac: string;
  ip: string;
  hostname: string;
}

/** Everything the guardian needs from AdGuard Home. Faked in tests. */
export interface AdGuardApi {
  isInstalled(): Promise<boolean>;
  install(username: string, password: string): Promise<void>;
  /** filtering on + adult blocklists + parental + safe search + DoH-bypass rules + protection on */
  applyBaselinePolicy(): Promise<void>;
  getProtection(): Promise<boolean>;
  setProtection(enabled: boolean): Promise<void>;
  listLeases(): Promise<Lease[]>;
  /** Turn on AdGuard's DHCP server (auto-detects interface, assumes a /24 network). */
  enableDhcp(): Promise<void>;
  setExempt(mac: string, name: string, exempt: boolean): Promise<void>;
  listExemptMacs(): Promise<string[]>;
}

export const ADULT_LISTS = [
  {
    name: 'StevenBlack porn-only',
    url: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn-only/hosts',
  },
  { name: 'OISD NSFW', url: 'https://nsfw.oisd.nl/' },
];

/** Block well-known DNS-over-HTTPS resolvers so browsers can't sidestep the box. */
export const BYPASS_RULES = [
  '||use-application-dns.net^$dnsrewrite=NXDOMAIN', // Firefox DoH canary
  '||dns.google^',
  '||dns64.dns.google^',
  '||cloudflare-dns.com^',
  '||mozilla.cloudflare-dns.com^',
  '||one.one.one.one^',
  '||dns.quad9.net^',
  '||doh.opendns.com^',
  '||dns.nextdns.io^',
  '||doh.dns.sb^',
  '||dns.adguard-dns.com^',
];

const exemptName = (mac: string) => `exempt-${mac.replace(/:/g, '')}`;

export class AdGuardHttp implements AdGuardApi {
  constructor(
    private base: string,
    private creds: () => { user: string; password: string } | undefined,
  ) {}

  private async req(path: string, init: RequestInit = {}, auth = true): Promise<any> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const c = this.creds();
    if (auth && c) headers.authorization = 'Basic ' + Buffer.from(`${c.user}:${c.password}`).toString('base64');
    const res = await fetch(this.base + path, { ...init, headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`AdGuard ${path} -> ${res.status} ${text}`);
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text;
    }
  }
  private post(path: string, body?: unknown, auth = true) {
    return this.req(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }, auth);
  }
  private async tryPost(path: string, body?: unknown): Promise<void> {
    try {
      await this.post(path, body);
    } catch (e) {
      console.warn(`[adguard] ${path} failed (continuing): ${(e as Error).message}`);
    }
  }

  async isInstalled(): Promise<boolean> {
    try {
      await this.req('/control/status');
      return true;
    } catch {
      return false;
    }
  }

  async install(username: string, password: string): Promise<void> {
    await this.post(
      '/control/install/configure',
      {
        web: { ip: '127.0.0.1', port: 3000 }, // admin UI reachable only from the box itself
        dns: { ip: '0.0.0.0', port: 53 },
        username,
        password,
      },
      false,
    );
  }

  async applyBaselinePolicy(): Promise<void> {
    await this.tryPost('/control/filtering/config', { enabled: true, interval: 1 });
    for (const l of ADULT_LISTS) {
      await this.tryPost('/control/filtering/add_url', { name: l.name, url: l.url, whitelist: false });
    }
    await this.tryPost('/control/filtering/set_rules', { rules: BYPASS_RULES });
    await this.tryPost('/control/safesearch/enable'); // older API
    await this.tryPost('/control/safesearch/settings', { enabled: true, bing: true, duckduckgo: true, google: true, pixabay: true, yandex: true, youtube: true });
    await this.tryPost('/control/parental/enable');
    await this.post('/control/protection', { enabled: true });
  }

  async getProtection(): Promise<boolean> {
    const s = await this.req('/control/status');
    return Boolean(s.protection_enabled);
  }

  async setProtection(enabled: boolean): Promise<void> {
    await this.post('/control/protection', { enabled });
  }

  async listLeases(): Promise<Lease[]> {
    const s = await this.req('/control/dhcp/status');
    const all = [...(s.leases ?? []), ...(s.static_leases ?? [])];
    const out: Lease[] = [];
    for (const l of all) {
      const mac = normMac(l.mac ?? '');
      if (mac) out.push({ mac, ip: l.ip, hostname: l.hostname ?? '' });
    }
    return out;
  }

  async enableDhcp(): Promise<void> {
    const ifaces = await this.req('/control/dhcp/interfaces');
    const entry = Object.entries<any>(ifaces ?? {}).find(([, v]) => v.gateway_ip && v.ipv4_addresses?.length);
    if (!entry) throw new Error('No suitable network interface found for DHCP');
    const [name, info] = entry;
    const ip: string = info.ipv4_addresses[0];
    const base = ip.split('.').slice(0, 3).join('.');
    await this.post('/control/dhcp/set_config', {
      enabled: true,
      interface_name: name,
      v4: {
        gateway_ip: info.gateway_ip,
        subnet_mask: '255.255.255.0',
        range_start: `${base}.100`,
        range_end: `${base}.250`,
        lease_duration: 86400,
      },
    });
  }

  private clientData(mac: string, name: string) {
    return {
      name,
      ids: [mac],
      use_global_settings: false,
      filtering_enabled: false,
      parental_enabled: false,
      safebrowsing_enabled: false,
      safesearch_enabled: false,
      safe_search: { enabled: false },
      use_global_blocked_services: true,
      blocked_services: [],
      tags: [],
      upstreams: [],
    };
  }

  async setExempt(mac: string, _label: string, exempt: boolean): Promise<void> {
    const name = exemptName(mac);
    if (!exempt) {
      try {
        await this.post('/control/clients/delete', { name });
      } catch (e) {
        if (!/not found|no such|does not exist|400|404/i.test((e as Error).message)) throw e;
      }
      return;
    }
    const data = this.clientData(mac, name);
    try {
      await this.post('/control/clients/add', data);
    } catch {
      await this.post('/control/clients/update', { name, data });
    }
  }

  async listExemptMacs(): Promise<string[]> {
    const r = await this.req('/control/clients');
    return (r?.clients ?? [])
      .filter((c: any) => typeof c.name === 'string' && c.name.startsWith('exempt-'))
      .map((c: any) => normMac(c.ids?.[0] ?? ''))
      .filter((m: string | null): m is string => Boolean(m));
  }
}
