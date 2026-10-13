#!/usr/bin/env node
/**
 * cv.mjs — Gestiona el CV como datos estructurados.
 *
 * El CV vive en `site/cv/curriculum.md`, un archivo legible que combina
 * prosa escrita a mano con listas que se generan desde la base de datos.
 * El flujo es el mismo que el del blog:
 *
 *   node scripts/cv.mjs export    # base de datos -> site/cv/curriculum.md
 *   (editar el archivo)
 *   node scripts/cv.mjs sync      # archivo -> base de datos
 *
 * El archivo se divide en secciones marcadas con comentarios HTML:
 *
 *   # Francisco G. Sarazá            <- prosa libre, se conserva tal cual
 *
 *   <!-- cv:experience -->           <- a partir de aquí manda la base de datos
 *   ## Experiencia
 *   ### Rol — Empresa
 *   ...
 *
 * Al exportar, todo lo que hay entre un marcador y el siguiente se regenera.
 * Lo que está fuera de los marcadores nunca se toca.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './publish.mjs';
import { iconFor, slugify } from './utils.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DB_PATH = join(ROOT, 'db', 'pikilon.db');
export const CV_DIR = join(ROOT, 'site', 'cv');
export const CV_FILE = join(CV_DIR, 'curriculum.md');

/** Marcadores que delimitan las secciones que genera la base de datos. */
const MARKERS = {
  contact: 'cv:contact',
  skills: 'cv:skills',
  experience: 'cv:experience',
  education: 'cv:education',
  projects: 'cv:projects',
};

const marker = (key) => `<!-- ${MARKERS[key]} -->`;

/* ------------------------------------------------------------------ lectura */

/**
 * Convierte el archivo Markdown del CV en estructuras de datos.
 *
 * @param {string} text
 * @returns {{data: object, body: string, contact: object, skills: object, experience: object[], education: object[], projects: object[]}}
 */
export function parseCv(text) {
  const { data, body } = parseFrontmatter(text);
  const sections = splitSections(body);

  return {
    data,
    body,
    contact: parseContact([sections.contact, sections.intro].filter(Boolean).join('\n')),
    skills: parseSkills(sections.skills || ''),
    experience: parseExperience(sections.experience || ''),
    education: parseEducation(sections.education || ''),
    projects: parseProjects(sections.projects || ''),
  };
}

/**
 * Trocea el cuerpo en las secciones delimitadas por los marcadores.
 * El texto anterior al primer marcador se devuelve como `intro`.
 */
function splitSections(body) {
  const found = {};
  const lines = String(body).split('\n');
  let current = 'intro';
  let buf = [];

  for (const line of lines) {
    const m = line.match(/^<!--\s*cv:([a-z]+)\s*-->\s*$/i);
    if (m) {
      found[current] = buf.join('\n').trim();
      current = m[1].toLowerCase();
      buf = [];
      continue;
    }
    buf.push(line);
  }
  found[current] = buf.join('\n').trim();
  return found;
}

/* ------------------------------------------------------------- analizadores */

/** `- clave: valor` -> objeto. Se usa para los datos de contacto. */
function parseContact(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*[-*]?\s*([a-z_]+)\s*:\s*(.+?)\s*$/i);
    if (m) out[m[1].toLowerCase()] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/** `- Área: a, b, c` -> { área: [a, b, c] } */
function parseSkills(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*[-*]\s*([^:]+):\s*(.+)$/);
    if (!m) continue;
    out[m[1].trim()] = m[2].split(',').map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

/**
 * Experiencia. Formato por bloque:
 *
 *   ### Rol — Empresa
 *   - inicio: 2020-03
 *   - fin: 2023-06          (se omite si es el puesto actual)
 *   - ubicacion: London
 *   - web: https://…
 *   - stack: TypeScript, Vue
 *
 *   Un párrafo de contexto.
 *
 *   - Un logro destacado
 *   - Otro logro
 *
 * Las viñetas que no son `clave: valor` se guardan como logros, una por línea.
 */
function parseExperience(text) {
  return parseBlocks(text, (meta) => ({
    role: meta.heading?.role || '',
    company: meta.heading?.company || '',
    started_at: meta.fields.inicio || meta.fields.start || '',
    ended_at: meta.fields.fin || meta.fields.end || null,
    location: meta.fields.ubicacion || meta.fields.location || null,
    url: meta.fields.web || meta.fields.url || null,
    stack: meta.fields.stack || null,
    summary: meta.paragraphs[0] || null,
    highlights: meta.bullets.length ? meta.bullets.join('\n') : null,
  }));
}

