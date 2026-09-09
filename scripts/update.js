#!/usr/bin/env node
/**
 * update.js — Sincroniza el esquema de la base de un cliente con las migraciones
 * del template.
 *
 * La fuente de verdad es la tabla `schema_migrations` EN LA BASE DEL CLIENTE, no
 * project.json. Si alguien tocó la base a mano, el archivo miente y la base no.
 *
 * Resuelve tres estados por migración:
 *   faltante           el archivo existe y no está aplicada → se aplica (en orden, con OK)
 *   checksum_distinto  aplicada pero el contenido cambió → alerta, NO procede solo
 *   ajena              aplicada pero no existe en el template → frena y pide instrucciones
 *
 * Los datos del cliente (servicios, precios, profesionales, turnos) NUNCA se tocan.
 * `template_version` en project.json se actualiza solo al terminar con éxito.
 *
 * Uso:
 *   node update.js --check      solo reporta los estados, no aplica nada
 *   node update.js              aplica las faltantes con confirmación
 *   node update.js --yes        no pregunta (salvo migraciones 'major')
 *   node update.js --db=<url>   usa otra base (default DATABASE_URL del .env)
 *
 * Exit: 0 ok (o nada que hacer) · 1 hay bloqueos o falló una migración · 2 config
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, c, banner, step, ok, warn, fail,
  loadEnv, loadProjectJson, saveProjectJson,
  pgConnect, tableExists, sha256, confirm, TEMPLATE_VERSION,
} from './lib/infra.js';

const MIGR_DIR = join(ROOT, 'database', 'migrations');
const PLACEHOLDER_CHECKSUM = 'CALCULATED_BY_UPDATE_SCRIPT';

const args = { check: false, yes: false, forceChecksum: false, db: null };
for (const x of process.argv.slice(2)) {
  if (x === '--check' || x === '--dry-run') args.check = true;
  else if (x === '--yes' || x === '-y') args.yes = true;
  else if (x === '--force-checksum') args.forceChecksum = true;
  else if (x.startsWith('--db=')) args.db = x.slice(5);
  else if (x === '--help' || x === '-h') { console.log('Ver cabecera del archivo.'); process.exit(0); }
  else { console.error(`Argumento desconocido: ${x}`); process.exit(2); }
}

function readMigrationFiles() {
  if (!existsSync(MIGR_DIR)) return [];
  return readdirSync(MIGR_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(f => {
      const content = readFileSync(join(MIGR_DIR, f), 'utf-8');
      return {
        file: f,
        id: f.replace(/\.sql$/, ''),
        content,
        checksum: sha256(content),
        isMajor: /--\s*(migration-type:\s*major|major\b)/i.test(content)
          || /\b(DROP\s+(TABLE|COLUMN|CONSTRAINT)|TRUNCATE|DELETE\s+FROM)\b/i.test(content),
      };
    });
}

/** Tablas que una migración destructiva podría afectar (para el dump previo). */
function affectedTables(sql) {
  const t = new Set();
  for (const re of [/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/gi, /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/gi, /TRUNCATE\s+(?:TABLE\s+)?"?(\w+)"?/gi, /DELETE\s+FROM\s+"?(\w+)"?/gi]) {
    let m; while ((m = re.exec(sql))) t.add(m[1]);
  }
  return [...t];
}

