# Pendientes del plan de trabajo

> Estado al cerrar la tanda del 10 sep 2026 (rama `plan-de-trabajo-a-c-d`).
> Se ejecutó **todo lo verificable sin una instancia de n8n**: bloque A completo,
> las porciones SQL de B1 y B5, y los bloques C y D enteros. Suite de tests:
> **28/28 en verde**.
>
> Lo que queda es **cirugía sobre los blueprints de n8n** (`blueprints/flows/*.json`):
> nodos Code nuevos, recableado de conexiones y un bucle de herramientas. El
> `test-unit.js` no ejecuta flujos de n8n, así que estos cambios no se pueden
> verificar desde acá — necesitan la instancia viva y una corrida con
> `scripts/simulator.js`. Se dejan documentados con el detalle exacto.

---

## Hecho en esta tanda

| Tarea | Qué se hizo | Verificación |
|---|---|---|
| **A1** | `slot_fits_schedule()` nueva; `get_availability` refactorizada para usarla | tests 05–09 + 21–25 |
| **A2** | `book_appointment` valida la ventana antes del INSERT; `p_force` para el handoff | tests 21–24 |
| **A3 (SQL)** | `get_availability(date, uuid[], uuid)` + sobrecarga vieja; `tools.json` y `rules.md` al día | tests 18–20, 25 |
| **B1 (SQL)** | test 26: la query de recordatorios excluye `opted_out = true` (regresión) | test 26 |
| **B5 (SQL)** | `book_appointment` exige que todos los servicios resuelvan; no acorta en silencio | tests 27–28 |
| **C1·C2·C3** | lenguaje neutro, regla clínica dura, `seed-demo-odonto.sql`, `reset-demo.js --rubro=odonto` | reset-demo probado a mano en ambos rubros |
| **D1·D2** | `install.sh`, `walkthroughs/07-demo-odontologia.md`, README al día | `install.sh` corrido |

Migraciones nuevas: `20260910_0002_validacion_ventana.sql`,
`20260910_0003_book_valida_servicios.sql`. Ambas reflejadas en `schema.sql`.

---

## Pendiente — todo n8n (`blueprints/flows/`)

Todo esto se aplica junto, con la instancia de n8n arriba, y se valida con
`scripts/simulator.js` antes de publicar.

### A3 (parte n8n) — `consultar_disponibilidad` con array · **BLOQUEANTE**

**Archivo:** `blueprints/flows/flow-agent.json`, nodo `Ejecutar herramienta (armar)`,
case `consultar_disponibilidad`.

Hoy el nodo lee `a.servicio` (string) y llama a `get_availability($1::date,
(SELECT id FROM services WHERE lower(name)=lower($2) ...), ...)`.

`agent/tools.json` **ya cambió**: el modelo ahora manda `a.servicios` (array). Hasta
que este nodo lea el array, `consultar_disponibilidad` devuelve 0 huecos siempre.
La sobrecarga vieja de `get_availability(date, uuid, uuid)` sigue existiendo, así
que no rompe la base — pero el flujo hay que tocarlo sí o sí.

Cambio: resolver `a.servicios` (array de nombres) a `uuid[]` y llamar a la firma
nueva. Ojo con cómo el nodo Postgres de n8n pasa arrays — el resto del archivo
usa parámetros escalares posicionales (ver `crear_turno`), así que probablemente
haya que aplanar a `$2,$3,$4` con `ARRAY[lower(NULLIF($2,'')), ...]` o confirmar
que el nodo acepta `$2::text[]`. Se resuelve junto con B5.

### B1 (parte n8n) — opt-out real

**Archivo:** `blueprints/flows/flow-webhook.json`.

1. Nodo Code nuevo después de `Dedup · ¿Nuevo?`: normalizar el texto entrante
   (trim, mayúsculas, sin acentos ni signos) y compararlo contra
   `business.opt_out_keywords`.
2. Si matchea: `UPDATE clients SET opted_out = true, opted_out_at = now() WHERE
   phone = $1`, responder con el texto fijo de `rules.md §5` (sin pasar por el
   modelo) y **terminar el flujo**. No se llama a `flow-agent`.
3. Si no matchea: sigue el camino normal.
4. **Contrapartida:** si un cliente con `opted_out = true` escribe pidiendo un
   turno, volver a poner `opted_out = false` (escribir es consentir de nuevo).

**Trampa:** NO tocar `conversations.state`. El opt-out corta lo que inicia el
sistema, no las respuestas. `clients.opted_out` solo. La parte de lectura
(`flow-reminder`, `notify_waitlist`) ya filtra bien — test 26 lo fija.

### B2 (parte n8n) — conectar el validador de parámetros

**Archivo:** `blueprints/flows/flow-agent.json`.

1. Nodo Code nuevo entre `¿Pidió herramienta?` y `Ejecutar herramienta (armar)`.
2. Portar la lógica de `scripts/lib/validate-tool-call.mjs` **inline** (los nodos
   Code de n8n no importan archivos). La spec entra por el marcador
   `__AGENT_TOOLS__`.
3. Si la validación falla: no se va a la base. Se arma `{ error: "..." }` y se lo
   devuelve al modelo como resultado de la herramienta (reusar `Componer
   resultado tool`).