/** Formación. `### Título — Institución`, con `tipo:` para diferenciar. */
function parseEducation(text) {
  const kindMap = { degree: 'degree', course: 'course', certificate: 'certificate' };
  return parseBlocks(text, (meta) => ({
    kind: kindMap[(meta.fields.tipo || '').toLowerCase()] || 'degree',
    title: meta.heading?.role || '',
    institution: meta.heading?.company || '',
    started_at: meta.fields.inicio || null,
    ended_at: meta.fields.fin || null,
    grade: meta.fields.nota || meta.fields.grade || null,
    url: meta.fields.web || null,
    summary: meta.paragraphs[0] || null,
  }));
}

/** Proyectos. `### Nombre` con `- repo:` y `- demo:`. */
function parseProjects(text) {
  return parseBlocks(text, (meta, i) => ({
    slug: meta.fields.slug || slugify(meta.heading?.role || `proyecto-${i + 1}`),
    name: meta.heading?.role || '',
    tagline: meta.fields.tagline || null,
    description: meta.paragraphs.join(' ') || null,
    url: meta.fields.repo || null,
    demo: meta.fields.demo || null,
    stack: meta.fields.stack || null,
    started_at: meta.fields.inicio || null,
    ended_at: meta.fields.fin || null,
  }));
}

/**
 * Analizador común de los bloques `### …` con campos `- clave: valor`,
 * párrafos y viñetas de logros.
 */
