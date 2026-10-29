import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RouterDriver, Snapshot } from './runner.js';

/**
 * Huawei HiLink (4G/5G home routers and some LTE dongles, e.g. B310 / B315 / B535 / H122-373).
 * UNTESTED on real devices. The protocol (token handling, the three login schemes, the DHCP/DNS endpoint) was read from
 * the open-source client https://github.com/Salamek/huawei-lte-api and re-implemented here; the tests run against a mock
 * of that protocol, not against a real router.
 */

export class HilinkError extends Error {
  constructor(message: string, public code?: number) {
    super(message);
    this.name = 'HilinkError';
  }
}
class ScramUnavailable extends Error {}

const CODE = { NOT_SUPPORTED: 100002, LOGIN_REQUIRED: 100003, CSRF: 125002, WRONG_TOKEN: 125003 };

const LOGIN_ERRORS: Record<number, string> = {
  108001: 'Wrong username.',
  108002: 'Wrong password.',
  108003: 'Somebody is already logged in to the router page. Close that session or wait a few minutes.',
  108006: 'Wrong username or password.',
  108007: 'Too many wrong attempts: the router locked logins for a few minutes. Wait, then try again.',
  115002: 'The router asks for a password change first: log in once from its web page and change it.',
};

const sha256hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/** Password field of the legacy "type 4" login: base64(sha256hex(user + base64(sha256hex(password)) + token)). */
export function legacySha256Password(username: string, password: string, token: string): string {
  const inner = Buffer.from(sha256hex(password), 'ascii').toString('base64');
  return Buffer.from(sha256hex(username + inner + token), 'ascii').toString('base64');
}

/**
 * SCRAM-style proof used by newer HiLink web UIs. NOTE (from the reference implementation): the firmware's own JavaScript
 * swaps key and message compared to RFC 5802, and a standard implementation is rejected with error 108006.
 */
export function scramClientProof(password: string, saltHex: string, iterations: number, firstNonce: string, serverNonce: string) {
  const authMessage = `${firstNonce},${serverNonce},${serverNonce}`;
  const salted = pbkdf2Sync(password, Buffer.from(saltHex, 'hex'), iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', 'Client Key').update(salted).digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const clientSignature = createHmac('sha256', authMessage).update(storedKey).digest();
  const proof = Buffer.from(clientKey.map((b, i) => b ^ clientSignature[i])).toString('hex');
  const serverKey = createHmac('sha256', 'Server Key').update(salted).digest();
  const serverSignature = createHmac('sha256', authMessage).update(serverKey).digest('hex');
  return { proof, serverSignature };
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlDecode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export interface Parsed {
  error?: { code: number; message: string };
  value: Record<string, string> | string;
}

/** Parses the router's reply: `<response>OK</response>`, a flat `<response><Field>value</Field>…</response>`, or `<error>`. */
export function parseResponse(text: string): Parsed {
  const t = text.trim();
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      if (j.error) return { error: { code: Number(j.error.code), message: String(j.error.message ?? '') }, value: {} };
      return { value: Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v)])) };
    } catch {
      /* fall through to XML */
    }
  }
  const err = /<error>[\s\S]*?<code>(\d+)<\/code>(?:[\s\S]*?<message>([^<]*)<\/message>)?[\s\S]*?<\/error>/.exec(t);
  if (err) return { error: { code: Number(err[1]), message: err[2] ?? '' }, value: {} };
  const m = /<response>([\s\S]*)<\/response>/.exec(t);
  const inner = (m ? m[1] : t).trim();
  if (!inner.includes('<')) return { value: inner };
  const out: Record<string, string> = {};
  for (const x of inner.matchAll(/<(\w+)>([^<]*)<\/\1>/g)) out[x[1]] = xmlDecode(x[2]);
  return { value: out };
}

export class HilinkClient {
  private tokens: string[] = [];
  private cookies = new Map<string, string>();
  private base: string;

  constructor(base: string, private fetchFn: typeof fetch = fetch, private timeoutMs = 10_000) {
    this.base = base.endsWith('/') ? base : base + '/';
  }

  private cookieHeader(): Record<string, string> {
    return this.cookies.size ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {};
  }

