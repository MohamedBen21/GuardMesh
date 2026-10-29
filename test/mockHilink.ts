import { createHash } from 'node:crypto';
import { legacySha256Password, scramClientProof } from '../src/router/hilink.js';

export interface MockOpts {
  passwordType?: 0 | 3 | 4;
  scram?: boolean;
  password?: string;
  noLogin?: boolean;
  dhcp?: Record<string, string>;
  /** drop the connection reply for POST dhcp/settings (LAN restart) */
  failWrite?: boolean;
  badServerSig?: boolean;
}

export const DEFAULT_DHCP = {
  DhcpIPAddress: '192.168.8.1', DhcpLanNetmask: '255.255.255.0', DhcpStatus: '1',
  DhcpStartIPAddress: '192.168.8.100', DhcpEndIPAddress: '192.168.8.200', DhcpLeaseTime: '86400',
  DnsStatus: '0', PrimaryDns: '', SecondaryDns: '', ShowDnsSetting: '1',
};

const xml = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?><response>${inner}</response>`;
const err = (code: number) => `<?xml version="1.0" encoding="UTF-8"?><error><code>${code}</code><message></message></error>`;
const fields = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `<${k}>${v}</${k}>`).join('');

/** A fake HiLink router speaking the protocol as read from the reference client. Not a real device. */
export function mockHilink(opts: MockOpts = {}) {
  const st = {
    dhcp: { ...DEFAULT_DHCP, ...opts.dhcp },
    loggedIn: false, token: 'tok0', n: 0, calls: [] as string[], writes: 0, loginFailures: 0,
    session: 'sess-1', nonceSrv: 'srvnonce', firstNonce: '',
  };
  const pw = opts.password ?? 'secret';
  const ptype = opts.passwordType ?? 3;
  const newToken = () => `tok${++st.n}`;

  const fetchFn = (async (url: any, init: any = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? 'GET';
    const ep = u.pathname.replace(/^\/api\//, '');
    const headers = new Headers(init.headers);
    const sent = headers.get('__RequestVerificationToken');
    st.calls.push(`${method} ${u.pathname}`);
    const res = (body: string, extra: Record<string, string> = {}, status = 200) => {
      const h = new Headers({ 'content-type': 'text/xml', ...extra });
      return new Response(body, { status, headers: h });
    };
    if (u.pathname === '/') return res(`<html><head><meta name="csrf_token" content="${(st.token = newToken())}"/></head></html>`, { 'set-cookie': `SessionID=${st.session}; path=/` });
    if (method === 'POST') {
      if (sent !== st.token) return res(err(125002));
      st.token = newToken();
    } else if (ep !== 'webserver/SesTokInfo' && ep !== 'webserver/token' && ep !== 'user/state-login' && sent && sent !== st.token) {
      return res(err(125002));
    }
    const next = { __RequestVerificationToken: st.token };
    const body: string = init.body ?? '';
    const val = (k: string) => new RegExp(`<${k}>([^<]*)</${k}>`).exec(body)?.[1] ?? '';

    switch (ep) {
      case 'user/state-login':
        if (opts.noLogin) return res(err(100002));
        return res(xml(fields({ State: st.loggedIn ? '0' : '-1', password_type: String(ptype) })), next);
      case 'user/challenge_login': {
        if (!(opts.scram && ptype === 4)) return res(err(100002), next);
        st.firstNonce = val('firstnonce');
        return res(xml(fields({ salt: 'aabbccddeeff', iterations: '100', servernonce: st.firstNonce + 'S', modeselected: '1' })), next);
      }
      case 'user/authentication_login': {
        const exp = scramClientProof(pw, 'aabbccddeeff', 100, st.firstNonce, st.firstNonce + 'S');
        if (val('clientproof') !== exp.proof) { st.loginFailures++; return res(err(108006), next); }
        st.loggedIn = true;
        return res(xml(fields({ serversignature: opts.badServerSig ? 'deadbeef' : exp.serverSignature })), next);
      }
      case 'user/login': {
        const u0 = val('Username');
        const sentPw = val('Password');
        const ok = ptype === 4 ? sentPw === legacySha256Password(u0, pw, sent!) : sentPw === Buffer.from(pw).toString('base64');
        if (!ok) { st.loginFailures++; return res(err(108006), next); }
        st.loggedIn = true;
        return res('<response>OK</response>', next);
      }
      case 'webserver/SesTokInfo': return res(xml(`<SesInfo>SessionID=${st.session}</SesInfo><TokInfo>${st.token}</TokInfo>`));
      case 'user/logout': st.loggedIn = false; return res('<response>OK</response>', next);
      case 'dhcp/settings':
        if (!st.loggedIn) return res(err(100003), next);
        if (method === 'GET') return res(xml(fields(st.dhcp)), next);
        if (opts.failWrite) { st.writes++; Object.assign(st.dhcp, Object.fromEntries(['DhcpIPAddress','DhcpLanNetmask','DhcpStatus','DhcpStartIPAddress','DhcpEndIPAddress','DhcpLeaseTime','DnsStatus','PrimaryDns','SecondaryDns','ShowDnsSetting'].map((k) => [k, val(k)]))); throw new TypeError('fetch failed'); }
        st.writes++;
        for (const k of Object.keys(st.dhcp)) (st.dhcp as any)[k] = val(k);
        return res('<response>OK</response>', next);
      default: return res(err(100002), next);
    }
  }) as typeof fetch;
  return { fetchFn, st };
}
void createHash;
