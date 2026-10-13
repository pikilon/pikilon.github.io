#!/usr/bin/env node
/**
 * import.mjs — Vuelca el archivo de WordPress en la base de datos simplificada.
 *
 * Fuentes, en orden de preferencia:
 *   1. archive/rest/*.json  (REST API: contenido completo y público)
 *   2. un dump .sql de Hostinger, si además quieres ajustes y borradores
 *
 * Este script es idempotente: se puede volver a ejecutar tantas veces como
 * haga falta. Reconstruye db/pikilon.db desde cero salvo que se pase --keep,
 * en cuyo caso sólo actualiza lo que ya exista.
 *
 * Uso:
 *   node scripts/import.mjs               # reconstruye la BD desde el archivo
 *   node scripts/import.mjs --keep        # conserva ediciones hechas a mano
 *   node scripts/import.mjs --media       # además copia los medios a assets/
 *   node scripts/import.mjs --dump=x.sql  # importa también un dump de MySQL
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandShortcodes, htmlToMarkdown, htmlToText, stripSizeSuffix } from './html-to-md.mjs';
import { extractUnpublished, extractWpOptions, parseSqlDump, summarizePosts } from './mysql-import.mjs';
import { exportToSite } from './publish.mjs';
import { exportCv, syncCv } from './cv.mjs';
import { iconFor } from './utils.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE = join(ROOT, 'archive');
const REST = join(ARCHIVE, 'rest');
const DB_PATH = join(ROOT, 'db', 'pikilon.db');
const ASSETS = join(ROOT, 'assets');

const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
const DO_MEDIA = args.includes('--media');
const DUMP = (args.find((a) => a.startsWith('--dump=')) || '').split('=')[1] || null;

/* ------------------------------------------------------------------ ayuda */

const log = (...a) => console.log(...a);
const readJson = async (p, fallback = null) => {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return fallback;
  }
};

/* --------------------------------------------------------------- medios */

/**
 * Copia cada recurso del archivo a assets/ y registra sus metadatos.
 *
 * Se copian TAMBIÉN todas las variantes (miniaturas, @2x…) que WordPress
 * generó: los artículos las referencian dentro del HTML con su propio
 * srcset, así que sin ellas aparecerían imágenes rotas.
 *
 * En la tabla `media` la ruta se guarda relativa a assets/ (sin el prefijo),
 * porque esa carpeta es el origen de todos los recursos; el prefijo se añade
 * al generar el sitio. Así puedes mover assets/ de sitio sin tocar la BD.
 *
 * @returns {{urlToPath: Map<string,string>, idToPath: Map<number,string>}}
 */
async function syncMedia(db) {
  const media = (await readJson(join(REST, 'media.json'), [])) || [];
  const urlToPath = new Map();
  const idToPath = new Map();

  const insert = db.prepare(`
    INSERT INTO media (wp_id, path, mime, width, height, bytes, sha256, alt, caption, wp_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertVariant = db.prepare(`
    INSERT OR IGNORE INTO media_variants (media_id, name, path, width, height, bytes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  /** Copia un recurso del archivo a assets/; devuelve su ruta relativa o null. */
  const copyAsset = async (url) => {
    if (!url || !isSiteAsset(url)) return null;
    const rel = assetRel(url);
    if (!rel) return null;
    const from = join(ARCHIVE, 'media', rel);
    if (!existsSync(from)) return null;
    const to = join(ASSETS, rel);
    await mkdir(dirname(to), { recursive: true });
    const buf = await readFile(from);
    await writeFile(to, buf);
    return { rel, bytes: buf.length, sha: createHash('sha256').update(buf).digest('hex') };
  };

  let copied = 0;
  let skipped = 0;

  for (const m of media) {
    const srcUrl = m.source_url;
    if (!srcUrl) continue;

    const local = await copyAsset(srcUrl);
    if (local) copied++;
    else skipped++;

    const rel = assetRel(srcUrl);
    const href = rel ? `assets/${rel}` : null;

    const info = insert.run(
      m.id ?? null,
      rel,
      m.mime_type ?? null,
      m.media_details?.width ?? null,
      m.media_details?.height ?? null,
      local?.bytes ?? m.media_details?.filesize ?? null,
      local?.sha ?? null,
      m.alt_text ? htmlToText(m.alt_text) : null,
      m.caption?.rendered ? htmlToText(m.caption.rendered) : null,
      srcUrl,
    );
    const rowId = Number(info.lastInsertRowid);

    urlToPath.set(srcUrl, href);
    urlToPath.set(decodeURIComponent(srcUrl), href);
    if (m.id != null) idToPath.set(m.id, href);

    // Original + cada tamaño generado por WordPress, copiados de verdad.
    const sizes = m.media_details?.sizes || {};
    await insertVariant.run(rowId, 'original', rel, m.media_details?.width ?? null, m.media_details?.height ?? null, local?.bytes ?? null);
    for (const [name, s] of Object.entries(sizes)) {
      if (!s?.source_url) continue;
      const v = await copyAsset(s.source_url);
      if (v) copied++;
      const vrel = assetRel(s.source_url);
      urlToPath.set(s.source_url, `assets/${vrel}`);
      await insertVariant.run(rowId, name, vrel, s.width ?? null, s.height ?? null, v?.bytes ?? s.filesize ?? null);
    }
  }

  log(`  medios: ${copied} archivos copiados a assets/${skipped ? `, ${skipped} sin original` : ''}`);
  return { urlToPath, idToPath };
}

/** Ruta relativa (sin prefijo) de un recurso a partir de su URL de WordPress. */
function assetRel(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ''));
  } catch {
    return null;
  }
}

