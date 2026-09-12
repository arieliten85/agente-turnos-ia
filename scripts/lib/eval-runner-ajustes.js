/**
 * eval-runner-ajustes.js — motor de la suite "ajustes" (T2-T6 de
 * PLAN-DE-AJUSTES.md) para test-eval.js --suite ajustes.
 *
 * Cada caso se corre N veces (default 5), con teléfono nuevo por repetición
 * (conversaciones independientes). El resultado de cada repetición sale de
 * una condición automática contra la base y/o el log de ejecución de n8n —
 * nunca de leer el texto y opinar (ver eval-cases-ajustes.js).
 *
 * Precio de Claude Haiku 4.5 (fuente: tabla vigente del skill claude-api):
 * input $1.00 / 1M tokens, output $5.00 / 1M tokens.
 */

import * as transport from './eval-transport.js';
import { buildCases } from '../eval-cases-ajustes.js';

const PRICE_IN_PER_M = 1.00;
const PRICE_OUT_PER_M = 5.00;

export function loadCases() {
  return buildCases(transport);
}

async function runRep(caso, rep) {
  const phone = transport.phoneFor(caso.id, rep);
  const otherPhone = transport.otherPhoneFor(caso.id, rep);
  await transport.resetPhone(phone);
  await transport.resetPhone(otherPhone);

  const variant = caso.variants ? caso.variants[(rep - 1) % caso.variants.length] : null;

  // Se pasa `rep`: si dos repeticiones reservaran el mismo horario fijo para
  // clientes distintos, la restricción de exclusión de appointments (mismo
  // profesional, mismo rango) haría fallar la reserva desde la 2da rep en
  // adelante. Cada caso con setup varía la hora en función de `rep`.
  if (caso.setup) await caso.setup(transport, phone, otherPhone, rep);

  const since = new Date();
  const turnsTexts = caso.turns(phone, otherPhone, variant, rep);
  const respuestas = [];
  // El opt-out ("BAJA" y variantes) lo resuelve flow-webhook directo, sin
  // pasar por flow-agent (ver notas de flow-webhook.json) — nunca cae una
  // fila en `runs`, así que esperar una acá se cuelga hasta el timeout
  // aunque el opt-out haya funcionado perfecto. skipRunsWait posta el
  // mensaje, espera un margen fijo para que el UPDATE llegue, y sigue.
  if (caso.skipRunsWait) {
    for (const texto of turnsTexts) {
      await transport.postMessage(phone, texto);
      await new Promise(res => setTimeout(res, 4000));
    }
    const ctx0 = { respuestas: [], todasTexto: '', calls: [], phone, otherPhone, variant, rep };
    try {
      const r = await caso.check(ctx0);
      return { ...r, tokensIn: 0, tokensOut: 0, variant };
    } catch (e) {
      return { ok: false, motivo: `el check lanzó: ${e.message}`, tokensIn: 0, tokensOut: 0, variant };
    }
  }
  for (const texto of turnsTexts) {
    const r = await transport.sendTurn(phone, texto);
    respuestas.push(r);
    if (!r) break; // sin respuesta: no tiene sentido seguir con el próximo turno
  }
  const until = new Date();

  const tokensIn = respuestas.reduce((a, r) => a + (r?.tokens_in || 0), 0);
  const tokensOut = respuestas.reduce((a, r) => a + (r?.tokens_out || 0), 0);

  if (respuestas.some(r => !r)) {
    return { ok: false, motivo: 'sin respuesta a tiempo', tokensIn, tokensOut, variant };
  }

  let calls = [];
  try {
    calls = await transport.toolCallsInWindow(since.toISOString(), until.toISOString());
  } catch (e) {
    return { ok: false, motivo: `no pude leer el log de ejecución: ${e.message}`, tokensIn, tokensOut, variant };
  }

  const todasTexto = respuestas.map(r => r.response_text || '').join('\n');
  const ctx = { respuestas, todasTexto, calls, phone, otherPhone, variant, rep };

  try {
    const r = await caso.check(ctx);
    return { ...r, tokensIn, tokensOut, variant };
  } catch (e) {
    return { ok: false, motivo: `el check lanzó: ${e.message}`, tokensIn, tokensOut, variant };
  }
}

/**
 * Corre una lista de casos, `runs` repeticiones cada uno. `onCaseDone` es un
 * callback opcional (caso, resultado) para ir reportando progreso en vivo.
 */
export async function runSuite(casos, { runs = 5, onCaseDone = null } = {}) {
  const resultados = [];
  for (const caso of casos) {
    if (caso.manual) {
      resultados.push({ caso, manual: true, motivo: caso.manual });
      if (onCaseDone) onCaseDone(caso, resultados[resultados.length - 1]);
      continue;
    }
    let pases = 0, noAplica = 0, tokensIn = 0, tokensOut = 0;
    const motivos = [];
    for (let rep = 1; rep <= runs; rep++) {
      let r;
      try {
        r = await runRep(caso, rep);
      } catch (e) {
        r = { ok: false, motivo: `excepción no manejada: ${e.message}` };
      }
      tokensIn += r.tokensIn || 0;
      tokensOut += r.tokensOut || 0;
      if (r.ok === null) noAplica++;
      else if (r.ok) pases++;
      else motivos.push(`rep ${rep}${r.variant ? ` (${r.variant})` : ''}: ${r.motivo}`);
    }
    const aplicables = runs - noAplica;
    const resultado = {
      caso, manual: false, pases, runs, aplicables, noAplica,
      rate: aplicables ? Math.round((pases / aplicables) * 100) : null,
      tokensIn, tokensOut,
      costoUSD: (tokensIn / 1e6) * PRICE_IN_PER_M + (tokensOut / 1e6) * PRICE_OUT_PER_M,
      motivos: motivos.slice(0, 3),
    };
    resultados.push(resultado);
    if (onCaseDone) onCaseDone(caso, resultado);
  }
  return resultados;
}

export function summarize(resultados) {
  const porTarea = {};
  for (const r of resultados) {
    const t = r.caso.tarea;
    porTarea[t] = porTarea[t] || { total: 0, solidos: 0, conFalla: 0, manual: 0 };
    porTarea[t].total++;
    if (r.manual) porTarea[t].manual++;
    else if (r.pases === r.aplicables) porTarea[t].solidos++;
    else porTarea[t].conFalla++;
  }
  const tokensIn = resultados.reduce((a, r) => a + (r.tokensIn || 0), 0);
  const tokensOut = resultados.reduce((a, r) => a + (r.tokensOut || 0), 0);
  const costoUSD = resultados.reduce((a, r) => a + (r.costoUSD || 0), 0);
  return { porTarea, tokensIn, tokensOut, costoUSD };
}
