#!/usr/bin/env node
/**
 * FocusGuard Router mode: no extra hardware.
 * Sets a family-filter DNS on your router (guided, or automatic for OpenWrt / MikroTik),
 * makes one-computer scripts, and checks that filtering is really active.
 */
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PROVIDER, PROVIDERS, getProvider, type Provider } from './providers.js';
import { DEFAULT_TEST_DOMAINS, verifyFiltering } from './verify.js';
import { IOS_STEPS, androidSteps, deviceScript, iosProfile, type Os } from './deviceScripts.js';
import { manualGuide, manualUndoGuide } from './guide.js';
import { HilinkDriver } from './hilink.js';
import { applyWithBackup, undoFromBackup, latestBackup, type RunnerIO } from './runner.js';
import { fingerprint, parseGateway, summarize, type Probe } from './database.js';
import { mikrotikApply, mikrotikUndo, openwrtApply, openwrtUndo, runMikrotik, sshArgs } from './drivers.js';

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { pos: string[]; flags: Flags } {
  const flags: Flags = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[a.slice(2)] = next;
        i++;
      } else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

let rl: readline.Interface | undefined;
const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
function getRl() {
  return (rl ??= readline.createInterface({ input: process.stdin, output: process.stdout }));
}
async function ask(question: string, def = ''): Promise<string> {
  if (!interactive) return def;
  const a = (await getRl().question(`${question}${def ? ` [${def}]` : ''} `)).trim();
  return a || def;
}
async function choose<T extends string>(question: string, options: { value: T; label: string }[], def?: T): Promise<T> {
  if (!interactive) return def ?? options[0].value;
  console.log(`\n${question}`);
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o.label}`));
  const defIdx = def ? options.findIndex((o) => o.value === def) + 1 : 1;
  for (;;) {
    const a = await ask('Your choice (number):', String(defIdx));
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value;
    console.log('Please type one of the numbers above.');
  }
}
async function confirm(question: string, def = false): Promise<boolean> {
  if (!interactive) return def;
  const a = (await ask(`${question} (y/n)`, def ? 'y' : 'n')).toLowerCase();
  return a.startsWith('y');
}

async function pickProvider(flags: Flags): Promise<Provider> {
  if (typeof flags.provider === 'string') return getProvider(flags.provider);
  const id = await choose(
    'Which filtering service do you want to use?',
    PROVIDERS.map((p) => ({ value: p.id, label: `${p.name} — ${p.description}` })),
    DEFAULT_PROVIDER,
  );
  return getProvider(id);
}

function defaultOs(): string {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
}

function help() {
  console.log(`FocusGuard Router — no extra hardware needed

Usage:  npm run router -- <command> [options]

Commands
  setup      Set the filtering DNS on your router (guided, or automatic for OpenWrt / MikroTik)
  device     Make a script/profile that sets the filtering DNS on ONE device (Windows, macOS, Linux, Android, iPhone)
  detect     Find your router and say whether an automatic recipe exists for it
  verify     Check that filtering is really active on this computer
  undo       Remove the filtering DNS (router or device)
  providers  List the available filtering services
  help       Show this text

Run a command without options and it asks you questions. Useful options:
  --provider <id>      cloudflare-families (default) | cleanbrowsing-family | cleanbrowsing-adult | opendns-familyshield
  --router <type>      manual (default) | huawei-hilink | openwrt | mikrotik
  --backup <file>      undo: backup file to restore (default: the newest one in --backup-dir)
  --backup-dir <dir>   where router backups are kept (default: ./focusguard-backups)
  --host <ip>          router address (openwrt / mikrotik)
  --user <name>        router login (default root for openwrt, admin for mikrotik)
  --password <pw>      MikroTik password (or set the ROUTER_PASSWORD environment variable)
  --dry-run            show what would be done, change nothing
  --yes                do not ask for confirmation
  --no-verify          skip the check after setup
  --os <name>          windows | macos | linux | android | ios   (device command)
  --out <folder>       where to write generated files (device command, default: current folder)
  --domain a.com,b.com domains to test with (verify command)
