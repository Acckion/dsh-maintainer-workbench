import { build } from 'esbuild';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/client/preview.tsx'], bundle: true, outfile: 'dist/app.js', format: 'esm', minify: true, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
// UI iteration must not reload the backend or interrupt active Agent sessions.
if (!process.argv.includes('--client-only')) {
await build({ entryPoints: ['src/server/dev.ts'], bundle: true, outfile: 'dist/server.js', platform: 'node', format: 'esm', packages: 'external' });
await build({ entryPoints: ['src/plugin/index.ts'], bundle: true, outfile: 'dist/plugin.js', platform: 'node', format: 'esm', packages: 'external' });
}
const client = await build({ entryPoints: ['src/plugin/client.tsx'], bundle: true, write: false, platform: 'browser', format: 'cjs', external: ['react', 'react/jsx-runtime', 'react-dom'], loader: { '.css': 'text' }, minify: true, define: { 'process.env.NODE_ENV': '"production"' } });
await writeFile('dist/client.js', `window.__ModuleLoader__.load({id:"dsh-maintainer-workbench",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`);
await writeFile('dist/preview.html', '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Maintainer · 开源维护工作台</title><link rel="stylesheet" href="/app.css"><style>body{margin:0}</style></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
console.log(process.argv.includes('--client-only') ? 'Built UI assets; backend unchanged.' : 'Built standalone preview, host plugin and native client factory.');

if (!process.argv.includes('--client-only')) await cp('skills', 'dist/skills', { recursive: true });
