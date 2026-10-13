/**
 * mysql-import.mjs — Lector de dumps de MySQL/MariaDB (formato phpMyAdmin/mysqldump).
 *
 * No necesita el servidor MySQL: interpreta el fichero .sql directamente.
 * Sirve para dos cosas:
 *
 *   1. Completar lo que la API REST no expone (ajustes, borradores,
 *      revisiones, comentarios, menús) cuando tengas el dump de Hostinger.
 *   2. Funcionar con CUALQUIER WordPress, no sólo con pikilon.com: el
 *      importador sólo necesita el .sql y este módulo lo entiende.
 *
 * Estrategia de parseo: en lugar de escribir un parser SQL completo (que
 * tendría que lidiar con funciones, triggers y delimitadores), se aísla el
 * cuerpo de cada `INSERT INTO` y se tokenizan sus tuplas respetando el
 * escapado de MySQL. Es suficiente para el formato real que generan
 * phpMyAdmin y mysqldump, y mucho más robusto que usar expresiones regulares
 * sobre las filas enteras.
 */

/** Sentencias que un dump puede contener y que aquí se ignoran deliberadamente. */
const SKIP_STATEMENTS = /^(SET|START|COMMIT|BEGIN|LOCK|UNLOCK|ALTER|DROP|CREATE|USE|\/\*|--|DELIMITER|SOURCE|REPLACE\b.*?CATALOG)/i;

/**
 * Interpreta un dump completo.
 *
 * @param {string} sql  contenido del fichero .sql
 * @returns {Promise<{tables: object, insertOrder: string[], charset: string|null}>}
 */
export async function parseSqlDump(sql) {
  const statements = splitStatements(sql);
  const tables = {};
  const insertOrder = [];
  let charset = null;

  // El charset se declara en la cabecera del dump; útil para decodificar textos.
  const cm = sql.match(/CHARSET=([a-z0-9_]+)/i);
  if (cm) charset = cm[1];

  // 1. Esquema: columnas de cada tabla, para poder dar nombre a los valores.
  for (const stmt of statements) {
    const m = stmt.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([\w$]+)`?\s*\(([\s\S]*)\)\s*ENGINE/i);
    if (!m) continue;
    const [, name, body] = m;
    const columns = [];
    for (const line of splitTopLevel(body, ',')) {
      const col = line.trim().match(/^`([^`]+)`\s+([a-z]+(?:\([^)]*\))?(?:\s+unsigned)?)/i);
      if (col) columns.push({ name: col[1], type: col[2].toLowerCase() });
    }
    tables[name] ||= { columns, rows: [] };
    tables[name].columns = columns;
  }

  // 2. Datos: cada INSERT aporta una o varias tuplas.
  for (const stmt of statements) {
    const m = stmt.match(/^INSERT\s+(?:IGNORE\s+)?INTO\s+`?([\w$]+)`?\s*(?:\(([^)]*)\))?\s*VALUES\s*([\s\S]*)$/i);
    if (!m) continue;
    const [, name, colList, valuesPart] = m;
    if (!tables[name]) tables[name] = { columns: [], rows: [] };
    if (!insertOrder.includes(name)) insertOrder.push(name);

    // Si el INSERT nombra sus columnas, mandan sobre las del CREATE TABLE.
    if (colList) {
      tables[name].columns = colList
        .split(',')
        .map((c) => ({ name: c.trim().replace(/^`|`$/g, ''), type: 'unknown' }));
    }

    for (const tuple of splitTuples(valuesPart)) {
      const values = parseTuple(tuple);
      if (values.length === 0) continue;
      const columns = tables[name].columns;
      const row = {};
      values.forEach((v, i) => {
        const key = columns[i]?.name ?? `col_${i}`;
        row[key] = v;
      });
      tables[name].rows.push(row);
    }
  }

  return {
    tables,
    insertOrder,
    charset,
    summary: summarize(tables),
  };
}

