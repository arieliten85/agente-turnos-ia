#!/usr/bin/env node
/**
 * setup.js — Arma una instalación del agente de turnos, de punta a punta.
 *
 * Idempotente y re-ejecutable: guarda el avance en `.setup-state.json` y retoma
 * donde se cortó. Cada paso valida antes de hacer nada.
 *
 * Pasos:
 *   prereqs         Docker, Node, variables del .env
 *   db_reachable    conecta a DATABASE_URL
 *   schema          aplica la migración inicial si la base está vacía
 *   seed            carga negocio / servicios / profesionales / horarios de project.json
 *   project_json    completa config/project.json con lo derivable del .env
 *   n8n_credentials crea las 4 credenciales de n8n (Supabase, Redis, WhatsApp, Modelo)
 *   n8n_flows       reemplaza marcadores e importa los 5 flujos por la API REST
 *   n8n_activate    activa los 5 flujos
 *   templates       dicta las 4 plantillas de WhatsApp para cargar en Meta
 *   connection_test n8n healthz + consulta a la base + verificación del webhook
 *
 * Uso:
 *   node setup.js                 corre lo que falte
 *   node setup.js --clean         borra el estado y rehace todo
 *   node setup.js --only=n8n_flows
 *   node setup.js --from=seed
 *   node setup.js --dry-run       valida y muestra, sin escribir nada
 *   node setup.js --yes           no pregunta (para CI)
 *
 * Exit: 0 ok · 1 un paso falló · 2 error de configuración
 */

import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, c, banner, step, ok, warn, fail,
  loadEnv, loadProjectJson, saveProjectJson,
  pgConnect, tableExists, n8nClient, applyMarkers, sha256,
  loadState, saveState, stepDone, markStep, confirm, run, TEMPLATE_VERSION,
} from './lib/infra.js';
import { credentialPayloads, buildFlow, FLOW_ORDER } from './lib/n8n-deploy.js';

const STEPS = [
  'prereqs', 'db_reachable', 'schema', 'seed', 'project_json',
  'n8n_credentials', 'n8n_flows', 'n8n_activate', 'templates', 'connection_test',
];

const args = parseArgs(process.argv.slice(2));
const STATE_PATH = args.state || join(ROOT, '.setup-state.json');

function parseArgs(argv) {
  const a = { clean: false, yes: false, dryRun: false, only: null, from: null, state: null, n8nUrl: null };
  for (const x of argv) {
    if (x === '--clean') a.clean = true;
    else if (x === '--yes' || x === '-y') a.yes = true;
    else if (x === '--dry-run') a.dryRun = true;
    else if (x.startsWith('--only=')) a.only = x.slice(7);
    else if (x.startsWith('--from=')) a.from = x.slice(7);
    else if (x.startsWith('--state=')) a.state = x.slice(8);
    else if (x.startsWith('--n8n-url=')) a.n8nUrl = x.slice(10);
    else if (x === '--help' || x === '-h') { printHelp(); process.exit(0); }
    else { console.error(`Argumento desconocido: ${x}`); process.exit(2); }
  }
  return a;
}
function printHelp() {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(2, 27).map(l => l.replace(/^ \*?/, '')).join('\n'));
}

function pending(name, state) {
  if (args.only) return name === args.only;
  if (args.from && STEPS.indexOf(name) < STEPS.indexOf(args.from)) return false;
  return args.clean || !stepDone(state, name);
}

// ---- Pasos --------------------------------------------------------------

