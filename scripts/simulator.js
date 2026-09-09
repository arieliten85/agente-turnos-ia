#!/usr/bin/env node
/**
 * simulator.js — Chat en terminal contra el webhook local de n8n.
 *
 * Manda a `flow-webhook` el mismo payload que mandaría Meta y captura la
 * respuesta del agente levantando un servidor que hace de Graph API (Meta).
 * Para que funcione, los flujos de n8n tienen que estar configurados con
 * `__WA_API_BASE__` apuntando a este capture server
 * (ej `http://host.docker.internal:3999`).
 *
 * Uso interactivo:
 *   node simulator.js
 *   node simulator.js --from 5491133334444 --name "Vale"
 *
 * Comandos dentro del chat:
 *   /reset                     limpia lo capturado (y la conversación en la base si hay PG)
 *   /burst hola || y un turno  manda varios mensajes seguidos (prueba el buffer)
 *   /button CONFIRMAR_<id>     manda una respuesta de botón
 *   /quit                      salir
 *
 * Como módulo (lo usa test-eval.js):
 *   import { createSimulator } from './simulator.js';
 *   const sim = await createSimulator();
 *   const { reply, elapsedMs } = await sim.send('quiero un turno');
 *   await sim.close();
 *
 * Variables de entorno:
 *   N8N_WEBHOOK_URL         default http://localhost:5678/webhook/wa-turnos
 *   SIMULATOR_CAPTURE_PORT  default 3999
 *   SIM_FROM               default 5491100000001
 *   SIM_REPLY_TIMEOUT_MS   default 20000
 *   DATABASE_URL           opcional, para /reset de la conversación
 */

import http from 'node:http';
import readline from 'node:readline';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

// ---- Payload estilo Meta ----------------------------------------------------

function metaWebhookPayload({ from, name, wabaId, phoneNumberId, message }) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: wabaId,
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550000000', phone_number_id: phoneNumberId },
          contacts: [{ profile: { name }, wa_id: from }],
          messages: [message],
        },
      }],
    }],
  };
}

function textMessage(from, body) {
  return {
    from,
    id: `wamid.SIM.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
    type: 'text',
    text: { body },
  };
}

function buttonMessage(from, payload, text) {
  return {
    from,
    id: `wamid.SIM.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
    type: 'button',
    button: { payload, text: text || payload },
  };
}

function extractReplyText(waBody) {
  if (!waBody || typeof waBody !== 'object') return null;
  if (waBody.type === 'text') return waBody.text?.body ?? null;
  if (waBody.type === 'template') {
    const t = waBody.template || {};
    const params = (t.components || [])
      .filter(c => c.type === 'body')
      .flatMap(c => (c.parameters || []).map(p => p.text))
      .filter(Boolean);
    return `[plantilla ${t.name}${params.length ? ' · ' + params.join(' | ') : ''}]`;
  }
  if (waBody.type === 'interactive') {
    return waBody.interactive?.body?.text
      ?? `[interactivo ${waBody.interactive?.type || ''}]`;
  }
  return `[mensaje ${waBody.type}]`;
}

// ---- Simulador ------------------------------------------------------------