4. Registrar el rechazo en `runs.error`.
5. **Deuda:** dejar un comentario al final de `validate-tool-call.mjs` diciendo
   que el flujo tiene una copia y que las dos se tocan juntas.

### B3 (parte n8n) — unificar el match de servicios

**Archivo:** `blueprints/flows/flow-agent.json`, nodo `Ejecutar herramienta (armar)`.

`crear_turno` matchea servicios con `name = ANY(ARRAY[...])` (case-sensitive);
`consultar_disponibilidad` y `sumar_lista_espera` usan `lower(name) = lower(...)`.
Con "corte" en minúscula la reserva devuelve 0 y `book_appointment` responde "Se
requiere al menos un servicio", error que no tiene relación con la causa.

Cambio: `crear_turno` matchea con `lower(name) = lower(...)`. Lo mismo con
`professionals`, que tiene el mismo patrón inconsistente. Un solo criterio en
todo el archivo.

### B4 (parte n8n) — bucle de herramientas y matar el `'Listo.'`

**Archivo:** `blueprints/flows/flow-agent.json`.

1. `Ejecutar herramienta (armar)` toma `norm.toolCalls[0]`: ejecutar **todas** las
   `toolCalls` de cada ronda, no solo la primera.
2. Convertir el tramo modelo → herramienta → modelo en un **bucle de hasta 3
   rondas** (nodo IF que vuelve al armado del request mientras haya `toolCalls` y
   el contador sea < 3; contador en el item).
3. Al agotar las 3 rondas sin texto final, o ante cualquier respuesta vacía:
   **derivar a humano** (reusar `Resp · fallback`). Nunca inventar una
   confirmación.
4. Borrar el `|| 'Listo.'` de `Modelo · Normalizar 2`.

Es el peor fallo posible del bot: si el modelo cierra la segunda vuelta con solo
un `tool_use` y sin texto, hoy la persona recibe la palabra "Listo." y no se hizo
nada.

### B5 (parte n8n) — sacar el tope de 3 servicios

**Archivo:** `blueprints/flows/flow-agent.json`, nodo `Ejecutar herramienta (armar)`,
case `crear_turno`.

Hoy: `NULLIF($3,''), NULLIF($4,''), NULLIF($5,'')` — tres posiciones fijas. Un 4º
servicio desaparece sin error.

Cambio: pasar el array de nombres como un solo parámetro y resolverlo con
`WHERE lower(name) = ANY(SELECT lower(unnest($3::text[])))`. Sin posiciones fijas.
Si la cantidad de ids resueltos no coincide con la de nombres pedidos, error
nombrando cuál faltó.

La parte SQL ya está: `book_appointment` (migración `20260910_0003`) ahora **lanza
excepción** si algún servicio no resuelve, en vez de sumar solo los que matchean.
Falta que el nodo pase el array completo y muestre un mensaje útil.

### E1 — doble recordatorio y rotación de tablas (un solo commit)

1. **`blueprints/flows/flow-reminder.json`:** hoy el orden es mandar el WhatsApp →
   insertar en `reminders_sent`. Si el envío sale bien y el INSERT falla, la hora
   siguiente el cron lo manda de nuevo. Invertir: insertar primero (el `UNIQUE
   (appointment_id, reminder_type)` hace de candado) y borrar la fila si el envío
   falla.
2. **`flow-cleanup` nuevo** con cron diario: borrar `processed_messages` de más de
   7 días y `runs` de más de 90. Anotar los dos números en
   `config/project.json → runtime` (p. ej. `processed_messages_retention_days`,
   `runs_retention_days`) para que sean configurables.

---

## Hallazgos nuevos

- **`tools.json` ↔ `flow-agent.json` acoplados (A3).** El cambio de `servicio` a
  `servicios` en `consultar_disponibilidad` deja el flujo desincronizado hasta
  que se aplique la parte n8n de A3. La sobrecarga de compatibilidad de
  `get_availability` evita que rompa la base, pero el flujo devuelve 0 huecos.
  **No publicar `tools.json` sin el cambio de flujo.**
- **`book_appointment` — llamadas posicionales en los blueprints.** El nodo
  `Ejecutar herramienta (armar)` llama a `book_appointment(client, prof, svc,
  ts)` con 4 argumentos (casos `crear_turno` y `modificar_turno`). La firma nueva
  agrega `p_notes DEFAULT NULL` (pos. 5) y `p_force DEFAULT false` (pos. 6); las
  llamadas de 4 argumentos siguen funcionando. No hay que tocarlas, pero tenerlo
  presente si se agregan parámetros en el medio.
- **`migrations/20260909_0001_initial.sql`** tiene en el header
  `template_version_when_applied = '1.2.0'` mientras `config/project.json` dice
  `1.0.0`. Cosmético (update.js recalcula), pero conviene unificar.
- **`get_availability` refactor — costo.** La versión nueva llama a
  `slot_fits_schedule()` una vez por slot candidato (STABLE, sin efectos). Para
  un día son ~40 llamadas por profesional: nada. Si algún cliente tuviera cientos
  de franjas o se consultaran rangos largos, revisar.
