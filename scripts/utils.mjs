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

/** Fecha ISO-8601 UTC completa; admite `YYYY-MM-DD` y fecha con hora. */
export function toIsoUtc(date, fallbackTime = '12:00:00') {
  if (!date) return null;
  const s = String(date).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(s)) return s;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?/);
  if (!m) return null;
  const t = (m[2] || fallbackTime).padEnd(8, ':00').slice(0, 8);
  return `${m[1]}T${t}Z`;
}
