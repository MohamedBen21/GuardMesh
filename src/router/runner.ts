import fs from 'node:fs';
import path from 'node:path';

export type RecipeStatus = 'verified' | 'community' | 'untested';
export type Snapshot = Record<string, string>;

/** What a router "recipe" must provide. Everything the runner does is built on these few methods. */
export interface RouterDriver {
  id: string;
  label: string;
  status: RecipeStatus;
  /** where the recipe comes from (open-source client, captured pages, …) */
  basis: string;
  defaultHost: string;
  defaultUser: string;
  login(user: string, password: string): Promise<void>;
  /** the router's current settings (everything that a write could overwrite) */
  read(): Promise<Snapshot>;
  /** the DNS servers the router currently hands out ([] = automatic) */
  dnsOf(s: Snapshot): string[];
  /** a copy of the settings with only the DNS servers changed */
  withDns(s: Snapshot, servers: string[]): Snapshot;
  write(s: Snapshot): Promise<void>;
  logout(): Promise<void>;
}

export interface RunnerIO {
  log(msg: string): void;
  confirm(question: string): Promise<boolean>;
}

export interface RunOptions {
  host: string;
  user: string;
  password: string;
  dryRun?: boolean;
  yes?: boolean;
  backupDir: string;
  /** wait after a write: routers often restart their LAN, which drops the connection */
  settleMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface Backup {
  tool: 'guardmesh-router';
  version: 1;
  driver: string;
  host: string;
  createdAt: string;
  before: Snapshot;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const show = (l: string[]) => (l.length ? l.join(', ') : '(automatic)');

export function backupFileName(host: string, at: Date): string {
  return `guardmesh-router-backup-${host.replace(/[^\w.-]/g, '_')}-${at.toISOString().replace(/[:.]/g, '-')}.json`;
}

export function latestBackup(dir: string, host?: string): string | undefined {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('guardmesh-router-backup-') && f.endsWith('.json') && (!host || f.includes(host.replace(/[^\w.-]/g, '_'))))
    .sort();
  return files.length ? path.join(dir, files[files.length - 1]) : undefined;
}

/**
 * Safe apply: log in, read the current settings, save a backup FIRST, show what will change, ask, write, then read back
 * to confirm the router kept the change. Passwords are never written to disk.
 */
export async function applyWithBackup(driver: RouterDriver, servers: string[], o: RunOptions, io: RunnerIO): Promise<{ ok: boolean; backupFile?: string }> {
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  await driver.login(o.user, o.password);
  let loggedIn = true;
  try {
    const before = await driver.read();
    const current = driver.dnsOf(before);
    io.log(`Current DNS on the router: ${show(current)}`);
    io.log(`New DNS:                   ${show(servers)}`);
    if (sameList(current, servers)) {
      io.log('Nothing to change: the router already uses these servers.');
      return { ok: true };
    }
    const next = driver.withDns(before, servers); // throws if the router's settings look incomplete
    if (o.dryRun) {
      io.log('Dry run: nothing was changed and no backup was written.');
      return { ok: true };
    }

    const backup: Backup = { tool: 'guardmesh-router', version: 1, driver: driver.id, host: o.host, createdAt: now().toISOString(), before };
    fs.mkdirSync(o.backupDir, { recursive: true });
    const backupFile = path.join(o.backupDir, backupFileName(o.host, now()));
    fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2), { mode: 0o600 });
    io.log(`Backup of the current settings saved: ${backupFile}`);

    if (!o.yes && !(await io.confirm('Apply the change now? (the router may briefly drop the connection)'))) {
      io.log('Cancelled. Nothing was changed.');
      return { ok: false, backupFile };
    }

    let writeError: unknown;
    try {
      await driver.write(next);
    } catch (e) {
      writeError = e; // a restarting LAN can cut the reply even though the change was applied: verify below
    }
    await driver.logout().catch(() => undefined);
    loggedIn = false;
    if (o.settleMs) await sleep(o.settleMs);

    let after: Snapshot;
    try {
      await driver.login(o.user, o.password);
      loggedIn = true;
      after = await driver.read();
    } catch (e) {
      io.log(`Could not confirm the result (${(e as Error).message}). Check the router; to undo run: undo --backup "${backupFile}"`);
      return { ok: false, backupFile };
    }
    if (sameList(driver.dnsOf(after), servers)) {
      io.log(writeError ? `The router restarted its network but kept the change. DNS is now ${show(servers)}.` : `Done. DNS on the router is now ${show(servers)}.`);
      io.log(`To undo: run  undo --backup "${backupFile}"`);
      return { ok: true, backupFile };
    }
    io.log(`The router did not keep the change${writeError ? ` (${(writeError as Error).message})` : ''}. Its DNS is still ${show(driver.dnsOf(after))}. Nothing is broken.`);
    return { ok: false, backupFile };
  } finally {
    if (loggedIn) await driver.logout().catch(() => undefined);
  }
}

/** Restores the settings saved by applyWithBackup. */
export async function undoFromBackup(driver: RouterDriver, backupFile: string, o: Omit<RunOptions, 'backupDir'>, io: RunnerIO): Promise<boolean> {
  const backup = JSON.parse(fs.readFileSync(backupFile, 'utf8')) as Backup;
  if (backup.tool !== 'guardmesh-router' || backup.driver !== driver.id) {
    throw new Error(`This backup is for "${backup.driver}", not "${driver.id}".`);
  }
  await driver.login(o.user, o.password);
  try {
    const current = await driver.read();
    io.log(`Restoring DNS: ${show(driver.dnsOf(current))}  ->  ${show(driver.dnsOf(backup.before))}`);
    if (o.dryRun) {
      io.log('Dry run: nothing was changed.');
      return true;
    }
    if (!o.yes && !(await io.confirm('Restore the saved settings now?'))) {
      io.log('Cancelled. Nothing was changed.');
      return false;
    }
    try {
      await driver.write(backup.before);
    } catch (e) {
      io.log(`The router did not answer cleanly (${(e as Error).message}); it may be restarting. Checking…`);
    }
  } finally {
    await driver.logout().catch(() => undefined);
  }
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (o.settleMs) await sleep(o.settleMs);
  await driver.login(o.user, o.password);
  try {
    const after = await driver.read();
    const ok = sameList(driver.dnsOf(after), driver.dnsOf(backup.before));
    io.log(ok ? 'Restored.' : `Could not confirm the restore: router DNS is ${show(driver.dnsOf(after))}.`);
    return ok;
  } finally {
    await driver.logout().catch(() => undefined);
  }
}
