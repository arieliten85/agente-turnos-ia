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
verificación pendiente: redeploy + reintentar los escenarios.