/**
 * Divide el dump en sentencias completas.
 * Se apoya en el hecho de que, fuera de cadenas y comentarios, `;` cierra
 * una sentencia. Los `DELIMITER` de rutinas se tratan como corte duro.
 */
export function splitStatements(sql) {
  const out = [];
  let buf = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];

    // Comentarios de línea
    if ((ch === '-' && sql[i + 1] === '-') || (ch === '#' && peekIsCommentStart(sql, i, '#'))) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    // Comentarios de bloque
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    // Cadenas: se copian tal cual, respetando el escapado.
    if (ch === "'" || ch === '"' || ch === '`') {
      const [lit, next] = readQuoted(sql, i);
      buf += lit;
      i = next;
      continue;
    }
    if (ch === ';') {
      const stmt = buf.trim();
      if (stmt && !SKIP_STATEMENTS.test(stmt)) out.push(stmt);
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  const tail = buf.trim();
  if (tail && !SKIP_STATEMENTS.test(tail)) out.push(tail);
  return out;
}

const peekIsCommentStart = (sql, i, marker) => marker === '#';

/** Lee una cadena entrecomillada y devuelve [texto literal, índice siguiente]. */
function readQuoted(sql, start) {
  const quote = sql[start];
  let i = start + 1;
  let out = quote;
  while (i < sql.length) {
    const c = sql[i];
    if (c === '\\') {
      out += c + (sql[i + 1] ?? '');
      i += 2;
      continue;
    }
    // En MySQL, '' dentro de una cadena representa una comilla literal.
    if (c === quote && sql[i + 1] === quote) {
      out += c + c;
      i += 2;
      continue;
    }
    out += c;
    i++;
    if (c === quote) break;
  }
  return [out, i];
}

/**
 * Extrae las tuplas `(...)` de la parte VALUES de un INSERT.
 * El nivel de paréntesis distingue los límites de cada fila de los
 * paréntesis que puedan aparecer dentro de una cadena.
 */
function splitTuples(valuesPart) {
  const tuples = [];
  let depth = 0;
  let start = -1;
  let i = 0;

  while (i < valuesPart.length) {
    const ch = valuesPart[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const [, next] = readQuoted(valuesPart, i);
      i = next;
      continue;
    }
    if (ch === '(') {
      if (depth === 0) start = i + 1;
      depth++;
      i++;
      continue;
    }
    if (ch === ')') {
      depth--;
      if (depth === 0 && start >= 0) tuples.push(valuesPart.slice(start, i));
      i++;
      continue;
    }
    i++;
  }
  return tuples;
}

/** Convierte el interior de una tupla en un array de valores JS. */
function parseTuple(inner) {
  const values = [];
  let i = 0;
  const n = inner.length;

  while (i < n) {
    // Salta separadores y espacios.
    while (i < n && (inner[i] === ',' || /\s/.test(inner[i]))) i++;
    if (i >= n) break;

    const ch = inner[i];

    if (ch === "'" || ch === '"') {
      const [lit, next] = readQuoted(inner, i);
      values.push(unquote(lit));
      i = next;
      continue;
    }

    // Valor desnudo: número, NULL, función (NOW(), etc.) o booleano.
    let j = i;
    while (j < n && inner[j] !== ',') j++;
    const raw = inner.slice(i, j).trim();
    values.push(bareValue(raw));
    i = j;
  }

  return values;
}

function unquote(lit) {
  const quote = lit[0];
  let body = lit.slice(1, lit.endsWith(quote) && lit.length > 1 ? -1 : undefined);
  body = body.replace(new RegExp(`\\\\(.)`, 'g'), (_, c) => {
    const map = { n: '\n', r: '\r', t: '\t', '0': '\0', b: '\b', Z: '\x1a', '\\': '\\', "'": "'", '"': '"' };
    return map[c] ?? c;
  });
  body = body.replace(new RegExp(quote + quote, 'g'), quote);
  return body;
}

