// Test: agent/tools.json es un contrato bien formado y expone exactamente las
// herramientas de la sección 7 del brief.

import { loadToolsSpec, assertToolsSpec } from '../../scripts/lib/validate-tool-call.mjs';
import { assert, assertEquals, assertThrows } from '../lib/assert.mjs';

const HERRAMIENTAS_BRIEF = [
  'consultar_servicios',
  'consultar_horarios',
  'consultar_disponibilidad',
  'crear_turno',
  'consultar_turnos_cliente',
  'modificar_turno',
  'cancelar_turno',
  'sumar_lista_espera',
  'derivar_a_humano',
];

export default function () {
  const spec = loadToolsSpec();

  const nombres = spec.tools.map(t => t.name);
  assertEquals(
    [...nombres].sort(),
    [...HERRAMIENTAS_BRIEF].sort(),
    'tools.json expone exactamente las 9 herramientas del brief',
  );

  for (const tool of spec.tools) {
    assert(tool.description.trim().length > 0, `"${tool.name}" tiene descripción`);
    assertEquals(tool.parameters.type, 'object', `"${tool.name}".parameters.type es object`);
    assert(
      tool.parameters.additionalProperties === false,
      `"${tool.name}" no admite parámetros extra`,
    );
    for (const req of tool.parameters.required ?? []) {
      assert(
        req in tool.parameters.properties,
        `"${tool.name}": el required "${req}" está en properties`,
      );
    }
  }

  // loadToolsSpec ya validó; assertToolsSpec tiene que rechazar contratos rotos.
  assertThrows(() => assertToolsSpec(null), 'rechaza spec null');
  assertThrows(() => assertToolsSpec({ tools: [] }), 'rechaza tools vacío');
  assertThrows(
    () => assertToolsSpec({ tools: [{ name: 'x', description: 'y', parameters: { type: 'string' } }] }),
    'rechaza parameters.type != object',
  );
  assertThrows(
    () => assertToolsSpec({
      tools: [
        { name: 'dup', description: 'a', parameters: { type: 'object', properties: {} } },
        { name: 'dup', description: 'b', parameters: { type: 'object', properties: {} } },
      ],
    }),
    'rechaza nombres duplicados',
  );
  assertThrows(
    () => assertToolsSpec({
      tools: [{
        name: 'x',
        description: 'y',
        parameters: { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] },
      }],
    }),
    'rechaza required que no está en properties',
  );
}
