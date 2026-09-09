/**
 * infra.js — Helpers compartidos por setup.js, update.js, promote.js y reset-demo.js.
 *
 * Sin dependencias fuera de `pg` (que ya está) y la librería estándar de Node.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, '..', '..');
export const SCRIPTS_DIR = resolve(__dirname, '..');

export const TEMPLATE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(SCRIPTS_DIR, 'package.json'), 'utf-8')).version;
  } catch { return '0.0.0'; }
})();

// ---- Consola --------------------------------------------------------------

const tty = process.stdout.isTTY;
export const c = {
  reset: tty ? '\x1b[0m' : '', bold: tty ? '\x1b[1m' : '', dim: tty ? '\x1b[2m' : '',
  green: tty ? '\x1b[32m' : '', red: tty ? '\x1b[31m' : '', yellow: tty ? '\x1b[33m' : '', cyan: tty ? '\x1b[36m' : '',
};
export const banner = (t) => console.log(`\n${c.bold}${t}${c.reset}`);
export const step = (t) => console.log(`${c.cyan}▸${c.reset} ${t}`);
export const ok = (t) => console.log(`  ${c.green}✓${c.reset} ${t}`);
export const warn = (t) => console.log(`  ${c.yellow}!${c.reset} ${t}`);
export const fail = (t) => console.log(`  ${c.red}✗${c.reset} ${t}`);

// ---- .env ---------------------------------------------------------------

/** Parsea un archivo KEY=VALUE (ignora comentarios y líneas vacías). */
export function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * Carga .env del root (si existe) por encima de process.env, y valida requeridas.
 * Devuelve el objeto combinado.
 */
export function loadEnv({ file = join(ROOT, '.env'), required = [] } = {}) {
  const fromFile = parseEnvFile(file);
  const env = { ...fromFile, ...process.env };
  // Las del archivo ganan si process.env no las trae explícitas.
  for (const [k, v] of Object.entries(fromFile)) {
    if (process.env[k] === undefined) env[k] = v;
  }
  const faltan = required.filter(k => !env[k]);
  if (faltan.length) {
    fail(`Faltan variables en ${file}: ${faltan.join(', ')}`);
    process.exit(2);
  }
  return env;
}

// ---- project.json -----------------------------------------------------

export const PROJECT_JSON = join(ROOT, 'config', 'project.json');
export function loadProjectJson() {
  return JSON.parse(readFileSync(PROJECT_JSON, 'utf-8'));
}
export function saveProjectJson(obj) {
  obj.updated_at = new Date().toISOString();
  writeFileSync(PROJECT_JSON, JSON.stringify(obj, null, 2) + '\n');
}

// ---- Postgres --------------------------------------------------------

export function parseDatabaseUrl(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    database: u.pathname.replace(/^\//, '') || 'postgres',
    user: decodeURIComponent(u.username || 'postgres'),
    password: decodeURIComponent(u.password || ''),
  };
}

/** Cliente pg conectado. El caller hace .end(). SSL laxo (Supabase). */
export async function pgConnect(connectionString) {
  const needSsl = /supabase\.co|supabase\.com|sslmode=require/.test(connectionString);
  const client = new pg.Client({
    connectionString,
    ssl: needSsl ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  return client;
}

export async function tableExists(client, name) {
  const r = await client.query('SELECT to_regclass($1) AS t', [`public.${name}`]);
  return r.rows[0].t !== null;
}

// ---- n8n REST API --------------------------------------------------

/** Cliente mínimo de la API pública de n8n (v1). */
export function n8nClient({ baseUrl, apiKey }) {
  const base = baseUrl.replace(/\/$/, '');
  const headers = { 'content-type': 'application/json', 'X-N8N-API-KEY': apiKey };
  async function req(method, path, body) {
    const res = await fetch(`${base}/api/v1${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* deja json en null */ }
    if (!res.ok) {
      throw new Error(`n8n ${method} ${path} → ${res.status} ${text.slice(0, 400)}`);
    }
    return json;
  }
  return {
    health: () => fetch(`${base}/healthz`).then(r => r.ok),
    listWorkflows: () => req('GET', '/workflows?limit=250'),
    createWorkflow: (wf) => req('POST', '/workflows', wf),
    updateWorkflow: (id, wf) => req('PUT', `/workflows/${id}`, wf),
    deleteWorkflow: (id) => req('DELETE', `/workflows/${id}`),
    activateWorkflow: (id) => req('POST', `/workflows/${id}/activate`),
    createCredential: (cred) => req('POST', '/credentials', cred),
    deleteCredential: (id) => req('DELETE', `/credentials/${id}`),
  };
}

// ---- Marcadores -------------------------------------------------------

const MARKER_RE = /__[A-Z0-9_]+__/g;

/**
 * Reemplaza los marcadores __NOMBRE__ en `text` con `map[NOMBRE]`.
 * Si `strict`, lanza si queda algún marcador sin resolver.
 */
export function applyMarkers(text, map, { strict = true } = {}) {
  let out = text;
  for (const [key, val] of Object.entries(map)) {
    out = out.split(`__${key}__`).join(String(val));
  }
  if (strict) {
    const sobran = [...new Set(out.match(MARKER_RE) || [])];
    if (sobran.length) {
      throw new Error(`Marcadores sin resolver: ${sobran.join(', ')}`);
    }
  }
  return out;
}

// ---- Checksums -------------------------------------------------------

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ---- Estado (.setup-state.json y afines) --------------------------

export function loadState(path) {
  if (!existsSync(path)) return { version: TEMPLATE_VERSION, started_at: new Date().toISOString(), steps: {} };
  return JSON.parse(readFileSync(path, 'utf-8'));
}
export function saveState(path, state) {
  state.updated_at = new Date().toISOString();
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n');
}
export function stepDone(state, name) {
  return state.steps?.[name]?.status === 'done';
}
export function markStep(state, name, status, data = null) {
  state.steps = state.steps || {};
  state.steps[name] = { status, at: new Date().toISOString(), ...(data ? { data } : {}) };
}

// ---- Confirmación interactiva -------------------------------------

/**
 * Pregunta y espera respuesta. `expect` (si se pasa) es el texto exacto que hay
 * que tipear para confirmar; sin `expect` acepta s/si/y/yes.
 * `assumeYes` salta la pregunta (para --yes).
 */
export async function confirm(question, { expect = null, assumeYes = false } = {}) {
  if (assumeYes) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise(res => rl.question(`${question} `, a => { rl.close(); res(a.trim()); }));
  if (expect) return ans === expect;
  return /^(s|si|sí|y|yes)$/i.test(ans);
}

// ---- Ejecutar comandos -----------------------------------------------

/** Corre un comando y devuelve { status, stdout, stderr }. No lanza. */
export function run(cmd, argv, opts = {}) {
  try {
    const stdout = execFileSync(cmd, argv, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout || '', stderr: e.stderr || e.message };
  }
}
