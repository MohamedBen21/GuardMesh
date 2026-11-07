import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdGuardHttp } from './adguard.js';
import { buildApp } from './app.js';
import { Guardian } from './guardian.js';
import { StoreNotifier } from './notify.js';
import { Store } from './store.js';
import { TelegramBot } from './telegram.js';
import { t } from './i18n.js';

const DATA_DIR = process.env.DATA_DIR ?? './data';
const PORT = Number(process.env.PORT ?? 8080);
const ADGUARD_URL = process.env.ADGUARD_URL ?? 'http://127.0.0.1:3000';
const HEARTBEAT_URL = process.env.HEARTBEAT_URL; // e.g. a healthchecks.io ping URL; partner gets alerted if pings stop

const store = new Store(path.join(DATA_DIR, 'state.json'));
await store.load();

const api = new AdGuardHttp(ADGUARD_URL, () => store.state.adguard);
const notifier = new StoreNotifier(store);
const guardian = new Guardian(store, api, notifier);
const here = path.dirname(fileURLToPath(import.meta.url));
const app = buildApp({ store, api, guardian, webDir: path.join(here, '..', 'web') });

// Lets the partner cancel / restore from Telegram (only runs when a bot token + chat ID are configured).
new TelegramBot(store, guardian).start();

async function loop() {
  try {
    await guardian.tick();
    if (HEARTBEAT_URL) await fetch(HEARTBEAT_URL).catch(() => undefined);
  } catch (e) {
    console.error('tick failed', (e as Error).message);
  }
}
setInterval(loop, 30_000);

app.listen(PORT, () => {
  console.log(`GuardMesh wizard on http://0.0.0.0:${PORT}`);
  if (store.state.setupDone) {
    // A reboot or unplug is visible to the partner.
    notifier.send(t(store.state.lang, 'restarted')).catch(() => undefined);
    void loop();
  }
});
