# Pendientes del plan de trabajo

> Estado al 10 sep 2026 (rama `plan-de-trabajo-a-c-d`).
>
> **Todo el plan (A, B, C, D, E) está implementado.** Lo que queda es
> **verificación en vivo**: las 7 tareas de cirugía sobre los blueprints de n8n
> (A3-flujo, B1, B2, B3, B4, B5-flujo, E1) se revisaron a nivel JSON y su SQL se
> probó contra un Postgres 16 real, pero **no se corrieron dentro de n8n**. Antes
> de publicar hay que pasar `scripts/simulator.js` contra una instancia viva.
>
> Suite de tests unitarios: **28/28 en verde**.

---

## Hecho

### Bloque A — integridad de la agenda
| | | Verificación |
|---|---|---|
| **A1** | `slot_fits_schedule()`; `get_availability` refactorizada para usarla | tests 05–09, 21–25 |
| **A2** | `book_appointment` valida la ventana; `p_force` para el handoff | tests 21–24 |
| **A3 (SQL)** | `get_availability(date, uuid[], uuid)` + sobrecarga vieja; `tools.json`, `rules.md` | tests 18–20, 25 |
| **A3 (flujo)** | `flow-agent.json` nodo `Ejecutar herramienta (armar)` → `consultar_disponibilidad` resuelve `a.servicios` (array) contra `services`; si un nombre no resuelve, corta con error en vez de dar disponibilidad parcial | SQL contra Postgres 16 |

### Bloque B — seguridad y robustez del agente
| | | Verificación |
|---|---|---|
| **B1 (SQL)** | test 26: la query de recordatorios excluye `opted_out = true` | test 26 |
| **B1 (flujo)** | `flow-webhook.json` cadena `Opt-out · …` tras `Dedup · ¿Nuevo?`: normaliza el texto, compara contra `business.opt_out_keywords`, si matchea hace upsert `clients.opted_out=true` + `opted_out_at`, responde el texto fijo de `rules.md §5` por la Graph API y termina (sin `flow-agent`). Si no matchea y el cliente estaba en opt-out, lo vuelve a `false`. Nunca toca `conversations.state` | normalización (11 casos), SQL de los 3 nodos |
| **B2** | `flow-agent.json` nodo `Validar params` entre `¿Pidió herramienta?` y `Ejecutar herramienta (armar)`: porta `scripts/lib/validate-tool-call.mjs` inline. Si un `toolCall` no valida → `Tool · Componer rechazo` arma la ronda 2 con el error como resultado, sin ir a la base; `Registrar run` marca `params_invalidos` | paridad con el `.mjs` (21 casos), tests 17–20 |
| **B3** | `crear_turno` matchea servicios con `lower(name)` como el resto del archivo | SQL |
| **B4** | `Ejecutar herramienta (armar)` hace fan-out de **todas** las `toolCalls`; `Componer resultado tool` las junta; bucle de hasta 3 rondas vía `¿Otra ronda?`; se mató el `\|\| 'Listo.'` (en `Modelo · Normalizar 2` **y** en `Construir waPayload`); respuesta vacía / rondas agotadas → `Resp · fallback` (deriva a humano) | Code nodes parsean; grafo sin nodos inalcanzables |
| **B5 (SQL)** | `book_appointment` exige que todos los servicios resuelvan; migración `20260910_0003` | tests 27–28 |
| **B5 (flujo)** | `crear_turno` pasa los nombres como JSON (`$2::json`), sin tope de 3; si un nombre no resuelve → `ERROR: no encontré el servicio <nombre>` y no reserva | SQL |

### Bloque C — adaptación a consultorios odontológicos
C1 (lenguaje neutro), C2 (regla clínica dura + 6º disparador + `razon` con nombre+motivo), C3 (`seed-demo-odonto.sql`, `reset-demo.js --rubro=odonto`). `reset-demo.js` probado a mano en ambos rubros.

### Bloque D — demo mostrable
D1 (`install.sh`, corrido), D2 (`walkthroughs/07-demo-odontologia.md`).

### Bloque E — higiene
E1: `flow-reminder.json` reserva `reminders_sent` **antes** de enviar (el UNIQUE hace de candado) y borra la fila si el envío falla; `flow-cleanup.json` nuevo (cron diario, borra `processed_messages` > 7 días y `runs` > 90). Números en `config/project.json → runtime` y `.env.template`. Wire completo en `n8n-deploy.js` (`FLOW_ORDER`, `scalarMap`), `setup.js` y `blueprints/README.md`. `buildFlow` de los 6 flujos sin marcadores sin resolver.

