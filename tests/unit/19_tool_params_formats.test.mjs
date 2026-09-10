// Test: validateToolCall verifica tipos y formatos (date, date-time, e164,
// uuid), enum, minItems y el trato de null según "nullable".

import { loadToolsSpec, validateToolCall } from '../../scripts/lib/validate-tool-call.mjs';
import { assert, assertOk, assertFallaEnCampo } from '../lib/assert.mjs';

const UUID_OK = '00000000-0000-0000-0000-000000000001';
const HORA_OK = '2026-09-12T15:00:00-03:00';
const TEL_OK = '5491122334455';

export default function () {
  const spec = loadToolsSpec();

  // --- format: date ---
  assertFallaEnCampo(
    validateToolCall(spec, 'consultar_disponibilidad', { fecha: '12/09/2026', servicios: ['Corte'] }),
    'fecha', 'AAAA-MM-DD', 'fecha con formato equivocado',
  );
  assertFallaEnCampo(
    validateToolCall(spec, 'consultar_disponibilidad', { fecha: '2026-13-40', servicios: ['Corte'] }),
    'fecha', null, 'fecha con mes/día imposible',
  );
  assertFallaEnCampo(
    validateToolCall(spec, 'consultar_disponibilidad', { fecha: '2025-02-29', servicios: ['Corte'] }),
    'fecha', null, '29 de febrero de año no bisiesto',
  );

  // --- tipo equivocado (item del array) ---
  assertFallaEnCampo(
    validateToolCall(spec, 'consultar_disponibilidad', { fecha: '2026-09-12', servicios: [123] }),
    'servicios[0]', 'texto', 'item de servicios numérico',
  );

  // --- array como string en vez de lista ---
  assertFallaEnCampo(
    validateToolCall(spec, 'consultar_disponibilidad', { fecha: '2026-09-12', servicios: 'Corte' }),
    'servicios', 'una lista', 'servicios como string en vez de array',
  );

  // --- minLength (item vacío) ---
  assertFallaEnCampo(
    validateToolCall(spec, 'consultar_disponibilidad', { fecha: '2026-09-12', servicios: [''] }),
    'servicios[0]', 'no puede estar vacío', 'item de servicios vacío',
  );

  // --- minItems (lista vacía) ---
  assertFallaEnCampo(
    validateToolCall(spec, 'consultar_disponibilidad', { fecha: '2026-09-12', servicios: [] }),
    'servicios', 'al menos 1', 'servicios lista vacía',
  );

  // --- format: date-time ---
  assertFallaEnCampo(
    validateToolCall(spec, 'crear_turno', {
      cliente: TEL_OK, servicios: ['Corte'], profesional: 'Carla', hora_inicio: '2026-09-12',
    }),
    'hora_inicio', 'ISO 8601', 'date-time sin hora ni offset',
  );
  assertFallaEnCampo(
    validateToolCall(spec, 'crear_turno', {
      cliente: TEL_OK, servicios: ['Corte'], profesional: 'Carla', hora_inicio: '2026-09-12T15:00:00',
    }),
    'hora_inicio', null, 'date-time sin offset',
  );

  // --- format: e164 ---
  assertFallaEnCampo(
    validateToolCall(spec, 'consultar_turnos_cliente', { cliente: '+54 9 11 2233-4455' }),
    'cliente', 'formato válido', 'teléfono con símbolos y espacios',
  );

  // --- format: uuid ---
  assertFallaEnCampo(
    validateToolCall(spec, 'cancelar_turno', { turno_id: 'turno-123' }),
    'turno_id', 'no es válido', 'uuid inválido',
  );

  // --- array: minItems + items ---
  assertFallaEnCampo(
    validateToolCall(spec, 'crear_turno', {
      cliente: TEL_OK, servicios: [], profesional: 'Carla', hora_inicio: HORA_OK,
    }),
    'servicios', 'al menos 1', 'servicios lista vacía',
  );
  assertFallaEnCampo(
    validateToolCall(spec, 'crear_turno', {
      cliente: TEL_OK, servicios: ['Corte', ''], profesional: 'Carla', hora_inicio: HORA_OK,
    }),
    'servicios[1]', 'no puede estar vacío', 'item de servicios vacío',
  );
  assertFallaEnCampo(
    validateToolCall(spec, 'crear_turno', {
      cliente: TEL_OK, servicios: 'Corte', profesional: 'Carla', hora_inicio: HORA_OK,
    }),
    'servicios', 'una lista', 'servicios como string en vez de array',
  );

  // --- enum ---
  assertFallaEnCampo(
    validateToolCall(spec, 'derivar_a_humano', { razon: 'la clienta insulta', categoria: 'insulto' }),
    'categoria', 'no es válido', 'categoría fuera del enum',
  );

  // --- nullable: profesional acepta null explícito ---
  assertOk(
    validateToolCall(spec, 'consultar_disponibilidad', {
      fecha: '2026-09-12', servicios: ['Corte'], profesional: null,
    }),
    'profesional null es válido (nullable:true)',
  );

  // --- no-nullable: cliente null falla ---
  assertFallaEnCampo(
    validateToolCall(spec, 'consultar_turnos_cliente', { cliente: null }),
    'cliente', 'no puede ser null', 'cliente no es nullable',
  );

  // --- un mismo call puede juntar varios errores ---
  const multi = validateToolCall(spec, 'sumar_lista_espera', {
    cliente: 'abc', servicio: '', fecha_desde: 'ayer', fecha_hasta: '2026-13-01',
  });
  assert(multi.ok === false && multi.errores.length >= 4, 'reporta todos los errores de una');
}
