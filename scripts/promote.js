#!/usr/bin/env node
/**
 * promote.js — Pasa una instalación de demo a producción.
 *
 * Paso explícito y con confirmación. Copia esquema y configuración; NO copia
 * turnos ni clientes ficticios. Apunta el entorno al número real y al proyecto
 * de Supabase de producción. Sube los flujos a Hetzner. Corre la batería de
 * tests y aborta si falla.
 *
 * Modos (project.json → deployment_mode):
 *   single (default)  sin staging. Se aplica sobre producción con rollback disponible.
 *   staging           segundo set con sufijo "-staging" (segundo proyecto de Supabase).
 *
 * Requiere un archivo `.env.production` (o `.env.staging`) con los valores de
 * producción. Si no existe, promote.js genera un borrador y frena.
 *
 * Uso:
 *   node promote.js                 promueve en modo single
 *   node promote.js --yes           no pregunta los pasos secundarios (el gate de
 *                                   producción se pide SIEMPRE)
 *   node promote.js --skip-tests    no corre test-unit (desaconsejado)
 *   node promote.js --no-deploy     no toca Hetzner (solo base + flujos por API)
 *
 * Exit: 0 promovido · 1 abortado / falló un paso · 2 configuración
 */

import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, SCRIPTS_DIR, c, banner, step, ok, warn, fail,
  parseEnvFile, loadEnv, loadProjectJson, saveProjectJson,
  pgConnect, tableExists, n8nClient, sha256, confirm, run, TEMPLATE_VERSION,
} from './lib/infra.js';
import { credentialPayloads, buildFlow, FLOW_ORDER } from './lib/n8n-deploy.js';

const args = { yes: false, skipTests: false, noDeploy: false };
for (const x of process.argv.slice(2)) {
  if (x === '--yes' || x === '-y') args.yes = true;
  else if (x === '--skip-tests') args.skipTests = true;
  else if (x === '--no-deploy') args.noDeploy = true;
  else if (x === '--help' || x === '-h') { console.log('Ver cabecera del archivo.'); process.exit(0); }
  else { console.error(`Argumento desconocido: ${x}`); process.exit(2); }
}

const CONFIG_TABLES = ['business', 'services', 'professionals', 'professional_services', 'schedule', 'schedule_exceptions'];
const NEVER_COPY = ['appointments', 'appointment_services', 'clients', 'waitlist', 'conversations', 'messages', 'processed_messages', 'reminders_sent', 'runs'];

function prodEnvPath(mode) {
  return join(ROOT, mode === 'staging' ? '.env.staging' : '.env.production');
}

/** Escribe un borrador del .env de producción a partir del .env de demo. */
function scaffoldProdEnv(path, demoEnv, mode) {
  const overrides = {
    DATABASE_URL: '', SUPABASE_URL: '', SUPABASE_PROJECT_REF: '',
    MODEL_PROVIDER: 'claude', MODEL_NAME: 'claude-sonnet-5', ANTHROPIC_API_KEY: '',
    WA_API_BASE: 'https://graph.facebook.com',
    WA_PHONE_NUMBER_ID: '', WA_WABA_ID: '', WA_TOKEN: '', WA_VERIFY_TOKEN: '',
    WEBHOOK_URL: '', WEBHOOK_PATH: mode === 'staging' ? 'wa-turnos-staging' : 'wa-turnos',
    N8N_BASE_URL: '', N8N_API_KEY: '', N8N_ENCRYPTION_KEY: '',
    HETZNER_SSH: '', HETZNER_PATH: '/opt/agente-turnos',
  };
  const merged = { ...demoEnv, ...overrides };
  const lines = [
    `# .env de ${mode === 'staging' ? 'staging' : 'producción'} — generado por promote.js. Completá los vacíos.`,
    `# Detalle en walkthroughs/06-hetzner.md`,
    '',
    ...Object.entries(merged).map(([k, v]) => `${k}=${v}`),
  ];
  writeFileSync(path, lines.join('\n') + '\n');
}

async function applyProdSchema(client) {
  const hasMig = await tableExists(client, 'schema_migrations');
  const count = hasMig ? Number((await client.query('SELECT count(*) FROM schema_migrations')).rows[0].count) : 0;
  const dir = join(ROOT, 'database', 'migrations');
  const files = existsSync(dir)
    ? readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
    : [];
  if (count === 0) {
    for (const f of files) {
      const sql = readFileSync(join(dir, f), 'utf-8');
      step(`aplicando ${f}`);
      await client.query(sql);
      const id = f.replace(/\.sql$/, '');
      const has = Number((await client.query('SELECT count(*) FROM schema_migrations WHERE id=$1', [id])).rows[0].count) > 0;
      if (has) await client.query('UPDATE schema_migrations SET checksum=$1, applied_at=now() WHERE id=$2', [sha256(sql), id]);
      else await client.query('INSERT INTO schema_migrations (id, template_version_when_applied, checksum) VALUES ($1,$2,$3)', [id, TEMPLATE_VERSION, sha256(sql)]);
    }
    ok(`esquema de producción aplicado (${files.length} migración/es)`);
  } else {
    ok(`producción ya tiene esquema (${count} migración/es) — usá update.js para deltas`);
  }
}

