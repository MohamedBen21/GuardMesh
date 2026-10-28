import type { AdGuardApi } from './adguard.js';
import type { ChangeKind, ChangeRequest, Store } from './store.js';
import type { AlertOpts, Notifier } from './notify.js';
import { verifySecret } from './auth.js';
import { id as newId, normMac } from './util.js';
import { fmtDuration, fmtTime, t, type Vars } from './i18n.js';

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

  /** Logs the alert (in the configured language) and sends it to the partner. */
  private async alert(key: string, vars: Vars = {}, opts?: AlertOpts) {
    const text = t(this.s.lang, key, vars);
    this.note(text);
    await this.notifier.send(text, opts);
  }

  deviceLabel(mac: string) {
    const d = this.s.devices[mac];
    return d?.name && d.name !== mac ? `${d.name} (${mac})` : mac;
  }

  /** Human description of a change, in the alert language. */
  whatOf(c: ChangeRequest): string {
    return c.kind === 'disable_all'
      ? t(this.s.lang, 'what_pause')
      : t(this.s.lang, 'what_exempt', { device: this.deviceLabel(c.mac!) });
  }

  async status(): Promise<{ protection: boolean | null; changes: ChangeRequest[] }> {
    let protection: boolean | null = null;
    try {
      protection = await this.api.getProtection();
    } catch {
      /* adguard unreachable */
    }
    return { protection, changes: this.s.changes.filter((c) => c.status === 'pending' || c.status === 'active') };
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

    const lang = this.s.lang;
    await this.alert(
      req.kind === 'disable_all' ? 'req_pause' : 'req_exempt',
      {
        delay: fmtDuration(lang, this.s.delayMinutes),
        time: fmtTime(req.unlockAt, lang),
        device: mac ? this.deviceLabel(mac) : '',
        durNote: req.durationMinutes ? ' ' + t(lang, 'dur_note', { dur: fmtDuration(lang, req.durationMinutes) }) : '',
      },
      { button: { id: req.id, labelKey: 'btn_cancel' } },
    );
    await this.store.save();
    return req;
  }

  /** Cancelling is a strengthening action: always allowed, no key needed. */
  async cancel(changeId: string): Promise<boolean> {
    const c = this.s.changes.find((x) => x.id === changeId);
    if (!c || (c.status !== 'pending' && c.status !== 'active')) return false;
    const wasActive = c.status === 'active';
    c.status = 'cancelled';
    if (wasActive) await this.revert(c);
    await this.alert('cancelled', { what: this.whatOf(c) });
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
    await this.alert('restored');
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
    const lang = this.s.lang;

    // 1. activate due requests
    for (const c of this.s.changes.filter((x) => x.status === 'pending' && x.unlockAt <= now)) {
      await this.apply(c);
      c.status = 'active';
      c.activeUntil = c.durationMinutes ? now + c.durationMinutes * 60_000 : null;
      await this.alert(
        c.kind === 'disable_all' ? 'applied_pause' : 'applied_exempt',
        {
          device: c.mac ? this.deviceLabel(c.mac) : '',
          untilNote: c.activeUntil ? ' ' + t(lang, 'until_note', { time: fmtTime(c.activeUntil, lang) }) : '',
        },
        { button: { id: c.id, labelKey: 'btn_restore' } },
      );
    }

    // 2. expire finished windows
    for (const c of this.s.changes.filter((x) => x.status === 'active' && x.activeUntil != null && x.activeUntil <= now)) {
      c.status = 'expired';
      await this.revert(c);
      await this.alert('expired');
    }

    // 3. integrity: actual state must match desired state
    const active = this.s.changes.filter((x) => x.status === 'active');
    const wantProtection = !active.some((c) => c.kind === 'disable_all');
    const protectionNow = await this.api.getProtection();
    if (protectionNow !== wantProtection) {
      await this.api.setProtection(wantProtection);
      await this.alert(wantProtection ? 'tamper_off' : 'repaused');
    }

    const wantExempt = new Set<string>([
      ...Object.values(this.s.devices).filter((d) => d.policy === 'exempt').map((d) => d.mac),
      ...active.filter((c) => c.kind === 'exempt_device' && c.mac).map((c) => c.mac!),
    ]);
    const haveExempt = new Set(await this.api.listExemptMacs());
    for (const mac of haveExempt) {
      if (!wantExempt.has(mac)) {
        await this.api.setExempt(mac, '', false);
        await this.alert('tamper_exempt', { device: mac });
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
        await this.alert('new_device', { device: l.hostname ? `${l.hostname} (${l.mac})` : l.mac });
      }
    }

    await this.store.save();
  }
}
