import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
let bad = 0;
for (const t of ['smoke', 'worldbook', 'render']) {
  await build({ entryPoints: ['test/' + t + '.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'test/.' + t + '.cjs', logLevel: 'error' });
  const r = spawnSync('node', ['test/.' + t + '.cjs'], { stdio: 'inherit' });
  if (r.status !== 0) bad++;
}
process.exit(bad ? 1 : 0);
