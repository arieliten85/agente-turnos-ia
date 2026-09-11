# Bitácora del loop analizar → arreglar → verificar → testear

Rama: `plan-de-trabajo-a-c-d`. Objetivo: TERMINADO de punta a punta según el
mensaje del usuario del 2026-09-11. Formato por línea:

```
[ítem] · intento N/3 · hipótesis · qué cambié · resultado verificado (dato crudo)
```

Reglas de corte activas: máx 3 intentos por ítem, máx 2 pasadas completas,
anti-repetición de hipótesis, frenar y preguntar ante gasto/irreversibilidad/
debilitar tests o validaciones.

---

## Pasada 1

**Baseline (antes de tocar nada):** flow-agent updatedAt 2026-09-10T00:22:56.111Z
(los otros 4 flujos vivos con updatedAt del 9-10 sep). `.setup-state.json` tenía
ids de credenciales y de los 5 flujos viejos (sin flow-cleanup).

[item2 maxTries/wait] · intento 1/3 · hipótesis: son los valores literales del
JSON de los 2 nodos HTTP · cambié maxTries 4→2, waitBetweenTries 3000→1000 en
"Modelo · Llamar" y "Modelo · Llamar 2" (commit c8f275a) · verificado por
lectura directa del JSON (`rg "maxTries"` → 2 en ambos); pendiente confirmar en
una corrida real que la instancia desplegada usa estos valores.

[item3 total_latency_ms] · intento 1/3 · hipótesis: "Registrar run" inserta el
literal 0 en vez de calcular una duración; no hay ningún timestamp capturado
antes en el flujo · agregué `_t0: Date.now()` al output de "Construir contexto
modelo" (primer nodo común a todos los caminos que llegan a "Registrar run") y
cambié el 8º parámetro de la query de `0` a
`Date.now() - $('Construir contexto modelo').item.json._t0` (commit c8f275a) ·
verificado que el JSON es válido y el jsCode parsea; falta correr una
conversación real y comparar `runs.total_latency_ms` contra la duración de
`/api/v1/executions` para esa misma corrida.

[item1 deploy 6 flujos] · intento 1/3 · hipótesis: basta con
`node setup.js --only=n8n_flows --yes` (usa las ids existentes en
.setup-state.json y crea flow-cleanup) · corrí el comando · **FALLÓ**: PUT de
flow-handoff → 400 "Cannot publish workflow: ... Missing or invalid required
parameters: workflowInputs" en el nodo "Disparado por agente/webhook".

[item1 deploy 6 flujos] · intento 2/3 · hipótesis nueva: n8n v2.38.5 exige que
los nodos `executeWorkflowTrigger` de un workflow activo tengan
`workflowInputs.values` definido; los triggers de flow-agent y flow-handoff
tienen `parameters:{}` desde siempre (nunca se habían vuelto a desplegar con
esta versión de n8n) · agregué `workflowInputs.values` a ambos triggers, con
los campos que sus llamadores reales mandan (flow-agent: waId, via;
flow-handoff: mode, waId, conversationId, razon, categoria, lastClientMessage,
ownerText) (commit e346586) · **VERDE** — `node setup.js --only=n8n_flows`
actualizó los 6 sin error; `/api/v1/workflows` muestra los 6 con
`updatedAt: 2026-09-11T14:3x` (ninguno en `2026-09-10T00:22:56.111Z`), los 6
`active:true` tras `node setup.js --only=n8n_activate`. Dato crudo:
```
turnos · flow-agent    | 3wxbZJ2Dr1CHJO3Y | active: true | updatedAt: 2026-09-11T14:36:52.083Z
turnos · flow-cleanup  | k2W7gnMNKumsX5S1 | active: true | updatedAt: 2026-09-11T14:36:53.087Z
turnos · flow-handoff  | a9vIsUBOxtAh4uGP | active: true | updatedAt: 2026-09-11T14:36:51.758Z
turnos · flow-recovery | vRQ8I19BCmv8hjDU | active: true | updatedAt: 2026-09-11T14:36:52.878Z
turnos · flow-reminder | F54OCcSLeBGpmSDy | active: true | updatedAt: 2026-09-11T14:36:52.582Z
turnos · flow-webhook  | QwVWpRgatxNFxwgr | active: true | updatedAt: 2026-09-11T14:36:52.342Z
```