function bareValue(raw) {
  if (!raw) return null;
  if (/^NULL$/i.test(raw)) return null;
  if (/^(TRUE|FALSE)$/i.test(raw)) return /^TRUE$/i.test(raw);
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d*\.\d+(e[-+]?\d+)?$/i.test(raw)) return Number(raw);
  return { __expr: raw }; // NOW(), CURRENT_TIMESTAMP, etc.
}

/** Divide por comas respetando paréntesis, útil para la lista de columnas. */
function splitTopLevel(str, sep) {
  const out = [];
  let depth = 0;
  let buf = '';
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const [lit, next] = readQuoted(str, i);
      buf += lit;
      i = next;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === sep && depth === 0) {
      out.push(buf);
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

/** Resumen legible: cuántas filas tiene cada tabla del dump. */
function summarize(tables) {
  const out = [];
  for (const [name, t] of Object.entries(tables)) {
    out.push({ table: name, rows: t.rows.length, columns: t.columns.map((c) => c.name) });
  }
  return out.sort((a, b) => b.rows - a.rows);
}

/* ------------------------------------------------- utilidades de WordPress */

/**
 * Extrae los ajustes relevantes de la tabla wp_options de un dump.
 * Devuelve sólo lo que el sitio nuevo necesita, no las 500 opciones.
 */
export function extractWpOptions(dump, prefix = 'wp_') {
  const table = dump.tables[`${prefix}options`];
  if (!table) return {};
  const wanted = new Set([
    'blogname', 'blogdescription', 'siteurl', 'home', 'admin_email',
    'timezone_string', 'date_format', 'start_of_week', 'blog_public',
    'permalink_structure', 'template', 'stylesheet', 'show_on_front',
    'page_on_front', 'page_for_posts', 'WPLANG',
  ]);
  const out = {};
  for (const row of table.rows) {
    const name = row.option_name;
    if (name && wanted.has(name)) out[name] = row.option_value;
  }
  return out;
}

/**
 * Devuelve las entradas no públicas del dump: borradores, pendientes y
 * programadas. Son justo las que la API REST no entrega sin autenticación,
 * así que es la razón principal para importar el dump.
 *
 * @param {object} dump  resultado de `parseSqlDump`
 * @param {string} [prefix]  prefijo de las tablas (`wp_` por defecto)
 * @param {object} [opts]
 * @param {boolean} [opts.includeTrash]  incluir la papelera (por defecto no)
 */
export function extractUnpublished(dump, prefix = 'wp_', { includeTrash = false } = {}) {
  const table = dump.tables[`${prefix}posts`];
  if (!table) return [];
  const excluded = ['publish', 'inherit', 'auto-draft', 'revision', ...(includeTrash ? [] : ['trash'])];

  return table.rows
    .filter((r) => r.post_type === 'post' || r.post_type === 'page')
    .filter((r) => r.post_status && !excluded.includes(r.post_status))
    .map((r) => ({
      id: r.ID,
      type: r.post_type,
      status: r.post_status,
      slug: r.post_name,
      title: r.post_title,
      // `post_date_gmt` puede no existir en dumps antiguos o venir a cero.
      date: usableDate(r.post_date_gmt) || usableDate(r.post_date),
      content: r.post_content,
    }))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

/** Descarta las fechas centinela que usa MySQL (`0000-00-00 …`). */
function usableDate(value) {
  if (!value || typeof value !== 'string') return null;
  if (/^0000-00-00/.test(value)) return null;
  return value;
}

/**
 * Cuenta lo que hay en el dump por tipo y estado.
 * Sirve para comprobar de un vistazo que se ha leído el dump correcto antes
 * de fiarse de él.
 */
export function summarizePosts(dump, prefix = 'wp_') {
  const table = dump.tables[`${prefix}posts`];
  if (!table) return null;
  const byStatus = {};
  const byType = {};
  for (const r of table.rows) {
    byStatus[r.post_status] = (byStatus[r.post_status] || 0) + 1;
    byType[r.post_type] = (byType[r.post_type] || 0) + 1;
  }
  return { total: table.rows.length, byStatus, byType };
}
