/**
 * validate-tool-call.mjs — Validación de parámetros de las herramientas del agente.
 *
 * El modelo pide una herramienta con un objeto de argumentos. Antes de ejecutar
 * nada contra la base, el flow-agent valida ese objeto contra el contrato de
 * `agent/tools.json`. Si algo falta o está mal, devuelve un error claro en
 * español y el modelo le pide a la clienta lo que falta.
 *
 * Sin dependencias: implementa solo el subconjunto de JSON Schema que usa
 * tools.json (type, properties, required, additionalProperties:false, enum,
 * minLength, minItems, items, format, nullable).
 *
 * API:
 *   loadToolsSpec(path?)              -> spec (lanza si el archivo está roto)
 *   validateToolCall(spec, name, args) -> { ok: true } | { ok: false, errores: [...] }
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SPEC_PATH = resolve(__dirname, '..', '..', 'agent', 'tools.json');

const SUPPORTED_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);
const SUPPORTED_FORMATS = new Set(['date', 'date-time', 'e164', 'uuid']);

// ---- Carga y chequeo estructural del contrato -----------------------------

/**
 * Lee y parsea agent/tools.json y verifica que sea un contrato bien formado.
 * Lanza Error con mensaje accionable si algo no cierra: esto corre en tests y
 * en el arranque del flow-agent, no en runtime por mensaje.
 */
export function loadToolsSpec(specPath = DEFAULT_SPEC_PATH) {
  let raw;
  try {
    raw = readFileSync(specPath, 'utf-8');
  } catch (e) {
    throw new Error(`No se pudo leer el contrato de herramientas en ${specPath}: ${e.message}`);
  }

  let spec;
  try {
    spec = JSON.parse(raw);
  } catch (e) {
    throw new Error(`agent/tools.json no es JSON válido: ${e.message}`);
  }

  assertToolsSpec(spec);
  return spec;
}

/** Valida la forma del contrato entero. Lanza en el primer problema. */
export function assertToolsSpec(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new Error('El contrato de herramientas tiene que ser un objeto.');
  }
  if (!Array.isArray(spec.tools) || spec.tools.length === 0) {
    throw new Error('El contrato de herramientas necesita un array "tools" con al menos una herramienta.');
  }

  const nombres = new Set();
  for (const [i, tool] of spec.tools.entries()) {
    const donde = `tools[${i}]`;
    if (!tool || typeof tool !== 'object') {
      throw new Error(`${donde} tiene que ser un objeto.`);
    }
    if (typeof tool.name !== 'string' || tool.name.trim() === '') {
      throw new Error(`${donde}.name es obligatorio y tiene que ser un string no vacío.`);
    }
    if (nombres.has(tool.name)) {
      throw new Error(`Hay dos herramientas con el nombre "${tool.name}".`);
    }
    nombres.add(tool.name);

    if (typeof tool.description !== 'string' || tool.description.trim() === '') {
      throw new Error(`La herramienta "${tool.name}" necesita una "description" no vacía.`);
    }
    assertParamSchema(tool.parameters, `La herramienta "${tool.name}"`);
  }
}

/** Valida el sub-esquema de parámetros de una herramienta. */
function assertParamSchema(schema, contexto) {
  if (!schema || typeof schema !== 'object') {
    throw new Error(`${contexto} necesita un objeto "parameters".`);
  }
  if (schema.type !== 'object') {
    throw new Error(`${contexto}: "parameters.type" tiene que ser "object".`);
  }
  if (schema.properties == null || typeof schema.properties !== 'object') {
    throw new Error(`${contexto}: "parameters.properties" tiene que ser un objeto.`);
  }
  const required = schema.required ?? [];
  if (!Array.isArray(required)) {
    throw new Error(`${contexto}: "parameters.required" tiene que ser un array.`);
  }
  for (const req of required) {
    if (!(req in schema.properties)) {
      throw new Error(`${contexto}: "${req}" está en required pero no está definido en properties.`);
    }
  }
  for (const [prop, propSchema] of Object.entries(schema.properties)) {
    assertPropSchema(propSchema, `${contexto}, parámetro "${prop}"`);
  }
}

function assertPropSchema(propSchema, contexto) {
  if (!propSchema || typeof propSchema !== 'object') {
    throw new Error(`${contexto}: el esquema tiene que ser un objeto.`);
  }
  if (!SUPPORTED_TYPES.has(propSchema.type)) {
    throw new Error(`${contexto}: "type" inválido (${JSON.stringify(propSchema.type)}).`);
  }
  if (propSchema.format != null && !SUPPORTED_FORMATS.has(propSchema.format)) {
    throw new Error(`${contexto}: "format" no soportado (${propSchema.format}).`);
  }
  if (propSchema.enum != null && !Array.isArray(propSchema.enum)) {
    throw new Error(`${contexto}: "enum" tiene que ser un array.`);
  }
  if (propSchema.type === 'array' && propSchema.items != null) {
    assertPropSchema(propSchema.items, `${contexto}, items`);
  }
}

// ---- Validación de una llamada concreta ----------------------------------

/**
 * Valida los argumentos de una llamada a herramienta contra el contrato.
 * @returns {{ok: true}} si todo cierra
 * @returns {{ok: false, errores: {campo: string, mensaje: string}[]}} si no
 */
