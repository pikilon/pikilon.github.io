/**
 * publish.mjs — Publicar y editar contenido en la base de datos del sitio.
 *
 * Es la pieza que sustituye al panel de WordPress: se escribe un archivo
 * Markdown con una cabecera (frontmatter) y este módulo lo inserta o lo
 * actualiza en db/pikilon.db. Después, `build.mjs` regenera el sitio.
 *
 * Formato del archivo (carpeta site/):
 *
 *   ---
 *   title: Rem + em, a love story
 *   slug: rem-em-love-story          # opcional: se deduce del título
 *   date: 2017-06-28                 # opcional: hoy por defecto
 *   status: published                # published | draft | archived
 *   category: code                   # una categoría (se crea si no existe)
 *   tags: [css, html]                # lista de etiquetas
 *   summary: Una línea de resumen.   # opcional
 *   featured: 2017/06/REM.jpg        # opcional: ruta dentro de assets/
 *   ---
 *
 *   Aquí va el cuerpo en Markdown.
 *
 * Uso desde la línea de órdenes:
 *   node scripts/publish.mjs site/code/mi-articulo.md
 *   node scripts/publish.mjs --list
 *   node scripts/publish.mjs site/x.md --dry-run
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cvOwnedSlugs } from './utils.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DB_PATH = join(ROOT, 'db', 'pikilon.db');
export const SITE_DIR = join(ROOT, 'site');
export const CV_DIR = join(SITE_DIR, 'cv');

/* ---------------------------------------------------------------- frontmatter */

/**
 * Separa la cabecera YAML del cuerpo.
 * Se admite un subconjunto de YAML: `clave: valor`, listas en línea
 * (`[a, b]`) y listas en varias líneas con guiones. Es suficiente para
 * escribir contenido a mano y evita depender de un parser completo.
 *
 * @param {string} text
 * @returns {{data: object, body: string}}
 */
export function parseFrontmatter(text) {
  const src = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const m = src.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: src.trim() };

  const data = {};
  let currentList = null;

  for (const raw of m[1].split('\n')) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;

    // Elemento de una lista que empezó en una línea anterior.
    const item = raw.match(/^\s*-\s+(.*)$/);
    if (item && currentList) {
      data[currentList].push(unquote(item[1]));
      continue;
    }

    const kv = raw.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();

    if (!value) {
      // `clave:` sin valor -> puede ser el inicio de una lista.
      data[key] = [];
      currentList = key;
      continue;
    }
    currentList = null;

    if (/^\[.*\]$/.test(value)) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
    } else if (/^(true|false)$/i.test(value)) {
      data[key] = /^true$/i.test(value);
    } else {
      data[key] = unquote(value);
    }
  }

  return { data, body: m[2].trim() };
}

