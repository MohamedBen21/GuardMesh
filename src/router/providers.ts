/** Free family-filter DNS services. Verify the addresses on each provider's own site before relying on them. */
export interface Provider {
  id: string;
  name: string;
  description: string;
  v4: string[];
  v6: string[];
  /** DNS-over-TLS hostname (used by Android "Private DNS") */
  dotHost?: string;
  /** DNS-over-HTTPS URL (used by the iPhone/iPad/Mac profile) */
  dohUrl?: string;
}

export const PROVIDERS: Provider[] = [
  {
    id: 'cloudflare-families',
    name: 'Cloudflare for Families (security + adult filter)',
    description: 'Fast, no account. Blocks malware and adult content.',
    v4: ['1.1.1.3', '1.0.0.3'],
    v6: ['2606:4700:4700::1113', '2606:4700:4700::1003'],
    dotHost: 'family.cloudflare-dns.com',
    dohUrl: 'https://family.cloudflare-dns.com/dns-query',
  },
  {
    id: 'cleanbrowsing-family',
    name: 'CleanBrowsing Family (strictest)',
    description: 'Blocks adult content, forces safe search, blocks many proxies/VPN sites.',
    v4: ['185.228.168.168', '185.228.169.168'],
    v6: ['2a0d:2a00:1::', '2a0d:2a00:2::'],
    dotHost: 'family-filter-dns.cleanbrowsing.org',
    dohUrl: 'https://doh.cleanbrowsing.org/doh/family-filter/',
  },
  {
    id: 'cleanbrowsing-adult',
    name: 'CleanBrowsing Adult Filter',
    description: 'Blocks adult content and forces safe search; does not block proxies/VPN sites.',
    v4: ['185.228.168.10', '185.228.169.11'],
    v6: ['2a0d:2a00:1::1', '2a0d:2a00:2::1'],
    dotHost: 'adult-filter-dns.cleanbrowsing.org',
    dohUrl: 'https://doh.cleanbrowsing.org/doh/adult-filter/',
  },
  {
    id: 'opendns-familyshield',
    name: 'OpenDNS FamilyShield',
    description: 'Pre-configured adult-content block. IPv4 only here (no phone profile).',
    v4: ['208.67.222.123', '208.67.220.123'],
    v6: [],
  },
];

export const DEFAULT_PROVIDER = 'cloudflare-families';

export function getProvider(id: string): Provider {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown provider "${id}". Available: ${PROVIDERS.map((x) => x.id).join(', ')}`);
  return p;
}
