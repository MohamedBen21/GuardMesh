/** Normalise a MAC address to lower-case, colon-separated form. Returns null if invalid. */
export function normMac(input: string): string | null {
  const hex = input.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g)!.join(':');
}

export function id(): string {
  return Math.random().toString(36).slice(2, 10);
}