[item4/5 primer intento de correr los 5 escenarios] · verificación (no cuenta
para el contador de item1) · al arrancar los escenarios contra el webhook
real, el puerto 3999 (donde n8n manda las respuestas de WhatsApp) ya lo tenía
tomado una sesión interactiva del usuario (`node scripts/simulator.js`, PID
465615, pts/9) · cambié de estrategia: en vez de `createSimulator()` (levanta
su propio capture server), posteo directo a `N8N_WEBHOOK_URL` y verifico
contra `runs` + `/api/v1/executions`, sin tocar el puerto 3999 · escenario 1
nunca generó fila en `runs`: la ejecución de flow-webhook (id 209) terminó en
`status: error` en el nodo **"Opt-out · Datos"** —
`NodeOperationError: Query Parameters must be a string of comma-separated
values or an array of values`. Bug real en el código de B1 de esta misma
rama, no relacionado con Gemini.

[bug Opt-out · Datos] · intento 1/3 · hipótesis: los 3 nodos Postgres de B1
(`Opt-out · Datos`, `Opt-out · Marcar baja`, `Opt-out · Reconsentir`) usan
`queryReplacement` como expresión ESCALAR (`={{ $('Nodo').item.json.waId }}`)
en typeVersion 2.4, copiando el patrón de `Dedup · Insertar wamid` — pero ese
nodo referencia `$json.wamid` (el ítem ACTUAL, sin cruzar de nodo); los 3 de
B1 hacen referencia CRUZADA a otro nodo (`$('Extraer mensaje')`,
`$('Opt-out · Evaluar')`). El propio `flow-agent.json` documenta en su
`meta.notas` que los Postgres con parámetros de OTRO nodo van en typeVersion
2.6 con `queryReplacement` como ARRAY explícito ("evita el split por coma") —
y así están los que sí corren bien hoy (ej. "Cargar contexto"). Los 3 nodos de
B1 no seguían esa convención · cambié `queryReplacement` a
`={{ [$('Nodo').item.json.waId] }}` (array) y `typeVersion` 2.4→2.6 en los 3
nodos, sin tocar `Dedup · Insertar wamid` (que sí funciona tal cual está) ·
redeploy hecho (`node setup.js --only=n8n_flows`) · smoke test de "BAJA" contra
un teléfono nuevo: "Opt-out · Datos" ya no tira el error de antes, pero aparece
uno NUEVO en "Opt-out · Marcar baja": `null value in column "phone" ...
violates not-null constraint`. Bug distinto — sigo analizando antes de dar por
bueno el fix.

[bug null waId] · intento 1/3 · hipótesis: mi propio script de prueba arma el
payload del webhook mal formado — le puse `wa_id` en `contacts[0]` pero NUNCA
`from` en el objeto `messages[0]`, y "Extraer mensaje" (código del producto,
sin tocar) hace `const waId = msg.from`. Con `msg.from` undefined, `waId`
queda `undefined` en cascada por todo el resto de la cadena (Opt-out ·
Evaluar → Opt-out · Marcar baja), y JSON.stringify omite las claves
`undefined`, por eso el output de "Opt-out · Evaluar" no tenía ni rastro de
`waId`. Esto probablemente también explica el error ORIGINAL de "Opt-out ·
Datos" (mismo payload mal armado en el intento anterior) — el fix a
array+2.6 puede no haber sido la causa real, pero coincide con la convención
documentada del propio repo así que lo dejo · arreglé mi script de prueba
(agregué `from` al objeto `messages[0]`, como hace `scripts/simulator.js`
en su `textMessage()`), NO toqué ningún blueprint · reintenté el smoke test de
"BAJA" → **VERDE**: exec 213 `status: success`, corrieron los 13 nodos de la
cadena incluido "Opt-out · Avisar" y "Opt-out · Fin (baja)" sin error, y
`clients` quedó `{phone: '5491100000199', opted_out: true, opted_out_at:
2026-09-11T14:49:21.428Z}`. Confirmé además que NO se disparó flow-agent
(últimas ejecuciones siguen siendo la 197 de las 13:55, ninguna nueva) — cumple
"no se llama a flow-agent, no se gasta un token".

