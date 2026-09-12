/**
 * test-eval-ajustes.js — reporte en consola para `test-eval.js --suite ajustes`.
 * El motor de corrida vive en scripts/lib/eval-runner-ajustes.js; este archivo
 * solo filtra casos, corre, y arma la tabla por tarea.
 */

import { loadCases, runSuite, summarize } from './lib/eval-runner-ajustes.js';

function ttyColors() {
  const t = process.stdout.isTTY;
  return { reset: t ? '\x1b[0m' : '', green: t ? '\x1b[32m' : '', red: t ? '\x1b[31m' : '', yellow: t ? '\x1b[33m' : '', dim: t ? '\x1b[2m' : '' };
}

export async function main(args) {
  const todos = loadCases();
  let casos = todos;
  if (args.only) casos = todos.filter(c => args.only.includes(c.id));
  if (!casos.length) { console.error('Ningún caso matchea --only.'); return 2; }

  if (args.list) {
    for (const c of casos) console.log(`  ${c.id.padEnd(8)} ${c.tarea}  ${c.nombre}${c.manual ? '  [manual]' : ''}`);
    return 0;
  }

  const c = ttyColors();
  console.log(`\ntest-eval --suite ajustes — ${casos.length} caso${casos.length === 1 ? '' : 's'} × ${args.runs} corrida${args.runs === 1 ? '' : ''}`);
  console.log(`webhook: ${process.env.N8N_WEBHOOK_URL || 'http://localhost:5678/webhook/wa-turnos'}\n`);

  const resultados = await runSuite(casos, {
    runs: args.runs,
    onCaseDone: (caso, r) => {
      if (r.manual) {
        console.log(`  ${c.yellow}○${c.reset} ${caso.id.padEnd(8)} ${caso.nombre.padEnd(38)} manual — ${r.motivo}`);
        return;
      }
      const mark = r.pases === r.aplicables ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
      const rateStr = r.rate === null ? ' n/a' : `${String(r.rate).padStart(3)}%`;
      const naStr = r.noAplica ? `  (${r.noAplica} no aplica)` : '';
      console.log(`  ${mark} ${caso.id.padEnd(8)} ${caso.nombre.padEnd(38)} ${rateStr}  (${r.pases}/${r.aplicables})${naStr}`);
      if (r.pases !== r.aplicables) for (const m of r.motivos) console.log(`      ${c.dim}${m}${c.reset}`);
    },
  });

  // ---- Tabla por tarea --------------------------------------------------
  console.log('');
  const tareas = [...new Set(resultados.map(r => r.caso.tarea))];
  for (const tarea of tareas) {
    console.log(`\n${tarea}`);
    console.log('─'.repeat(60));
    for (const r of resultados.filter(x => x.caso.tarea === tarea)) {
      if (r.manual) {
        console.log(`  ${r.caso.id.padEnd(8)} ${r.caso.nombre.padEnd(38)} revisión humana`);
        continue;
      }
      const rateStr = r.rate === null ? ' n/a' : `${r.pases}/${r.aplicables}`;
      console.log(`  ${r.caso.id.padEnd(8)} ${r.caso.nombre.padEnd(38)} ${rateStr}`);
    }
  }

  const resumen = summarize(resultados);
  console.log('\nResumen por tarea');
  console.log('─'.repeat(60));
  for (const tarea of tareas) {
    const s = resumen.porTarea[tarea];
    console.log(`  ${tarea}: ${s.solidos}/${s.total - s.manual} sólidos (5/5)${s.conFalla ? `, ${s.conFalla} con falla` : ''}${s.manual ? `, ${s.manual} manual` : ''}`);
  }

  console.log(`\nCosto real de la corrida (Claude Haiku 4.5, $1.00/$5.00 por 1M tokens in/out):`);
  console.log(`  tokens in: ${resumen.tokensIn.toLocaleString('es-AR')}  ·  tokens out: ${resumen.tokensOut.toLocaleString('es-AR')}`);
  console.log(`  costo estimado: USD ${resumen.costoUSD.toFixed(4)}\n`);

  if (args.json) {
    console.log(JSON.stringify({
      resultados: resultados.map(r => r.manual
        ? { id: r.caso.id, tarea: r.caso.tarea, nombre: r.caso.nombre, manual: true, motivo: r.motivo }
        : { id: r.caso.id, tarea: r.caso.tarea, nombre: r.caso.nombre, pases: r.pases, aplicables: r.aplicables, noAplica: r.noAplica, rate: r.rate, motivos: r.motivos }),
      resumen,
    }, null, 2));
  }

  const conFalla = resultados.filter(r => !r.manual && r.pases !== r.aplicables);
  return conFalla.length === 0 ? 0 : 1;
}