const unquote = (s = '') =>
  String(s).replace(/^["'](.*)["']$/s, '$1').trim();

/** Convierte un título en un slug estable, sin acentos ni signos. */
export function slugify(text = '') {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Normaliza una fecha a ISO-8601 UTC; admite `YYYY-MM-DD` y fecha+hora. */
export function toIsoUtc(date, time = '12:00:00') {
  if (!date) return null;
  const s = String(date).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(s)) return s;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?/);
  if (!m) return null;
  const t = (m[2] || time).padEnd(8, ':00').slice(0, 8);
  return `${m[1]}T${t}Z`;
}

/* ------------------------------------------------------------------ escritura */

/**
 * Publica (o actualiza) un archivo Markdown en la base de datos.
 *
 * @param {string} file  ruta del .md
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]  no escribe nada, sólo informa
 * @param {boolean} [opts.force]   permite cambiar el slug de una entrada existente
 * @returns {object} resumen de la operación
 */
export function publishFile(file, { dryRun = false, force = false } = {}) {
  const abs = resolve(file);
  if (!existsSync(abs)) throw new Error(`No existe el archivo: ${file}`);

  const { data, body } = parseFrontmatter(readFileSync(abs, 'utf8'));
  if (!data.title) throw new Error(`${basename(abs)}: falta "title" en la cabecera`);
  if (!body) throw new Error(`${basename(abs)}: el cuerpo está vacío`);

  const slug = data.slug ? slugify(data.slug) : slugify(data.title);
  const kind = data.kind === 'page' ? 'page' : 'post';
  const status = ['published', 'draft', 'archived'].includes(data.status) ? data.status : 'published';
  const publishedAt = toIsoUtc(data.date || data.published_at);
  const tags = normalizeList(data.tags);
  // El nombre visible y el slug determinan la URL del término. Al exportar se
  // conservan ambos para que un ciclo exportar -> sincronizar sea idempotente.
  const category = data.category ? String(data.category) : null;
  const categorySlug = data.category_slug ? slugify(data.category_slug) : null;

  const result = {
    file: abs.replace(ROOT + '/', ''),
    slug,
    kind,
    status,
    title: data.title,
    category,
    tags,
    created: false,
    dryRun,
  };

  if (dryRun) return result;

  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON;');

  const existing = db.prepare('SELECT * FROM entries WHERE slug = ?').get(slug);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  // La imagen destacada se referencia por su ruta dentro de assets/.
  let featuredId = null;
  if (data.featured) {
    const p = String(data.featured).replace(/^\/?(assets\/)?/, '');
    const row = db.prepare('SELECT id FROM media WHERE path = ?').get(p);
    if (!row) throw new Error(`featured: no hay ningún medio con la ruta "${p}"`);
    featuredId = row.id;
  }

  let entryId;
  if (existing) {
    if (data.slug && slugify(data.slug) !== existing.slug && !force) {
      // El slug es la URL: cambiarlo rompe enlaces. Hay que pedirlo a propósito.
      throw new Error(
        `El slug "${slug}" ya existe con otro valor ("${existing.slug}"). ` +
        `Usa --force si de verdad quieres cambiar la URL.`,
      );
    }
    db.prepare(`
      UPDATE entries SET kind=?, title=?, summary=?, body=?, published_at=?,
             updated_at=?, status=?, featured_id=?
      WHERE id=?
    `).run(
      kind,
      data.title,
      // `??` y no `||`: un resumen vacío en el archivo debe poder borrar el
      // anterior. WordPress y node:sqlite no admiten `undefined` como parámetro.
      summaryFor(data, existing),
      body,
      nullify(publishedAt ?? existing.published_at),
      now,
      status,
      nullify(featuredId ?? existing.featured_id),
      existing.id,
    );
    entryId = existing.id;
    result.updated = true;
  } else {
    const info = db.prepare(`
      INSERT INTO entries (kind, slug, title, summary, body, body_format, published_at,
                           updated_at, status, featured_id, lang, position)
      VALUES (?, ?, ?, ?, ?, 'markdown', ?, ?, ?, ?, 'en', 0)
    `).run(
      kind,
      slug,
      data.title,
      insertSummary(data, body),
      body,
      nullify(publishedAt || now),
      now,
      status,
      nullify(featuredId),
    );
    entryId = Number(info.lastInsertRowid);
    result.created = true;
  }

  // Categoría (se crea si no existe) y etiquetas.
  db.prepare('DELETE FROM entry_terms WHERE entry_id = ?').run(entryId);
  if (category) {
    const termId = ensureTerm(db, 'category', category, categorySlug);
    db.prepare('INSERT OR IGNORE INTO entry_terms (entry_id, term_id) VALUES (?, ?)').run(entryId, termId);
  }
  for (const raw of tags) {
    // Se admite "slug|Nombre visible" o sólo el nombre.
    const [a, b] = String(raw).split('|');
    const termId = b ? ensureTerm(db, 'tag', b, a) : ensureTerm(db, 'tag', a);
    db.prepare('INSERT OR IGNORE INTO entry_terms (entry_id, term_id) VALUES (?, ?)').run(entryId, termId);
  }

  // Los términos que se quedan sin ninguna entrada se limpian solos: así el
  // vocabulario no se llena de duplicados al reescribir etiquetas.
  db.prepare(`
    DELETE FROM terms WHERE id NOT IN (SELECT DISTINCT term_id FROM entry_terms)
  `).run();

  result.id = entryId;
  db.close();
  return result;
}

/**
 * Devuelve el id de un término, creándolo sólo si no existe.
 *
 * Busca primero por slug y después por nombre. Lo segundo importa: en
 * WordPress el slug y el nombre pueden diferir (etiqueta «javascript» con
 * slug «js»), y sin esa comprobación cada ciclo exportar/sincronizar
 * duplicaría el vocabulario.
 */
function ensureTerm(db, kind, name, slugHint = null) {
  const nameSlug = slugify(name);
  const wantedSlug = slugHint ? slugify(slugHint) : nameSlug;

  const bySlug = db.prepare('SELECT id FROM terms WHERE kind = ? AND slug = ?').get(kind, wantedSlug);
  if (bySlug) return bySlug.id;

  const byName = db.prepare('SELECT id FROM terms WHERE kind = ? AND lower(name) = lower(?)').get(kind, String(name));
  if (byName) return byName.id;

  const info = db.prepare('INSERT INTO terms (kind, slug, name, position) VALUES (?, ?, ?, ?)')
    .run(kind, wantedSlug, String(name), 999);
  return Number(info.lastInsertRowid);
}

const normalizeList = (v) => {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
};

/**
 * Convierte `undefined` en `null`.
 * `node:sqlite` rechaza `undefined` como parámetro, pero aquí el valor nulo
 * es legítimo (sin resumen, sin imagen destacada), así que hay que
 * distinguirlo de «no se ha indicado nada».
 */
const nullify = (v) => (v === undefined ? null : v);

/**
 * Resumen de una entrada NUEVA: el del archivo si trae texto, si no el primer
 * párrafo del cuerpo. Nunca un array ni `undefined`: `node:sqlite` sólo admite
 * tipos escalares y `null`.
 */
function insertSummary(data, body) {
  const s = data.summary;
  const hasText = typeof s === 'string' && s.trim() !== '';
  return hasText ? String(s) : firstParagraph(body);
}

/**
 * Resumen que corresponde al actualizar una entrada.
 * Tres casos distintos que no se pueden confundir:
 *   - el archivo no trae `summary:`      -> se conserva el que ya había
 *   - el archivo trae `summary:` vacío   -> se borra el resumen
 *   - el archivo trae texto              -> se usa ese texto
 * Un `summary:` sin valor se parsea como lista vacía, de ahí la comprobación.
 */
function summaryFor(data, existing) {
  if (!Object.hasOwn(data, 'summary')) return nullify(existing.summary);
  const s = data.summary;
  if (s === undefined || s === null || (Array.isArray(s) && s.length === 0) || String(s).trim() === '') {
    return null;
  }
  return String(s);
}

/** Primer párrafo del cuerpo, para usarlo como resumen si no se da ninguno. */
function firstParagraph(body) {
  const para = String(body).split(/\n\s*\n/).find((p) => p.trim() && !/^[#>\-*]/.test(p.trim()));
  const text = (para || '').replace(/\s+/g, ' ').replace(/[#*_`[\]]/g, '').trim().slice(0, 200);
  return text || null;
}

/* ------------------------------------------------------------------- lectura */

/**
 * Vuelca la base de datos a archivos Markdown editables en site/.
 *
 * Esto convierte `site/` en la fuente de verdad: a partir de aquí se edita
 * el Markdown, no la base de datos. Se ejecuta tras importar el WordPress y
 * siempre que se quiera reconstruir los archivos.
 *
 * @returns {number} número de archivos escritos
 */
export function exportToSite() {
  const cvSlugs = cvOwnedSlugs(join(CV_DIR, 'curriculum.md'));
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const entries = db.prepare('SELECT * FROM entries ORDER BY kind, published_at').all();

  const termsOf = (id) =>
    db.prepare(`
      SELECT t.kind, t.name, t.slug FROM entry_terms et
      JOIN terms t ON t.id = et.term_id WHERE et.entry_id = ?
    `).all(id);

  let n = 0;
  for (const e of entries) {
    // La portada no se exporta como entrada: la compone el CV
    // (`site/cv/curriculum.md`) con las tablas `experience`, `education`,
    // `skills` y `projects`. Exportarla aquí crearía un segundo archivo
    // compitiendo por el mismo slug.
    if (cvSlugs.has(e.slug)) continue;

    const own = termsOf(e.id);
    const cat = own.find((t) => t.kind === 'category');
    const tags = own.filter((t) => t.kind === 'tag');

    // Se emiten también los slugs de los términos ("slug|Nombre") para que
    // volver a importar el archivo reutilice los mismos términos en vez de
    // crear duplicados cuando slug y nombre difieren (js / javascript).
    const head = [
      '---',
      `title: ${e.title}`,
      `slug: ${e.slug}`,
      `kind: ${e.kind}`,
      `date: ${(e.published_at || '').slice(0, 10)}`,
      `status: ${e.status}`,
      cat ? `category: ${cat.name}` : null,
      cat && cat.slug !== slugify(cat.name) ? `category_slug: ${cat.slug}` : null,
      `tags: [${tags.map((t) => (t.slug === slugify(t.name) ? t.name : `${t.slug}|${t.name}`)).join(', ')}]`,
      e.summary ? `summary: ${String(e.summary).replace(/\n/g, ' ')}` : null,
      e.featured_id ? `featured: ${mediaPathOf(db, e.featured_id)}` : null,
      '---',
      '',
    ].filter((l) => l !== null);

    const dir = e.kind === 'page'
      ? join(SITE_DIR, 'pages')
      : join(SITE_DIR, cat ? slugify(cat.name) : 'writing');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${e.slug}.md`), `${head.join('\n')}\n${e.body || ''}`);
    n++;
  }
  db.close();
  return n;
}

/** Ruta dentro de assets/ de un medio, o cadena vacía si no existe. */
function mediaPathOf(db, id) {
  const row = db.prepare('SELECT path FROM media WHERE id = ?').get(id);
  return row ? row.path : '';
}

/** Lista las entradas con su estado, para revisar qué hay publicado. */
export function listEntries() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db.prepare(`
    SELECT e.id, e.kind, e.slug, e.title, e.status, e.published_at,
           GROUP_CONCAT(t.name, ', ') AS terms
    FROM entries e
    LEFT JOIN entry_terms et ON et.entry_id = e.id
    LEFT JOIN terms t ON t.id = et.term_id
    GROUP BY e.id
    ORDER BY e.published_at DESC
  `).all();
  db.close();
  return rows;
}

/**
 * Crea un archivo Markdown nuevo a partir de una plantilla.
 * Deja el contenido en site/, que es de donde `publishFile` lo lee: así el
 * repositorio conserva una copia legible de todo lo publicado.
 */
export function scaffold({ title, category = 'code', tags = [], date, kind = 'post' }) {
  const slug = slugify(title);
  const dir = join(SITE_DIR, kind === 'page' ? 'pages' : category);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${slug}.md`);
  if (existsSync(file)) throw new Error(`Ya existe: ${file.replace(ROOT + '/', '')}`);

  const isoDate = date || new Date().toISOString().slice(0, 10);
  const tagLine = tags.length ? `[${tags.join(', ')}]` : '[]';
  const content = `---
title: ${title}
slug: ${slug}
date: ${isoDate}
status: draft
category: ${category}
tags: ${tagLine}
summary:
---

Escribe aquí el contenido en Markdown.

## Un apartado

Y aquí el desarrollo.
`;
  writeFileSync(file, content);
  return file;
}

/**
 * Recorre `site/` y devuelve todos los .md que representan ENTRADAS.
 *
 * Se excluye `site/cv/`: el CV no es una entrada del blog ni una página
 * normal, sino datos estructurados que gestiona `scripts/cv.mjs`. Si se
 * incluyera aquí, competiría con la portada generada.
 */
export function findSourceFiles(dir = SITE_DIR) {
  const out = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d)) {
      if (name.startsWith('.')) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        if (resolve(p) === resolve(CV_DIR)) continue;
        walk(p);
      } else if (p.endsWith('.md')) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Sincroniza todo site/ con la base de datos.
 * Es lo que se ejecuta en cada publicación: primero importa lo que haya en
 * los archivos, y después el sitio se regenera con `build.mjs`.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.prune]  borra las entradas que ya no tienen archivo
 */
export function syncSiteDirectory({ dryRun = false, prune = false } = {}) {
  const files = findSourceFiles();
  const results = [];
  const seen = new Set();
  for (const f of files) {
    try {
      const r = publishFile(f, { dryRun });
      seen.add(r.slug);
      results.push({ ok: true, ...r });
    } catch (err) {
      results.push({ ok: false, file: f.replace(ROOT + '/', ''), error: err.message });
    }
  }

  if (prune && !dryRun) {
    for (const r of pruneMissing(seen)) results.push({ ok: true, ...r, pruned: true });
  }
  return results;
}

/**
 * Elimina las entradas cuya fuente ya no existe en site/.
 *
 * Sólo se aplica si site/ contiene archivos: si la carpeta está vacía o no
 * se ha exportado nunca, borrar todo sería un accidente, no una intención.
 * Devuelve la lista de entradas retiradas.
 */
export function pruneMissing(seenSlugs) {
  if (seenSlugs.size === 0) return [];

  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON;');
  const rows = db.prepare('SELECT id, slug, title FROM entries').all();
  const removed = [];

  for (const row of rows) {
    if (seenSlugs.has(row.slug)) continue;
    db.prepare('DELETE FROM entries WHERE id = ?').run(row.id);
    removed.push({ slug: row.slug, title: row.title });
  }
  db.prepare('DELETE FROM terms WHERE id NOT IN (SELECT DISTINCT term_id FROM entry_terms)').run();
  db.close();
  return removed;
}
