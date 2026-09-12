/**
 * eval-transport.js — Transporte y verificación para la suite de evals "ajustes"
 * (T2-T6 de PLAN-DE-AJUSTES.md), usada por test-eval.js --suite ajustes.
 *
 * A diferencia de simulator.js (que levanta un capture server en el puerto 3999
 * y depende de __WA_API_BASE__ en los flujos — conflictivo con una sesión
 * interactiva propia), este módulo:
 *   - Postea directo al webhook real de n8n (mismo camino que produce Meta).
 *   - Lee la respuesta y los metadatos de la tabla `runs` en Postgres.
 *   - Cuando un caso necesita el historial COMPLETO de herramientas (no solo
 *     la ronda 1, que es lo único que guarda runs.tools_called — ver hallazgo
 *     de T0.5), lo reconstruye leyendo /api/v1/executions de n8n directamente.
 *   - Abre una conexión de Postgres nueva por consulta en vez de sostener una
 *     sola conexión larga: sostenerla viva durante un `await` largo (esperar
 *     la respuesta del modelo) fue la causa de varios ETIMEDOUT contra el
 *     pooler de Supabase durante T0.5/T1.
 */

import { loadEnv, pgConnect } from './infra.js';

let _env = null;
function env() {
  if (!_env) _env = loadEnv({ required: [] });
  return _env;
}

export function n8nWebhookUrl() {
  return process.env.N8N_WEBHOOK_URL || 'http://localhost:5678/webhook/wa-turnos';
}

function n8nBase() {
  const e = env();
  return `${e.N8N_PROTOCOL || 'http'}://${e.N8N_HOST || 'localhost'}:${e.N8N_PORT || 5678}`;
}

function n8nHeaders() {
  return { 'X-N8N-API-KEY': env().N8N_API_KEY };
}

// ---- Generación de teléfonos de prueba -------------------------------------

// Prefijo propio de esta suite (549117...) para no pisar números usados a mano
// en sesiones anteriores (549110...). Determinístico por caso+repetición: una
// corrida se puede repetir y cada (caso, repetición) siempre cae en el mismo
// número, lo que hace más fácil re-investigar un fallo puntual.
export function phoneFor(caseId, rep) {
  const digits = String(caseId).replace(/[^0-9]/g, '').padStart(4, '0').slice(-4);
  return `549117${digits}${String(rep).padStart(2, '0')}`;
}

// Un teléfono "ajeno" fijo para los casos de privacidad (T4) que necesitan un
// tercero real con turnos propios para confirmar que nunca se filtran.
export function otherPhoneFor(caseId, rep) {
  return `549118${String(caseId).replace(/[^0-9]/g, '').padStart(4, '0').slice(-4)}${String(rep).padStart(2, '0')}`;
}

// ---- Postgres: una conexión por llamada ------------------------------------

