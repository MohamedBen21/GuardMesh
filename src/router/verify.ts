import dns from 'node:dns/promises';
import type { Provider } from './providers.js';

export type Verdict = 'active' | 'inactive' | 'inconclusive';
export type Lookup = (host: string) => Promise<string[]>;

export const DEFAULT_TEST_DOMAINS = ['xnxx.com', 'xvideos.com'];

const SINKHOLES = new Set(['0.0.0.0', '::']);
/** Blocked answers look like 0.0.0.0 / :: / nothing at all. Real answers are what is left. */
const real = (ips: string[]) => ips.filter((ip) => !SINKHOLES.has(ip));
const overlap = (a: string[], b: string[]) => a.some((x) => b.includes(x));
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Decides whether this computer's own DNS path goes through the filter, by comparing three answers for a
 * domain the filter is known to block:
 *   sys  = what this computer gets (the router / system DNS)
 *   filt = what the filtering provider answers directly
 *   pub  = what an unfiltered public resolver answers
 */
export function judge(sys: string[], filt: string[], pub: string[]): Verdict {
  const S = real(sys);
  const F = real(filt);
  const P = real(pub);
  if (P.length === 0) return 'inconclusive'; // the domain does not resolve publicly: cannot compare
  const providerBlocks = F.length === 0 || !overlap(F, P);
  if (!providerBlocks) return 'inconclusive'; // the provider does not block this domain: try another
  if (sameSet(S, F)) return 'active';
  if (overlap(S, P)) return 'inactive';
  return 'inconclusive';
}

export interface VerifyResult {
  domain: string;
  verdict: Verdict;
  system: string[];
  filter: string[];
  public: string[];
  error?: string;
}

export interface VerifyDeps {
  systemLookup: Lookup;
  resolveVia: (server: string, host: string) => Promise<string[]>;
}

const NO_ANSWER = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ENOENT']);

export function defaultDeps(): VerifyDeps {
  return {
    systemLookup: async (host) => {
      try {
        const r = await dns.lookup(host, { all: true, family: 4 });
        return r.map((x) => x.address);
      } catch (e: any) {
        if (NO_ANSWER.has(e.code)) return [];
        throw e;
      }
    },
    resolveVia: async (server, host) => {
      const r = new dns.Resolver({ timeout: 4000, tries: 2 });
      r.setServers([server]);
      try {
        return await r.resolve4(host);
      } catch (e: any) {
        if (NO_ANSWER.has(e.code)) return [];
        throw e;
      }
    },
  };
}

export async function verifyFiltering(
  provider: Provider,
  domains: string[] = DEFAULT_TEST_DOMAINS,
  deps: VerifyDeps = defaultDeps(),
  publicServer = '9.9.9.9',
): Promise<{ overall: Verdict | 'error'; results: VerifyResult[] }> {
  const results: VerifyResult[] = [];
  for (const domain of domains) {
    try {
      const [system, filter, pub] = await Promise.all([
        deps.systemLookup(domain),
        deps.resolveVia(provider.v4[0], domain),
        deps.resolveVia(publicServer, domain),
      ]);
      results.push({ domain, verdict: judge(system, filter, pub), system, filter, public: pub });
    } catch (e) {
      results.push({ domain, verdict: 'inconclusive', system: [], filter: [], public: [], error: (e as Error).message });
    }
  }
  // no answers from the public resolver at all = no internet / DNS blocked: we could not run the check
  if (results.every((r) => r.error || r.public.length === 0)) return { overall: 'error', results };
  if (results.some((r) => r.verdict === 'inactive')) return { overall: 'inactive', results };
  if (results.some((r) => r.verdict === 'active')) return { overall: 'active', results };
  return { overall: 'inconclusive', results };
}
