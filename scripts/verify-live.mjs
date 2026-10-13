#!/usr/bin/env node
/**
 * verify-live.mjs — Comprueba el sitio YA DESPLEGADO, no el generado en local.
 *
 * `check.mjs` valida el HTML en disco; esto comprueba además que lo que sirve
 * GitHub Pages responde de verdad: cada URL del sitemap, una muestra de los
 * recursos, las redirecciones heredadas de WordPress y las páginas de error.
 *
 * Uso:
 *   node scripts/verify-live.mjs [url-base]
 *   node scripts/verify-live.mjs https://pikilon.com
 *
 * Devuelve código 1 si algo falla, para poder usarlo en una comprobación
 * posterior al despliegue.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.argv[2] || 'https://pikilon.github.io').replace(/\/$/, '');

const ok = [];
const bad = [];

/** Lanza una petición y registra el resultado esperado. */
async function head(path, { expect = 200, label = path } = {}) {
  const url = `${BASE}${path}`;
  try {
    const res = await fetch(url, { redirect: 'manual', headers: { 'user-agent': 'pikilon-verify/1.0' } });
    const good = Array.isArray(expect) ? expect.includes(res.status) : res.status === expect;
    (good ? ok : bad).push(`${label} -> ${res.status}${good ? '' : ` (esperado ${expect})`}`);
    return res;
  } catch (err) {
    bad.push(`${label} -> ERROR ${err.message}`);
    return null;
  }
}

async function main() {
  console.log(`Verificando ${BASE}\n`);

  // 1. Portada y páginas principales.
  console.log('Portada y secciones');
  const home = await head('/', { label: 'portada' });
  if (home) {
    const html = await home.text();
    if (!/<title>[^<]+<\/title>/i.test(html)) bad.push('portada: sin <title>');
    else ok.push(`portada: título "${html.match(/<title>([^<]+)<\/title>/i)[1]}"`);
  }
  await head('/writing/');
  await head('/topics/');
  await head('/favicon.svg');

  // 2. Todas las URLs del sitemap.
  console.log('\nURLs del sitemap');
  let sitemap;
  try {
    sitemap = await fetch(`${BASE}/sitemap.xml`).then((r) => (r.ok ? r.text() : ''));
  } catch {
    sitemap = '';
  }
  if (!sitemap) {
    bad.push('sitemap.xml no se pudo leer');
  } else {
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    console.log(`  ${locs.length} URLs listadas`);
    for (const loc of locs) {
      const path = loc.replace(/^https?:\/\/[^/]+/, '') || '/';
      await head(path);
    }
  }

  // 3. Recursos: el manifiesto del despliegue da la lista exacta de lo subido.
  console.log('\nRecursos');
  try {
    const manifest = JSON.parse(readFileSync(join(ROOT, '.deploy-manifest.json'), 'utf8'));
    const assets = manifest.files.filter((f) => f.startsWith('assets/'));
    // Se sondea una muestra: comprobar los 128 archivos sería lento y frágil.
    const step = Math.max(1, Math.floor(assets.length / 12));
    const sample = assets.filter((_, i) => i % step === 0).slice(0, 12);
    console.log(`  ${assets.length} recursos en total, se comprueban ${sample.length}`);
    for (const f of sample) await head(`/${f}`, { label: f });
  } catch {
    console.log('  (sin .deploy-manifest.json; se omite la comprobación de recursos)');
  }

  // 4. Redirecciones heredadas de WordPress.
  console.log('\nRedirecciones heredadas');
  const redirects = ['/category/code/', '/category/imho/', '/feed/'];
  for (const r of redirects) {
    const res = await head(r);
    if (res) {
      const body = await res.text();
      if (!/rel="canonical"/.test(body)) bad.push(`${r}: la página no declara canonical`);
      else ok.push(`${r}: canonical correcto`);
    }
  }

  // 5. Página 404 personalizada.
  console.log('\nPágina de error');
  const missing = await head('/esta-pagina-no-existe-xyz/', { expect: 404, label: '404 personalizada' });
  if (missing) {
    const body = await missing.text();
    if (!/Página no encontrada/i.test(body)) bad.push('el 404 no es la página personalizada');
  }

  // 6. Proyectos hermanos del dominio compartido.
  console.log('\nProyectos hermanos (no deben romperse)');
  await head('/die-hard-dice/');
  await head('/red-line/');

  // Resultado.
  console.log(`\n${'='.repeat(60)}`);
  if (bad.length) {
    console.log(`FALLOS (${bad.length}):`);
    for (const b of bad) console.log(`  ✗ ${b}`);
  }
  console.log(`\n${ok.length} comprobaciones correctas.`);
  if (bad.length) {
    console.log('La verificación ha FALLADO.');
    process.exit(1);
  }
  console.log('✓ El sitio desplegado responde correctamente.');
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