**[item4 caso 3 "BAJA" → opted_out]** → **VERDE**, verificado con dato crudo de
arriba (exec 213 + fila de `clients`).

[bug migraciones nunca aplicadas a la base real] · intento 1/3 · corrí los 5
escenarios completos (payload ya corregido) · caso 2 (servicio inexistente),
caso 3 (BAJA, visto arriba) y caso 4 (baja médica) dieron bien: `opted_out:
false` en el caso 4, confirmando también en una conversación real (no solo en
el matcher aislado) que la frase ambigua no dispara la baja. Caso 1 (4
servicios) siguió fallando: el modelo respondió "tuve un problemita para
chequear la disponibilidad". Caso 5 (2+ rondas) directamente no generó fila en
`runs` (timeout) — la ejecución de n8n (exec 224) sí corrió pero terminó en
`status: error`. · hipótesis: reproduje a mano la query exacta de
consultar_disponibilidad con los mismos argumentos que mandó el modelo →
`ERROR: function get_availability(date, uuid[], uuid) does not exist`. Hasta
ahora asumí que desplegar los blueprints alcanzaba; nunca corrí las
migraciones SQL de los bloques A/B sobre la base real (`.env` DATABASE_URL) —
sólo las probé contra contenedores Postgres efímeros durante el desarrollo.
`schema_migrations` en la base real solo tenía `20260909_0001_initial` ·
corrí `node update.js --check` (confirmó `faltante` las dos migraciones) y
`node update.js --yes --force-checksum` (el checksum de la migración inicial
estaba marcado `applied_via_mcp`, no el hash real — metadato, no drift de
contenido) · **la migración 0002 falló**: `function name "book_appointment"
is not unique` — bug real de la migración (ver commit cb1aeb0: CREATE OR
REPLACE no pisa una función cuando cambia la cantidad de parámetros, quedaban
2 book_appointment ambiguos) · arreglé la migración (DROP FUNCTION IF EXISTS
de la firma vieja antes del CREATE), reintenté `update.js` → **aplicó las 2
migraciones limpio**. Verificado: `pg_proc` muestra un solo book_appointment
(6 params) y slot_fits_schedule existe; la query de consultar_disponibilidad
con 4 servicios ya no tira error y devuelve slots reales.

