import { cp, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

const common = { bundle: true, sourcemap: true, logLevel: 'info' };

await mkdir('dist', { recursive: true });
await Promise.all([
  build({
    ...common,
    entryPoints: ['src/main/main.ts'],
    outfile: 'dist/main.js',
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: { preload: 'src/preload/preload.ts', 'pdf-preload': 'src/preload/pdf-preload.ts' },
    outdir: 'dist',
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: ['src/renderer/renderer.ts', 'src/renderer/pdf-host.ts'],
    outdir: 'dist',
    platform: 'browser',
    format: 'esm',
  }),
  ...['index.html', 'styles.css', 'pdf-host.html'].map((file) => cp(`src/renderer/${file}`, `dist/${file}`)),
  cp('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'dist/pdf.worker.min.mjs'),
  // Fonty, cmapy a wasm dekodéry (JBIG2/JPEG 2000 bývají ve skenech).
  ...['cmaps', 'standard_fonts', 'wasm', 'iccs'].map((dir) =>
    cp(`node_modules/pdfjs-dist/${dir}`, `dist/pdfjs/${dir}`, { recursive: true }),
  ),
  cp('build/icon.png', 'dist/icon.png'),
  cp('build/trayTemplate.png', 'dist/trayTemplate.png'),
  cp('build/trayTemplate@2x.png', 'dist/trayTemplate@2x.png'),
  cp('build/tray-win.png', 'dist/tray-win.png'),
]);
