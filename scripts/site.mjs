#!/usr/bin/env node
/**
 * site.mjs — Interfaz única para gestionar el sitio.
 *
 * Reúne todo lo que antes se hacía en el panel de WordPress:
 *
 *   node scripts/site.mjs new "Título del artículo" [--category=code]
 *   node scripts/site.mjs export          # vuelca la BD a archivos Markdown
 *   node scripts/site.mjs sync            # archivos -> base de datos
 *   node scripts/site.mjs build           # base de datos -> HTML en public/
 *   node scripts/site.mjs check           # auditoría de integridad
 *   node scripts/site.mjs list            # qué hay publicado
 *   node scripts/site.mjs deploy          # copia public/ al repo de GitHub Pages
 *   node scripts/site.mjs publish <arch>  # sync + check + build en un paso
 *
 * El flujo normal es: `new` -> escribir -> `publish`.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  DB_PATH, ROOT, SITE_DIR, exportToSite, findSourceFiles, listEntries,
  publishFile, scaffold, syncSiteDirectory,
} from './publish.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Map(
  rest
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.replace(/^--/, '').split('=');
      return [k, v ?? true];
    }),
);
const positional = rest.filter((a) => !a.startsWith('--'));

const run = (script, args = []) => {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], {
    stdio: 'inherit',
    cwd: ROOT,
  });
  return r.status ?? 1;
};

/* ------------------------------------------------------------------ comandos */

