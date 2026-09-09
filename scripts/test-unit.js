#!/usr/bin/env node
/**
 * test-unit.js — Runner de tests unitarios determinísticos.
 *
 * Levanta un Postgres efímero (Docker por defecto, local como fallback),
 * aplica el schema y los helpers, corre cada test de tests/unit/, reporta y
 * baja el ambiente. Dos tipos de test conviven en el mismo runner:
 *   - *.test.sql  — corre en su propia transacción contra la base efímera.
 *   - *.test.mjs  — módulo ES que exporta `default` (función, puede ser async).
 *                   Falla si lanza. No usa la base: valida lógica de JS pura
 *                   (p. ej. validación de parámetros de tools, dedup, etc).
 *
 * Uso:
 *   node test-unit.js                    # Docker (recomendado)
 *   node test-unit.js --backend=local    # Postgres local
 *   node test-unit.js --verbose          # ver SQL de cada test
 *   node test-unit.js --filter=book      # correr solo tests que matcheen
 *   node test-unit.js --keep             # no bajar el ambiente al terminar
 *
 * Exit codes:
 *   0 — todos los tests pasaron
 *   1 — al menos un test falló
 *   2 — error de infraestructura (Docker no disponible, schema roto, etc)
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import pg from 'pg';

const { Client } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SCHEMA_PATH  = join(ROOT, 'database', 'schema.sql');
const HELPERS_PATH = join(ROOT, 'tests', 'helpers.sql');
const TESTS_DIR    = join(ROOT, 'tests', 'unit');

// ---- Colores para el reporte ---------------------------------------------
const isTTY = process.stdout.isTTY;
const c = {
  reset: isTTY ? '\x1b[0m'  : '',
  bold:  isTTY ? '\x1b[1m'  : '',
  dim:   isTTY ? '\x1b[2m'  : '',
  green: isTTY ? '\x1b[32m' : '',
  red:   isTTY ? '\x1b[31m' : '',
  yellow:isTTY ? '\x1b[33m' : '',
  cyan:  isTTY ? '\x1b[36m' : '',
};

// ---- Parseo de argumentos ------------------------------------------------
const args = {
  backend: 'auto',
  verbose: false,
  filter:  null,
  keep:    false,
};
for (const a of process.argv.slice(2)) {
  if (a === '--verbose')            args.verbose = true;
  else if (a === '--keep')          args.keep = true;
  else if (a.startsWith('--backend=')) args.backend = a.split('=')[1];
  else if (a.startsWith('--filter='))  args.filter  = a.split('=')[1];
  else if (a === '--help' || a === '-h') {
    printHelp();
    process.exit(0);
  } else {
    console.error(`${c.red}Argumento desconocido:${c.reset} ${a}`);
    process.exit(2);
  }
}

function printHelp() {
  console.log(`
${c.bold}test-unit.js${c.reset} — runner de tests unitarios

  --backend=auto|docker|local   dónde levantar Postgres (auto por defecto)
  --filter=<substring>          correr solo tests cuyo nombre contenga eso
  --verbose                     mostrar SQL de cada test que falle
  --keep                        no bajar el ambiente al terminar (para debugging)
  --help                        esta ayuda
`);
}

// ---- Detección de backend ------------------------------------------------
function hasDocker() {
  try {
    execSync('docker version', { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function hasLocalPostgres() {
  try {
    // Intentar via psql como cliente, con el usuario del sistema
    execSync('psql --version', { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// ---- Provisioning --------------------------------------------------------
async function provisionDocker() {
  const containerName = `pg-turnos-test-${process.pid}`;
  const port = 55432 + (process.pid % 10000);
  const password = 'test';
  const dbName = 'turnos_test';

  console.log(`${c.cyan}▸ Levantando Postgres en Docker (puerto ${port})...${c.reset}`);

  execSync(
    `docker run --rm -d --name ${containerName} ` +
    `-p ${port}:5432 -e POSTGRES_PASSWORD=${password} -e POSTGRES_DB=${dbName} ` +
    `postgres:16-alpine`,
    { stdio: 'ignore' }
  );

  const connectionString = `postgres://postgres:${password}@localhost:${port}/${dbName}`;
  await waitForPg(connectionString, 30000);

  const cleanup = () => {
    if (args.keep) {
      console.log(`${c.yellow}▸ Ambiente preservado (--keep): ${containerName}${c.reset}`);
      console.log(`  Conectate con: psql "${connectionString}"`);
      console.log(`  Para bajarlo:  docker stop ${containerName}`);
      return;
    }
    try { execSync(`docker stop ${containerName}`, { stdio: 'ignore' }); } catch {}
  };

  return { connectionString, cleanup, kind: 'docker' };
}

async function provisionLocal() {
  const dbName = `turnos_test_${process.pid}_${Date.now()}`;
  console.log(`${c.cyan}▸ Creando base local: ${dbName}${c.reset}`);

  const runAsPostgres = process.getuid && process.getuid() === 0;
  const psqlCreate = runAsPostgres
    ? `su - postgres -c 'psql -c "CREATE DATABASE ${dbName};"'`
    : `createdb ${dbName}`;

  try {
    execSync(psqlCreate, { stdio: 'pipe' });
  } catch (e) {
    throw new Error(`No se pudo crear la base local: ${e.stderr?.toString() || e.message}`);
  }

  const connectionString = runAsPostgres
    ? `postgres:///${dbName}?host=/var/run/postgresql&user=postgres`
    : `postgres:///${dbName}`;

  const cleanup = () => {
    if (args.keep) {
      console.log(`${c.yellow}▸ Base preservada (--keep): ${dbName}${c.reset}`);
      return;
    }
    const dropCmd = runAsPostgres
      ? `su - postgres -c 'psql -c "DROP DATABASE ${dbName};"'`
      : `dropdb ${dbName}`;
    try { execSync(dropCmd, { stdio: 'ignore' }); } catch {}
  };

  return { connectionString, cleanup, kind: 'local' };
}

async function waitForPg(connectionString, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    const client = new Client({ connectionString });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (e) {
      lastErr = e;
      await client.end().catch(() => {});
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error(`Postgres no respondió en ${timeoutMs}ms: ${lastErr?.message}`);
}

// ---- Aplicar schema y helpers --------------------------------------------
async function bootstrap(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    console.log(`${c.dim}▸ Aplicando schema.sql${c.reset}`);
    await client.query(readFileSync(SCHEMA_PATH, 'utf-8'));
    console.log(`${c.dim}▸ Aplicando helpers.sql${c.reset}`);
    await client.query(readFileSync(HELPERS_PATH, 'utf-8'));
  } finally {
    await client.end();
  }
}

// ---- Correr un test ------------------------------------------------------
async function runOneTest(connectionString, filePath) {
  return filePath.endsWith('.test.mjs')
    ? runJsTest(filePath)
    : runSqlTest(connectionString, filePath);
}

async function runSqlTest(connectionString, filePath) {
  const sql = readFileSync(filePath, 'utf-8');
  const client = new Client({ connectionString });
  const started = Date.now();
  try {
    await client.connect();
    await client.query(sql);
    return { status: 'pass', durationMs: Date.now() - started };
  } catch (err) {
    return {
      status: 'fail',
      durationMs: Date.now() - started,
      error: err.message,
      hint: err.hint,
      where: err.where,
      sqlForDebug: args.verbose ? sql : null,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

async function runJsTest(filePath) {
  const started = Date.now();
  try {
    const mod = await import(pathToFileURL(filePath).href);
    if (typeof mod.default !== 'function') {
      throw new Error(`el módulo no exporta una función por default`);
    }
    await mod.default();
    return { status: 'pass', durationMs: Date.now() - started };
  } catch (err) {
    return {
      status: 'fail',
      durationMs: Date.now() - started,
      error: err.message,
      where: args.verbose ? err.stack : null,
    };
  }
}

// ---- Descubrir tests -----------------------------------------------------
function discoverTests() {
  if (!existsSync(TESTS_DIR)) {
    return [];
  }
  return readdirSync(TESTS_DIR)
    .filter(f => f.endsWith('.test.sql') || f.endsWith('.test.mjs'))
    .filter(f => !args.filter || f.includes(args.filter))
    .sort()
    .map(f => join(TESTS_DIR, f));
}

// ---- Reporte -------------------------------------------------------------
function fmtDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function reportResult(name, result) {
  if (result.status === 'pass') {
    console.log(`  ${c.green}✓${c.reset} ${name} ${c.dim}(${fmtDuration(result.durationMs)})${c.reset}`);
  } else {
    console.log(`  ${c.red}✗${c.reset} ${name} ${c.dim}(${fmtDuration(result.durationMs)})${c.reset}`);
    console.log(`    ${c.red}${result.error}${c.reset}`);
    if (result.where) {
      const firstLine = result.where.split('\n')[0];
      console.log(`    ${c.dim}${firstLine}${c.reset}`);
    }
  }
}

// ---- Main ----------------------------------------------------------------
async function main() {
  // Elegir backend
  let backend = args.backend;
  if (backend === 'auto') {
    if (hasDocker()) backend = 'docker';
    else if (hasLocalPostgres()) backend = 'local';
    else {
      console.error(`${c.red}Error:${c.reset} necesitás Docker o Postgres local instalado.`);
      process.exit(2);
    }
  }
  console.log(`${c.bold}Backend:${c.reset} ${backend}\n`);

  // Provisioning
  let env;
  try {
    env = backend === 'docker' ? await provisionDocker() : await provisionLocal();
  } catch (e) {
    console.error(`${c.red}Error de provisioning:${c.reset} ${e.message}`);
    process.exit(2);
  }

  // Registrar cleanup para cualquier salida
  const registerCleanup = () => {
    const doCleanup = () => { try { env.cleanup(); } catch {} };
    process.on('exit', doCleanup);
    process.on('SIGINT',  () => { doCleanup(); process.exit(130); });
    process.on('SIGTERM', () => { doCleanup(); process.exit(143); });
  };
  registerCleanup();

  // Bootstrap
  try {
    await bootstrap(env.connectionString);
  } catch (e) {
    console.error(`${c.red}Error aplicando schema o helpers:${c.reset}`);
    console.error(e.message);
    process.exit(2);
  }

  // Descubrir y correr
  const tests = discoverTests();
  if (tests.length === 0) {
    console.log(`${c.yellow}No hay tests para correr.${c.reset}`);
    if (args.filter) console.log(`(Filtro: "${args.filter}")`);
    process.exit(0);
  }

  console.log(`\n${c.bold}Corriendo ${tests.length} test${tests.length === 1 ? '' : 's'}${c.reset}`);
  const results = [];
  const totalStart = Date.now();

  for (const testPath of tests) {
    const name = testPath.split('/').pop().replace(/\.test\.(sql|mjs)$/, '');
    const result = await runOneTest(env.connectionString, testPath);
    results.push({ name, ...result });
    reportResult(name, result);
  }

  const totalMs = Date.now() - totalStart;
  const passed = results.filter(r => r.status === 'pass').length;
  const failed = results.filter(r => r.status === 'fail').length;

  console.log(`\n${c.bold}Resumen:${c.reset}`);
  console.log(`  ${c.green}✓ ${passed} pasaron${c.reset}`);
  if (failed > 0) console.log(`  ${c.red}✗ ${failed} fallaron${c.reset}`);
  console.log(`  ${c.dim}total ${fmtDuration(totalMs)}${c.reset}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`${c.red}Error inesperado:${c.reset}`, err);
  process.exit(2);
});