/** Filtro barato: sólo interesan recursos del propio sitio. */
function isSiteAsset(url) {
  return /^https?:\/\/(www\.)?pikilon\.com\/wp-content\//i.test(url);
}

/* ------------------------------------------------------------- contenido */

/** Convierte las categorías y etiquetas de WordPress en `terms`. */
function importTerms(db, categories, tags) {
  const insert = db.prepare(`
    INSERT INTO terms (id, kind, slug, name, description, position) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const byWpId = new Map();

  for (const [i, c] of categories.entries()) {
    const id = insert.run(c.id, 'category', c.slug, htmlToText(c.name), c.description ? htmlToText(c.description) : null, i).lastInsertRowid;
    byWpId.set(c.id, Number(id));
  }
  for (const [i, t] of tags.entries()) {
    const id = insert.run(t.id, 'tag', t.slug, htmlToText(t.name), t.description ? htmlToText(t.description) : null, i).lastInsertRowid;
    byWpId.set(t.id, Number(id));
  }
  log(`  términos: ${categories.length} categorías, ${tags.length} etiquetas`);
  return byWpId;
}

/**
 * Limpia el extracto de WordPress.
 * Los extractos automáticos acaban en «Continue reading “Título”» y vienen
 * con el primer párrafo entero; aquí se recorta a una línea legible.
 */
function cleanSummary(html) {
  let text = htmlToText(html);
  if (!text) return '';
  text = text
    .replace(/\s*Continue reading\s*[“"'].*$/i, '')
    .replace(/\s*Leer más\s*[“"'].*$/i, '')
    .replace(/\s*\[…\]\s*$/, '')
    .replace(/\s*…\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 200 ? `${text.slice(0, 197).trimEnd()}…` : text;
}

/** Importa artículos y páginas a `entries` + `entry_terms`. */
function importEntries(db, posts, pages, termByWpId, imageMap, idToPath) {  const insertEntry = db.prepare(`
    INSERT INTO entries
      (kind, slug, title, summary, body, body_format, published_at, updated_at,
       status, featured_id, lang, template, position, wp_id, wp_link, wp_modified)
    VALUES (?, ?, ?, ?, ?, 'markdown', ?, ?, ?, ?, 'en', NULL, ?, ?, ?, ?)
  `);
  const insertTerm = db.prepare('INSERT OR IGNORE INTO entry_terms (entry_id, term_id) VALUES (?, ?)');
  const findMedia = db.prepare('SELECT id FROM media WHERE wp_id = ?');

  let count = 0;
  const all = [
    ...posts.map((p) => ({ ...p, _kind: 'post' })),
    ...pages.map((p) => ({ ...p, _kind: 'page' })),
  ];

  for (const [i, item] of all.entries()) {
    const raw = expandShortcodes(item.content?.rendered || '', idToPath);
    const body = htmlToMarkdown(raw, { imageMap });

    // Extracto: el de WordPress si existe, si no el primer párrafo del cuerpo.
    const summary =
      cleanSummary(item.excerpt?.rendered || '') ||
      htmlToText(body).slice(0, 200).trim() ||
      null;

    // La imagen destacada se referencia por id de WordPress.
    let featuredId = null;
    if (item.featured_media) {
      const row = findMedia.get(item.featured_media);
      if (row) featuredId = row.id;
    }

    const info = insertEntry.run(
      item._kind,
      item.slug,
      htmlToText(item.title?.rendered || item.slug),
      summary,
      body,
      item.date_gmt ? `${item.date_gmt}Z` : null,
      item.modified_gmt ? `${item.modified_gmt}Z` : null,
      item.status === 'publish' ? 'published' : 'draft',
      featuredId,
      item._kind === 'page' ? i : 0,
      item.id,
      item.link ?? null,
      item.modified_gmt ? `${item.modified_gmt}Z` : null,
    );
    const entryId = Number(info.lastInsertRowid);

    for (const wpTerm of [...(item.categories || []), ...(item.tags || [])]) {
      const termId = termByWpId.get(wpTerm);
      if (termId) insertTerm.run(entryId, termId);
    }
    count++;
  }
  log(`  entradas: ${count} (${posts.length} artículos, ${pages.length} páginas)`);
}

/**
 * Rellena la tabla `site` y `links`.
 * El contenido del CV se toma de la página de inicio; los enlaces, del
 * propio HTML de la home, que es donde vivían en WordPress.
 */
async function importSite(db, pages) {
  const root = (await readJson(join(REST, 'site-root.json'), {})) || {};
  const home = pages.find((p) => p.slug === 'home') || pages[0] || {};

  db.prepare(`
    INSERT INTO site (id, title, tagline, description, author_name, author_email, author_photo, lang, url, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, 'en', ?, ?)
  `).run(
    htmlToText(root.name || 'Pikilon'),
    htmlToText(root.description || ''),
    htmlToText(root.description || ''),
    'Francisco G. Sarazá',
    'pikilon@gmail.com',
    'assets/wp-content/uploads/2015/06/pikilon_francisco_gutierrez.jpg',
    'https://pikilon.com',
    new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  );

  // Enlaces del CV: se extraen de los <a> de la home.
  const links = [];
  const html = home.content?.rendered || '';
  for (const m of html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = m[1];
    const label = htmlToText(m[2]);
    if (!url || !label) continue;
    if (/^https?:\/\/(www\.)?pikilon\.com/.test(url)) continue; // enlaces internos
    links.push({ url, label });
  }

  // Los perfiles sociales y de contacto NO se importan aquí: el autor de esta
  // web los mantiene en `site/cv/curriculum.md`, que es la fuente de verdad y
  // se aplica después. Importarlos desde la home de WordPress (que además
  // apuntaba a Google+, cerrado en 2019) sólo crearía duplicados y datos
  // obsoletos. Aquí únicamente se enlazan los proyectos detectados.
  db.prepare("DELETE FROM links WHERE kind IN ('social', 'contact')").run();

  const insertLink = db.prepare('INSERT INTO links (kind, label, url, icon, position) VALUES (?, ?, ?, ?, ?)');
  let pos = 0;
  for (const l of links) {
    if (!/github\.com\/pikilon/i.test(l.url)) continue;
    insertLink.run('project', l.label, l.url, 'github', pos++);
  }
  log(`  sitio: 1 fila, ${pos} enlace(s) de proyecto`);
}

/**
 * Incorpora lo que sólo está en el dump de MySQL.
 *
 * La API REST pública devuelve únicamente lo publicado. El dump trae además
 * los borradores y lo programado, los ajustes del sitio y los menús. Aquí se
 * importan como entradas en estado `draft`, que no se publican pero quedan
 * disponibles y visibles con `site.mjs list`.
 *
 * Es idempotente: empareja por `wp_id`, así que reimportar no duplica.
 *
 * @returns {object} informe de lo incorporado
 */
function importDumpExtra(db, dump, imageMap, idToPath) {
  const prefix = detectPrefix(dump);
  const stats = summarizePosts(dump, prefix);
  if (stats) {
    const estados = Object.entries(stats.byStatus)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    log(`  ${prefix}posts: ${stats.total} filas (${estados})`);
  }

  const options = extractWpOptions(dump, prefix);
  if (options.permalink_structure) log(`  permalinks: ${options.permalink_structure}`);
  if (options.template) log(`  tema: ${options.template}`);

  // Ajustes del sitio: sólo se rellenan huecos, no se pisa lo ya importado.
  if (options.blogname || options.admin_email || options.blogdescription) {
    db.prepare(`
      UPDATE site SET
        title = COALESCE(NULLIF(title, ''), ?),
        description = COALESCE(NULLIF(description, ''), ?),
        author_email = COALESCE(author_email, ?)
      WHERE id = 1
    `).run(options.blogname ?? null, options.blogdescription ?? null, options.admin_email ?? null);
  }

  // Borradores y programados.
  const drafts = extractUnpublished(dump, prefix);
  const findExisting = db.prepare('SELECT id FROM entries WHERE wp_id = ?');
  const insert = db.prepare(`
    INSERT INTO entries (kind, slug, title, summary, body, body_format, published_at,
                         updated_at, status, lang, position, wp_id)
    VALUES (?, ?, ?, ?, ?, 'markdown', ?, ?, 'draft', 'en', 0, ?)
  `);

  let added = 0;
  let skipped = 0;
  for (const d of drafts) {
    if (!d.slug || findExisting.get(d.id)) {
      skipped++;
      continue;
    }
    const raw = expandShortcodes(d.content || '', idToPath);
    const body = htmlToMarkdown(raw, { imageMap });
    if (!body.trim()) {
      skipped++;
      continue;
    }
    insert.run(
      d.type === 'page' ? 'page' : 'post',
      d.slug,
      htmlToText(d.title || d.slug),
      htmlToText(body).slice(0, 200).trim() || null,
      body,
      d.date ? `${d.date.replace(' ', 'T')}Z` : null,
      d.date ? `${d.date.replace(' ', 'T')}Z` : null,
      d.id,
    );
    added++;
  }
  if (drafts.length) {
    log(`  no publicados: ${added} importados como borrador${skipped ? `, ${skipped} omitidos` : ''}`);
  }

  // Menús: la tabla puede no existir si el sitio no usaba menús clásicos.
  const menuItems = dump.tables[`${prefix}postmeta`]
    ? dump.tables[`${prefix}postmeta`].rows.filter((r) => r.meta_key === '_menu_item_url').length
    : 0;
  if (menuItems) log(`  menús: ${menuItems} enlaces en postmeta`);

  return { prefix, posts: stats, options, draftsImported: added, draftsSkipped: skipped, menuItems };
}

/** Detecta el prefijo de las tablas de WordPress (`wp_`, `wp2_`, `mod_`…). */
function detectPrefix(dump) {
  const hit = Object.keys(dump.tables).find((t) => t.endsWith('posts') && t.includes('_'));
  return hit ? hit.slice(0, hit.length - 'posts'.length) : 'wp_';
}

/* ------------------------------------------------------------- migraciones */

/**
 * Añade las columnas que falten en una base de datos creada con un esquema
 * anterior. `CREATE TABLE IF NOT EXISTS` no modifica tablas ya existentes,
 * así que sin esto una base antigua se quedaría sin las columnas nuevas.
 *
 * Es idempotente: se puede ejecutar en cada importación sin efectos.
 */
function migrate(db) {
  const columnsOf = (table) =>
    db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

  const additions = [
    ['site', 'bio', 'TEXT'],
    ['site', 'location', 'TEXT'],
  ];

  const added = [];
  for (const [table, column, type] of additions) {
    const existing = columnsOf(table);
    if (existing.length && !existing.includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      added.push(`${table}.${column}`);
    }
  }
  if (added.length) log(`  esquema migrado: +${added.join(', +')}`);
}

/** Tablas del CV cuya información NO procede de WordPress. */
const CV_TABLES = ['experience', 'education', 'skills', 'projects'];

/** Copia las tablas del CV antes de recrear la base de datos. */
async function dumpCvTables() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const backup = {};
  try {
    for (const t of CV_TABLES) backup[t] = db.prepare(`SELECT * FROM ${t}`).all();
    const site = db.prepare('SELECT bio, location, author_email FROM site WHERE id = 1').get();
    if (site) backup.__site = site;
    const links = db.prepare("SELECT * FROM links WHERE kind IN ('social','contact')").all();
    backup.__links = links;
  } catch {
    return null; // base de datos antigua sin estas tablas
  } finally {
    db.close();
  }
  return backup;
}

/** Reinserta las tablas del CV copiadas antes de recrear la base de datos. */
function restoreCvTables(db, backup) {
  let total = 0;
  for (const [table, rows] of Object.entries(backup)) {
    if (!CV_TABLES.includes(table) || !rows?.length) continue;
    const cols = Object.keys(rows[0]);
    const stmt = db.prepare(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    );
    for (const row of rows) stmt.run(...cols.map((c) => row[c]));
    total += rows.length;
  }
  if (backup.__site) {
    db.prepare('UPDATE site SET bio = ?, location = ?, author_email = ? WHERE id = 1')
      .run(backup.__site.bio, backup.__site.location, backup.__site.author_email);
  }
  if (backup.__links?.length) {
    db.prepare("DELETE FROM links WHERE kind IN ('social','contact')").run();
    const stmt = db.prepare('INSERT INTO links (kind, label, url, icon, position) VALUES (?, ?, ?, ?, ?)');
    for (const l of backup.__links) stmt.run(l.kind, l.label, l.url, l.icon, l.position);
  }
  if (total) log(`  CV conservado: ${total} filas`);
  return total;
}

/* ------------------------------------------------------------------ main */

async function main() {
  const t0 = Date.now();
  log('Importando el archivo de WordPress a la base de datos simplificada\n');

  // 1. Cargar el archivo REST.
  const posts = (await readJson(join(REST, 'posts.json'), [])) || [];
  const pages = (await readJson(join(REST, 'pages.json'), [])) || [];
  const categories = (await readJson(join(REST, 'categories.json'), [])) || [];
  const tags = (await readJson(join(REST, 'tags.json'), [])) || [];
  if (!posts.length && !pages.length) {
    throw new Error('No hay archive/rest/posts.json ni pages.json. Ejecuta antes: node scripts/mirror-wp.mjs');
  }

  // 2. Base de datos. Por defecto se recrea desde cero (el archivo es la
  //    fuente), pero las tablas del CV se conservan: no vienen de WordPress y
  //    perderlas obligaría a reescribir el CV a mano.
  await mkdir(dirname(DB_PATH), { recursive: true });
  const cvBackup = !KEEP && existsSync(DB_PATH) ? await dumpCvTables() : null;
  if (!KEEP && existsSync(DB_PATH)) {
    for (const suffix of ['', '-wal', '-shm']) await rm(DB_PATH + suffix, { force: true });
  }
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(await readFile(join(ROOT, 'db', 'schema.sql'), 'utf8'));
  // El esquema se declara con CREATE TABLE IF NOT EXISTS, así que una base de
  // datos anterior no recibe las columnas nuevas: hay que migrarla.
  migrate(db);

  if (KEEP) {
    log('  modo --keep: no se borran datos existentes');
  }

  // 3. Medios (copia física + metadatos) para poder resolver las URLs.
  log('\n[1/4] Medios');
  const { urlToPath, idToPath } = await syncMedia(db);

  // Mapa auxiliar: las URLs con sufijo de tamaño también resuelven al original.
  const imageMap = new Map(urlToPath);
  for (const [url, path] of urlToPath) {
    imageMap.set(stripSizeSuffix(url), path);
    imageMap.set(stripSizeSuffix(url).replace('https://pikilon.com/', 'https://www.pikilon.com/'), path);
  }

  // 4. Términos, entradas y sitio.
  log('\n[2/4] Taxonomía');
  const termByWpId = importTerms(db, categories, tags);

  log('\n[3/4] Entradas');
  importEntries(db, posts, pages, termByWpId, imageMap, idToPath);

  log('\n[4/4] Identidad del sitio');
  await importSite(db, pages);

  // 5. Dump opcional de MySQL: aporta lo que la API REST no expone sin
  //    autenticación (borradores, ajustes, menús, revisiones).
  const dumpPath = DUMP ? resolve(DUMP) : findDump();
  if (dumpPath) {
    log(`\n[+] Dump de MySQL: ${dumpPath.replace(ROOT + '/', '')}`);
    try {
      const dump = await parseSqlDump(await readFile(dumpPath, 'utf8'));
      const report = importDumpExtra(db, dump, imageMap, idToPath);
      await writeFile(join(ROOT, 'db', 'dump-summary.json'), JSON.stringify({ summary: dump.summary, report }, null, 2));
      log(`  ${dump.summary.length} tablas leídas -> db/dump-summary.json`);
    } catch (err) {
      log(`  ! no se pudo interpretar el dump: ${err.message}`);
    }
  } else {
    log('\n[+] Sin dump de MySQL (opcional). Deja el .sql en la raíz y repite.');
  }

  // 6. El CV. `site/cv/curriculum.md` es la fuente de verdad: si existe, se
  //    aplica SIEMPRE (después de importSite, para que mande sobre los enlaces
  //    sociales deducidos de la home de WordPress). Si no existe, se recupera
  //    lo que hubiera en la base de datos anterior.
  const cvFile = join(ROOT, 'site', 'cv', 'curriculum.md');
  let cvRestored = null;
  if (existsSync(cvFile)) {
    try {
      const counts = syncCv();
      log(`\n[+] CV aplicado desde site/cv/: ${counts.education} títulos, ${counts.skills} tecnologías, ${counts.projects} proyectos, ${counts.links} enlaces`);
    } catch (err) {
      log(`\n[!] No se pudo aplicar site/cv/: ${err.message}`);
    }
  } else if (cvBackup) {
    cvRestored = restoreCvTables(db, cvBackup);
    if (cvRestored) log(`\n[+] CV recuperado de la base de datos anterior (${cvRestored} filas)`);
  } else {
    log('\n[+] Sin site/cv/curriculum.md todavía (se creará al hacer cv.mjs export)');
  }

  // 7. Volcar las entradas a site/, que pasa a ser la fuente editable.
  if (!args.includes('--no-export')) {
    const n = exportToSite();
    log(`\n[+] ${n} archivo(s) Markdown escritos en site/ — a partir de ahora se edita ahí.`);
    try {
      const cvFileOut = exportCv();
      log(`[+] CV volcado a ${cvFileOut.file.replace(ROOT + '/', '')}`);
    } catch (err) {
      log(`[+] CV no volcado: ${err.message}`);
    }
  }

  // 8. Informe.
  const stats = {
    entries: db.prepare('SELECT COUNT(*) n FROM entries').get().n,
    published: db.prepare("SELECT COUNT(*) n FROM entries WHERE status='published'").get().n,
    media: db.prepare('SELECT COUNT(*) n FROM media').get().n,
    variants: db.prepare('SELECT COUNT(*) n FROM media_variants').get().n,
    terms: db.prepare('SELECT COUNT(*) n FROM terms').get().n,
    links: db.prepare('SELECT COUNT(*) n FROM links').get().n,
  };
  db.exec(`INSERT INTO builds (started_at, finished_at, tool, entries, notes)
           VALUES ('${new Date(t0).toISOString()}', '${new Date().toISOString()}', 'import.mjs', ${stats.entries}, 'importación inicial')`);
  db.close();

  log('\nResultado:');
  for (const [k, v] of Object.entries(stats)) log(`  ${k.padEnd(10)} ${v}`);
  log(`\nBase de datos: db/pikilon.db (${((await stat(DB_PATH)).size / 1024).toFixed(0)} KB)`);
  log(`Listo en ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
}

/** Busca un dump .sql/.sql.gz dejado en la raíz o en data/. */
function findDump() {
  for (const dir of [ROOT, join(ROOT, 'data')]) {
    if (!existsSync(dir)) continue;
    const hit = readdirSync(dir).find((f) => /\.sql$/i.test(f));
    if (hit) return join(dir, hit);
  }
  return null;
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
  process.exit(1);
});
