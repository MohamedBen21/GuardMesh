import type { AdGuardApi } from './adguard.js';
import type { ChangeKind, ChangeRequest, Store } from './store.js';
import type { Notifier } from './notify.js';
import { verifySecret } from './auth.js';
import { id as newId, normMac } from './util.js';

export interface Clock {
  now(): number;
}

/**
 * Core rule: anything that WEAKENS protection (pause filtering, exempt a device) is a ChangeRequest that
 * only takes effect after `delayMinutes`, can be vetoed (cancelled) at any time, and notifies the partner.
 * Anything that STRENGTHENS protection (restore, cancel) is instant.
 * tick() also reverts any drift (protection off / unauthorised exemptions) back to the desired state.
 */
export class Guardian {
  constructor(
    private store: Store,
    private api: AdGuardApi,
    private notifier: Notifier,
    private clock: Clock = { now: () => Date.now() },
  ) {}

  private get s() {
    return this.store.state;
  }

  private note(event: string) {
    this.s.log.push({ at: this.clock.now(), event });
    if (this.s.log.length > 200) this.s.log.splice(0, this.s.log.length - 200);
  }

  private async alert(text: string) {
    this.note(text);
    await this.notifier.send(text);
  }

  async requestChange(input: { kind: ChangeKind; mac?: string; durationMinutes?: number | null }): Promise<ChangeRequest> {
    const now = this.clock.now();
    let mac: string | undefined;
    if (input.kind === 'exempt_device') {
      const m = input.mac ? normMac(input.mac) : null;
      if (!m) throw new Error('A valid MAC address is required');
      mac = m;
    }
    const dup = this.s.changes.find(
      (c) => (c.status === 'pending' || c.status === 'active') && c.kind === input.kind && c.mac === mac,
    );
    if (dup) return dup;

    const req: ChangeRequest = {
      id: newId(),
      kind: input.kind,
      mac,
      durationMinutes: input.durationMinutes ?? null,
      createdAt: now,
      unlockAt: now + this.s.delayMinutes * 60_000,
      status: 'pending',
    };
    this.s.changes.push(req);
    const what = req.kind === 'disable_all' ? 'pause ALL protection' : `stop filtering device ${this.deviceLabel(mac!)}`;
    await this.alert(`Request to ${what}. It will take effect at ${new Date(req.unlockAt).toISOString()} unless cancelled.`);
    await this.store.save();
    return req;
  }

  private deviceLabel(mac: string) {
    const d = this.s.devices[mac];
    return d?.name ? `${d.name} (${mac})` : mac;
  }

  /** Cancelling is a strengthening action: always allowed, no key needed. */
  async cancel(changeId: string): Promise<boolean> {
    const c = this.s.changes.find((x) => x.id === changeId);
    if (!c || (c.status !== 'pending' && c.status !== 'active')) return false;
    const wasActive = c.status === 'active';
    c.status = 'cancelled';
    if (wasActive) await this.revert(c);
    await this.alert(`Change ${c.kind}${c.mac ? ' ' + c.mac : ''} was cancelled.`);
    await this.store.save();
    return true;
  }

  /** Partner can skip the waiting period. */
  async approveEarly(changeId: string, partnerKey: string): Promise<boolean> {
    if (!verifySecret(partnerKey, this.s.partnerKeyHash)) return false;
    const c = this.s.changes.find((x) => x.id === changeId);
    if (!c || c.status !== 'pending') return false;
    c.unlockAt = this.clock.now();
    await this.tick();
    return true;
  }

  /** Instantly end every active change (restore full protection). */
  async restoreNow(): Promise<void> {
    for (const c of this.s.changes.filter((x) => x.status === 'active')) {
      c.status = 'cancelled';
      await this.revert(c);
    }
    await this.api.setProtection(true);
    await this.alert('Protection restored manually.');
    await this.store.save();
  }

  private async apply(c: ChangeRequest) {
    if (c.kind === 'disable_all') await this.api.setProtection(false);
    else if (c.mac) await this.api.setExempt(c.mac, this.s.devices[c.mac]?.name ?? c.mac, true);
  }

  private async revert(c: ChangeRequest) {
    if (c.kind === 'disable_all') await this.api.setProtection(true);
    else if (c.mac && this.s.devices[c.mac]?.policy !== 'exempt') await this.api.setExempt(c.mac, '', false);
  }

  /** Called every ~30s. */
  async tick(): Promise<void> {
    if (!this.s.setupDone) return;
    const now = this.clock.now();

    // 1. activate due requests
    for (const c of this.s.changes.filter((x) => x.status === 'pending' && x.unlockAt <= now)) {
      await this.apply(c);
      c.status = 'active';
      c.activeUntil = c.durationMinutes ? now + c.durationMinutes * 60_000 : null;
      await this.alert(`Change applied: ${c.kind}${c.mac ? ' ' + this.deviceLabel(c.mac) : ''}.`);
    }

    // 2. expire finished windows
    for (const c of this.s.changes.filter((x) => x.status === 'active' && x.activeUntil != null && x.activeUntil <= now)) {
      c.status = 'expired';
      await this.revert(c);
      await this.alert(`Change expired and protection restored: ${c.kind}${c.mac ? ' ' + c.mac : ''}.`);
    }

    // 3. integrity: actual state must match desired state
    const active = this.s.changes.filter((x) => x.status === 'active');
    const wantProtection = !active.some((c) => c.kind === 'disable_all');
    const protectionNow = await this.api.getProtection();
    if (protectionNow !== wantProtection) {
      await this.api.setProtection(wantProtection);
      await this.alert(
        wantProtection
          ? 'TAMPER: protection was switched off outside an approved window; re-enabled.'
          : 'Protection re-paused to match an approved window.',
      );
    }

    const wantExempt = new Set<string>([
      ...Object.values(this.s.devices).filter((d) => d.policy === 'exempt').map((d) => d.mac),
      ...active.filter((c) => c.kind === 'exempt_device' && c.mac).map((c) => c.mac!),
    ]);
    const haveExempt = new Set(await this.api.listExemptMacs());
    for (const mac of haveExempt) {
      if (!wantExempt.has(mac)) {
        await this.api.setExempt(mac, '', false);
        await this.alert(`TAMPER: unauthorised exemption for ${mac} removed.`);
      }
    }
    for (const mac of wantExempt) {
      if (!haveExempt.has(mac)) await this.api.setExempt(mac, this.s.devices[mac]?.name ?? mac, true);
    }

    // 4. discover devices; unknown ones are strict by default
    for (const l of await this.api.listLeases()) {
      if (!this.s.devices[l.mac]) {
        this.s.devices[l.mac] = {
          mac: l.mac,
          name: l.hostname || l.mac,
          policy: 'strict',
          firstSeen: new Date(now).toISOString(),
        };
        await this.alert(`New device on the network: ${l.hostname || 'unknown'} (${l.mac}). It is filtered by default.`);
      }
    }

    await this.store.save();
  }
}
