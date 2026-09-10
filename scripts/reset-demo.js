#!/usr/bin/env node
/**
 * reset-demo.js — Deja la base de la demo en un estado conocido y "vivo".
 *
 * Borra los turnos y las conversaciones generados, recarga el seed base y arma
 * turnos de muestra relativos a hoy: una agenda parcialmente ocupada para que la
 * demo no muestre todo libre y se dispare el "no hay, te ofrezco alternativas",
 * que es lo que muestra el valor del agente.
 *
 * Rubros:
 *   peluqueria (default) — "Bella Studio", seed database/seed-demo.sql
 *   odonto              — "Consultorio Demo", seed database/seed-demo-odonto.sql
 *
 * Se corre después de cada demostración.
 *
 * Uso:
 *   node reset-demo.js                  pregunta antes de borrar (peluquería)
 *   node reset-demo.js --rubro=odonto   usa el seed de consultorio odontológico
 *   node reset-demo.js --yes            sin preguntar
 *   node reset-demo.js --db=<url>       otra base
 *
 * Exit: 0 ok · 1 falló · 2 configuración
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, c, banner, step, ok, warn, fail,
  loadEnv, pgConnect, tableExists, confirm,
} from './lib/infra.js';

const args = { yes: false, db: null, rubro: 'peluqueria' };
for (const x of process.argv.slice(2)) {
  if (x === '--yes' || x === '-y') args.yes = true;
  else if (x.startsWith('--db=')) args.db = x.slice(5);
  else if (x.startsWith('--rubro=')) args.rubro = x.slice(8);
  else if (x === '--help' || x === '-h') { console.log('Ver cabecera del archivo.'); process.exit(0); }
  else { console.error(`Argumento desconocido: ${x}`); process.exit(2); }
}

const TZ_OFFSET = '-03:00'; // Argentina, sin horario de verano

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

// ---- Config por rubro ---------------------------------------------------------
// Cada rubro define su seed, su profesional de referencia para los turnos de
// muestra, el mapa de servicios y las personas. `buildAgenda` arma los turnos
// vivos y devuelve las líneas de resumen que se imprimen al final.

const RUBROS = {
  peluqueria: {
    seed: 'seed-demo.sql',
    label: 'Bella Studio',
    professional: 'a0000000-0000-0000-0000-000000000001', // Carla
    svc: {
      corte:    'c0000000-0000-0000-0000-000000000001',
      color:    'c0000000-0000-0000-0000-000000000002',
      brushing: 'c0000000-0000-0000-0000-000000000003',
    },
    clients: [
      'd0000000-0000-0000-0000-000000000001',
      'd0000000-0000-0000-0000-000000000002',
      'd0000000-0000-0000-0000-000000000003',
      'd0000000-0000-0000-0000-000000000004',
      'd0000000-0000-0000-0000-000000000005',
    ],
    async buildAgenda({ book, svc, cli }) {
      const jueves = nextDow(4);
      const viernes = nextDow(5);

      step(`armando el jueves ${ymd(jueves)} (medio ocupado)`);
      await book(cli[0], svc.corte,    ts(jueves, '10:00'));
      await book(cli[1], svc.color,    ts(jueves, '12:00'));
      await book(cli[2], svc.corte,    ts(jueves, '16:00')); // "las 4" ocupada
      await book(cli[3], svc.brushing, ts(jueves, '17:30'));

      step(`armando el viernes ${ymd(viernes)} (tarde tapada)`);
      await book(cli[0], svc.color, ts(viernes, '14:00')); // 14:00-16:00
      await book(cli[1], svc.corte, ts(viernes, '16:00')); // 16:00-16:45
      await book(cli[2], svc.corte, ts(viernes, '16:45'));
      await book(cli[3], svc.corte, ts(viernes, '17:30'));
      await book(cli[4], svc.corte, ts(viernes, '18:15')); // -19:00

      return [
        `jueves ${ymd(jueves)}: 10:00, 12:00, 16:00 y 17:30 ocupados — "jueves a las 4" no tiene lugar`,
        `viernes ${ymd(viernes)}: 14:00 a 19:00 completo`,
      ];
    },
  },

  odonto: {
    seed: 'seed-demo-odonto.sql',
    label: 'Consultorio Demo',
    professional: 'e1000000-0000-0000-0000-000000000001', // Dra. Rossi
    svc: {
      diagnostico: 'e0000000-0000-0000-0000-000000000001',
      limpieza:    'e0000000-0000-0000-0000-000000000002',
      ortodoncia:  'e0000000-0000-0000-0000-000000000004',
    },
    clients: [
      'e2000000-0000-0000-0000-000000000001',
      'e2000000-0000-0000-0000-000000000002',
      'e2000000-0000-0000-0000-000000000003',
      'e2000000-0000-0000-0000-000000000004',
      'e2000000-0000-0000-0000-000000000005',
    ],
    async buildAgenda({ book, svc, cli }) {
      // Turno partido 9-13 / 15-19: todos los horarios caen en una franja.
      const jueves = nextDow(4);
      const viernes = nextDow(5);

      step(`armando el jueves ${ymd(jueves)} (medio ocupado)`);
      await book(cli[0], svc.diagnostico, ts(jueves, '09:30'));
      await book(cli[1], svc.limpieza,    ts(jueves, '11:00'));
      await book(cli[2], svc.ortodoncia,  ts(jueves, '16:00')); // "las 4" ocupada
      await book(cli[3], svc.limpieza,    ts(jueves, '17:30'));

      step(`armando el viernes ${ymd(viernes)} (tarde tapada)`);
      await book(cli[0], svc.limpieza, ts(viernes, '15:00')); // 15:00-15:45
      await book(cli[1], svc.limpieza, ts(viernes, '15:45'));
      await book(cli[2], svc.limpieza, ts(viernes, '16:30'));
      await book(cli[3], svc.limpieza, ts(viernes, '17:15'));
      await book(cli[4], svc.limpieza, ts(viernes, '18:00')); // -18:45

      return [
        `jueves ${ymd(jueves)}: 09:30, 11:00, 16:00 y 17:30 ocupados — "jueves a las 4" no tiene lugar`,
        `viernes ${ymd(viernes)}: franja de la tarde (15:00-19:00) completa`,
      ];
    },
  },
};

async function main() {
  const rubro = RUBROS[args.rubro];
  if (!rubro) {
    fail(`rubro desconocido: ${args.rubro}. Opciones: ${Object.keys(RUBROS).join(', ')}`);
    process.exit(2);
  }

  banner(`reset-demo.js — ${rubro.label}`);
  const env = loadEnv({ required: [] });
  const dbUrl = args.db || env.DATABASE_URL;
  if (!dbUrl) { fail('falta DATABASE_URL (o --db=<url>)'); process.exit(2); }

  const seedSql = join(ROOT, 'database', rubro.seed);
  const book = async (client, clienteId, serviceId, startsAtIso) => {
    await client.query(
      'SELECT book_appointment($1, $2, ARRAY[$3]::uuid[], $4::timestamptz)',
      [clienteId, rubro.professional, serviceId, startsAtIso],
    );
  };

  const client = await pgConnect(dbUrl);
  try {
    if (!(await tableExists(client, 'business'))) {
      fail('la base no tiene el esquema. Corré setup.js primero.');
      process.exit(2);
    }

    const go = await confirm(
      `${c.yellow}Esto BORRA todos los turnos, personas y conversaciones de la demo y recarga el seed. ¿Seguir? (s/N)${c.reset}`,
      { assumeYes: args.yes });
    if (!go) { warn('cancelado.'); process.exit(1); }

    await client.query('BEGIN');
    let resumen;
    try {
      step('borrando datos generados');
      await client.query(`TRUNCATE
        business, services, professionals, clients, conversations, runs, processed_messages
        RESTART IDENTITY CASCADE`);

      step('recargando seed base');
      await client.query(readFileSync(seedSql, 'utf-8'));

      resumen = await rubro.buildAgenda({
        book: (clienteId, serviceId, iso) => book(client, clienteId, serviceId, iso),
        svc: rubro.svc,
        cli: rubro.clients,
      });

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    }

    const n = Number((await client.query("SELECT count(*) FROM appointments WHERE status='confirmed'")).rows[0].count);
    console.log('');
    ok(`base reseteada: ${n} turnos de muestra`);
    for (const linea of resumen) ok(linea);
    process.exit(0);
  } catch (e) {
    fail(`falló: ${e.message}`);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch(e => { fail(`error inesperado: ${e.stack || e.message}`); process.exit(2); });