`);
}

function printVerify(r: Awaited<ReturnType<typeof verifyFiltering>>): boolean {
  console.log('');
  for (const x of r.results) {
    const icon = x.error ? '?' : x.verdict === 'active' ? '✔' : x.verdict === 'inactive' ? '✘' : '?';
    const detail = x.error ? `could not test (${x.error})` : x.verdict;
    console.log(`  ${icon} ${x.domain.padEnd(18)} ${detail}`);
  }
  console.log('');
  if (r.overall === 'active') console.log('RESULT: filtering is ACTIVE on this computer.');
  else if (r.overall === 'inactive') {
    console.log('RESULT: filtering is NOT active. This computer still gets unfiltered answers.');
    console.log('  - Did you save the router settings and restart Wi-Fi on this computer?');
    console.log('  - Does the computer use its own DNS (VPN, browser "Secure DNS", manual DNS)? Those skip the router.');
  } else if (r.overall === 'error') console.log('RESULT: could not run the check (no internet or DNS blocked?).');
  else console.log('RESULT: inconclusive. Try other domains with --domain, or check the provider.');
  return r.overall === 'active';
}

async function runVerify(provider: Provider, flags: Flags): Promise<boolean> {
  const domains = typeof flags.domain === 'string' ? flags.domain.split(',').map((d) => d.trim()).filter(Boolean) : DEFAULT_TEST_DOMAINS;
  console.log(`\nChecking with ${provider.name} …`);
  return printVerify(await verifyFiltering(provider, domains));
}

async function cmdSetup(flags: Flags, undo = false) {
  const provider = undo ? undefined : await pickProvider(flags);
  const type = (typeof flags.router === 'string'
    ? flags.router
    : await choose(
        'What kind of router do you have?',
        [
          { value: 'manual', label: 'A normal / ISP router (I will follow step-by-step instructions)' },
          { value: 'huawei-hilink', label: 'Huawei 4G/5G HiLink router (automatic over its web API)  [UNTESTED]' },
          { value: 'openwrt', label: 'OpenWrt (automatic over SSH)  [experimental]' },
          { value: 'mikrotik', label: 'MikroTik RouterOS 7 (automatic over its REST API)  [experimental]' },
        ],
        'manual',
      )) as string;
  const dry = Boolean(flags['dry-run']);

  if (type === 'manual') {
    console.log('\n' + (undo ? manualUndoGuide() : manualGuide(provider!)) + '\n');
    if (!undo && provider && interactive && (await confirm('Run the check now (after you finished the steps)?', false))) await runVerify(provider, flags);
    return;
  }

  if (type === 'huawei-hilink') {
    const host = typeof flags.host === 'string' ? flags.host : await ask('Router address?', '192.168.8.1');
    const user = typeof flags.user === 'string' ? flags.user : await ask('Router login?', 'admin');
    const password = (typeof flags.password === 'string' ? flags.password : undefined) ?? process.env.ROUTER_PASSWORD ?? (await ask('Router password (typing is visible; never saved):'));
    const backupDir = typeof flags['backup-dir'] === 'string' ? flags['backup-dir'] : path.join(process.cwd(), 'focusguard-backups');
    const driver = new HilinkDriver(host);
    console.log(`\nRecipe "${driver.id}" is ${driver.status.toUpperCase()}: ${driver.basis}\nIt can only change the DNS servers; your Wi-Fi, address range and lease time are re-sent unchanged. Everything is backed up first.\n`);
    const io: RunnerIO = { log: (m) => console.log(m), confirm: (q) => confirm(q, false) };
    const common = { host, user, password, dryRun: dry, yes: Boolean(flags.yes), settleMs: 8000 };
    if (undo) {
      const file = typeof flags.backup === 'string' ? flags.backup : fs.existsSync(backupDir) ? latestBackup(backupDir, host) : undefined;
      if (!file) return console.error('No backup found. Use --backup <file>, or run "setup --router manual" and clear the DNS by hand.');
      process.exitCode = (await undoFromBackup(driver, file, common, io)) ? 0 : 1;
      return;
    }
    const servers = [...provider!.v4];
    const r = await applyWithBackup(driver, servers, { ...common, backupDir }, io);
    if (!r.ok) process.exitCode = 1;
    else if (!dry && !flags['no-verify']) await runVerify(provider!, flags);
    return;
  }

  if (type === 'openwrt') {
    const host = typeof flags.host === 'string' ? flags.host : await ask('Router address?', '192.168.1.1');
    const user = typeof flags.user === 'string' ? flags.user : await ask('Router login?', 'root');
    const cmds = undo ? openwrtUndo() : openwrtApply(provider!);
    console.log(`\nThis will run on ${user}@${host} over SSH:\n` + cmds.map((c) => '  ' + c).join('\n') + '\n');
    if (dry) return;
    if (!flags.yes && !(await confirm('Run it now? (ssh will ask for the router password)', false))) return console.log('Cancelled. Nothing was changed.');
    const r = spawnSync('ssh', sshArgs(host, user, cmds), { stdio: 'inherit' });
    if (r.error) return console.error(`Could not run ssh: ${r.error.message}. Is the OpenSSH client installed?`);
    if (r.status !== 0) return console.error(`ssh exited with code ${r.status}. Nothing may have been changed.`);
    console.log(undo ? '\nDone. DNS is back to automatic.' : '\nDone.');
    if (!undo && !flags['no-verify']) await runVerify(provider!, flags);
    return;
  }

  if (type === 'mikrotik') {
    const host = typeof flags.host === 'string' ? flags.host : await ask('Router address?', '192.168.88.1');
    const user = typeof flags.user === 'string' ? flags.user : await ask('Router login?', 'admin');
    const password =
      (typeof flags.password === 'string' ? flags.password : undefined) ??
      process.env.ROUTER_PASSWORD ??
      (dry ? '' : await ask('Router password (typing is visible):'));
    const calls = undo ? mikrotikUndo() : mikrotikApply(provider!);
    const base = flags.https ? `https://${host}` : `http://${host}`;
    console.log(`\nThis will call the router's REST API at ${base}:\n` + calls.map((c) => `  ${c.method} ${c.path} ${JSON.stringify(c.body ?? '')}`).join('\n') + '\n');
    console.log('(The REST API needs the "www" service enabled on the router. For https, a self-signed certificate will be rejected.)');
    if (dry) return;
    if (!flags.yes && !(await confirm('Apply it now?', false))) return console.log('Cancelled. Nothing was changed.');
    try {
      await runMikrotik(base, user, password, calls);
      console.log(undo ? '\nDone. DNS servers cleared.' : '\nDone.');
      if (!undo && !flags['no-verify']) await runVerify(provider!, flags);
    } catch (e) {
      console.error(`Failed: ${(e as Error).message}`);
    }
    return;
  }

  console.error(`Unknown router type "${type}". Use manual, huawei-hilink, openwrt or mikrotik.`);
  process.exitCode = 1;
}