[bug pairedItem en 2ª iteración del bucle] · intento 1/3 · con las migraciones
aplicadas, reintenté escenario 5 vía `/api/v1/executions/224?includeData=true`
→ `status: error`, nodo "Construir waPayload":
`ExpressionError: Paired item data for item from node 'Postgres · Herramienta'
is unavailable` (`descriptionKey: pairedItemNoInfo`, `nodeCause: 'Postgres ·
Herramienta'`). "Ejecutar herramienta (armar)" había corrido 2 veces (bucle de
B4 funcionando), y en la 2ª iteración "Modelo · Llamar 2" falló (maxTries=2 ya
consumidos) → cayó a "Resp · fallback" → "Construir waPayload" no pudo
resolver `$('Construir contexto modelo').item.json` porque el linaje de ítems
pareados tenía que cruzar las 2 corridas de "Postgres · Herramienta" y n8n no
lo resuelve · hipótesis: reemplazar `.item` por `.first()` en toda referencia
posterior al bucle a un nodo que corre a lo sumo una vez por ejecución
(Construir contexto modelo, Disparado por webhook/recovery, Modelo ·
Normalizar) — `.first()` no camina la cadena de pairedItem, es equivalente
para un nodo sin ambigüedad · aplicado (commit 6bd0a90), redeploy, reintenté
escenario 5 con teléfono nuevo (`5491100000205`) → **VERDE**: exec 231,
`status: success`, sin errores, respuesta real ("No tenés ningún turno
agendado... Para el sábado con Carla hay lugar..."), aunque esa corrida en
particular resolvió las 2 herramientas en 1 sola ronda (fan-out). Para probar
el caso específico que rompía (2 rondas REALES, secuenciales) armé un turno de
prueba y pedí cancelarlo ("buscar turno" → usar su id → "cancelarlo", no se
puede resolver en paralelo) → **exec 234, `status: success`, "armar" corrió
2x, sin errores**, `appointments.status` pasó a `'cancelled'` en la base, y la
respuesta fue real ("Listo, ya te cancelé el turno del lunes con Carla").

**[item4 caso 5 "2+ rondas de herramientas" → contenido real]** → **VERDE**,
doble evidencia: exec 231 (fan-out en 1 ronda) y exec 234 (2 rondas
secuenciales reales, con efecto en la base verificado).

[bug hora UTC vs hora local] · intento 1/3 · con las 2 migraciones y el fix de
pairedItem aplicados, reintenté escenario 1 (4 servicios) con teléfono nuevo
(`5491100000201`) → el modelo SÍ recibió slots reales de
`consultar_disponibilidad` (incluido 2026-09-12T13:00:00+00:00 = 10:00 ART)
pero respondió "Para las 10:00 no tengo lugar con Carla el sábado, pero sí a
partir de las 12:00" — dato mal leído por el modelo, no un error de código ·
verifiqué con la query cruda contra la base real y con el output exacto que
recibió el modelo (`Postgres · Herramienta` / `Componer resultado tool` de esa
ejecución): el dato ERA correcto, el modelo no convirtió el offset UTC a la
zona horaria del negocio · hipótesis: dejar de pedirle al modelo la cuenta de
huso horario, que es exactamente lo que este proyecto evita en todos lados
("la IA nunca calcula fechas") · agregué un campo `hora` (ya convertido a
business.timezone con `to_char`) en `consultar_disponibilidad` y
`consultar_turnos_cliente`, y una línea en `rules.md §1` diciendo que para
hablar con la persona se usa siempre `hora`, nunca `inicio` a mano (commit
61de5e1) · redeploy hecho · reintenté escenario 1 con teléfono nuevo
(`5491100000301`), misma pregunta ("...a las 10 de la mañana...") →
**VERDE**: respuesta "Listo, ya te agendé el turno con Carla para el sábado a
las 10:00 para corte, color, brushing y manicura." y en `appointments`:
`starts_at 2026-09-12T13:00:00.000Z` (=10:00 ART), `ends_at
2026-09-12T17:15:00.000Z`, `duracion {hours:4, minutes:15}` = 255 min = 45
(Corte) + 120 (Color) + 30 (Brushing) + 60 (Manicura), `servicios: [Brushing,
Color, Corte, Manicura]`.

**[item4 caso 1 "4 servicios" → reserva con duración = suma]** → **VERDE**,
dato crudo arriba (fila real de `appointments` + `appointment_services`).

**Los 5 casos del item4 están VERDES.**

[item5 sin "Listo." tras el deploy] · verificación directa · `SELECT ...
FROM runs WHERE created_at::date = CURRENT_DATE AND created_at >
'2026-09-11T14:36:52Z'` (hora del primer deploy de hoy) → 7 corridas, **0 con
`response_text = 'Listo.'`**. El único "Listo." de hoy fue a las 13:57:02,
ANTES del primer deploy de esta rama (bug preexistente, documentado en la
sesión anterior). → **VERDE**.