function parseBlocks(text, build) {
  const out = [];
  let heading = null;
  let fields = {};
  let paragraphs = [];
  let bullets = [];

  const flush = () => {
    if (!heading) return;
    out.push(build({ heading, fields, paragraphs, bullets }, out.length));
    heading = null;
    fields = {};
    paragraphs = [];
    bullets = [];
  };

  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    const h = line.match(/^###\s+(.+)$/);
    if (h) {
      flush();
      // "Rol — Empresa" o "Título – Institución" o sólo un nombre.
      const parts = h[1].split(/\s+[—–-]\s+/);
      heading = {
        role: parts[0].trim(),
        company: parts.length > 1 ? parts.slice(1).join(' - ').trim() : '',
      };
      continue;
    }
    if (/^##\s+/.test(line)) continue; // encabezado de sección

    const field = line.match(/^[-*]\s*([a-záéíóúñ_]+)\s*:\s*(.+)$/i);
    if (field) {
      fields[field[1].toLowerCase()] = field[2].trim();
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      bullets.push(bullet[1].trim());
      continue;
    }
    paragraphs.push(line.replace(/^\*\*|\*\*$/g, '').trim());
  }
  flush();
  return out;
}

/* ------------------------------------------------------------------ escritura */

/**
 * Vuelca la base de datos al archivo del CV, regenerando sólo las secciones
 * marcadas y conservando intacta la prosa escrita a mano.
 *
 * @returns {{file: string, counts: object}}
 */
export function exportCv() {
  if (!existsSync(DB_PATH)) throw new Error('No hay base de datos. Ejecuta: node scripts/import.mjs');
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const all = (sql) => db.prepare(sql).all();

  const experience = all('SELECT * FROM experience WHERE visible = 1 ORDER BY position, started_at DESC');
  const education = all('SELECT * FROM education WHERE visible = 1 ORDER BY position, ended_at DESC');
  const skills = all('SELECT * FROM skills WHERE visible = 1 ORDER BY position, area, name');
  const projects = all('SELECT * FROM projects WHERE visible = 1 ORDER BY position, name');
  const links = all("SELECT * FROM links WHERE visible = 1 AND kind IN ('social','contact') ORDER BY position");
  const site = db.prepare('SELECT * FROM site WHERE id = 1').get();
  db.close();

  // La presentación es del ARCHIVO, no de la base de datos: el archivo es la
  // fuente de verdad y `sync` sólo lo lee. Si aquí se tomara el valor de la
  // base de datos, un `export` con la tabla vacía borraría la presentación
  // que el usuario había escrito a mano.
  let intro = '';
  let frontmatter = null;
  if (existsSync(CV_FILE)) {
    const prev = readFileSync(CV_FILE, 'utf8');
    const { data, body } = parseFrontmatter(prev);
    frontmatter = data;
    intro = splitSections(body).intro || '';
  }
  // Sólo si el archivo no existe todavía se plantea una plantilla.
  if (!intro.trim()) {
    intro = templateIntro(site);
  }

  const head = [
    '---',
    `title: ${frontmatter?.title || 'CV'}`,
    'slug: home',
    'kind: page',
    `date: ${frontmatter?.date || new Date().toISOString().slice(0, 10)}`,
    'status: published',
    'tags: []',
    `summary: ${frontmatter?.summary || site?.description || ''}`,
    '---',
    '',
  ];

  const body = [
    intro.trim(),
    '',
    marker('contact'),
    '## Contacto',
    '',
    renderContact(site, links),
    '',
    marker('skills'),
    '## Tecnologías',
    '',
    renderSkills(skills),
    '',
    marker('experience'),
    '## Experiencia',
    '',
    renderExperience(experience),
    '',
    marker('education'),
    '## Formación',
    '',
    renderEducation(education),
    '',
    marker('projects'),
    '## Proyectos',
    '',
    renderProjects(projects),
    '',
  ];

  mkdirSync(CV_DIR, { recursive: true });
  writeFileSync(CV_FILE, head.join('\n') + body.join('\n'));

  return {
    file: CV_FILE,
    counts: {
      experience: experience.length,
      education: education.length,
      skills: skills.length,
      projects: projects.length,
      links: links.length,
    },
  };
}

/** Plantilla de presentación para cuando aún no existe el archivo del CV. */
function templateIntro(site) {
  const bio = String(site?.bio || '').trim();
  const header = [`# ${site?.author_name || 'Pikilon'}`, '', site?.tagline ? `_${site.tagline}_` : ''];
  if (bio) return [...header, '', bio].filter((l, i) => !(i === 2 && !l)).join('\n');
  return [
    ...header,
    '',
    'Escribe aquí tu presentación. Este texto se conserva tal cual;',
    'lo que va después de los marcadores `<!-- cv:… -->` se regenera',
    'desde la base de datos.',
  ]
    .filter((l, i) => !(i === 2 && !l))
    .join('\n');
}

function renderContact(site, links) {
  const rows = [];
  if (site?.author_email) rows.push(`- email: ${site.author_email}`);
  // `links` trae ya los sociales y de contacto de la tabla, que `sync` acaba
  // de reponer desde este mismo archivo: el ciclo es estable.
  for (const l of links) {
    // La clave (`icon`) es la que se vuelve a leer al sincronizar, así que
    // tiene que ser estable y en minúsculas; el nombre visible lo pone la web.
    // Se deduce del dominio si la fila no trae icono.
    const key = l.kind === 'project' ? 'proyecto' : l.icon || iconFor(l.url);
    rows.push(`- ${key}: ${l.url}`);
  }
  return rows.length ? rows.join('\n') : '_Sin datos de contacto todavía._';
}

function renderSkills(skills) {
  if (!skills.length) return '_Sin tecnologías todavía._';
  const byArea = new Map();
  for (const s of skills) {
    if (!byArea.has(s.area)) byArea.set(s.area, []);
    byArea.get(s.area).push(s.name);
  }
  return [...byArea].map(([area, names]) => `- ${area}: ${names.join(', ')}`).join('\n');
}

function renderExperience(list) {
  if (!list.length) return '_Sin experiencia registrada todavía._';
  return list
    .map((e) => {
      const out = [`### ${e.role} — ${e.company}`, ''];
      out.push(`- inicio: ${(e.started_at || '').slice(0, 7)}`);
      if (e.ended_at) out.push(`- fin: ${(e.ended_at || '').slice(0, 7)}`);
      if (e.location) out.push(`- ubicacion: ${e.location}`);
      if (e.url) out.push(`- web: ${e.url}`);
      if (e.stack) out.push(`- stack: ${e.stack}`);
      if (e.summary) out.push('', e.summary);
      for (const h of String(e.highlights || '').split('\n').filter(Boolean)) out.push(`- ${h}`);
      return out.join('\n');
    })
    .join('\n\n');
}

function renderEducation(list) {
  if (!list.length) return '_Sin formación registrada todavía._';
  return list
    .map((e) => {
      const out = [`### ${e.title} — ${e.institution}`, ''];
      if (e.kind !== 'degree') out.push(`- tipo: ${e.kind}`);
      if (e.started_at) out.push(`- inicio: ${(e.started_at || '').slice(0, 7)}`);
      if (e.ended_at) out.push(`- fin: ${(e.ended_at || '').slice(0, 7)}`);
      if (e.grade) out.push(`- nota: ${e.grade}`);
      if (e.url) out.push(`- web: ${e.url}`);
      if (e.summary) out.push('', e.summary);
      return out.join('\n');
    })
    .join('\n\n');
}

function renderProjects(list) {
  if (!list.length) return '_Sin proyectos registrados todavía._';
  return list
    .map((p) => {
      const out = [`### ${p.name}`, ''];
      out.push(`- slug: ${p.slug}`);
      if (p.tagline) out.push(`- tagline: ${p.tagline}`);
      if (p.url) out.push(`- repo: ${p.url}`);
      if (p.demo) out.push(`- demo: ${p.demo}`);
      if (p.stack) out.push(`- stack: ${p.stack}`);
      if (p.started_at) out.push(`- inicio: ${(p.started_at || '').slice(0, 7)}`);
      if (p.description) out.push('', p.description);
      return out.join('\n');
    })
    .join('\n\n');
}

/* -------------------------------------------------------------------- sync */

/**
 * Importa el archivo del CV a la base de datos.
 * Sustituye por completo el contenido de las tablas del CV: el archivo manda.
 *
 * @returns {object} recuento de filas importadas
 */
export function syncCv() {
  if (!existsSync(CV_FILE)) {
    throw new Error(`No existe ${CV_FILE.replace(ROOT + '/', '')}. Ejecuta antes: node scripts/cv.mjs export`);
  }
  const cv = parseCv(readFileSync(CV_FILE, 'utf8'));
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM experience; DELETE FROM education; DELETE FROM skills; DELETE FROM projects;');

    const insExp = db.prepare(`
      INSERT INTO experience (company, role, url, location, started_at, ended_at, summary, highlights, stack, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    cv.experience.forEach((e, i) => {
      insExp.run(e.company, e.role, e.url, e.location,
        normalizeMonth(e.started_at) || '1970-01', e.ended_at ? normalizeMonth(e.ended_at) : null,
        e.summary, e.highlights, e.stack, i);
    });

    const insEdu = db.prepare(`
      INSERT INTO education (kind, institution, title, url, started_at, ended_at, grade, summary, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    cv.education.forEach((e, i) => {
      insEdu.run(e.kind, e.institution, e.title, e.url,
        normalizeMonth(e.started_at), normalizeMonth(e.ended_at), e.grade, e.summary, i);
    });

    const insSkill = db.prepare('INSERT INTO skills (area, name, position) VALUES (?, ?, ?)');
    let skillCount = 0;
    let pos = 0;
    for (const [area, names] of Object.entries(cv.skills)) {
      for (const name of names) {
        insSkill.run(area, name, pos++);
        skillCount++;
      }
    }

    const insProj = db.prepare(`
      INSERT INTO projects (slug, name, tagline, description, url, demo, stack, started_at, ended_at, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    cv.projects.forEach((p, i) => {
      insProj.run(p.slug, p.name, p.tagline, p.description, p.url, p.demo, p.stack,
        normalizeMonth(p.started_at), normalizeMonth(p.ended_at), i);
    });

    // La presentación y los datos de contacto viven en la tabla `site`.
    // `id = 1` con un UPSERT: la fila ya existe tras `import.mjs`.
    const contact = cv.contact || {};
    const email = contact.email || contact.mail || null;
    const location = contact.ubicacion || contact.location || null;
    db.prepare(`
      INSERT INTO site (id, title, tagline, description, bio, author_name, author_email, author_photo, location, lang, url, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 'en', 'https://pikilon.com', ?)
      ON CONFLICT(id) DO UPDATE SET
        bio = excluded.bio,
        author_email = COALESCE(excluded.author_email, site.author_email),
        location = COALESCE(excluded.location, site.location),
        updated_at = excluded.updated_at
    `).run(
      cv.data.title || 'Pikilon',
      cv.data.tagline || null,
      cv.data.summary || null,
      introProse(cv) || null,
      cv.data.author || 'Francisco G. Sarazá',
      email,
      null,
      location,
      new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    );

    // Los enlaces de contacto/sociales se reemplazan por los del archivo,
    // conservando los que ya hubiera de tipo distinto (proyectos).
    const webLinks = Object.entries(contact)
      .filter(([k]) => !['email', 'mail', 'ubicacion', 'location', 'nombre', 'name'].includes(k))
      .map(([k, v]) => ({ kind: 'social', label: k, url: v, icon: k }));
    db.prepare("DELETE FROM links WHERE kind IN ('social', 'contact')").run();
    const insLink = db.prepare('INSERT INTO links (kind, label, url, icon, position) VALUES (?, ?, ?, ?, ?)');
    webLinks.forEach((l, i) => insLink.run(l.kind, l.label, l.url, l.icon, i));

    db.exec('COMMIT');
    return {
      experience: cv.experience.length,
      education: cv.education.length,
      skills: skillCount,
      projects: cv.projects.length,
      links: webLinks.length,
    };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.close();
  }
}

/** La presentación es todo lo que hay antes del primer marcador `cv:`. */
function introProse(cv) {
  const sections = splitSections(cv.body || '');
  // Se quitan el encabezado H1 y la línea de lema: ya están en el diseño.
  return String(sections.intro || '')
    .split('\n')
    .filter((l) => !/^#\s/.test(l) && !/^_[^_]*_$/.test(l.trim()))
    .join('\n')
    .trim();
}

/** `2020-3` o `2020-03-15` -> `2020-03-15` (la BD guarda fechas completas). */
function normalizeMonth(value) {
  if (!value) return null;
  const s = String(value).trim();
  const m = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}-${mo.padStart(2, '0')}-${(d || '01').padStart(2, '0')}`;
}

/* --------------------------------------------------------------------- CLI */

const commands = {
  export() {
    const { file, counts } = exportCv();
    console.log(`CV escrito en ${file.replace(ROOT + '/', '')}`);
    for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(11)} ${v}`);
    return 0;
  },
  sync() {
    const counts = syncCv();
    console.log('CV importado a la base de datos:');
    for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(11)} ${v}`);
    return 0;
  },
  list() {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    const q = (sql) => db.prepare(sql).all();
    console.log('EXPERIENCIA');
    for (const e of q('SELECT * FROM experience ORDER BY position, started_at DESC')) {
      console.log(`  ${(e.started_at || '').slice(0, 7)} → ${e.ended_at ? (e.ended_at || '').slice(0, 7) : 'hoy  '}  ${e.role} — ${e.company}`);
    }
    console.log('\nFORMACIÓN');
    for (const e of q('SELECT * FROM education ORDER BY position')) {
      console.log(`  [${e.kind}] ${e.title} — ${e.institution}${e.grade ? ` (${e.grade})` : ''}`);
    }
    console.log('\nTECNOLOGÍAS');
    for (const s of q('SELECT * FROM skills ORDER BY position')) console.log(`  ${s.area}: ${s.name}`);
    console.log('\nPROYECTOS');
    for (const p of q('SELECT * FROM projects ORDER BY position')) console.log(`  ${p.name}${p.repo ? ` — ${p.repo}` : ''}`);
    db.close();
    return 0;
  },
};

const HELP = `Gestión del CV

  node scripts/cv.mjs export    base de datos -> site/cv/curriculum.md
  node scripts/cv.mjs sync      site/cv/curriculum.md -> base de datos
  node scripts/cv.mjs list      resumen de lo que hay registrado

El archivo site/cv/curriculum.md combina prosa libre con secciones que se
regeneran desde la base de datos. Edita el texto y las listas, ejecuta
"sync" y después "node scripts/site.mjs publish" para regenerar la web.
`;

// Punto de entrada: sólo se ejecuta si este archivo se lanza directamente.
// `import.mjs` lo importa para reutilizar `syncCv`/`exportCv`, y en ese caso
// no debe interpretar argumentos ni terminar el proceso.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const cmd = process.argv[2];
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(HELP);
    process.exit(0);
  }
  if (!commands[cmd]) {
    console.error(`Comando desconocido: ${cmd}\n`);
    console.log(HELP);
    process.exit(1);
  }
  try {
    process.exit(commands[cmd]());
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}
