import { build } from 'esbuild';
await build({ entryPoints: ['src/frontend/index.ts'], outfile: 'dist/frontend.js', bundle: true, format: 'esm', target: 'es2022', platform: 'browser', sourcemap: false });
await build({ entryPoints: ['src/backend/index.ts'], outfile: 'dist/backend.js', bundle: true, format: 'esm', target: 'esnext', platform: 'node', sourcemap: false });
console.log('built');