async function dumpTables(client, tables) {
  if (!tables.length) return null;
  const dir = join(ROOT, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  for (const t of tables) {
    try {
      const rows = (await client.query(`SELECT * FROM ${t}`)).rows;
      writeFileSync(join(dir, `${t}.json`), JSON.stringify(rows, null, 2));
      ok(`dump ${t}: ${rows.length} fila(s) → ${join(dir, t)}.json`);
    } catch (e) { warn(`no pude respaldar ${t}: ${e.message}`); }
  }
  return dir;
}

async function applyMigration(client, mig) {
  const wrapped = /^\s*BEGIN\s*;/i.test(mig.content);
  if (!wrapped) await client.query('BEGIN');
  try {
    await client.query(mig.content);
    // ¿La migración registró su propia fila?
    const has = Number((await client.query('SELECT count(*) FROM schema_migrations WHERE id = $1', [mig.id])).rows[0].count) > 0;
    if (has) {
      await client.query(
        'UPDATE schema_migrations SET checksum = $1, applied_at = now(), template_version_when_applied = $2 WHERE id = $3',
        [mig.checksum, TEMPLATE_VERSION, mig.id],
      );
    } else {
      await client.query(
        'INSERT INTO schema_migrations (id, template_version_when_applied, checksum) VALUES ($1, $2, $3)',
        [mig.id, TEMPLATE_VERSION, mig.checksum],
      );
    }
    if (!wrapped) await client.query('COMMIT');
  } catch (e) {
    if (!wrapped) await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

async function main() {
  banner(`update.js — sincronización de migraciones (template ${TEMPLATE_VERSION})`);
  const env = loadEnv({ required: [] });
  const dbUrl = args.db || env.DATABASE_URL;
  if (!dbUrl) { fail('falta DATABASE_URL (o --db=<url>)'); process.exit(2); }

  const client = await pgConnect(dbUrl);
  try {
    if (!(await tableExists(client, 'schema_migrations'))) {
      fail('esta base no tiene la tabla schema_migrations: no está manejada por el template.');
      fail('corré setup.js primero, o aplicá la migración inicial a mano.');
      process.exit(2);
    }

    const applied = new Map(
      (await client.query('SELECT id, applied_at, checksum, template_version_when_applied FROM schema_migrations')).rows
        .map(r => [r.id, r]),
    );
    const files = readMigrationFiles();
    const fileIds = new Set(files.map(f => f.id));

    const faltantes = files.filter(f => !applied.has(f.id));
    const distintas = files.filter(f => {
      const a = applied.get(f.id);
      if (!a) return false;
      if (!a.checksum || a.checksum === PLACEHOLDER_CHECKSUM) return false; // legacy, no verificable
      return a.checksum !== f.checksum;
    });
    const ajenas = [...applied.keys()].filter(id => !fileIds.has(id));

    // --- Reporte ---
    banner('estado');
    for (const f of files) {
      const a = applied.get(f.id);
      if (!a) console.log(`  ${c.yellow}faltante${c.reset}          ${f.id}${f.isMajor ? c.red + '  [major]' + c.reset : ''}`);
      else if (distintas.includes(f)) console.log(`  ${c.red}checksum distinto${c.reset} ${f.id}`);
      else console.log(`  ${c.green}ok${c.reset}                ${f.id}`);
    }
    for (const id of ajenas) console.log(`  ${c.red}ajena${c.reset}             ${id}  (aplicada, no existe en el template)`);

    // --- Bloqueos ---
    if (distintas.length && !args.forceChecksum) {
      console.log('');
      fail(`${distintas.length} migración(es) aplicada(s) con contenido distinto al del template.`);
      fail('Alguien la alteró a mano, o el archivo del template cambió después de publicarse.');
      fail('No procedo solo. Revisá con --check, y si estás seguro, --force-checksum.');
      process.exit(1);
    }
    if (ajenas.length) {
      console.log('');
      fail(`${ajenas.length} migración(es) aplicada(s) que no están en el template: ${ajenas.join(', ')}`);
      fail('Puede haber cambios hechos por fuera. Freno y pido instrucciones.');
      process.exit(1);
    }

    if (!faltantes.length) {
      console.log('');
      ok('la base está al día con el template. Nada que aplicar.');
      const p = loadProjectJson();
      if (p.template_version !== TEMPLATE_VERSION && !args.check) { p.template_version = TEMPLATE_VERSION; saveProjectJson(p); ok(`template_version → ${TEMPLATE_VERSION}`); }
      process.exit(0);
    }

    if (args.check) {
      console.log('');
      ok(`--check: ${faltantes.length} migración(es) para aplicar (${faltantes.map(f => f.id).join(', ')}). No apliqué nada.`);
      process.exit(0);
    }

    // --- Aplicar faltantes en orden ---
    banner('aplicar');
    for (const mig of faltantes) {
      if (mig.isMajor) {
        warn(`${mig.id} es una migración MAJOR (rompe compatibilidad o transforma datos).`);
        const tablas = affectedTables(mig.content);
        if (tablas.length) { step(`respaldo previo de: ${tablas.join(', ')}`); await dumpTables(client, tablas); }
        const go = await confirm(`Escribí "major" para aplicar ${mig.id}:`, { expect: 'major', assumeYes: false });
        if (!go) { fail('cancelada. Freno acá; las anteriores ya quedaron aplicadas.'); process.exit(1); }
      } else {
        const go = await confirm(`Aplicar ${mig.id}? (s/N)`, { assumeYes: args.yes });
        if (!go) { warn('cancelada por el usuario. Freno acá.'); process.exit(1); }
      }
      step(`aplicando ${mig.id}`);
      await applyMigration(client, mig);
      ok(`${mig.id} aplicada y registrada`);
    }

    // --- Éxito: recién ahora se toca project.json ---
    const p = loadProjectJson();
    p.template_version = TEMPLATE_VERSION;
    saveProjectJson(p);
    console.log('');
    ok(`listo: ${faltantes.length} migración(es) aplicada(s). template_version → ${TEMPLATE_VERSION}`);
    process.exit(0);
  } catch (e) {
    console.log('');
    fail(`falló: ${e.message}`);
    fail('Las migraciones aplicadas antes del error quedaron. Corregí y volvé a correr.');
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch(e => { fail(`error inesperado: ${e.stack || e.message}`); process.exit(2); });
