// Test: una llamada bien formada a cada herramienta pasa la validación.
// Es el complemento en positivo de los tests 18 y 19.

import { loadToolsSpec, validateToolCall } from '../../scripts/lib/validate-tool-call.mjs';
import { assertOk } from '../lib/assert.mjs';

const TEL = '5491122334455';
const UUID = 'a1b2c3d4-e5f6-4788-9a0b-1c2d3e4f5061';
const HORA = '2026-09-12T15:00:00-03:00';

export default function () {
  const spec = loadToolsSpec();

  const casos = {
    consultar_servicios: {},
    consultar_horarios: {},
    consultar_disponibilidad: { fecha: '2026-09-12', servicios: ['Corte'] },
    crear_turno: {
      cliente: TEL,
      servicios: ['Corte', 'Color'],
      profesional: 'Carla',
      hora_inicio: HORA,
    },
    consultar_turnos_cliente: { cliente: TEL },
    modificar_turno: { turno_id: UUID, nueva_hora: HORA },
    cancelar_turno: { turno_id: UUID },
    sumar_lista_espera: {
      cliente: TEL,
      servicio: 'Color',
      fecha_desde: '2026-09-12',
      fecha_hasta: '2026-09-20',
      profesional: null,
    },
    derivar_a_humano: { razon: 'pide hablar con una persona', categoria: 'pide_humano' },
  };

  for (const [tool, args] of Object.entries(casos)) {
    assertOk(validateToolCall(spec, tool, args), `llamada válida a ${tool}`);
  }

  // Aceptar 'Z' como offset en date-time
  assertOk(
    validateToolCall(spec, 'modificar_turno', { turno_id: UUID, nueva_hora: '2026-09-12T18:00:00Z' }),
    'date-time con Z',
  );
}
