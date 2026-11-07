/** Writes the ready-made files that the README download buttons point to: `npm run build:downloads`. */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PROVIDER, getProvider } from './providers.js';
import { DOWNLOAD_OS, deviceDownload } from './deviceScripts.js';

export function buildDownloads(dir: string): string[] {
  fs.mkdirSync(dir, { recursive: true });
  const p = getProvider(DEFAULT_PROVIDER);
  const written: string[] = [];
  for (const os of DOWNLOAD_OS) {
    for (const action of ['apply', 'undo'] as const) {
      if (os === 'ios' && action === 'undo') continue;
      const f = deviceDownload(os, p, action);
      const file = os === 'ios' ? 'guardmesh-protect-iphone.mobileconfig' : f.filename;
      fs.writeFileSync(path.join(dir, file), f.content);
      written.push(file);
    }
  }
  return written;
}

if (process.argv[1] && /buildDownloads\.(ts|js)$/.test(process.argv[1])) {
  const dir = path.join(process.cwd(), 'downloads');
  console.log(buildDownloads(dir).map((f) => `downloads/${f}`).join('\n'));
}
