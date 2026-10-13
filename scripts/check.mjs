#!/usr/bin/env node
/**
 * check.mjs — Auditoría de la base de datos y del sitio generado.
 *
 * Comprueba que la migración no ha perdido nada por el camino. Se puede
 * ejecutar en cualquier momento; devuelve código de salida 1 si encuentra
 * errores, para poder encadenarlo en un script de publicación.
 *
 * Uso:
 *   node scripts/check.mjs            # audita la base de datos
 *   node scripts/check.mjs --site     # audita además el HTML generado
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = join(ROOT, 'db', 'pikilon.db');
const CHECK_SITE = process.argv.includes('--site');

const problems = [];
const warnings = [];
const fail = (msg) => problems.push(msg);
const warn = (msg) => warnings.push(msg);

/* --------------------------------------------------------------- base de datos */

function checkDatabase() {
  if (!existsSync(DB_PATH)) {
    fail('No existe db/pikilon.db. Ejecuta: node scripts/import.mjs');
    return null;
  }
  const db = new DatabaseSync(DB_PATH, { readOnly: true });

  // Integridad física del fichero.
  const integrity = db.prepare('PRAGMA integrity_check').get();
  const integrityValue = Object.values(integrity)[0];
  if (integrityValue !== 'ok') fail(`integrity_check devolvió: ${integrityValue}`);

  // Claves foráneas huérfanas.
  const fk = db.prepare('PRAGMA foreign_key_check').all();
  if (fk.length) fail(`${fk.length} violaciones de clave foránea`);

  const entries = db.prepare('SELECT * FROM entries').all();
  const media = db.prepare('SELECT * FROM media').all();
  const sites = db.prepare('SELECT * FROM site').all();

  if (sites.length !== 1) fail(`La tabla site debe tener 1 fila, tiene ${sites.length}`);
  if (!entries.length) fail('No hay entradas');

  // --- por cada entrada, comprobaciones de contenido ---
  const slugs = new Map();
  for (const e of entries) {
    const where = `entrada ${e.id} (${e.slug})`;

    if (!e.slug) fail(`${where}: sin slug`);
    if (!e.title?.trim()) fail(`${where}: sin título`);
    if (!e.body?.trim()) fail(`${where}: cuerpo vacío`);

    // Slugs duplicados (la columna es UNIQUE, pero avisamos con contexto).
    if (slugs.has(e.slug)) fail(`slug duplicado: ${e.slug}`);
    slugs.set(e.slug, e.id);

    // Fechas en ISO-8601.
    for (const field of ['published_at', 'updated_at']) {
      const v = e[field];
      if (v && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v)) {
        warn(`${where}: ${field} no es ISO-8601 UTC (${v})`);
      }
    }
    if (e.status === 'published' && !e.published_at) fail(`${where}: publicada sin fecha`);

    // Restos de HTML o shortcodes de WordPress en el Markdown.
    const body = e.body || '';
    if (/\[(codepen_embed|lazy_responsive_img|gist|email)\b/.test(body)) {
      fail(`${where}: shortcode sin resolver`);
    }
    if (/&(?:lt|gt|amp|quot|#\d+);/.test(body)) fail(`${where}: entidades HTML sin decodificar`);
    if (/<script|<style/i.test(body)) fail(`${where}: etiquetas peligrosas en el Markdown`);

    // Enlaces Markdown deformados por la conversión.
    if (/\]\(\s*\)/.test(body)) warn(`${where}: enlace Markdown con URL vacía`);
    if (/\*\*\s+\*\*/.test(body)) warn(`${where}: énfasis vacío`);

    // Cada imagen referenciada debe existir en disco.
    for (const m of body.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) {
      const src = m[1];
      if (/^https?:/.test(src)) continue; // recurso externo, no lo controlamos
      const p = join(ROOT, src.replace(/^\//, ''));
      if (!existsSync(p)) fail(`${where}: imagen no encontrada -> ${src}`);
    }

    // La imagen destacada debe existir.
    if (e.featured_id) {
      const f = media.find((x) => x.id === e.featured_id);
      if (!f) fail(`${where}: featured_id ${e.featured_id} no existe en media`);
      else if (!existsSync(join(ROOT, 'assets', f.path))) {
        fail(`${where}: archivo de imagen destacada ausente -> assets/${f.path}`);
      }
    }
  }

  // --- medios ---
  for (const m of media) {
    const p = join(ROOT, 'assets', m.path);
    if (!existsSync(p)) {
      fail(`medio ${m.id}: falta el archivo assets/${m.path}`);
      continue;
    }
    const size = statSync(p).size;
    if (m.bytes && size !== m.bytes) warn(`medio ${m.id}: tamaño en disco (${size}) != BD (${m.bytes})`);
  }

  const variants = db.prepare('SELECT * FROM media_variants').all();
  let missingVariants = 0;
  for (const v of variants) {
    if (!existsSync(join(ROOT, 'assets', v.path))) missingVariants++;
  }
  if (missingVariants) warn(`${missingVariants}/${variants.length} variantes de medios sin archivo`);

  // --- taxonomía ---
  const orphanTerms = db.prepare(`
    SELECT t.slug FROM terms t
    LEFT JOIN entry_terms et ON et.term_id = t.id
    WHERE et.entry_id IS NULL
  `).all();
  for (const t of orphanTerms) warn(`término sin entradas: ${t.slug}`);

  const cvSummary = checkCv(db);

  db.close();
  return { entries, media, variants, cv: cvSummary };
}

/**
 * Comprueba las tablas del CV.
 *
 * El CV no viene de WordPress, así que no pasa por la validación del archivo:
 * es contenido escrito a mano y es donde más fácil es colar una fecha mal
 * formateada o un enlace roto sin que nadie lo note.
 */
function checkCv(db) {
  const experience = db.prepare('SELECT * FROM experience').all();
  const education = db.prepare('SELECT * FROM education').all();
  const skills = db.prepare('SELECT * FROM skills').all();
  const projects = db.prepare('SELECT * FROM projects').all();
  const site = db.prepare('SELECT * FROM site WHERE id = 1').get();

  // La portada es el CV: sin nombre no hay página.
  if (!site?.author_name?.trim()) fail('CV: site.author_name está vacío');

  for (const e of experience) {
    const where = `CV/experiencia ${e.id} (${e.role || '?'})`;
    if (!e.role?.trim()) fail(`${where}: sin puesto`);
    if (!e.company?.trim()) warn(`${where}: sin empresa`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.started_at || '')) {
      fail(`${where}: fecha de inicio inválida (${e.started_at}); se espera YYYY-MM-DD`);
    }
    if (e.ended_at && !/^\d{4}-\d{2}-\d{2}$/.test(e.ended_at)) {
      fail(`${where}: fecha de fin inválida (${e.ended_at})`);
    }
    if (e.ended_at && e.ended_at < e.started_at) {
      fail(`${where}: termina antes de empezar (${e.started_at} > ${e.ended_at})`);
    }
    if (e.url && !/^https?:\/\//.test(e.url)) warn(`${where}: URL sin esquema (${e.url})`);
  }

  for (const e of education) {
    const where = `CV/formación ${e.id} (${e.title || '?'})`;
    if (!e.title?.trim()) fail(`${where}: sin titulación`);
    if (!e.institution?.trim()) warn(`${where}: sin institución`);
    for (const [field, value] of [['inicio', e.started_at], ['fin', e.ended_at]]) {
      if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        fail(`${where}: fecha de ${field} inválida (${value})`);
      }
    }
  }

  for (const s of skills) {
    if (!s.area?.trim()) fail(`CV/tecnología ${s.id}: sin área`);
    if (!s.name?.trim()) fail(`CV/tecnología ${s.id}: sin nombre`);
    if (s.level != null && (s.level < 1 || s.level > 5)) {
      warn(`CV/tecnología ${s.id} (${s.name}): nivel fuera de 1-5`);
    }
  }

  const seenSlugs = new Set();
  for (const p of projects) {
    const where = `CV/proyecto ${p.id} (${p.name || '?'})`;
    if (!p.name?.trim()) fail(`${where}: sin nombre`);
    if (p.slug && seenSlugs.has(p.slug)) fail(`${where}: slug duplicado ${p.slug}`);
    seenSlugs.add(p.slug);
    for (const [label, url] of [['repo', p.url], ['demo', p.demo]]) {
      if (url && !/^https?:\/\//.test(url)) warn(`${where}: ${label} sin esquema (${url})`);
    }
  }

  return { experience: experience.length, education: education.length, skills: skills.length, projects: projects.length };
}

/* ------------------------------------------------------------------- sitio */

function checkSite() {
  const out = join(ROOT, 'public');
  if (!existsSync(out)) {
    warn('No hay public/ generado todavía. Ejecuta: node scripts/build.mjs');
    return;
  }

  const htmlFiles = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.html')) htmlFiles.push(p);
    }
  };
  walk(out);

  if (!htmlFiles.length) {
    fail('public/ no contiene ningún HTML');
    return;
  }

  for (const file of htmlFiles) {
    const html = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file);

    if (!/<!DOCTYPE html>/i.test(html)) fail(`${rel}: sin doctype`);
    if (!/<title>[^<]+<\/title>/i.test(html)) fail(`${rel}: sin <title>`);
    if (!/lang="[a-z-]+"/i.test(html)) warn(`${rel}: sin atributo lang`);
    if (/href="(?:\.\.\/)*undefined/.test(html)) fail(`${rel}: enlace a undefined`);
    if (/src="(?:\.\.\/)*undefined/.test(html)) fail(`${rel}: recurso undefined`);
    if (/\[object Object\]/.test(html)) fail(`${rel}: valor no serializado en la plantilla`);

    // Cada recurso local enlazado debe existir. Las rutas que empiezan por /
    // son absolutas al sitio (se resuelven desde la raíz de public/), no
    // relativas al archivo: confundirlo da falsos positivos en todas partes.
    for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const url = m[1];
      if (/^(https?:|mailto:|#|data:|tel:)/.test(url)) continue;
      const clean = url.split('#')[0].split('?')[0];
      if (!clean) continue;
      let target;
      if (clean.startsWith('/')) {
        target = join(ROOT, 'public', clean.replace(/^\/+/, ''));
      } else {
        target = resolve(dirname(file), clean);
      }
      // Un enlace a una carpeta se sirve con su index.html.
      if (existsSync(target) && statSync(target).isDirectory()) {
        target = join(target, 'index.html');
      }
      if (!existsSync(target)) fail(`${rel}: recurso roto -> ${url}`);
    }

    // Cada candidato de un `srcset` también tiene que existir: un srcset con
    // una variante ausente puede hacer que el navegador elija justo la que
    // falta y muestre una imagen rota.
    for (const m of html.matchAll(/srcset="([^"]+)"/g)) {
      for (const candidate of m[1].split(',')) {
        const url = candidate.trim().split(/\s+/)[0];
        if (!url || /^https?:/.test(url)) continue;
        const target = url.startsWith('/')
          ? join(ROOT, 'public', url.replace(/^\/+/, ''))
          : resolve(dirname(file), url);
        if (!existsSync(target)) fail(`${rel}: variante de srcset ausente -> ${url}`);
      }
    }

    // El retrato y las imágenes destacadas deberían ofrecer varios tamaños:
    // sin `srcset` se descarga el original aunque se muestre en miniatura.
    for (const m of html.matchAll(/<img[^>]*class="(?:portrait|hero|card__thumb)"[^>]*>/g)) {
      if (!/srcset=/.test(m[0])) {
        const src = (m[0].match(/src="([^"]+)"/) || [])[1];
        warn(`${rel}: imagen sin srcset -> ${src}`);
      }
    }
  }

  console.log(`  ${htmlFiles.length} páginas HTML revisadas en public/`);
}

/* -------------------------------------------------------------------- main */

console.log('Auditando la migración…\n');
const data = checkDatabase();
if (data) {
  console.log(`  ${data.entries.length} entradas, ${data.media.length} medios, ${data.variants.length} variantes`);
  if (data.cv) {
    console.log(`  CV: ${data.cv.experience} puestos, ${data.cv.education} títulos, ${data.cv.skills} tecnologías, ${data.cv.projects} proyectos`);
  }
}
if (CHECK_SITE) checkSite();

console.log('');
if (warnings.length) {
  console.log(`Avisos (${warnings.length}):`);
  for (const w of warnings.slice(0, 40)) console.log(`  · ${w}`);
  if (warnings.length > 40) console.log(`  … y ${warnings.length - 40} más`);
  console.log('');
}
if (problems.length) {
  console.log(`ERRORES (${problems.length}):`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  console.log('\nLa auditoría ha FALLADO.');
  process.exit(1);
}
console.log('✓ La auditoría ha pasado sin errores.');