const commands = {
  /** Crea un archivo Markdown nuevo con la cabecera ya preparada. */
  new() {
    const title = positional.join(' ').trim();
    if (!title) {
      console.error('Falta el título. Ejemplo:\n  node scripts/site.mjs new "Mi artículo" --category=code');
      return 1;
    }
    const file = scaffold({
      title,
      category: flags.get('category') || 'code',
      tags: String(flags.get('tags') || '').split(',').map((s) => s.trim()).filter(Boolean),
      date: flags.get('date'),
      kind: flags.get('kind') || 'post',
    });
    console.log(`Archivo creado: ${file.replace(ROOT + '/', '')}\n`);
    console.log('1. Escribe el contenido en ese archivo.');
    console.log('2. Publica con:  node scripts/site.mjs publish');
    return 0;
  },

  /** Importa todos los archivos de site/ a la base de datos. */
  sync() {
    const md = findSourceFiles();
    if (!md.length) {
      console.log(`No hay archivos .md en ${SITE_DIR.replace(ROOT + '/', '')}/`);
      console.log('Crea uno con:  node scripts/site.mjs new "Título"');
      return 0;
    }
    const prune = Boolean(flags.get('prune')) || Boolean(flags.get('prune-all'));
    console.log(`Sincronizando ${md.length} archivo(s) desde site/${prune ? ' (con purga)' : ''}\n`);
    let created = 0;
    let updated = 0;
    let failed = 0;
    let pruned = 0;

    for (const r of syncSiteDirectory({ dryRun: Boolean(flags.get('dry-run')), prune })) {
      if (!r.ok) {
        failed++;
        console.error(`  ✗ ${r.file}: ${r.error}`);
        continue;
      }
      if (r.pruned) {
        pruned++;
        console.log(`  - ${r.slug} (retirada: ya no tiene archivo)`);
        continue;
      }
      if (r.created) created++;
      else updated++;
      console.log(`  ${r.created ? '+' : '~'} ${r.slug} (${r.status})`);
    }
    console.log(
      `\n${created} nuevas, ${updated} actualizadas${pruned ? `, ${pruned} retiradas` : ''}${failed ? `, ${failed} con error` : ''}`,
    );
    return failed ? 1 : 0;
  },

  /** Vuelca la base de datos a archivos Markdown editables en site/. */
  export() {
    if (!existsSync(DB_PATH)) {
      console.error('No hay base de datos. Ejecuta primero: node scripts/import.mjs');
      return 1;
    }
    const n = exportToSite();
    console.log(`${n} archivo(s) escritos en site/`);
    console.log('Ahora site/ es la fuente: edita ahí y ejecuta "node scripts/site.mjs publish".');
    return 0;
  },

  /** Muestra qué hay en la base de datos. */
  list() {
    if (!existsSync(DB_PATH)) {
      console.error('No hay base de datos. Ejecuta: node scripts/import.mjs');
      return 1;
    }
    const rows = listEntries();
    const w = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
    console.log(`${w('ESTADO', 10)}${w('FECHA', 12)}${w('TIPO', 6)}${w('SLUG', 46)}TÍTULO`);
    console.log('-'.repeat(110));
    for (const r of rows) {
      console.log(`${w(r.status, 10)}${w((r.published_at || '').slice(0, 10), 12)}${w(r.kind, 6)}${w(r.slug, 46)}${r.title}`);
    }
    console.log(`\n${rows.length} entradas`);
    return 0;
  },

  /** Publica todo: pasa las pruebas, sincroniza, audita y genera. */
  publish() {
    const files = positional.length ? positional : null;

    // Las pruebas van primero: si el parser de Markdown está roto, publicar
    // generaría contenido incorrecto y mejor no llegar ni a escribirlo.
    console.log('== 1/4 Pasar las pruebas\n');
    if (run('test.mjs')) {
      console.error('\nHay pruebas fallando: se detiene la publicación.');
      return 1;
    }

    console.log('\n== 2/4 Sincronizar site/ -> base de datos\n');
    if (files) {
      for (const f of files) {
        try {
          const r = publishFile(f);
          console.log(`  ${r.created ? '+' : '~'} ${r.slug} (${r.status})`);
        } catch (err) {
          console.error(`  ✗ ${f}: ${err.message}`);
          return 1;
        }
      }
    } else {
      const rc = commands.sync();
      if (rc) return rc;
    }

    console.log('\n== 3/4 Auditar\n');
    if (run('check.mjs')) {
      console.error('\nLa auditoría falló: se detiene la publicación.');
      return 1;
    }

    console.log('\n== 4/4 Generar el sitio\n');
    const rc = run('build.mjs', flags.get('drafts') ? ['--drafts'] : []);
    if (rc) return rc;

    console.log('Hecho. Revisa public/index.html o despliega con "node scripts/site.mjs deploy".');
    return 0;
  },

  /** Ejecuta las pruebas de las piezas críticas. */
  test() {
    return run('test.mjs', flags.get('verbose') ? ['--verbose'] : []);
  },

  check() {
    return run('check.mjs', ['--site']);
  },

  build() {
    return run('build.mjs', flags.get('drafts') ? ['--drafts'] : []);
  },

  deploy() {
    const args = [];
    for (const [k, v] of flags) args.push(v === true ? `--${k}` : `--${k}=${v}`);
    return run('deploy.mjs', args);
  },

  help() {
    console.log(HELP);
    return 0;
  },
};

const HELP = `Gestión del sitio pikilon.com

  node scripts/site.mjs new "Título" [--category=code] [--tags=a,b]
        Crea un archivo Markdown nuevo en site/ listo para escribir.

  node scripts/site.mjs export
        Vuelca el contenido de la base de datos a archivos Markdown en site/.

  node scripts/site.mjs list
        Lista las entradas con su estado.

  node scripts/site.mjs sync [--dry-run]
        Importa los archivos de site/ a la base de datos.

  node scripts/site.mjs build [--drafts]
        Genera el HTML estático en public/.

  node scripts/site.mjs test [--verbose]
        Pasa las pruebas del parser de Markdown y del conversor de WordPress.

  node scripts/site.mjs check
        Audita la integridad de la base de datos y del sitio generado.

  node scripts/site.mjs publish [archivo.md ...]
        Pasa las pruebas, sincroniza, audita y genera. Es el comando del día a día.

  node scripts/site.mjs deploy [--dry-run]
        Copia public/ al repositorio de GitHub Pages.
`;

if (!cmd || cmd === 'help' || flags.has('help')) {
  process.exit(commands.help());
}
if (!commands[cmd]) {
  console.error(`Comando desconocido: ${cmd}\n`);
  console.log(HELP);
  process.exit(1);
}
process.exit(commands[cmd]());