async function copyConfigData(demo, prod) {
  const okTrunc = await confirm(
    `${c.yellow}Voy a TRUNCAR la configuración de la base de producción (${CONFIG_TABLES.join(', ')}) y copiar la de demo. ¿Seguir? (s/N)${c.reset}`,
    { assumeYes: args.yes });
  if (!okTrunc) throw new Error('cancelado en la copia de configuración');

  await prod.query('BEGIN');
  try {
    await prod.query(`TRUNCATE ${CONFIG_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    for (const t of CONFIG_TABLES) {
      const rows = (await demo.query(`SELECT * FROM ${t}`)).rows;
      for (const row of rows) {
        const cols = Object.keys(row);
        const vals = cols.map((_, i) => `$${i + 1}`);
        await prod.query(
          `INSERT INTO ${t} (${cols.map(x => `"${x}"`).join(',')}) VALUES (${vals.join(',')})`,
          cols.map(x => row[x]),
        );
      }
      ok(`${t}: ${rows.length} fila(s) copiadas`);
    }
    await prod.query('COMMIT');
  } catch (e) {
    await prod.query('ROLLBACK').catch(() => {});
    throw e;
  }
  warn(`no se copió nada de: ${NEVER_COPY.join(', ')} (datos operativos / ficticios)`);
}

async function deployToHetzner(prodEnvFile, prodEnv) {
  if (args.noDeploy) { warn('--no-deploy: no toco Hetzner'); return; }
  if (!prodEnv.HETZNER_SSH) { warn('HETZNER_SSH vacío: salteo el deploy al servidor (importo flujos por API igual)'); return; }
  const host = prodEnv.HETZNER_SSH;
  const path = prodEnv.HETZNER_PATH || '/opt/agente-turnos';

  step(`sincronizando repo con ${host}:${path}`);
  const rsync = run('rsync', ['-az', '--delete', '--exclude', '.git', '--exclude', 'node_modules', '--exclude', '.env*', `${ROOT}/`, `${host}:${path}/`]);
  if (rsync.status !== 0) throw new Error(`rsync falló: ${rsync.stderr.slice(0, 300)}`);

  step('copiando .env de producción');
  const scp = run('scp', [prodEnvFile, `${host}:${path}/.env`]);
  if (scp.status !== 0) throw new Error(`scp falló: ${scp.stderr.slice(0, 300)}`);

  step('levantando el stack en el servidor');
  const up = run('ssh', [host, `cd ${path} && docker compose --profile tunnel up -d`]);
  if (up.status !== 0) throw new Error(`docker compose remoto falló: ${up.stderr.slice(0, 300)}`);
  ok('stack de producción levantado en Hetzner');
}

async function deployFlows(prodEnv, mode) {
  const suffix = mode === 'staging' ? ' -staging' : '';
  const baseUrl = prodEnv.N8N_BASE_URL || prodEnv.WEBHOOK_URL;
  if (!baseUrl || !prodEnv.N8N_API_KEY) throw new Error('falta N8N_BASE_URL / N8N_API_KEY de producción');
  const api = n8nClient({ baseUrl, apiKey: prodEnv.N8N_API_KEY });

  const credNames = {
    postgres: `turnos · Supabase${suffix}`, redis: `turnos · Redis${suffix}`,
    whatsapp: `turnos · WhatsApp${suffix}`, model: `turnos · Modelo${suffix}`,
  };
  const creds = {};
  for (const cred of credentialPayloads(prodEnv, credNames)) {
    const r = await api.createCredential({ name: cred.name, type: cred.type, data: cred.data });
    creds[cred.key] = { id: r.id, name: cred.name };
    ok(`credencial ${cred.name} → ${r.id}`);
  }

  const ctx = {
    identity: readFileSync(join(ROOT, 'agent', 'identity.md'), 'utf-8'),
    rules: readFileSync(join(ROOT, 'agent', 'rules.md'), 'utf-8'),
    tools: JSON.parse(readFileSync(join(ROOT, 'agent', 'tools.json'), 'utf-8')).tools,
    creds, flowIds: {}, nameSuffix: suffix,
  };

  let existing = [];
  try { existing = (await api.listWorkflows())?.data || []; } catch { /* sin list */ }

  for (const name of FLOW_ORDER) {
    const built = buildFlow(name, prodEnv, ctx);
    let id = existing.find(w => w.name === built.name)?.id;
    if (id) { await api.updateWorkflow(id, built); ok(`${built.name} actualizado`); }
    else { id = (await api.createWorkflow(built)).id; ok(`${built.name} creado (${id})`); }
    ctx.flowIds[name] = id;
    await api.activateWorkflow(id).catch(e => warn(`no pude activar ${name}: ${e.message}`));
  }
  return ctx.flowIds;
}

async function connectionTest(prod, prodEnv) {
  const api = n8nClient({ baseUrl: prodEnv.N8N_BASE_URL || prodEnv.WEBHOOK_URL, apiKey: prodEnv.N8N_API_KEY });
  (await api.health().catch(() => false)) ? ok('n8n de producción responde') : warn('n8n de producción no responde');
  const n = Number((await prod.query('SELECT count(*) FROM services WHERE active')).rows[0].count);
  n > 0 ? ok(`base de producción con ${n} servicio(s)`) : warn('producción sin servicios activos');
  if (prodEnv.WEBHOOK_URL && prodEnv.WEBHOOK_PATH && prodEnv.WA_VERIFY_TOKEN) {
    const ch = `PING${Date.now()}`;
    const url = `${prodEnv.WEBHOOK_URL.replace(/\/$/, '')}/webhook/${prodEnv.WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(prodEnv.WA_VERIFY_TOKEN)}&hub.challenge=${ch}`;
    try {
      const body = (await (await fetch(url)).text()).trim();
      body === ch ? ok('webhook de producción verifica') : warn(`webhook respondió "${body.slice(0, 60)}"`);
    } catch (e) { warn(`webhook no probado: ${e.message}`); }
  }
}

async function main() {
  banner(`promote.js — demo → producción (template ${TEMPLATE_VERSION})`);
  const demoEnv = loadEnv({ required: ['DATABASE_URL'] });
  const project = loadProjectJson();
  const mode = project.deployment_mode === 'staging' ? 'staging' : 'single';
  const marca = project.brand.name || project.brand.business_name || 'este proyecto';
  console.log(`  modo: ${mode}\n`);

  // --- Gate de producción: SIEMPRE se pregunta ---
  const go = await confirm(
    `${c.bold}¿pasás ${marca} a producción? esto va a mandar mensajes reales${c.reset}  (escribí "si")`,
    { expect: 'si' });
  if (!go) { warn('cancelado. No se tocó nada.'); process.exit(1); }

  // --- Preflight: test-unit completo ---
  if (!args.skipTests) {
    banner('test-unit');
    const t = run(process.execPath, [join(SCRIPTS_DIR, 'test-unit.js')], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (t.status !== 0) { fail('test-unit falló. Aborto la promoción.'); process.exit(1); }
    ok('test-unit en verde');
  } else {
    warn('--skip-tests: no corrí test-unit');
  }

  // --- Config de producción ---
  banner('config de producción');
  const prodEnvFile = prodEnvPath(mode === 'single' ? 'production' : 'staging');
  if (!existsSync(prodEnvFile)) {
    scaffoldProdEnv(prodEnvFile, demoEnv, mode === 'single' ? 'production' : 'staging');
    fail(`generé un borrador en ${prodEnvFile}. Completalo (walkthroughs/06-hetzner.md) y volvé a correr.`);
    process.exit(1);
  }
  const prodEnv = { ...parseEnvFile(prodEnvFile) };
  prodEnv.MODEL_PROVIDER = 'claude';
  prodEnv.WA_API_BASE = 'https://graph.facebook.com';
  const faltan = ['DATABASE_URL', 'WEBHOOK_URL', 'N8N_API_KEY', 'WA_PHONE_NUMBER_ID', 'WA_TOKEN', 'ANTHROPIC_API_KEY']
    .filter(k => !prodEnv[k]);
  if (faltan.length) { fail(`faltan en ${prodEnvFile}: ${faltan.join(', ')}`); process.exit(2); }
  ok(`${prodEnvFile} completo`);

  const demo = await pgConnect(demoEnv.DATABASE_URL);
  const prod = await pgConnect(prodEnv.DATABASE_URL);
  try {
    banner('esquema de producción');
    await applyProdSchema(prod);

    banner('copiar configuración (sin datos ficticios)');
    await copyConfigData(demo, prod);

    banner('deploy a Hetzner');
    await deployToHetzner(prodEnvFile, prodEnv);

    banner('flujos de n8n en producción');
    const ids = await deployFlows(prodEnv, mode);

    banner('prueba de conexión');
    await connectionTest(prod, prodEnv);

    // --- Marcar el estado ---
    const p = loadProjectJson();
    if (mode === 'single') p.environment = 'production';
    p.n8n.workflow_ids = { ...p.n8n.workflow_ids, ...Object.fromEntries(Object.entries(ids).map(([k, v]) => [k.replace('flow-', ''), v])) };
    saveProjectJson(p);

    console.log('');
    ok(`${marca} ${mode === 'single' ? 'promovido a producción' : 'desplegado en staging'}.`);
    warn('acordate de commitear config/project.json y de actualizar el Callback URL en Meta si cambió el hostname.');
    process.exit(0);
  } catch (e) {
    console.log('');
    fail(`falló: ${e.message}`);
    fail('La demo no se tocó. En producción puede haber quedado esquema/config aplicados y flujos a medio importar:');
    fail('  · revisá los workflows en el n8n de producción y borrá los que quedaron sueltos');
    fail('  · si hace falta, bajá el stack de prod y restaurá el .env anterior');
    process.exit(1);
  } finally {
    await demo.end(); await prod.end();
  }
}

main().catch(e => { fail(`error inesperado: ${e.stack || e.message}`); process.exit(2); });