async function stepPrereqs(env) {
  const dv = run('docker', ['--version']);
  if (dv.status !== 0) throw new Error('Docker no está disponible. Instalalo antes de seguir.');
  ok(`docker: ${dv.stdout.trim()}`);
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) throw new Error(`Node ${process.versions.node}: hace falta 18 o más.`);
  ok(`node: ${process.versions.node}`);

  const req = ['DATABASE_URL', 'N8N_API_KEY', 'WEBHOOK_PATH', 'WA_VERIFY_TOKEN'];
  const missing = req.filter(k => !env[k]);
  if (missing.length) throw new Error(`Faltan en .env: ${missing.join(', ')}`);
  const provider = (env.MODEL_PROVIDER || 'gemini').toLowerCase();
  const key = provider === 'claude' ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY';
  if (!env[key]) throw new Error(`MODEL_PROVIDER=${provider} pero falta ${key} en .env`);
  if (!env.WA_TOKEN) warn('WA_TOKEN vacío: las credenciales de WhatsApp van a quedar incompletas.');
  if (!env.WEBHOOK_URL) warn('WEBHOOK_URL vacío: no se va a poder verificar el webhook en connection_test.');
  ok('variables mínimas presentes');
}

async function stepDbReachable(env) {
  const client = await pgConnect(env.DATABASE_URL);
  try {
    await client.query('SELECT 1');
    ok('conexión a la base OK');
  } finally { await client.end(); }
}

async function stepSchema(env) {
  const client = await pgConnect(env.DATABASE_URL);
  try {
    const hasMig = await tableExists(client, 'schema_migrations');
    const count = hasMig ? Number((await client.query('SELECT count(*) FROM schema_migrations')).rows[0].count) : 0;
    if (count > 0 && !args.clean) { ok(`esquema ya aplicado (${count} migración/es)`); return { migrations: count }; }
    if (count > 0 && args.clean) {
      warn('--clean no borra la base. Si querés rehacer el esquema, usá una base limpia.');
      return { migrations: count };
    }
    const migPath = join(ROOT, 'database', 'migrations', '20260909_0001_initial.sql');
    const sql = readFileSync(migPath, 'utf-8');
    if (args.dryRun) { warn('(dry-run) aplicaría la migración inicial'); return { migrations: 1 }; }
    step('aplicando 20260909_0001_initial');
    await client.query(sql);
    await client.query(
      "UPDATE schema_migrations SET checksum = $1, applied_at = now() WHERE id = '20260909_0001_initial'",
      [sha256(sql)],
    );
    ok('esquema aplicado y registrado en schema_migrations');
    return { migrations: 1 };
  } finally { await client.end(); }
}

const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