export async function createSimulator(opts = {}) {
  const config = {
    n8nUrl: opts.n8nUrl || process.env.N8N_WEBHOOK_URL || 'http://localhost:5678/webhook/wa-turnos',
    capturePort: Number(opts.capturePort || process.env.SIMULATOR_CAPTURE_PORT || 3999),
    from: String(opts.from || process.env.SIM_FROM || '5491100000001'),
    name: opts.name || process.env.SIM_NAME || 'Ana',
    wabaId: opts.wabaId || 'SIM_WABA',
    phoneNumberId: opts.phoneNumberId || 'SIM_PNID',
    replyTimeoutMs: Number(opts.replyTimeoutMs || process.env.SIM_REPLY_TIMEOUT_MS || 20000),
    databaseUrl: opts.databaseUrl || process.env.DATABASE_URL || null,
    verbose: opts.verbose ?? false,
  };

  const captured = []; // { at, wall, to, body }

  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('simulator capture ok');
      return;
    }
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { body = { _unparsed: raw }; }
      captured.push({ at: performance.now(), wall: Date.now(), to: body?.to, body });
      if (config.verbose) console.error('[capture]', JSON.stringify(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        messaging_product: 'whatsapp',
        contacts: [{ input: body?.to, wa_id: body?.to }],
        messages: [{ id: `wamid.SIMOUT.${Date.now()}.${Math.random().toString(36).slice(2, 8)}` }],
      }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.capturePort, resolve);
  });

  function waitForCapture(sinceMark) {
    const deadline = performance.now() + config.replyTimeoutMs;
    return new Promise(resolve => {
      const tick = () => {
        const hit = captured.find(c => c.at >= sinceMark && c.to === config.from);
        if (hit) return resolve(hit);
        if (performance.now() > deadline) return resolve(null);
        setTimeout(tick, 120);
      };
      tick();
    });
  }

  async function postWebhook(message) {
    const payload = metaWebhookPayload({ ...config, message });
    let r;
    try {
      r = await fetch(config.n8nUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      throw new Error(`no pude llegar a n8n en ${config.n8nUrl} (${e.cause?.code || e.message}). ¿Está levantado y activo el flow-webhook?`);
    }
    if (!r.ok && r.status !== 200) {
      throw new Error(`n8n respondió ${r.status} en ${config.n8nUrl}`);
    }
    return r;
  }

  async function send(text, { type = 'text', buttonPayload = null, buttonText = null } = {}) {
    const mark = performance.now();
    const started = performance.now();
    const message = type === 'button'
      ? buttonMessage(config.from, buttonPayload, buttonText)
      : textMessage(config.from, text);
    await postWebhook(message);
    const hit = await waitForCapture(mark);
    const elapsedMs = Math.round(performance.now() - started);
    return {
      reply: hit ? extractReplyText(hit.body) : null,
      raw: hit?.body ?? null,
      timedOut: !hit,
      elapsedMs,
    };
  }

  async function sendBurst(texts, { gapMs = 400 } = {}) {
    const mark = performance.now();
    const started = performance.now();
    for (let i = 0; i < texts.length; i++) {
      await postWebhook(textMessage(config.from, texts[i]));
      if (i < texts.length - 1) await new Promise(r => setTimeout(r, gapMs));
    }
    const hit = await waitForCapture(mark);
    const elapsedMs = Math.round(performance.now() - started);
    return {
      reply: hit ? extractReplyText(hit.body) : null,
      raw: hit?.body ?? null,
      timedOut: !hit,
      elapsedMs,
      sent: texts.length,
    };
  }

  async function resetConversation() {
    captured.length = 0;
    if (!config.databaseUrl) return { db: false };
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: config.databaseUrl });
    await client.connect();
    try {
      await client.query(
        `DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE phone = $1);
         DELETE FROM runs WHERE conversation_id IN (SELECT id FROM conversations WHERE phone = $1);
         DELETE FROM waitlist WHERE client_id IN (SELECT id FROM clients WHERE phone = $1);
         DELETE FROM appointments WHERE client_id IN (SELECT id FROM clients WHERE phone = $1) AND starts_at > now();
         DELETE FROM conversations WHERE phone = $1;`,
        [config.from],
      );
      return { db: true };
    } finally {
      await client.end();
    }
  }

  async function close() {
    await new Promise(resolve => server.close(resolve));
  }

  return { config, captured, send, sendBurst, resetConversation, close };
}

// ---- Modo interactivo ----------------------------------------------------

async function repl() {
  const sim = await createSimulator({ verbose: process.argv.includes('--verbose') });
  const argFrom = argValue('--from');
  const argName = argValue('--name');
  if (argFrom) sim.config.from = argFrom;
  if (argName) sim.config.name = argName;

  console.log(`
  simulator.js — chat contra n8n
  ──────────────────────────────
  webhook n8n : ${sim.config.n8nUrl}
  capture     : http://localhost:${sim.config.capturePort}  (apuntá __WA_API_BASE__ acá)
  de          : ${sim.config.from} (${sim.config.name})
  timeout     : ${sim.config.replyTimeoutMs} ms

  Comandos: /reset  /burst a || b  /button <PAYLOAD>  /quit
`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'vos> ' });
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    try {
      if (input === '/quit' || input === '/exit') { rl.close(); return; }

      if (input === '/reset') {
        const r = await sim.resetConversation();
        console.log(r.db ? 'listo — conversación borrada de la base' : 'listo — capturas limpiadas (sin PG)');
        rl.prompt();
        return;
      }

      if (input.startsWith('/burst ')) {
        const parts = input.slice(7).split('||').map(s => s.trim()).filter(Boolean);
        const res = await sim.sendBurst(parts);
        printReply(res);
        rl.prompt();
        return;
      }

      if (input.startsWith('/button ')) {
        const payload = input.slice(8).trim();
        const res = await sim.send(null, { type: 'button', buttonPayload: payload });
        printReply(res);
        rl.prompt();
        return;
      }

      const res = await sim.send(input);
      printReply(res);
    } catch (err) {
      console.error(`  ✗ ${err.message}`);
    }
    rl.prompt();
  });

  rl.on('close', async () => {
    await sim.close();
    process.exit(0);
  });
}

function printReply(res) {
  const secs = (res.elapsedMs / 1000).toFixed(2);
  if (res.timedOut) {
    console.log(`agente> (sin respuesta en ${secs}s)\n`);
  } else {
    console.log(`agente> ${res.reply}   ${dim(`(${secs}s)`)}\n`);
  }
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

function dim(s) {
  return process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s;
}

if (isMain) {
  repl().catch(err => {
    console.error('Error fatal:', err);
    process.exit(1);
  });
}
