#!/usr/bin/env node
/**
 * reset-demo.js — Deja la base de la demo en un estado conocido y "vivo".
 *
 * Borra los turnos y las conversaciones generados, recarga el seed base
 * (database/seed-demo.sql) y arma turnos de muestra relativos a hoy:
 *   - el próximo JUEVES queda MEDIO OCUPADO (incluida "las 4")
 *   - el próximo VIERNES a la tarde queda TAPADO
 * Así, pedir "jueves a las 4" dispara el "no hay, te ofrezco alternativas", que
 * es lo que muestra el valor del agente.
 *
 * Se corre después de cada demostración.
 *
 * Uso:
 *   node reset-demo.js            pregunta antes de borrar
 *   node reset-demo.js --yes      sin preguntar
 *   node reset-demo.js --db=<url> otra base
 *
 * Exit: 0 ok · 1 falló · 2 configuración
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, c, banner, step, ok, warn, fail,
  loadEnv, pgConnect, tableExists, confirm,
} from './lib/infra.js';

const args = { yes: false, db: null };
for (const x of process.argv.slice(2)) {
  if (x === '--yes' || x === '-y') args.yes = true;
  else if (x.startsWith('--db=')) args.db = x.slice(5);
  else if (x === '--help' || x === '-h') { console.log('Ver cabecera del archivo.'); process.exit(0); }
  else { console.error(`Argumento desconocido: ${x}`); process.exit(2); }
}

const SEED_SQL = join(ROOT, 'database', 'seed-demo.sql');
const TZ_OFFSET = '-03:00'; // Argentina, sin horario de verano

const CARLA = 'a0000000-0000-0000-0000-000000000001';
const SVC = {
  corte: 'c0000000-0000-0000-0000-000000000001',
  color: 'c0000000-0000-0000-0000-000000000002',
  brushing: 'c0000000-0000-0000-0000-000000000003',
};
const CLI = [
  'd0000000-0000-0000-0000-000000000001',
  'd0000000-0000-0000-0000-000000000002',
  'd0000000-0000-0000-0000-000000000003',
  'd0000000-0000-0000-0000-000000000004',
  'd0000000-0000-0000-0000-000000000005',
];

/** Próxima fecha (estrictamente futura) que caiga en el día de semana dado (0=dom). */
function nextDow(target) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const delta = ((target - d.getDay() + 6) % 7) + 1; // 1..7
  d.setDate(d.getDate() + delta);
  return d;
}
const ymd = (d) => d.toISOString().slice(0, 10);
const ts = (d, hhmm) => `${ymd(d)}T${hhmm}:00${TZ_OFFSET}`;

async function book(client, clienteId, serviceId, startsAtIso) {
  await client.query('SELECT book_appointment($1, $2, ARRAY[$3]::uuid[], $4::timestamptz)', [clienteId, CARLA, serviceId, startsAtIso]);
}

async function main() {
  banner('reset-demo.js — Bella Studio');
  const env = loadEnv({ required: [] });
  const dbUrl = args.db || env.DATABASE_URL;
  if (!dbUrl) { fail('falta DATABASE_URL (o --db=<url>)'); process.exit(2); }

  const client = await pgConnect(dbUrl);
  try {
    if (!(await tableExists(client, 'business'))) {
      fail('la base no tiene el esquema. Corré setup.js primero.');
      process.exit(2);
    }

    const go = await confirm(
      `${c.yellow}Esto BORRA todos los turnos, clientas y conversaciones de la demo y recarga el seed. ¿Seguir? (s/N)${c.reset}`,
      { assumeYes: args.yes });
    if (!go) { warn('cancelado.'); process.exit(1); }

    await client.query('BEGIN');
    try {
      step('borrando datos generados');
      await client.query(`TRUNCATE
        business, services, professionals, clients, conversations, runs, processed_messages
        RESTART IDENTITY CASCADE`);

      step('recargando seed base');
      await client.query(readFileSync(SEED_SQL, 'utf-8'));

      const jueves = nextDow(4);
      const viernes = nextDow(5);

      step(`armando el jueves ${ymd(jueves)} (medio ocupado)`);
      await book(client, CLI[0], SVC.corte,    ts(jueves, '10:00'));
      await book(client, CLI[1], SVC.color,    ts(jueves, '12:00'));
      await book(client, CLI[2], SVC.corte,    ts(jueves, '16:00')); // "las 4" ocupada
      await book(client, CLI[3], SVC.brushing, ts(jueves, '17:30'));

      step(`armando el viernes ${ymd(viernes)} (tarde tapada)`);
      await book(client, CLI[0], SVC.color, ts(viernes, '14:00')); // 14:00-16:00
      await book(client, CLI[1], SVC.corte, ts(viernes, '16:00')); // 16:00-16:45
      await book(client, CLI[2], SVC.corte, ts(viernes, '16:45'));
      await book(client, CLI[3], SVC.corte, ts(viernes, '17:30'));
      await book(client, CLI[4], SVC.corte, ts(viernes, '18:15')); // -19:00

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    }

    const n = Number((await client.query("SELECT count(*) FROM appointments WHERE status='confirmed'")).rows[0].count);
    console.log('');
    ok(`base reseteada: ${n} turnos de muestra`);
    ok(`jueves ${ymd(nextDow(4))}: 10:00, 12:00, 16:00 y 17:30 ocupados — "jueves a las 4" no tiene lugar`);
    ok(`viernes ${ymd(nextDow(5))}: 14:00 a 19:00 completo`);
    process.exit(0);
  } catch (e) {
    fail(`falló: ${e.message}`);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch(e => { fail(`error inesperado: ${e.stack || e.message}`); process.exit(2); });
