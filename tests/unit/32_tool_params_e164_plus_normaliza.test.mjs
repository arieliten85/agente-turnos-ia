// Test: un teléfono E.164 con "+" antepuesto (Claude lo escribe así a veces)
// se normaliza antes de validar, en vez de rechazarse. clients.phone se
// guarda sin "+" (ver database/schema.sql), así que ese es el formato que
// tiene que quedar en `args` después de validar — la mutación es visible
// para quien llamó, porque `crear_turno` usa el mismo objeto `args` después.

import { loadToolsSpec, validateToolCall } from '../../scripts/lib/validate-tool-call.mjs';
import { assert, assertOk } from '../lib/assert.mjs';

export default function () {
  const spec = loadToolsSpec();

  const args = { cliente: '+5491122334455' };
  const r = validateToolCall(spec, 'consultar_turnos_cliente', args);
  assertOk(r, 'cliente con "+" antepuesto pasa la validación');
  assert(args.cliente === '5491122334455', 'la mutación saca el "+" del objeto args original');

  // Sin "+" sigue funcionando igual que antes (no romper el caso normal).
  const argsLimpio = { cliente: '5491122334455' };
  assertOk(
    validateToolCall(spec, 'consultar_turnos_cliente', argsLimpio),
    'cliente ya sin "+" sigue pasando',
  );
  assert(argsLimpio.cliente === '5491122334455', 'un valor ya limpio no se toca');

  // Un "+" en el medio del número (no al principio) sigue siendo inválido:
  // no es el caso real que reportó el modelo, y no queremos enmascarar un
  // valor genuinamente roto.
  const argsRoto = { cliente: '549+1122334455' };
  const rRoto = validateToolCall(spec, 'consultar_turnos_cliente', argsRoto);
  assert(rRoto.ok === false, 'un "+" en el medio del número sigue rechazándose');
}
