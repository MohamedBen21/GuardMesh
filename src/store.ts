import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Lang } from './i18n.js';

export type Mode = 'self' | 'parental';
export type ChangeKind = 'disable_all' | 'exempt_device';
export type ChangeStatus = 'pending' | 'active' | 'cancelled' | 'expired';

export interface Device {
  mac: string;
  name: string;
  /** 'exempt' devices are NOT filtered. Everything else is strict (the default). */
  policy: 'strict' | 'exempt';
  firstSeen: string;
}

/** Any change that WEAKENS protection goes through one of these (delay + partner can veto). */
export interface ChangeRequest {
  id: string;
  kind: ChangeKind;
  mac?: string;
  /** minutes the change stays active once applied; null = until restored manually */
  durationMinutes: number | null;
  createdAt: number;
  unlockAt: number;
  status: ChangeStatus;
  activeUntil?: number | null;
}

export interface PartnerContact {
  telegramBotToken?: string;
  telegramChatId?: string;
  webhookUrl?: string;
}

export interface State {
  setupDone: boolean;
  mode: Mode;
  /** language of alerts sent to the partner and of the activity log */
  lang: Lang;
  delayMinutes: number;
  /** true once the box's DHCP server was enabled (full mode); false = DNS-only mode */
  dhcpEnabled: boolean;
  partnerKeyHash?: string;
  partner: PartnerContact;
  adguard?: { user: string; password: string };
  devices: Record<string, Device>;
  changes: ChangeRequest[];
  log: { at: number; event: string }[];
}

export const defaultState = (): State => ({
  setupDone: false,
  mode: 'self',
  lang: 'en',
  delayMinutes: 24 * 60,
  dhcpEnabled: false,
  partner: {},
  devices: {},
  changes: [],
  log: [],
});

export class Store {
  state: State = defaultState();
  constructor(private file: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      this.state = { ...defaultState(), ...JSON.parse(raw) };
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }
}
