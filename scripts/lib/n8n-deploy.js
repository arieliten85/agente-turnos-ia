/**
 * n8n-deploy.js — Construcción de credenciales y flujos de n8n a partir de los
 * blueprints. Lo usan setup.js (demo) y promote.js (producción).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, applyMarkers } from './infra.js';

/** Payloads para crear las 4 credenciales de n8n desde el `.env`. */
export function credentialPayloads(env, names) {
  const db = new URL(env.DATABASE_URL);
  const provider = (env.MODEL_PROVIDER || 'gemini').toLowerCase();
  const model = provider === 'claude'
    ? { name: 'x-api-key', value: env.ANTHROPIC_API_KEY || '' }
    : { name: 'x-goog-api-key', value: env.GEMINI_API_KEY || '' };
  return [
    {
      key: 'postgres', type: 'postgres', name: names.postgres, data: {
        host: db.hostname, port: Number(db.port || 5432),
        database: db.pathname.replace(/^\//, '') || 'postgres',
        user: decodeURIComponent(db.username), password: decodeURIComponent(db.password),
        ssl: 'require', allowUnauthorizedCerts: true,
      },
    },
    {
      key: 'redis', type: 'redis', name: names.redis, data: {
        host: env.REDIS_HOST || 'redis', port: Number(env.REDIS_PORT || 6379),
        password: env.REDIS_PASSWORD || '', database: 0, ssl: false,
      },
    },
    {
      key: 'whatsapp', type: 'httpHeaderAuth', name: names.whatsapp, data: {
        name: 'Authorization', value: `Bearer ${env.WA_TOKEN || ''}`,
      },
    },
    { key: 'model', type: 'httpHeaderAuth', name: names.model, data: model },
  ];
}

/**
 * Lee un flujo de blueprints/flows/, reemplaza todos los marcadores y devuelve
 * el payload listo para la API de n8n ({ name, nodes, connections, settings }).
 *
 * ctx = { identity, rules, tools, creds: {key:{id,name}}, flowIds: {name:id}, nameSuffix? }
 */
export function buildFlow(flowName, env, ctx) {
  const raw = readFileSync(join(ROOT, 'blueprints', 'flows', `${flowName}.json`), 'utf-8');
  let flow = JSON.parse(raw);

  const scalarMap = {
    REDIS_PREFIX: env.REDIS_PREFIX || 'turnos',
    WA_API_BASE: env.WA_API_BASE || 'https://graph.facebook.com',
    WA_GRAPH_VERSION: env.WA_GRAPH_VERSION || 'v21.0',
    WA_PHONE_NUMBER_ID: env.WA_PHONE_NUMBER_ID || '',
    WA_TEMPLATE_LANG: env.WA_TEMPLATE_LANG || 'es_AR',
    WA_TEMPLATE_REMINDER: env.WA_TEMPLATE_REMINDER || 'turno_recordatorio',
    WA_TEMPLATE_CANCELLATION: env.WA_TEMPLATE_CANCELLATION || 'turno_cancelado_hueco',
    WA_TEMPLATE_WAITLIST: env.WA_TEMPLATE_WAITLIST || 'turno_lista_espera',
    WA_TEMPLATE_REENGAGEMENT: env.WA_TEMPLATE_REENGAGEMENT || 'handoff_reengagement',
    HANDOFF_PHONE_DIGITS: env.HANDOFF_PHONE_DIGITS || '',
    MODEL_PROVIDER: (env.MODEL_PROVIDER || 'gemini').toLowerCase(),
    MODEL_NAME: env.MODEL_NAME || 'gemini-flash-lite-latest',
    BUFFER_SECONDS: env.BUFFER_SECONDS || '2.5',
    BUFFER_TTL_SECONDS: env.BUFFER_TTL_SECONDS || '60',
    RECOVERY_STALE_SECONDS: env.RECOVERY_STALE_SECONDS || '30',
    REMINDER_TYPE: env.REMINDER_TYPE || '24h',
    WEBHOOK_PATH: env.WEBHOOK_PATH || 'wa-turnos',
    WA_VERIFY_TOKEN: env.WA_VERIFY_TOKEN || '',
    FLOW_AGENT_ID: ctx.flowIds['flow-agent'] || '',
    FLOW_HANDOFF_ID: ctx.flowIds['flow-handoff'] || '',
    AGENT_IDENTITY: JSON.stringify(ctx.identity),
    AGENT_RULES: JSON.stringify(ctx.rules),
    AGENT_TOOLS: JSON.stringify(ctx.tools),
  };

  const walk = (v) => {
    if (typeof v === 'string') return applyMarkers(v, scalarMap, { strict: false });
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, val] of Object.entries(v)) o[k] = walk(val);
      return o;
    }
    return v;
  };
  flow = walk(flow);

  for (const node of flow.nodes || []) {
    if (!node.credentials) continue;
    for (const [ctype, ref] of Object.entries(node.credentials)) {
      let key = ctype === 'postgres' ? 'postgres' : ctype === 'redis' ? 'redis' : null;
      if (ctype === 'httpHeaderAuth') {
        key = /modelo|model/i.test(ref.name) || node.name?.startsWith('Modelo') ? 'model' : 'whatsapp';
      }
      const real = ctx.creds[key];
      if (real) node.credentials[ctype] = { id: real.id, name: real.name };
    }
  }

  const name = ctx.nameSuffix ? `${flow.name}${ctx.nameSuffix}` : flow.name;
  const payload = { name, nodes: flow.nodes, connections: flow.connections, settings: { executionOrder: 'v1' } };

  // El chequeo va sobre el payload real, no sobre meta.placeholders (que documenta
  // los marcadores y no se envía a n8n).
  const sobran = [...new Set(JSON.stringify(payload).match(/__[A-Z0-9_]+__/g) || [])];
  if (sobran.length) throw new Error(`${flowName}: marcadores sin resolver → ${sobran.join(', ')}`);

  return payload;
}

export const FLOW_ORDER = ['flow-handoff', 'flow-agent', 'flow-webhook', 'flow-reminder', 'flow-recovery'];
