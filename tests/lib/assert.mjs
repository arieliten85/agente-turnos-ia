/**
 * assert.mjs — Aserciones mínimas para los tests .test.mjs.
 *
 * Mismo espíritu que los helpers de helpers.sql: fallar con un mensaje claro
 * que diga qué se esperaba y qué se obtuvo. Cualquier throw marca el test como
 * fallado en test-unit.js.
 */

export function assert(condicion, mensaje) {
  if (!condicion) {
    throw new Error(`ASSERTION FAILED: ${mensaje}`);
  }
}

export function assertEquals(actual, esperado, mensaje = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(esperado);
  if (a !== e) {
    throw new Error(`ASSERTION FAILED: ${mensaje} | esperado: ${e} | obtenido: ${a}`);
  }
}

export function assertOk(resultado, mensaje = '') {
  if (!resultado || resultado.ok !== true) {
    throw new Error(
      `ASSERTION FAILED: ${mensaje} | esperaba ok:true | obtenido: ${JSON.stringify(resultado)}`,
    );
  }
}

/**
 * Verifica que la validación falló y que hay un error para el campo dado.
 * Si se pasa `patron`, además exige que el mensaje de ese error lo contenga.
 */
export function assertFallaEnCampo(resultado, campo, patron = null, mensaje = '') {
  if (!resultado || resultado.ok !== false || !Array.isArray(resultado.errores)) {
    throw new Error(
      `ASSERTION FAILED: ${mensaje} | esperaba ok:false con errores | obtenido: ${JSON.stringify(resultado)}`,
    );
  }
  const err = resultado.errores.find(e => e.campo === campo);
  if (!err) {
    const campos = resultado.errores.map(e => e.campo).join(', ');
    throw new Error(
      `ASSERTION FAILED: ${mensaje} | esperaba un error en el campo "${campo}" | campos con error: ${campos || '(ninguno)'}`,
    );
  }
  if (patron && !err.mensaje.includes(patron)) {
    throw new Error(
      `ASSERTION FAILED: ${mensaje} | el error de "${campo}" no contiene "${patron}" | mensaje: ${err.mensaje}`,
    );
  }
}

export function assertThrows(fn, mensaje = '') {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(`ASSERTION FAILED: ${mensaje} | se esperaba que lanzara y no lo hizo`);
}