async function stepSeed(env) {
  const p = loadProjectJson();
  const client = await pgConnect(env.DATABASE_URL);
  try {
    const yaHay = Number((await client.query('SELECT count(*) FROM business')).rows[0].count) > 0;
    if (yaHay && !args.clean) { ok('seed ya cargado (hay negocio configurado)'); return; }
    if (args.dryRun) { warn('(dry-run) cargaría negocio, servicios, profesionales y horarios'); return; }

    if (yaHay && args.clean) {
      const okClean = await confirm(
        `${c.yellow}--clean va a TRUNCAR la configuración del negocio (y los turnos por cascada). ¿Seguir? (s/N)${c.reset}`,
        { assumeYes: args.yes });
      if (!okClean) throw new Error('cancelado por el usuario');
      await client.query('TRUNCATE business, services, professionals, professional_services, schedule, schedule_exceptions RESTART IDENTITY CASCADE');
    }

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO business (name, timezone, address, handoff_phone, cancellation_hours, reminder_hours, buffer_seconds, slot_granularity_min, opt_out_keywords, custom_tone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        p.brand.name || p.brand.business_name || 'Negocio',
        p.brand.timezone, p.brand.address || null, p.brand.handoff_phone || null,
        p.policy.cancellation_hours, p.policy.reminder_hours, p.policy.buffer_seconds,
        p.policy.slot_granularity_min, p.policy.opt_out_keywords, p.tone?.custom || null,
      ],
    );

    const svcId = {};
    for (const s of p.services.filter(x => x.name)) {
      const r = await client.query(
        'INSERT INTO services (name, duration_minutes, price) VALUES ($1,$2,$3) RETURNING id',
        [s.name, s.duration_minutes, s.price ?? null],
      );
      svcId[s.name] = r.rows[0].id;
    }

    for (const pro of p.professionals.filter(x => x.name)) {
      const r = await client.query('INSERT INTO professionals (name) VALUES ($1) RETURNING id', [pro.name]);
      const pid = r.rows[0].id;
      for (const sname of pro.services || []) {
        if (svcId[sname]) await client.query('INSERT INTO professional_services VALUES ($1,$2)', [pid, svcId[sname]]);
      }
      for (const [dname, franjas] of Object.entries(pro.schedule || {})) {
        if (!(dname in DOW)) continue;
        for (const [from, to] of (franjas || [])) {
          await client.query(
            'INSERT INTO schedule (professional_id, day_of_week, time_from, time_to) VALUES ($1,$2,$3,$4)',
            [pid, DOW[dname], from, to],
          );
        }
      }
    }
    await client.query('COMMIT');
    ok(`seed cargado: ${p.services.filter(x => x.name).length} servicios, ${p.professionals.filter(x => x.name).length} profesionales`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { await client.end(); }
}

async function stepProjectJson(env) {
  const p = loadProjectJson();
  p.template_version = p.template_version || TEMPLATE_VERSION;
  p.environment = p.environment || 'demo';
  p.created_at = p.created_at || new Date().toISOString();
  p.model.provider = (env.MODEL_PROVIDER || p.model.provider || 'gemini').toLowerCase();
  p.model.name = env.MODEL_NAME || p.model.name;
  p.redis.prefix = env.REDIS_PREFIX || p.redis.prefix || 'turnos';
  p.whatsapp.api_base = env.WA_API_BASE || p.whatsapp.api_base;
  p.whatsapp.graph_version = env.WA_GRAPH_VERSION || p.whatsapp.graph_version;
  p.whatsapp.phone_number_id = env.WA_PHONE_NUMBER_ID || p.whatsapp.phone_number_id;
  p.whatsapp.waba_id = env.WA_WABA_ID || p.whatsapp.waba_id;
  p.whatsapp.verify_token = env.WA_VERIFY_TOKEN || p.whatsapp.verify_token;
  p.whatsapp.webhook_path = env.WEBHOOK_PATH || p.whatsapp.webhook_path;
  p.whatsapp.template_lang = env.WA_TEMPLATE_LANG || p.whatsapp.template_lang;
  p.whatsapp.templates.reminder = env.WA_TEMPLATE_REMINDER || p.whatsapp.templates.reminder;
  p.whatsapp.templates.cancellation = env.WA_TEMPLATE_CANCELLATION || p.whatsapp.templates.cancellation;
  p.whatsapp.templates.waitlist = env.WA_TEMPLATE_WAITLIST || p.whatsapp.templates.waitlist;
  p.whatsapp.templates.reengagement = env.WA_TEMPLATE_REENGAGEMENT || p.whatsapp.templates.reengagement;
  p.supabase.project_ref = env.SUPABASE_PROJECT_REF || p.supabase.project_ref;
  p.supabase.url = env.SUPABASE_URL || p.supabase.url;
  p.n8n.base_url = args.n8nUrl || env.N8N_BASE_URL || p.n8n.base_url;
  p.tunnel.hostname = env.WEBHOOK_URL || p.tunnel.hostname;
  if (args.dryRun) { warn('(dry-run) no escribo project.json'); return; }
  saveProjectJson(p);
  ok('config/project.json actualizado');
}

async function stepN8nCredentials(env, state) {
  const p = loadProjectJson();
  const api = n8nClient({ baseUrl: p.n8n.base_url, apiKey: env.N8N_API_KEY });
  const prev = state.steps?.n8n_credentials?.data || {};
  const result = {};
  for (const cred of credentialPayloads(env, p.n8n.credential_names)) {
    if (prev[cred.key]?.id && !args.clean) { result[cred.key] = prev[cred.key]; ok(`credencial ${cred.name} (existente)`); continue; }
    if (prev[cred.key]?.id && args.clean) { await api.deleteCredential(prev[cred.key].id).catch(() => {}); }
    if (args.dryRun) { warn(`(dry-run) crearía credencial ${cred.name} (${cred.type})`); result[cred.key] = { id: 'dry', name: cred.name }; continue; }
    const r = await api.createCredential({ name: cred.name, type: cred.type, data: cred.data });
    result[cred.key] = { id: r.id, name: cred.name };
    ok(`credencial ${cred.name} → ${r.id}`);
  }
  return result;
}

async function stepN8nFlows(env, state) {
  const p = loadProjectJson();
  const api = n8nClient({ baseUrl: p.n8n.base_url, apiKey: env.N8N_API_KEY });
  const ctx = {
    identity: readFileSync(join(ROOT, 'agent', 'identity.md'), 'utf-8'),
    rules: readFileSync(join(ROOT, 'agent', 'rules.md'), 'utf-8'),
    tools: JSON.parse(readFileSync(join(ROOT, 'agent', 'tools.json'), 'utf-8')).tools,
    creds: state.steps?.n8n_credentials?.data || {},
    flowIds: { ...(state.steps?.n8n_flows?.data || {}) },
  };
  if (!args.dryRun && !Object.keys(ctx.creds).length) throw new Error('n8n_credentials tiene que correr antes que n8n_flows');

  let existing = [];
  try { existing = (await api.listWorkflows())?.data || []; } catch { /* la API puede no soportar list */ }

  for (const name of FLOW_ORDER) {
    const wfName = `turnos · ${name}`;
    const built = buildFlow(name, env, ctx);
    if (args.dryRun) {
      ok(`(dry-run) ${wfName}: ${built.nodes.length} nodos, marcadores resueltos`);
      ctx.flowIds[name] = ctx.flowIds[name] || `dry-${name}`;
      continue;
    }
    let id = ctx.flowIds[name] || existing.find(w => w.name === wfName)?.id;
    if (id && args.clean) { await api.deleteWorkflow(id).catch(() => {}); id = null; }
    if (id) {
      await api.updateWorkflow(id, built);
      ok(`${wfName} actualizado (${id})`);
    } else {
      const r = await api.createWorkflow(built);
      id = r.id;
      ok(`${wfName} creado (${id})`);
    }
    ctx.flowIds[name] = id;
  }

  const proj = loadProjectJson();
  proj.n8n.workflow_ids = {
    webhook: ctx.flowIds['flow-webhook'] || '', agent: ctx.flowIds['flow-agent'] || '',
    reminder: ctx.flowIds['flow-reminder'] || '', handoff: ctx.flowIds['flow-handoff'] || '',
    recovery: ctx.flowIds['flow-recovery'] || '', cleanup: ctx.flowIds['flow-cleanup'] || '',
  };
  if (!args.dryRun) { proj.setup.flows_imported = true; saveProjectJson(proj); }
  return ctx.flowIds;
}

async function stepN8nActivate(env, state) {
  const p = loadProjectJson();
  const api = n8nClient({ baseUrl: p.n8n.base_url, apiKey: env.N8N_API_KEY });
  const ids = state.steps?.n8n_flows?.data || {};
  for (const [name, id] of Object.entries(ids)) {
    if (!id || String(id).startsWith('dry')) { warn(`${name}: sin id, no se activa`); continue; }
    if (args.dryRun) { warn(`(dry-run) activaría ${name}`); continue; }
    await api.activateWorkflow(id).catch(e => warn(`${name}: ${e.message}`));
    ok(`${name} activo`);
  }
}

function stepTemplates(env) {
  const wa = loadProjectJson().whatsapp;
  console.log(`
  ${c.bold}Cargá estas 4 plantillas en Meta${c.reset} (WhatsApp Manager → Message templates).
  Categoría: Utility · Idioma: ${wa.template_lang}. Detalle en walkthroughs/03-plantillas-whatsapp.md

  1. ${wa.templates.reminder}
     "Hola {{1}}, te recordamos tu turno del {{2}} con {{3}}. ¿Confirmás?"
     Botones quick reply: Confirmar / Reprogramar / Cancelar

  2. ${wa.templates.cancellation}
     "Hola {{1}}, se liberó un turno el {{2}}. Si te sirve, escribinos y te lo agendamos."

  3. ${wa.templates.waitlist}
     "Hola {{1}}, se liberó un lugar para {{2}} el {{3}}. ¿Lo querés? Respondé este mensaje."

  4. ${wa.templates.reengagement}
     "Tenés un mensaje de una clienta esperando respuesta. Abrí WhatsApp para verlo."
`);
  const p = loadProjectJson();
  for (const k of Object.keys(p.whatsapp.templates_status || {})) p.whatsapp.templates_status[k] = 'dictated';
  if (!args.dryRun) saveProjectJson(p);
}

async function stepConnectionTest(env) {
  const p = loadProjectJson();
  const api = n8nClient({ baseUrl: p.n8n.base_url, apiKey: env.N8N_API_KEY });

  const healthy = await api.health().catch(() => false);
  healthy ? ok('n8n /healthz responde') : warn('n8n /healthz no responde');

  const client = await pgConnect(env.DATABASE_URL);
  try {
    const n = Number((await client.query('SELECT count(*) FROM services WHERE active')).rows[0].count);
    n > 0 ? ok(`base con ${n} servicio(s) activo(s)`) : warn('la base no tiene servicios activos');
  } finally { await client.end(); }

  if (env.WEBHOOK_URL && env.WEBHOOK_PATH && env.WA_VERIFY_TOKEN) {
    const challenge = `PING${Date.now()}`;
    const url = `${env.WEBHOOK_URL.replace(/\/$/, '')}/webhook/${env.WEBHOOK_PATH}` +
      `?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(env.WA_VERIFY_TOKEN)}&hub.challenge=${challenge}`;
    try {
      const body = (await (await fetch(url)).text()).trim();
      body === challenge ? ok('webhook verifica el challenge de Meta') : warn(`webhook respondió "${body.slice(0, 60)}" (esperaba "${challenge}")`);
    } catch (e) { warn(`no pude probar el webhook: ${e.message}`); }
  } else {
    warn('sin WEBHOOK_URL: salteo la verificación del webhook');
  }
  const proj = loadProjectJson();
  proj.setup.last_connection_test = new Date().toISOString();
  proj.setup.webhook_active = true;
  if (!args.dryRun) saveProjectJson(proj);
}

// ---- Main --------------------------------------------------------------

const RUNNERS = {
  prereqs: stepPrereqs,
  db_reachable: stepDbReachable,
  schema: stepSchema,
  seed: stepSeed,
  project_json: stepProjectJson,
  n8n_credentials: stepN8nCredentials,
  n8n_flows: stepN8nFlows,
  n8n_activate: stepN8nActivate,
  templates: stepTemplates,
  connection_test: stepConnectionTest,
};

async function main() {
  banner(`setup.js — agente de turnos (template ${TEMPLATE_VERSION})`);
  if (args.clean && existsSync(STATE_PATH)) {
    rmSync(STATE_PATH);
    warn('estado anterior borrado (--clean)');
  }
  const env = loadEnv();
  const state = loadState(STATE_PATH);

  let failed = false;
  for (const name of STEPS) {
    if (!pending(name, state)) { console.log(`${c.dim}· ${name} (hecho)${c.reset}`); continue; }
    banner(name);
    try {
      const data = await RUNNERS[name](env, state);
      markStep(state, name, args.dryRun ? 'dry' : 'done', data && typeof data === 'object' ? data : null);
      if (!args.dryRun) saveState(STATE_PATH, state);
    } catch (e) {
      fail(e.message);
      markStep(state, name, 'failed', { error: e.message });
      if (!args.dryRun) saveState(STATE_PATH, state);
      failed = true;
      break;
    }
  }

  console.log('');
  if (failed) { fail('setup incompleto. Corregí y volvé a correr: retoma donde quedó.'); process.exit(1); }
  ok(args.dryRun ? 'dry-run OK: nada se escribió' : 'setup completo');
  process.exit(0);
}

main().catch(e => { fail(`error inesperado: ${e.stack || e.message}`); process.exit(2); });
