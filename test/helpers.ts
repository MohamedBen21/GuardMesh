import { Store, defaultState } from '../src/store.js';
import { Guardian } from '../src/guardian.js';
import { generatePartnerKey, hashSecret } from '../src/auth.js';
import type { AdGuardApi, Lease } from '../src/adguard.js';
import type { AlertOpts } from '../src/notify.js';

export class FakeApi implements AdGuardApi {
  protection = true;
  exempt = new Set<string>();
  leases: Lease[] = [];
  async isInstalled() { return true; }
  async install() {}
  async applyBaselinePolicy() {}
  async getProtection() { return this.protection; }
  async setProtection(e: boolean) { this.protection = e; }
  async listLeases() { return this.leases; }
  async enableDhcp() {}
  async setExempt(mac: string, _n: string, on: boolean) { on ? this.exempt.add(mac) : this.exempt.delete(mac); }
  async listExemptMacs() { return [...this.exempt]; }
}

export const MIN = 60_000;

export function makeStore(over: Partial<ReturnType<typeof defaultState>> = {}) {
  const store = new Store('/tmp/fg-test-state.json');
  store.save = async () => {}; // no disk in tests
  store.state = { ...defaultState(), ...over };
  return store;
}

/** A configured box: setup done, 60 min delay, a known partner key. */
export function setup(over: Partial<ReturnType<typeof defaultState>> = {}) {
  const key = generatePartnerKey();
  const store = makeStore({ setupDone: true, delayMinutes: 60, partnerKeyHash: hashSecret(key), ...over });
  const api = new FakeApi();
  const sent: { text: string; opts?: AlertOpts }[] = [];
  let t = 1_000_000;
  const clock = { now: () => t };
  const g = new Guardian(store, api, { send: async (text, opts) => void sent.push({ text, opts }) }, clock);
  return { store, api, sent, g, key, advance: (ms: number) => (t += ms) };
}
