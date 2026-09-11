// Test: validateToolCall detecta parámetros faltantes, herramientas
// inexistentes, parámetros no permitidos y argumentos que no son objeto.

import { loadToolsSpec, validateToolCall } from '../../scripts/lib/validate-tool-call.mjs';
import { assert, assertFallaEnCampo } from '../lib/assert.mjs';

export default function () {
  const spec = loadToolsSpec();

  // Herramienta inexistente
  assertFallaEnCampo(
    validateToolCall(spec, 'agendar_turno', {}),
    '_tool',
    'no existe',
    'herramienta desconocida',
  );

  // Argumentos que no son objeto
  assertFallaEnCampo(
    validateToolCall(spec, 'cancelar_turno', 'turno-123'),
    '_args',
    'objeto',
    'args string',
  );
  assertFallaEnCampo(
    validateToolCall(spec, 'cancelar_turno', null),
    '_args',
    null,
    'args null',
  );

  // Falta un required
  assertFallaEnCampo(
    validateToolCall(spec, 'consultar_disponibilidad', { servicios: ['Corte'] }),
    'fecha',
    'Falta el parámetro',
    'falta fecha en consultar_disponibilidad',
  );

  // Faltan varios: crear_turno sin nada
  const r = validateToolCall(spec, 'crear_turno', {});
  assert(r.ok === false, 'crear_turno vacío falla');
  const camposFaltantes = r.errores.map(e => e.campo).sort();
  assert(
    ['cliente', 'dia_semana', 'hora_inicio', 'profesional', 'servicios'].every(c => camposFaltantes.includes(c)),
    'crear_turno reporta los 5 required faltantes',
  );

  // Parámetro no permitido
  assertFallaEnCampo(
    validateToolCall(spec, 'consultar_servicios', { rubro: 'peluqueria' }),
    'rubro',
    'no está permitido',
    'parámetro extra en herramienta sin parámetros',
  );

  // Un opcional ausente no es error: consultar_disponibilidad sin profesional
  const okSinOpcional = validateToolCall(spec, 'consultar_disponibilidad', {
    fecha: '2026-09-12',
    servicios: ['Corte'],
  });
  assert(okSinOpcional.ok === true, 'profesional es opcional en consultar_disponibilidad');
}