Migraciones nuevas: `20260910_0002_validacion_ventana.sql`,
`20260910_0003_book_valida_servicios.sql`. Ambas reflejadas en `schema.sql`.

---

## Verificación en vivo pendiente (n8n)

Levantar el stack (`docker compose up -d`), correr `setup.js` con el seed de C3 y
pasar `scripts/simulator.js`. Chequear especialmente:

1. **A3 / B3 / B5 (flujo) — `consultar_disponibilidad` y `crear_turno`.**
   Confirmar que el nodo Postgres 2.6 pasa el string JSON (`$2::json`) como un
   solo parámetro sin partirlo por comas. Probar: pedir dos servicios juntos,
   pedir un servicio con nombre inexistente, pedir en minúscula.

2. **B1 — opt-out.** Escribir "BAJA" y variantes ("dame de baja", "no molesten
   más"): tiene que responder el texto fijo, marcar `opted_out=true` y NO llamar
   a `flow-agent`. Después escribir pidiendo un turno: tiene que volver a
   `opted_out=false` y atender normal. Verificar que "trabajar" u otras palabras
   con "baja" adentro NO disparan la baja.

3. **B2 — validación.** Forzar que el modelo pida `crear_turno` sin `hora_inicio`
   o con una fecha inválida: no tiene que tocar la base; el modelo tiene que
   pedir el dato que falta. Revisar que `runs.error` guarde `params_invalidos`.

4. **B4 — bucle y fin.** Los puntos más frágiles:
   - Resolución de *paired items* de `$('Componer resultado tool').item` y de
     `$('Ejecutar herramienta (armar)').all()` en la **2ª iteración** del bucle.
   - Alineación resultado↔herramienta cuando una de varias queries de la misma
     ronda tira error (`Postgres · Herramienta` con `continueErrorOutput` y las
     dos salidas hacia `Componer resultado tool`).
   - Que una segunda vuelta del modelo que responde SOLO con `tool_use` y sin
     texto termine en `Resp · fallback` (deriva), nunca en "Listo.".
   - Que el contador corte de verdad en 3 rondas.

5. **E1 — recordatorio.** Simular un fallo de envío (apuntar `WA_API_BASE` a un
   host muerto) y confirmar que `reminders_sent` queda sin la fila para que el
   próximo cron reintente. Confirmar que dos corridas seguidas no mandan dos
   veces.

6. **flow-cleanup.** Correr el workflow a mano y verificar los `DELETE`.

---

## Hallazgos nuevos

- **`book_appointment` — llamadas posicionales en los blueprints.** El nodo
  `Ejecutar herramienta (armar)` llama a `book_appointment(client, prof, svc, ts)`
  con 4 argumentos (casos `crear_turno` y `modificar_turno`). La firma nueva
  agrega `p_notes DEFAULT NULL` (pos. 5) y `p_force DEFAULT false` (pos. 6); las
  llamadas de 4 argumentos siguen funcionando. No hay que tocarlas.
- **`migrations/20260909_0001_initial.sql`** tiene en el header
  `template_version_when_applied = '1.2.0'` mientras `config/project.json` dice
  `1.0.0`. Cosmético (update.js recalcula), pero conviene unificar.
- **`get_availability` refactor — costo.** La versión nueva llama a
  `slot_fits_schedule()` una vez por slot candidato (STABLE, sin efectos). Para
  un día son ~40 llamadas por profesional: nada. Revisar solo si algún cliente
  tuviera cientos de franjas o se consultaran rangos largos.
- **`validate-tool-call.mjs` tiene una copia inline** en el nodo `Validar params`
  de `flow-agent.json`. Anotado al final del `.mjs`. Se tocan juntos; hay un test
  de paridad manual (comparar salidas contra los casos de tests 18–20).
- **`Modelo · Construir request 2`** sigue sin threadear contexto hacia adelante;
  `Modelo · Normalizar 2` lo recupera con `$('Componer resultado tool').item`.
  Es el patrón que ya usaba el resto del flujo, pero en un bucle es lo que más
  conviene mirar (punto 4 de arriba).