export function validateToolCall(spec, toolName, args) {
  const tool = spec?.tools?.find(t => t.name === toolName);
  if (!tool) {
    return {
      ok: false,
      errores: [{ campo: '_tool', mensaje: `La herramienta "${toolName}" no existe.` }],
    };
  }

  if (args == null || typeof args !== 'object' || Array.isArray(args)) {
    return {
      ok: false,
      errores: [{ campo: '_args', mensaje: `Los argumentos de "${toolName}" tienen que ser un objeto.` }],
    };
  }

  const schema = tool.parameters;
  const errores = [];
  const required = new Set(schema.required ?? []);

  // Propiedades no permitidas
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!(key in schema.properties)) {
        errores.push({
          campo: key,
          mensaje: `El parámetro "${key}" no está permitido en la herramienta "${toolName}".`,
        });
      }
    }
  }

  for (const [prop, propSchema] of Object.entries(schema.properties)) {
    const presente = prop in args && args[prop] !== undefined;
    const valor = args[prop];

    if (!presente) {
      if (required.has(prop)) {
        errores.push({ campo: prop, mensaje: `Falta el parámetro "${prop}".` });
      }
      continue;
    }

    if (valor === null) {
      if (propSchema.nullable === true) continue;
      errores.push({ campo: prop, mensaje: `El parámetro "${prop}" no puede ser null.` });
      continue;
    }

    for (const err of validateValue(prop, valor, propSchema)) {
      errores.push(err);
    }
  }

  return errores.length === 0 ? { ok: true } : { ok: false, errores };
}

// ---- Validación de un valor contra un sub-esquema -----------------------

function validateValue(campo, valor, schema) {
  const errores = [];

  if (!matchesType(valor, schema.type)) {
    errores.push({ campo, mensaje: tipoMsg(campo, schema.type) });
    return errores; // sin el tipo correcto, el resto de chequeos no aplica
  }

  if (schema.type === 'string') {
    if (schema.minLength != null && valor.length < schema.minLength) {
      errores.push({
        campo,
        mensaje: schema.minLength === 1
          ? `El parámetro "${campo}" no puede estar vacío.`
          : `El parámetro "${campo}" es demasiado corto (mínimo ${schema.minLength}).`,
      });
    }
    if (schema.format && !matchesFormat(valor, schema.format)) {
      errores.push({ campo, mensaje: formatoMsg(campo, valor, schema.format) });
    }
  }

  if (schema.type === 'array') {
    if (schema.minItems != null && valor.length < schema.minItems) {
      errores.push({
        campo,
        mensaje: `Tenés que indicar al menos ${schema.minItems} ${schema.minItems === 1 ? 'elemento' : 'elementos'} en "${campo}".`,
      });
    }
    if (schema.items) {
      valor.forEach((item, idx) => {
        for (const err of validateValue(`${campo}[${idx}]`, item, schema.items)) {
          errores.push(err);
        }
      });
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(valor)) {
    errores.push({
      campo,
      mensaje: `El valor "${valor}" no es válido para "${campo}". Opciones: ${schema.enum.join(', ')}.`,
    });
  }

  return errores;
}

// ---- Helpers de tipo y formato -----------------------------------------

function matchesType(valor, type) {
  switch (type) {
    case 'string':  return typeof valor === 'string';
    case 'number':  return typeof valor === 'number' && Number.isFinite(valor);
    case 'integer': return typeof valor === 'number' && Number.isInteger(valor);
    case 'boolean': return typeof valor === 'boolean';
    case 'array':   return Array.isArray(valor);
    case 'object':  return valor != null && typeof valor === 'object' && !Array.isArray(valor);
    default:        return false;
  }
}

function tipoMsg(campo, type) {
  const nombre = {
    string: 'texto',
    number: 'un número',
    integer: 'un número entero',
    boolean: 'verdadero o falso',
    array: 'una lista',
    object: 'un objeto',
  }[type] ?? type;
  return `El parámetro "${campo}" tiene que ser ${nombre}.`;
}

const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_E164 = /^\d{8,15}$/;
const RE_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function matchesFormat(valor, format) {
  switch (format) {
    case 'date':
      return RE_DATE.test(valor) && esFechaCalendarioValida(valor);
    case 'date-time':
      return esDateTimeISOValido(valor);
    case 'e164':
      return RE_E164.test(valor);
    case 'uuid':
      return RE_UUID.test(valor);
    default:
      return true;
  }
}

function esFechaCalendarioValida(valor) {
  const [y, m, d] = valor.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function esDateTimeISOValido(valor) {
  if (typeof valor !== 'string') return false;
  // Exigir fecha + hora + (Z u offset). Evita aceptar solo 'AAAA-MM-DD'.
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(valor)) {
    return false;
  }
  const ms = Date.parse(valor);
  return Number.isFinite(ms);
}

function formatoMsg(campo, valor, format) {
  switch (format) {
    case 'date':
      return `La fecha "${valor}" no es válida en "${campo}". Usá el formato AAAA-MM-DD.`;
    case 'date-time':
      return `La hora "${valor}" no es válida en "${campo}". Usá ISO 8601 con offset (ej 2026-09-12T15:00:00-03:00).`;
    case 'e164':
      return `El teléfono "${valor}" en "${campo}" no tiene un formato válido (solo dígitos, 8 a 15).`;
    case 'uuid':
      return `El identificador "${valor}" en "${campo}" no es válido.`;
    default:
      return `El valor "${valor}" en "${campo}" no cumple el formato ${format}.`;
  }
}

// ============================================================================
// DEUDA CONOCIDA — hay una segunda copia de esta lógica.
// ----------------------------------------------------------------------------
// Los nodos Code de n8n no pueden importar archivos del repo, así que
// `validateToolCall` y sus helpers (matchesType/tipoMsg/matchesFormat/
// formatoMsg/validateValue) están portados INLINE en el nodo "Validar params"
// de blueprints/flows/flow-agent.json. Ese es el que corre en producción; este
// archivo es el que testean tests/unit/17-20.
//
// Si tocás la lógica de validación acá, replicalo en ese nodo (y viceversa).
// Hay un test de paridad manual: comparar la salida de ambas implementaciones
// contra los mismos casos de tests 18-20.
// ============================================================================
