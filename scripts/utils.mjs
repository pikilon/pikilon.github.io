import { readFileSync } from 'node:fs';

/**
 * utils.mjs — Utilidades compartidas por los scripts.
 *
 * Vive aparte para que los módulos puedan usarlas sin arrastrar efectos
 * secundarios: importar `import.mjs` ejecuta la importación entera, así que
 * no puede ser el sitio donde vivan funciones que otros necesitan.
 */

/**
 * Convierte un texto en un slug estable: sin acentos, minúsculas y separado
 * por guiones. Es la base de todas las URLs, así que su comportamiento no
 * debe cambiar sin avisar.
 *
 * @param {string} text
 * @param {number} [max]  longitud máxima
 */
export function slugify(text = '', max = 80) {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
}

/**
 * Clave estable (icono) a partir del dominio de un enlace.
 * Se guarda en la base de datos y se vuelve a leer al sincronizar, así que
 * tiene que ser predecible y en minúsculas.
 */
export function iconFor(url = '') {
  const map = {
    'facebook.com': 'facebook', 'twitter.com': 'twitter', 'x.com': 'twitter',
    'linkedin.com': 'linkedin', 'github.com': 'github', 'codepen.io': 'codepen',
    'youtube.com': 'youtube', 'instagram.com': 'instagram', 'mastodon': 'mastodon',
    'stackoverflow.com': 'stackoverflow',
  };
  for (const [host, icon] of Object.entries(map)) if (String(url).includes(host)) return icon;
  return String(url).startsWith('mailto:') ? 'email' : 'web';
}

/** Fecha ISO-8601 UTC completa; admite `YYYY-MM`, `YYYY-MM-DD` y con hora. */
export function toIsoUtc(date, fallbackTime = '12:00:00') {
  if (!date) return null;
  const s = String(date).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(s)) return s;

  const withDay = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}:\d{2}(?::\d{2})?))?/);
  if (withDay) {
    const [, y, mo, d, time] = withDay;
    const t = (time || fallbackTime).padEnd(8, ':00').slice(0, 8);
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${t}Z`;
  }

  // Sólo año y mes (como en `- inicio: 2020-03`): se asume el día 1. Es el
  // formato que usan los archivos del CV, donde no se sabe el día.
  const yearMonth = s.match(/^(\d{4})-(\d{1,2})$/);
  if (yearMonth) {
    const [, y, mo] = yearMonth;
    const t = fallbackTime.padEnd(8, ':00').slice(0, 8);
    return `${y}-${mo.padStart(2, '0')}-01T${t}Z`;
  }

  return null;
}

/**
 * Slugs de página que gestiona el CV y que, por tanto, no deben tratarse como
 * entradas: ni importarse desde WordPress ni exportarse a `site/`.
 *
 * Se leen del frontmatter de `site/cv/curriculum.md`, que es quien declara qué
 * slug ocupa la portada (por defecto `home`). Vive aquí para que `import.mjs`
 * y `publish.mjs` compartan una única definición.
 *
 * @param {string} cvFile  ruta absoluta al archivo del CV
 * @returns {Set<string>}
 */
export function cvOwnedSlugs(cvFile) {
  const fallback = new Set(['home']);
  try {
    const text = readFileSync(cvFile, 'utf8');
    const m = text.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return fallback;
    const slug = (m[1].match(/^\s*slug\s*:\s*(.+)$/m) || [])[1];
    return new Set([slug ? slug.trim().replace(/^["']|["']$/g, '') : 'home']);
  } catch {
    return fallback;
  }
}
