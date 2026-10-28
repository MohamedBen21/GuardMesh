import type { Provider } from './providers.js';

/**
 * Optional "drivers" that change the DNS of routers which have a real management interface.
 * Both are EXPERIMENTAL: written from the vendors' documentation, not yet run on a real router.
 * Most ISP-supplied routers have no such interface, so they use the guided manual mode instead.
 */

// ---------------- OpenWrt (over SSH) ----------------
/** Makes dnsmasq (the router's DNS forwarder) use only the filtering servers. Clients use the router as DNS by default. */
export function openwrtApply(p: Provider): string[] {
  return [
    `uci set dhcp.@dnsmasq[0].noresolv='1'`,
    `uci -q delete dhcp.@dnsmasq[0].server`,
    ...p.v4.map((a) => `uci add_list dhcp.@dnsmasq[0].server='${a}'`),
    `uci commit dhcp`,
    `/etc/init.d/dnsmasq restart`,
  ];
}

export function openwrtUndo(): string[] {
  return [
    `uci -q delete dhcp.@dnsmasq[0].server`,
    `uci set dhcp.@dnsmasq[0].noresolv='0'`,
    `uci commit dhcp`,
    `/etc/init.d/dnsmasq restart`,
  ];
}

/** Arguments for `ssh`; the whole script is passed as ONE argument (no local shell involved). */
export function sshArgs(host: string, user: string, commands: string[]): string[] {
  return [`${user}@${host}`, commands.join(' && ')];
}

// ---------------- MikroTik RouterOS 7 (REST API) ----------------
export interface HttpCall {
  method: 'POST' | 'GET' | 'PATCH';
  path: string;
  body?: unknown;
}

export function mikrotikApply(p: Provider): HttpCall[] {
  return [{ method: 'POST', path: '/rest/ip/dns/set', body: { servers: p.v4.join(','), 'allow-remote-requests': 'yes' } }];
}

export function mikrotikUndo(): HttpCall[] {
  return [{ method: 'POST', path: '/rest/ip/dns/set', body: { servers: '' } }];
}

export async function runMikrotik(
  base: string,
  user: string,
  password: string,
  calls: HttpCall[],
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const auth = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
  for (const c of calls) {
    const res = await fetchFn(base + c.path, {
      method: c.method,
      headers: { authorization: auth, ...(c.body ? { 'content-type': 'application/json' } : {}) },
      body: c.body ? JSON.stringify(c.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`${c.method} ${c.path} -> HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}
