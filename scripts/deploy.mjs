#!/usr/bin/env node
/**
 * deploy.mjs — Publica el sitio generado en el repositorio de GitHub Pages.
 *
 * El repositorio es `pikilon/pikilon.github.io`, que sirve la raíz de
 * pikilon.github.io. Ese dominio lo COMPARTEN otros proyectos del usuario,
 * que viven en sus propios repositorios y se publican como subcarpetas
 * (/die-hard-dice/, /red-line/…). Por eso el despliegue NUNCA borra el
 * repositorio entero: sólo reemplaza lo que genera este sitio, usando un
 * manifiesto de la última publicación (`.deploy-manifest.json`).
 *
 * Uso:
 *   node scripts/deploy.mjs --dry-run     # muestra qué haría, sin tocar nada
 *   node scripts/deploy.mjs               # copia, hace commit y push
 *   node scripts/deploy.mjs --no-push     # copia y hace commit, sin subir
 *   node scripts/deploy.mjs --local       # en vez de copiar, commitea public/
 *                                         # copiado a la raíz de este repo
 *
 * Requisitos: `public/` generado (`node scripts/site.mjs build`) y permiso de
 * escritura en el repositorio remoto (git push por SSH).
 */

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const STAGE = join(ROOT, '.deploy');
const MANIFEST = join(ROOT, '.deploy-manifest.json');
/**
 * URL del repositorio de GitHub Pages.
 * Se usa el alias SSH `github-pikilon` (definido en ~/.ssh/config) porque la
 * clave por defecto de esta máquina pertenece a OTRA cuenta de GitHub
 * (francisco-toptal), que no tiene permiso sobre este repositorio.
 */
const REMOTE = 'github-pikilon:pikilon/pikilon.github.io.git';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const NO_PUSH = args.includes('--no-push');
const LOCAL = args.includes('--local');

/**
 * Archivos que pertenecen a otros proyectos y nunca se deben tocar.
 * Esta lista es la red de seguridad: aunque el manifiesto falle, estos
 * directorios quedan intactos.
 */
const PROTECTED = new Set([
  '.git', '.github', '.well-known', '.deploy-manifest.json',
  'die-hard-dice', 'red-line', 'dungeon-copilot', 'paste-across-devices',
  'rocking-rolling-dices', 'bideolist', 'emergency-dices', 'airtemis',
  'francisco-gutierrez-4-5-2021', 'drive-login', 'plugin.googledrive',
  'tutorial-native-base-styling',
]);

const log = (...a) => console.log(...a);

function sh(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${cmdArgs.join(' ')} falló:\n${r.stderr || r.stdout}`);
  }
  return (r.stdout || '').trim();
}

/** Lista recursiva de archivos relativos a `dir`. */
function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === '.git') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p));
  }
  return out;
}

/* ------------------------------------------------------------------- main */

async function main() {
  if (!existsSync(PUBLIC)) {
    throw new Error('No existe public/. Ejecuta antes: node scripts/site.mjs build');
  }

  const generated = walk(PUBLIC);
  log(`Sitio generado: ${generated.length} archivos en public/\n`);

  // 1. Qué se va a reemplazar y qué se va a retirar de la última publicación.
  let previous = [];
  try {
    previous = JSON.parse(await readFile(MANIFEST, 'utf8')).files || [];
  } catch {
    log('Sin manifiesto previo: es la primera publicación de este generador.');
  }
  const removed = previous.filter((f) => !generated.includes(f) && !isProtected(f));
  if (removed.length) {
    log(`Se retirarán ${removed.length} archivos que ya no se generan:`);
    for (const f of removed.slice(0, 10)) log(`  - ${f}`);
    if (removed.length > 10) log(`  … y ${removed.length - 10} más`);
    log('');
  }

  if (DRY) {
    log('--dry-run: no se ha copiado ni subido nada.');
    log(`Se escribirían ${generated.length} archivos en el repositorio de GitHub Pages.`);
    return;
  }

  if (LOCAL) {
    await deployLocally(generated, removed);
  } else {
    await deployToClone(generated, removed);
  }

  // 2. Manifiesto de esta publicación, para poder limpiar la próxima vez.
  await writeFile(
    MANIFEST,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        count: generated.length,
        files: generated,
        protected: [...PROTECTED],
      },
      null,
      2,
    ),
  );
  log(`\nManifiesto guardado: ${relative(ROOT, MANIFEST)} (${generated.length} archivos)`);
}

/** ¿La ruta pertenece a otro proyecto del dominio compartido? */
function isProtected(rel) {
  const first = String(rel).split('/')[0];
  return PROTECTED.has(first);
}

/**
 * Copia el sitio a la raíz de ESTE repositorio.
 * El repositorio del workspace tiene como remoto el de GitHub Pages, así que
 * el sitio generado convive con el código fuente y se publica con un push.
 */
async function deployLocally(generated, removed) {
  log('Copiando public/ a la raíz del repositorio…');

  for (const f of removed) {
    const p = join(ROOT, f);
    if (existsSync(p)) await rm(p, { force: true });
  }
  for (const f of generated) {
    const from = join(PUBLIC, f);
    const to = join(ROOT, f);
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to);
  }

  // Sólo se añade lo generado: el código fuente y el archivo no se tocan.
  sh('git', ['add', '--', ...generated], { cwd: ROOT, allowFail: true });
  if (removed.length) {
    sh('git', ['rm', '--cached', '--ignore-unmatch', '--', ...removed], { cwd: ROOT, allowFail: true });
  }

  const status = sh('git', ['status', '--porcelain'], { cwd: ROOT });
  if (!status) {
    log('Nada que publicar: el sitio generado es idéntico al ya subido.');
    return;
  }

  sh('git', ['commit', '-m', `Publicar el sitio (${generated.length} archivos)`], { cwd: ROOT });
  log('Commit creado.');

  if (!NO_PUSH) {
    sh('git', ['push', 'origin', 'main'], { cwd: ROOT });
    log(`Subido a ${REMOTE}`);
  }
}

/**
 * Alternativa: clonar el repositorio de GitHub Pages en una carpeta temporal,
 * reemplazar sólo lo generado y hacer push. Útil si prefieres no mezclar el
 * código fuente y el sitio en la misma rama.
 */
async function deployToClone(generated, removed) {
  if (existsSync(STAGE)) await rm(STAGE, { recursive: true, force: true });
  log(`Clonando ${REMOTE}…`);
  sh('git', ['clone', '--depth', '1', REMOTE, STAGE]);

  for (const f of removed) {
    const p = join(STAGE, f);
    if (existsSync(p)) await rm(p, { force: true });
  }
  for (const f of generated) {
    const from = join(PUBLIC, f);
    const to = join(STAGE, f);
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to);
  }

  sh('git', ['add', '-A'], { cwd: STAGE });
  const status = sh('git', ['status', '--porcelain'], { cwd: STAGE });
  if (!status) {
    log('Nada que publicar: no hay cambios.');
    return;
  }
  sh('git', ['commit', '-m', `Publicar el sitio (${generated.length} archivos)`], { cwd: STAGE });
  if (!NO_PUSH) {
    sh('git', ['push', 'origin', 'main'], { cwd: STAGE });
    log(`Subido a ${REMOTE}`);
  }
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
  process.exit(1);
});
