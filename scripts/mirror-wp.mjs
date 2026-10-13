#!/usr/bin/env node
/**
 * mirror-wp.mjs — Archivo completo de un sitio WordPress vía REST API + HTML.
 *
 * Uso:
 *   node scripts/mirror-wp.mjs                # archiva todo (resumible)
 *   node scripts/mirror-wp.mjs --force        # re-descarga todo
 *   node scripts/mirror-wp.mjs --only=media   # solo una fase
 *
 * Salida:
 *   archive/rest/*.json    -> contenido estructurado (posts, pages, media, taxonomías)
 *   archive/media/...      -> archivos originales + todas sus miniaturas
 *   archive/html/...       -> HTML renderizado de cada URL (plan B / fidelidad visual)
 *   archive/manifest.json  -> inventario con sha256 de todo lo descargado
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = process.env.WP_SITE || 'https://pikilon.com';
const REST = `${SITE}/wp-json/wp/v2`;
const UA = 'pikilon-archive/1.0 (+static migration)';
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;

const DIRS = {
  rest: join(ROOT, 'archive', 'rest'),
  media: join(ROOT, 'archive', 'media'),
  html: join(ROOT, 'archive', 'html'),
};

const manifest = { site: SITE, capturedAt: new Date().toISOString(), files: {}, failures: [] };

/* ---------------------------------------------------------------- utilidades */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRetry(url, { as = 'text', tries = 4, timeout = 60000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeout);
      const res = await fetch(url, { headers: { 'user-agent': UA }, signal: ctl.signal, redirect: 'follow' });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      if (as === 'buffer') return Buffer.from(await res.arrayBuffer());
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await sleep(700 * 2 ** i);
    }
  }
  throw new Error(`${url} -> ${lastErr.message}`);
}

async function exists(p) {
  if (FORCE) return false;
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function saveFile(absPath, data) {
  await mkdir(dirname(absPath), { recursive: true });
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  await writeFile(absPath, buf);
  manifest.files[rel(absPath)] = {
    bytes: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
  return buf.length;
}

const rel = (abs) => abs.replace(ROOT + '/', '');

function slugToPath(urlStr) {
  const u = new URL(urlStr);
  let p = u.pathname;
  if (p.endsWith('/')) p += 'index.html';
  else if (!/\.[a-z0-9]{2,5}$/i.test(p)) p += '/index.html';
  return p.replace(/^\/+/, '');
}

/** Ejecuta tareas con concurrencia limitada, reportando progreso. */
async function pool(items, worker, label) {
  let done = 0;
  let failed = 0;
  const queue = [...items.entries()];
  const runners = Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, async () => {
    while (queue.length) {
      const [i, item] = queue.shift();
      try {
        await worker(item, i);
      } catch (err) {
        failed++;
        manifest.failures.push({ label, item: String(item), error: err.message });
        process.stderr.write(`  ! ${label}: ${err.message}\n`);
      }
      done++;
      if (done % 10 === 0 || done === items.length) {
        process.stdout.write(`\r  ${label}: ${done}/${items.length} (fallos: ${failed})   `);
      }
    }
  });
  await Promise.all(runners);
  process.stdout.write(`\r  ${label}: ${done}/${items.length} (fallos: ${failed})\n`);
  return { done, failed };
}

/** GET paginado de una colección REST. */
async function restAll(resource, params = {}) {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const qs = new URLSearchParams({ per_page: '100', page: String(page), ...params });
    const url = `${REST}/${resource}?${qs}`;
    const res = await fetch(url, { headers: { 'user-agent': UA } });
    if (res.status === 400 && page > 1) break; // "rest_post_invalid_page_number"
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    const totalPages = Number(res.headers.get('x-total-pages') || 1);
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (page >= totalPages) break;
  }
  return out;
}

/* ------------------------------------------------------------------- fases */

async function phaseRest() {
  console.log('\n[1/4] Contenido estructurado (REST)');
  const resources = [
    ['posts', { _embed: '1' }],
    ['pages', { _embed: '1' }],
    ['media', {}],
    ['categories', {}],
    ['tags', {}],
    ['users', {}],
    ['comments', {}],
    ['menus', {}],
    ['menu-items', {}],
  ];
  for (const [resource, params] of resources) {
    const file = join(DIRS.rest, `${resource}.json`);
    if (await exists(file)) {
      console.log(`  = ${resource}.json ya existe`);
      continue;
    }
    try {
      const data = await restAll(resource, params);
      await saveFile(file, JSON.stringify(data, null, 2));
      console.log(`  + ${resource}.json (${data.length} elementos)`);
    } catch (err) {
      console.log(`  ! ${resource}: ${err.message}`);
      manifest.failures.push({ label: 'rest', item: resource, error: err.message });
    }
  }

  // Metadatos del sitio (nombre, descripción, zona horaria...) sin autenticar.
  const rootFile = join(DIRS.rest, 'site-root.json');
  if (!(await exists(rootFile))) {
    try {
      const root = await fetchRetry(`${SITE}/wp-json/`);
      await saveFile(rootFile, root);
      console.log('  + site-root.json');
    } catch (err) {
      manifest.failures.push({ label: 'rest', item: 'site-root', error: err.message });
    }
  }
}