async function cmdDetect(flags: Flags) {
  let gateway = typeof flags.host === 'string' ? flags.host : undefined;
  if (!gateway) {
    try {
      const out = process.platform === 'linux' ? fs.readFileSync('/proc/net/route', 'utf8') : spawnSync(process.platform === 'win32' ? 'route' : 'netstat', process.platform === 'win32' ? ['print', '-4'] : ['-rn'], { encoding: 'utf8' }).stdout;
      gateway = parseGateway(process.platform, out);
    } catch {
      /* ask below */
    }
  }
  gateway ??= await ask('Could not find the router automatically. Its address?', '192.168.1.1');
  const probe: Probe = { gateway };
  const get = async (p: string) => fetch(`http://${gateway}${p}`, { signal: AbortSignal.timeout(4000), redirect: 'follow' });
  try {
    const res = await get('/');
    probe.status = res.status;
    probe.server = res.headers.get('server') ?? undefined;
    probe.body = (await res.text()).slice(0, 20000);
    probe.title = /<title>([^<]*)<\/title>/i.exec(probe.body)?.[1];
  } catch (e) {
    console.log(`Could not open http://${gateway}/ (${(e as Error).message}). Are you on that router's Wi-Fi?`);
  }
  try {
    const r = await get('/api/webserver/SesTokInfo');
    probe.hilink = r.ok && /<TokInfo>|<token>/i.test(await r.text());
  } catch {
    /* not HiLink */
  }
  const d = fingerprint(probe);
  console.log('\n' + summarize(d, gateway).join('\n') + '\n');
  console.log('Nothing was changed and no password was used. To help add support for other routers, send the router model (not any passwords).\n');
}