export async function withDb(fn) {
  const client = await pgConnect(env().DATABASE_URL);
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function query(sql, params = []) {
  return withDb(client => client.query(sql, params));
}

/** Limpia todo rastro de un teléfono de prueba antes de correr un caso. */
export async function resetPhone(phone) {
  // El pooler de Supabase (Supavisor, modo transacción) no acepta varios
  // comandos en un solo prepared statement — cada DELETE va en su propia
  // llamada, no separados por ";" en una sola query.
  await withDb(async client => {
    await client.query(`DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE phone = $1)`, [phone]);
    await client.query(`DELETE FROM runs WHERE conversation_id IN (SELECT id FROM conversations WHERE phone = $1)`, [phone]);
    await client.query(`DELETE FROM waitlist WHERE client_id IN (SELECT id FROM clients WHERE phone = $1)`, [phone]);
    await client.query(`DELETE FROM appointment_services WHERE appointment_id IN (SELECT id FROM appointments WHERE client_id IN (SELECT id FROM clients WHERE phone = $1))`, [phone]);
    await client.query(`DELETE FROM appointments WHERE client_id IN (SELECT id FROM clients WHERE phone = $1)`, [phone]);
    await client.query(`DELETE FROM conversations WHERE phone = $1`, [phone]);
    await client.query(`DELETE FROM clients WHERE phone = $1`, [phone]);
  });
}

// ---- Webhook: mismo payload que manda Meta ---------------------------------

export async function postMessage(phone, text, { name = 'Eval' } = {}) {
  const wamid = `wamid.EVAL.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ id: 'SIM_WABA', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '15550000000', phone_number_id: 'SIM_PNID' },
      contacts: [{ profile: { name }, wa_id: phone }],
      messages: [{ from: phone, id: wamid, type: 'text', text: { body: text }, timestamp: String(Math.floor(Date.now() / 1000)) }],
    } }] }],
  };
  const r = await fetch(n8nWebhookUrl(), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`webhook respondió ${r.status}`);
  return wamid;
}

/** Espera la próxima fila en `runs` para ese teléfono posterior a `since`. */
export async function waitForRun(phone, since, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await withDb(async client => {
      const rr = await client.query(
        `SELECT r.response_text, r.error, r.tools_called, r.tokens_in, r.tokens_out, r.created_at
         FROM runs r JOIN conversations c ON c.id = r.conversation_id JOIN clients cl ON cl.id = c.client_id
         WHERE cl.phone = $1 AND r.created_at > $2 ORDER BY r.created_at DESC LIMIT 1`,
        [phone, since],
      );
      return rr.rows[0] || null;
    });
    if (row) return row;
    await new Promise(res => setTimeout(res, 3000));
  }
  return null;
}

/** Manda un turno y espera su respuesta. Devuelve null si no hubo respuesta a tiempo. */
export async function sendTurn(phone, text, opts = {}) {
  const since = new Date();
  await postMessage(phone, text, opts);
  return waitForRun(phone, since, opts.timeoutMs);
}

// ---- Setup de datos para casos que necesitan estado previo -----------------

/** Crea (o reutiliza) el cliente para un teléfono de prueba y devuelve su id. */
export async function ensureClient(phone, { optedOut = false } = {}) {
  return withDb(async client => {
    const r = await client.query(
      `INSERT INTO clients (phone, opted_out, consent_shown_at)
       VALUES ($1, $2, now())
       ON CONFLICT (phone) DO UPDATE SET opted_out = $2
       RETURNING id`,
      [phone, optedOut],
    );
    return r.rows[0].id;
  });
}

/** Reserva un turno real (para casos que necesitan un turno preexistente). */
export async function bookAppointmentFor(phone, { professional, services, startsAt, notes = null }) {
  return withDb(async client => {
    await client.query(
      `INSERT INTO clients (phone, consent_shown_at) VALUES ($1, now()) ON CONFLICT (phone) DO NOTHING`,
      [phone],
    );
    const r = await client.query(
      `SELECT book_appointment(
         (SELECT id FROM clients WHERE phone = $1),
         (SELECT id FROM professionals WHERE lower(name) = lower($2) AND active LIMIT 1),
         (SELECT array_agg(id) FROM services WHERE lower(name) = ANY($3::text[]) AND active),
         $4::timestamptz, $5, true
       ) AS id`,
      [phone, professional, services.map(s => s.toLowerCase()), startsAt, notes],
    );
    return r.rows[0].id;
  });
}

export async function appointmentsFor(phone) {
  return withDb(async client => {
    const r = await client.query(
      `SELECT ap.id, ap.starts_at, ap.status, p.name AS professional
       FROM appointments ap JOIN clients c ON c.id = ap.client_id JOIN professionals p ON p.id = ap.professional_id
       WHERE c.phone = $1 ORDER BY ap.starts_at`,
      [phone],
    );
    return r.rows;
  });
}

export async function clientRow(phone) {
  return withDb(async client => {
    const r = await client.query(`SELECT * FROM clients WHERE phone = $1`, [phone]);
    return r.rows[0] || null;
  });
}

export async function waitlistFor(phone) {
  return withDb(async client => {
    const r = await client.query(
      `SELECT w.* FROM waitlist w JOIN clients c ON c.id = w.client_id WHERE c.phone = $1`,
      [phone],
    );
    return r.rows;
  });
}

// ---- n8n: historial COMPLETO de herramientas (todas las rondas) -----------

let _flowAgentId = null;
async function flowAgentId() {
  if (_flowAgentId) return _flowAgentId;
  const r = await fetch(`${n8nBase()}/api/v1/workflows?limit=50`, { headers: n8nHeaders() });
  const j = await r.json();
  const wf = (j.data || []).find(w => w.name === 'turnos · flow-agent');
  if (!wf) throw new Error('no encontré el workflow "turnos · flow-agent" en n8n');
  _flowAgentId = wf.id;
  return _flowAgentId;
}

/**
 * Todas las llamadas a herramientas (de TODAS las rondas, de TODAS las
 * ejecuciones de flow-agent) que arrancaron en la ventana [sinceISO, untilISO].
 * Necesario porque runs.tools_called solo guarda la ronda 1 (ver T0.5).
 * Devuelve [{ toolName, toolArgs, executionId, round }].
 */
export async function toolCallsInWindow(sinceISO, untilISO) {
  const id = await flowAgentId();
  const r = await fetch(`${n8nBase()}/api/v1/executions?workflowId=${id}&limit=100`, { headers: n8nHeaders() });
  const j = await r.json();
  const since = new Date(sinceISO).getTime();
  const until = new Date(untilISO).getTime();
  const enVentana = (j.data || []).filter(e => {
    const t = new Date(e.startedAt).getTime();
    return t >= since - 2000 && t <= until + 2000;
  });

  const calls = [];
  for (const e of enVentana) {
    const full = await fetch(`${n8nBase()}/api/v1/executions/${e.id}?includeData=true`, { headers: n8nHeaders() }).then(x => x.json());
    const runsData = full.data?.resultData?.runData?.['Ejecutar herramienta (armar)'] || [];
    runsData.forEach((run, roundIdx) => {
      const items = run?.data?.main?.[0] || [];
      for (const it of items) {
        const j2 = it.json || {};
        if (!j2.toolName) continue;
        // "Ejecutar herramienta (armar)" corta camino para derivar_a_humano:
        // en vez de {toolName, toolArgs} devuelve {toolName:'derivar_a_humano',
        // razon, categoria} con los argumentos como campos de nivel superior,
        // no anidados en toolArgs (ver el nodo en flow-agent.json). Sin este
        // caso especial, toolArgs queda {} y cualquier check que mire
        // toolArgs.categoria da undefined.
        const toolArgs = j2.toolName === 'derivar_a_humano'
          ? { razon: j2.razon, categoria: j2.categoria }
          : (j2.toolArgs || {});
        calls.push({ toolName: j2.toolName, toolArgs, executionId: e.id, round: roundIdx + 1 });
      }
    });
  }
  return calls;
}

/** true si alguna llamada en la ventana usó ese nombre de herramienta. */
export function calledTool(calls, toolName) {
  return calls.some(c => c.toolName === toolName);
}

/** Llamadas a una herramienta puntual, para inspeccionar sus argumentos. */
export function callsTo(calls, toolName) {
  return calls.filter(c => c.toolName === toolName);
}
