import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

/** Partner key looks like XXXX-XXXX-XXXX-XXXX (~80 bits). Shown/sent to the partner once, only its hash is kept. */
export function generatePartnerKey(): string {
  const group = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return [group(), group(), group(), group()].join('-');
}

export function generatePassword(): string {
  return randomBytes(24).toString('base64url');
}

export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(normalise(secret), salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifySecret(secret: string, stored: string | undefined): boolean {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(normalise(secret), Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

function normalise(s: string): string {
  // case, spaces and dashes are irrelevant when a human retypes the key
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Simple in-memory lockout: 5 failures => locked for 15 minutes. */
export class Lockout {
  private fails: number[] = [];
  constructor(private max = 5, private windowMs = 15 * 60_000) {}

  isLocked(now = Date.now()): boolean {
    this.fails = this.fails.filter((t) => now - t < this.windowMs);
    return this.fails.length >= this.max;
  }
  fail(now = Date.now()): void {
    this.fails.push(now);
  }
  reset(): void {
    this.fails = [];
  }
}