async function cmdDevice(flags: Flags) {
  const provider = await pickProvider(flags);
  const os = (typeof flags.os === 'string'
    ? flags.os
    : await choose(
        'Which device is this for?',
        [
          { value: 'windows', label: 'Windows computer' },
          { value: 'macos', label: 'Mac' },
          { value: 'linux', label: 'Linux computer (NetworkManager)' },
          { value: 'android', label: 'Android phone / tablet' },
          { value: 'ios', label: 'iPhone / iPad' },
        ],
        defaultOs() as 'windows',
      )) as string;
  const out = typeof flags.out === 'string' ? flags.out : process.cwd();

  if (os === 'android') return console.log('\n' + androidSteps(provider) + '\n');
  if (os === 'ios') {
    const prof = iosProfile(provider);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, prof.filename), prof.content);
    return console.log(`\nWrote ${path.join(out, prof.filename)}\n\n${IOS_STEPS}\n`);
  }
  if (os !== 'windows' && os !== 'macos' && os !== 'linux') {
    console.error(`Unknown device "${os}". Use windows, macos, linux, android or ios.`);
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(out, { recursive: true });
  const apply = deviceScript(os as Os, provider, 'apply');
  const undo = deviceScript(os as Os, provider, 'undo');
  for (const s of [apply, undo]) fs.writeFileSync(path.join(out, s.filename), s.content, { mode: 0o755 });
  console.log(`\nWrote:\n  ${path.join(out, apply.filename)}   (turns filtering ON for this computer)\n  ${path.join(out, undo.filename)}   (turns it OFF again)\n`);
  if (os === 'windows') {
    console.log(`How to run it (Windows):
  1. Start menu → type "PowerShell" → right-click → Run as administrator.
  2. Run:  Set-ExecutionPolicy -Scope Process Bypass
  3. Run:  & "${path.join(out, apply.filename)}"\n`);
  } else {
    console.log(`How to run it:  bash "${path.join(out, apply.filename)}"\n`);
  }
  console.log('Then check it:  npm run router -- verify --provider ' + provider.id + '\n');
}

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  let cmd = pos[0];
  if (!cmd) {
    if (!interactive) return help();
    console.log('FocusGuard Router — no extra hardware needed');
    cmd = await choose(
      'What do you want to do?',
      [
        { value: 'setup', label: 'Set up my router (all devices on my Wi-Fi)' },
        { value: 'device', label: 'Protect ONE device (script / profile)' },
        { value: 'verify', label: 'Check that filtering is working' },
        { value: 'undo', label: 'Undo / remove filtering' },
        { value: 'help', label: 'Show help' },
      ],
      'setup',
    );
  }
  switch (cmd) {
    case 'setup':
      await cmdSetup(flags);
      break;
    case 'detect':
      await cmdDetect(flags);
      break;
    case 'device':
      await cmdDevice(flags);
      break;
    case 'verify': {
      const ok = await runVerify(await pickProvider(flags), flags);
      process.exitCode = ok ? 0 : 1;
      break;
    }
    case 'undo': {
      const what = flags.os || flags.undo ? 'device' : await choose('Undo what?', [{ value: 'router', label: 'The router setting' }, { value: 'device', label: 'A single device' }], 'router');
      if (what === 'device') {
        const provider = await pickProvider(flags);
        const os = (typeof flags.os === 'string' ? flags.os : await choose('Which device?', [{ value: 'windows', label: 'Windows' }, { value: 'macos', label: 'Mac' }, { value: 'linux', label: 'Linux' }, { value: 'android', label: 'Android' }, { value: 'ios', label: 'iPhone / iPad' }], defaultOs() as 'windows')) as string;
        if (os === 'android') console.log('\nSettings → Network → Private DNS → set to "Automatic".\n');
        else if (os === 'ios') console.log('\nSettings → General → VPN, DNS & Device Management → remove the FocusGuard profile.\n');
        else {
          const s = deviceScript(os as Os, provider, 'undo');
          const out = typeof flags.out === 'string' ? flags.out : process.cwd();
          fs.mkdirSync(out, { recursive: true });
          fs.writeFileSync(path.join(out, s.filename), s.content, { mode: 0o755 });
          console.log(`\nWrote ${path.join(out, s.filename)}. Run it the same way as the apply script.\n`);
        }
      } else await cmdSetup(flags, true);
      break;
    }
    case 'providers':
      PROVIDERS.forEach((p) => console.log(`${p.id.padEnd(24)} ${p.name}\n${' '.repeat(24)} ${p.description}\n${' '.repeat(24)} DNS: ${p.v4.join(', ')}\n`));
      break;
    case 'help':
    case '--help':
      help();
      break;
    default:
      console.error(`Unknown command "${cmd}".\n`);
      help();
      process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(`\nError: ${(e as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => rl?.close());