async function phaseMedia() {
  console.log('\n[2/4] Recursos (media + miniaturas)');
  const mediaFile = join(DIRS.rest, 'media.json');
  let media;
  try {
    media = JSON.parse(await readFile(mediaFile, 'utf8'));
  } catch {
    console.log('  ! falta archive/rest/media.json — ejecuta primero la fase REST');
    return;
  }

  // Todas las URLs: original + cada tamaño generado por WordPress.
  const urls = new Set();
  for (const m of media) {
    if (m.source_url) urls.add(m.source_url);
    const sizes = m.media_details?.sizes || {};
    for (const s of Object.values(sizes)) if (s?.source_url) urls.add(s.source_url);
    // El srcset puede apuntar a variantes no listadas en `sizes`.
    for (const s of Object.values(sizes)) {
      if (s?.srcset) {
        for (const part of String(s.srcset).split(',')) {
          const u = part.trim().split(/\s+/)[0];
          if (u) urls.add(u);
        }
      }
    }
  }

  // Recursos referenciados dentro del HTML de los artículos (fuera de la biblioteca).
  try {
    const posts = JSON.parse(await readFile(join(DIRS.rest, 'posts.json'), 'utf8'));
    const pages = JSON.parse(await readFile(join(DIRS.rest, 'pages.json'), 'utf8'));
    for (const p of [...posts, ...pages]) {
      const html = `${p.content?.rendered || ''} ${p.excerpt?.rendered || ''}`;
      for (const m of html.matchAll(/https?:\/\/pikilon\.com\/wp-content\/[^\s"'<>()]+/gi)) {
        urls.add(m[0].replace(/&#0?38;/g, '&').replace(/&amp;/g, '&'));
      }
    }
  } catch { /* opcional */ }

  const list = [...urls].filter((u) => !u.startsWith('data:')).sort();
  console.log(`  ${list.length} archivos a verificar`);

  const localPathFor = (url) => {
    const { pathname } = new URL(url);
    return join(DIRS.media, decodeURIComponent(pathname.replace(/^\/+/, '')));
  };

  const result = await pool(
    list,
    async (url) => {
      const dest = localPathFor(url);
      if (await exists(dest)) return;
      const buf = await fetchRetry(url, { as: 'buffer', timeout: 120000 });
      await saveFile(dest, buf);
    },
    'recursos',
  );
  return result;
}

async function phaseHtml() {
  console.log('\n[3/4] HTML renderizado (plan B / fidelidad visual)');
  const urls = new Map(); // url -> ruta local
  urls.set(`${SITE}/`, 'index.html');
  urls.set(`${SITE}/feed/`, 'feed/index.xml');

  try {
    const posts = JSON.parse(await readFile(join(DIRS.rest, 'posts.json'), 'utf8'));
    const pages = JSON.parse(await readFile(join(DIRS.rest, 'pages.json'), 'utf8'));
    for (const p of [...posts, ...pages]) if (p.link) urls.set(p.link, slugToPath(p.link));
  } catch { /* opcional */ }

  // Archivos de sitemap: dan todas las URLs indexables, incluidas taxonomías.
  try {
    const idx = await fetchRetry(`${SITE}/wp-sitemap.xml`);
    for (const m of idx.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const sm = m[1];
      const xml = await fetchRetry(sm);
      for (const mm of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
        const u = mm[1];
        if (u.endsWith('.xml') || u.endsWith('.xsl')) continue;
        if (u.startsWith(SITE)) urls.set(u, slugToPath(u));
      }
    }
    // El índice en sí también se guarda.
    await saveFile(join(DIRS.html, 'wp-sitemap.xml'), idx);
  } catch (err) {
    manifest.failures.push({ label: 'html', item: 'sitemap', error: err.message });
  }

  const list = [...urls.entries()];
  console.log(`  ${list.length} URLs a archivar`);

  const result = await pool(
    list,
    async ([url, path]) => {
      const dest = join(DIRS.html, path);
      if (await exists(dest)) return;
      const body = await fetchRetry(url);
      await saveFile(dest, body);
    },
    'html',
  );
  return result;
}

/* -------------------------------------------------------------------- main */

async function main() {
  await Promise.all(Object.values(DIRS).map((d) => mkdir(d, { recursive: true })));
  const t0 = Date.now();

  if (!ONLY || ONLY === 'rest') await phaseRest();
  if (!ONLY || ONLY === 'media') await phaseMedia();
  if (!ONLY || ONLY === 'html') await phaseHtml();

  console.log('\n[4/4] Manifiesto');
  const mf = join(ROOT, 'archive', 'manifest.json');
  // Conserva entradas previas si es una ejecución parcial (--only).
  if (ONLY) {
    try {
      const prev = JSON.parse(await readFile(mf, 'utf8'));
      manifest.files = { ...prev.files, ...manifest.files };
      manifest.failures = [...(prev.failures || []), ...manifest.failures];
    } catch { /* primera vez */ }
  }
  const totalBytes = Object.values(manifest.files).reduce((a, f) => a + f.bytes, 0);
  manifest.summary = {
    files: Object.keys(manifest.files).length,
    bytes: totalBytes,
    failures: manifest.failures.length,
    elapsedSeconds: Math.round((Date.now() - t0) / 1000),
  };
  await writeFile(mf, JSON.stringify(manifest, null, 2));

  console.log(`  ${manifest.summary.files} archivos, ${(totalBytes / 1048576).toFixed(1)} MB`);
  if (manifest.failures.length) {
    console.log(`  ${manifest.failures.length} fallos -> ver archive/manifest.json`);
  }
  console.log(`\nListo en ${manifest.summary.elapsedSeconds}s.`);
}

main().catch((err) => {
  console.error('\nERROR FATAL:', err);
  process.exit(1);
});