  private keepCookies(res: Response) {
    const list: string[] = (res.headers as any).getSetCookie?.() ?? [];
    for (const c of list) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  private keepTokens(res: Response) {
    const one = res.headers.get('__RequestVerificationTokenone');
    if (one) {
      this.tokens.push(one);
      const two = res.headers.get('__RequestVerificationTokentwo');
      if (two) this.tokens.push(two);
    } else {
      const single = res.headers.get('__RequestVerificationToken');
      if (single) this.tokens.push(single);
    }
  }

  /** Fetches the page and an anti-CSRF token. Must be called before anything else. */
  async init(): Promise<void> {
    this.tokens = [];
    const res = await this.fetchFn(this.base, { headers: this.cookieHeader(), signal: AbortSignal.timeout(this.timeoutMs) });
    this.keepCookies(res);
    const html = await res.text();
    const found = [...html.matchAll(/name="csrf_token"\s+content="(\S+?)"/g)].map((m) => m[1]);
    if (found.length) {
      this.tokens = found;
      return;
    }
    const token = await this.apiToken();
    if (token) this.tokens.push(token);
  }

  private async apiToken(): Promise<string | null> {
    try {
      const d = (await this.get('webserver/token', false)) as Record<string, string>;
      return d.token ?? null;
    } catch (e) {
      if (!(e instanceof HilinkError) || e.code !== CODE.NOT_SUPPORTED) throw e;
    }
    try {
      const d = (await this.get('webserver/SesTokInfo', false)) as Record<string, string>;
      const ses = /SessionID=([^;\s]+)/.exec(d.SesInfo ?? '');
      if (ses && !this.cookies.has('SessionID')) this.cookies.set('SessionID', ses[1]);
      return d.TokInfo ?? null;
    } catch (e) {
      if (e instanceof HilinkError && e.code === CODE.NOT_SUPPORTED) return null;
      throw e;
    }
  }

  private check(parsed: Parsed): Record<string, string> | string {
    if (parsed.error) throw new HilinkError(`${parsed.error.code}: ${parsed.error.message || 'router error'}`, parsed.error.code);
    return parsed.value;
  }

  async get(endpoint: string, retry = true): Promise<Record<string, string> | string> {
    const headers: Record<string, string> = { ...this.cookieHeader() };
    if (this.tokens.length === 1) headers.__RequestVerificationToken = this.tokens[0];
    const res = await this.fetchFn(`${this.base}api/${endpoint}`, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    this.keepCookies(res);
    try {
      return this.check(parseResponse(await res.text()));
    } catch (e) {
      if (retry && e instanceof HilinkError && e.code === CODE.CSRF) {
        await this.init();
        return this.get(endpoint, false);
      }
      throw e;
    }
  }

  async post(endpoint: string, data: Record<string, string | number>, refreshCsrf = false, retry = true): Promise<Record<string, string> | string> {
    const headers: Record<string, string> = { 'content-type': 'application/xml', ...this.cookieHeader() };
    if (this.tokens.length > 1) headers.__RequestVerificationToken = this.tokens.shift()!;
    else if (this.tokens.length === 1) headers.__RequestVerificationToken = this.tokens[0];
    const body =
      '<?xml version="1.0" encoding="UTF-8"?><request>' +
      Object.entries(data).map(([k, v]) => `<${k}>${xmlEscape(String(v))}</${k}>`).join('') +
      '</request>';
    const res = await this.fetchFn(`${this.base}api/${endpoint}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
    this.keepCookies(res);
    if (refreshCsrf) this.tokens = [];
    this.keepTokens(res);
    try {
      return this.check(parseResponse(await res.text()));
    } catch (e) {
      if (retry && e instanceof HilinkError && e.code === CODE.CSRF) {
        await this.init();
        return this.post(endpoint, data, refreshCsrf, false);
      }
      throw e;
    }
  }

  private friendly(e: unknown): never {
    if (e instanceof HilinkError && e.code && LOGIN_ERRORS[e.code]) throw new HilinkError(LOGIN_ERRORS[e.code], e.code);
    throw e;
  }

  private async loginScram(username: string, password: string): Promise<void> {
    const firstNonce = randomBytes(32).toString('hex');
    let challenge: Record<string, string> | string;
    try {
      challenge = await this.post('user/challenge_login', { username, firstnonce: firstNonce, mode: 1 }, true);
    } catch (e) {
      if (e instanceof HilinkError && (e.code === CODE.NOT_SUPPORTED || e.code === CODE.LOGIN_REQUIRED)) throw new ScramUnavailable();
      this.friendly(e);
    }
    if (typeof challenge === 'string' || !challenge.salt || !challenge.iterations || !challenge.servernonce) throw new ScramUnavailable();
    const { proof, serverSignature } = scramClientProof(password, challenge.salt, Number(challenge.iterations), firstNonce, challenge.servernonce);
    let result: Record<string, string> | string;
    try {
      result = await this.post('user/authentication_login', { clientproof: proof, finalnonce: challenge.servernonce }, true);
    } catch (e) {
      this.friendly(e);
    }
    const got = typeof result === 'string' ? '' : result.serversignature ?? '';
    const a = Buffer.from(got);
    const b = Buffer.from(serverSignature);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HilinkError('The router did not prove it knows the password (server signature mismatch). Not continuing.');
  }

  async login(username: string, password: string): Promise<void> {
    let state: Record<string, string> | string;
    try {
      state = await this.get('user/state-login');
    } catch (e) {
      if (e instanceof HilinkError && e.code === CODE.NOT_SUPPORTED) return; // this model needs no login
      throw e;
    }
    if (typeof state === 'string') throw new HilinkError('Unexpected reply from the router (is this really a Huawei HiLink router?)');
    const passwordType = Number(state.password_type ?? 0);
    if (passwordType === 4 && password) {
      try {
        return await this.loginScram(username, password);
      } catch (e) {
        if (!(e instanceof ScramUnavailable)) throw e;
        if (!this.tokens.length) await this.init();
      }
    }
    const encoded =
      !password ? '' : passwordType === 4 ? legacySha256Password(username, password, this.tokens[0] ?? '') : b64(password);
    let result: Record<string, string> | string;
    try {
      result = await this.post('user/login', { Username: username, Password: encoded, password_type: passwordType }, true);
    } catch (e) {
      this.friendly(e);
    }
    if (result !== 'OK') throw new HilinkError('Login was not accepted by the router.');
  }

  async logout(): Promise<void> {
    try {
      await this.post('user/logout', { Logout: 1 });
    } catch {
      /* best effort */
    }
  }

  async readDhcp(): Promise<Record<string, string>> {
    const r = await this.get('dhcp/settings');
    if (typeof r === 'string') throw new HilinkError('Unexpected DHCP settings reply.');
    return r;
  }

  /**
   * The router replaces ALL these fields at once, so the caller must send the current values for everything except DNS
   * (the reference library's defaults would reset your LAN address and range).
   */
  static requireComplete(f: Record<string, string>): void {
    const required = ['DhcpIPAddress', 'DhcpLanNetmask', 'DhcpStatus', 'DhcpStartIPAddress', 'DhcpEndIPAddress', 'DhcpLeaseTime'];
    const missing = required.filter((k) => !f[k]);
    if (missing.length) throw new HilinkError(`The router's DHCP settings are missing ${missing.join(', ')}. Refusing to write so your network is not broken.`);
  }

  async writeDhcp(f: Record<string, string>): Promise<void> {
    HilinkClient.requireComplete(f);
    const result = await this.post('dhcp/settings', {
      DhcpIPAddress: f.DhcpIPAddress,
      DhcpLanNetmask: f.DhcpLanNetmask,
      DhcpStatus: f.DhcpStatus,
      DhcpStartIPAddress: f.DhcpStartIPAddress,
      DhcpEndIPAddress: f.DhcpEndIPAddress,
      DhcpLeaseTime: f.DhcpLeaseTime,
      DnsStatus: f.DnsStatus ?? '0',
      PrimaryDns: f.PrimaryDns ?? '',
      SecondaryDns: f.SecondaryDns ?? '',
      ShowDnsSetting: f.ShowDnsSetting ?? '1',
    });
    if (result !== 'OK') throw new HilinkError('The router did not confirm the change.');
  }
}

/** Driver used by the safe runner. */
export class HilinkDriver implements RouterDriver {
  readonly id = 'huawei-hilink';
  readonly label = 'Huawei HiLink 4G/5G router';
  readonly status = 'untested' as const;
  readonly basis = 'Re-implemented from the open-source client Salamek/huawei-lte-api; not yet run on a real router.';
  readonly defaultHost = '192.168.8.1';
  readonly defaultUser = 'admin';
  private client: HilinkClient;

  constructor(host: string, fetchFn: typeof fetch = fetch) {
    this.client = new HilinkClient(host.startsWith('http') ? host : `http://${host}`, fetchFn);
  }

  async login(user: string, password: string) {
    await this.client.init();
    await this.client.login(user, password);
  }
  async read(): Promise<Snapshot> {
    return this.client.readDhcp();
  }
  dnsOf(s: Snapshot): string[] {
    return s.DnsStatus === '1' ? [s.PrimaryDns, s.SecondaryDns].filter(Boolean) : [];
  }
  withDns(s: Snapshot, servers: string[]): Snapshot {
    HilinkClient.requireComplete(s);
    return { ...s, DnsStatus: '1', PrimaryDns: servers[0] ?? '', SecondaryDns: servers[1] ?? '' };
  }
  async write(s: Snapshot) {
    await this.client.writeDhcp(s);
  }
  async logout() {
    await this.client.logout();
  }
}
