# Plan de trabajo — agente-turnos-ia

> **Para Claude Code.** Este archivo es la fuente de verdad de qué hay que hacer.
> Leelo entero antes de tocar nada. Ejecutá las tareas **en orden**. No improvises
> alcance: si algo te parece que también habría que arreglar y no está acá,
> anotalo en la sección "Hallazgos nuevos" del final y seguí con tu tarea.

Origen: auditoría del commit `155ac73` (10 sep 2026). Se verificaron 20/20 tests
verdes contra un Postgres 16 real y se confirmaron 11 hallazgos ejecutando pruebas
propias contra la base. Este plan cubre los 11.

**Objetivo final:** dejar el template sólido, adaptado a consultorios odontológicos,
y con una instalación de demo a la que un prospecto le pueda escribir por WhatsApp
desde su celular.

---

## Reglas de ejecución

1. **Una tarea por vez, en orden.** No arranques la siguiente hasta cerrar la anterior.
2. **Toda tarea termina con los tests en verde.** Corré `cd scripts && node test-unit.js`
   antes y después de cada tarea de los bloques A y B. Si algo falla: **frená,
   reportá qué falló, y no avances.** No comentes un test para que pase.
3. **Los tests crecen.** Cada tarea que arregla un bug agrega el test que lo hubiera
   atrapado. Al terminar el bloque B el runner tiene que dar **28/28**, no 20/20.
4. **Un commit por tarea**, con el id en el mensaje: `A1: valida ventana horaria en book_appointment`.
5. **Todo cambio de esquema va como migración nueva** en `database/migrations/`
   (nombre `AAAAMMDD_000N_descripcion.sql`, envuelta en transacción, con su entrada
   en `schema_migrations`) **y además** se refleja en `database/schema.sql`, que es
   el snapshot canónico. Los dos, siempre.
6. **Nunca** toques `.env`, nunca pongas secretos en un archivo versionado, nunca
   borres datos de cliente. Servicios y profesionales se dan de baja con
   `active = false`, no con DELETE.
7. Si una tarea te lleva a cambiar la firma de una función SQL, **buscá todos los
   llamadores** antes de dar por cerrada la tarea. Los flujos de n8n llaman a las
   funciones por SQL crudo dentro de nodos Code: `grep -rn "nombre_funcion" blueprints/`.

---

## Estado de partida

| | |
|---|---|
| Commit base | `155ac73` |
| Tests | 16 SQL + 4 JS = 20, todos verdes |
| Stack | n8n · Supabase (Postgres) · Redis · WhatsApp Cloud API |
| Rubro actual del template | peluquería (seed "Bella Studio") |
| Rubro destino | consultorio odontológico |

---

# Bloque A — Integridad de la agenda

> **El patrón que estás arreglando:** hoy la validación vive del lado de la lectura
> y no del lado de la escritura. `get_availability` respeta horarios, feriados y
> excepciones con precisión. `book_appointment` no revisa nada de eso: confía en
> que el modelo copie un valor que salió de `get_availability`. Esa confianza está
> escrita en `agent/rules.md`, que es un prompt, no una restricción.
>
> Las tres tareas de este bloque van en **una sola migración**:
> `database/migrations/20260910_0002_validacion_ventana.sql`.

## A1 · Función `slot_fits_schedule()`

**Qué crear.** Una función SQL que responda si un rango `[starts_at, ends_at)` cae
entero dentro del horario laboral de un profesional y no pisa ninguna excepción.

```
slot_fits_schedule(p_professional_id uuid, p_starts_at timestamptz, p_ends_at timestamptz)
  RETURNS TABLE (fits boolean, reason text)
```

**Lógica.** Es la que ya existe adentro de `get_availability` (CTEs `work_windows`
y `applicable_exceptions`), extraída. Tiene que:

- Convertir `p_starts_at` a la zona del negocio para sacar el día y la hora locales.
- Verificar que exista **al menos una** fila de `schedule` para ese profesional y ese
  `day_of_week` que contenga el rango completo. Ojo con los turnos partidos: un
  profesional puede tener 9–13 y 15–19 el mismo día; el rango tiene que caber
  entero dentro de **una** de las franjas, no repartido entre las dos.
- Verificar que no se solape con ninguna fila de `schedule_exceptions` aplicable
  (`professional_id` NULL = feriado de todo el negocio; `time_from`/`time_to` NULL
  = día completo).
- Devolver `reason` con un texto claro en rioplatense cuando `fits = false`
  ("El profesional no atiende ese día", "El turno termina después del cierre",
  "Ese día está bloqueado: <reason de la excepción>").

**Terminado cuando.** La función existe en la migración y en `schema.sql`, y
`get_availability` fue refactorizada para usarla en lugar de repetir la lógica
(mismo resultado, sin duplicación). Los 8 tests existentes de `get_availability`
(05 a 09) siguen verdes sin tocarlos.

---

## A2 · `book_appointment` valida la ventana

**Problema verificado.** Estas tres llamadas crean el turno hoy, sin error:

```
book_appointment(..., local_ts(next_dow(6), '03:00'))   → creado (Carla atiende 9–19)
book_appointment(..., local_ts(next_dow(0), '10:00'))   → creado (domingo, sin schedule)
book_appointment(..., local_ts(feriado,     '10:00'))   → creado (get_availability daba 0 huecos)
```

**Qué hacer.** En `book_appointment`, después de calcular `v_ends_at` y **antes**
del INSERT, llamar a `slot_fits_schedule()` y hacer `RAISE EXCEPTION` con el
`reason` si no entra.

**Cuidado con el parámetro `p_force`.** `cancel_appointment` ya tiene uno para que
el handoff humano pueda saltarse la política. Agregale a `book_appointment` un
`p_force boolean DEFAULT false` con el mismo criterio: el dueño, por vía humana,
tiene que poder meter un turno fuera de horario. El agente **nunca** lo manda en
`true` — dejalo documentado en el comentario de la función.

**Tests que agregar** (`tests/unit/`, seguí la numeración y el estilo de los que ya están):

| Archivo | Verifica |
|---|---|
| `21_book_rejects_outside_hours.test.sql` | 03:00 un sábado tira excepción |
| `22_book_rejects_non_working_day.test.sql` | domingo tira excepción |
| `23_book_rejects_holiday.test.sql` | feriado en `schedule_exceptions` tira excepción |
| `24_book_force_bypasses_window.test.sql` | con `p_force := true` sí entra |

**Terminado cuando.** Los 4 tests nuevos pasan y los 20 viejos siguen verdes.

---

## A3 · `get_availability` con varios servicios

**Problema verificado.** `get_availability` recibe **un** `service_id` y calcula los
huecos con esa duración. `crear_turno` acepta un **array** y suma las duraciones.
Resultado real: ofrece las 18:00 para Corte (45 min, cierra 19:00), y al agregar
Color reserva **18:00–20:45**.

**Qué hacer.**

1. Cambiar la firma a `get_availability(p_date date, p_service_ids uuid[], p_professional_id uuid DEFAULT NULL)`.
   La duración es la **suma** de los servicios activos del array.
2. Los candidatos ahora son los profesionales que pueden hacer **todos** los
   servicios del array, no uno.
3. Mantené una sobrecarga con la firma vieja (`p_service_id uuid`) que llame a la
   nueva con `ARRAY[p_service_id]`, para no romper nada que quede colgado.
4. **Actualizá los llamadores**, que están fuera de la base:
   - `blueprints/flows/flow-agent.json`, nodo `Ejecutar herramienta (armar)`,
     case `consultar_disponibilidad`: hoy resuelve un solo nombre de servicio a id.
     Tiene que resolver un array.
   - `agent/tools.json`: el parámetro `servicio` de `consultar_disponibilidad` pasa
     a ser `servicios` (array de strings, `minItems: 1`), igual que en `crear_turno`.
     Actualizá también la `description` para que el modelo sepa que si la persona
     pide dos cosas en la misma visita, las manda juntas.
   - `agent/rules.md`: agregá una línea en la sección 1 — si la clienta pide más de
     un servicio para la misma visita, se consultan **juntos**, nunca por separado.

**Test que agregar.** `25_availability_multi_service_fits.test.sql`: con Corte (45)
+ Color (120) y cierre a las 19:00, las 18:00 **no** puede aparecer entre los huecos,
y el último hueco ofrecido tiene que terminar 19:00 o antes.

**Terminado cuando.** El test nuevo pasa, los anteriores siguen verdes, y
`grep -rn "get_availability" blueprints/ agent/` no devuelve ningún llamador con la
firma vieja.

---

# Bloque B — Seguridad y robustez del agente

## B1 · Opt-out real

**Problema verificado.** `agent/rules.md §5` promete que ante "BAJA" se marca la
baja en la base. `clients.opted_out` existe y se **lee** correctamente en
`flow-reminder` y en `notify_waitlist`. Pero no hay un solo `UPDATE` en todo el
repo que lo escriba. La clienta escribe BAJA, el bot confirma, y al día siguiente
le llega el recordatorio.

Esto no es solo una promesa incumplida: la persona bloquea el número, cae el
*quality rating* del número **del cliente**, y Meta termina limitándole el envío.

**Qué hacer.** La baja **no puede depender de que el modelo acierte**. Va detectada
en `blueprints/flows/flow-webhook.json`, antes de disparar `flow-agent`:

1. Nodo Code nuevo después de `Dedup · ¿Nuevo?`: normalizar el texto entrante
   (trim, mayúsculas, sacar acentos y signos) y compararlo contra
   `business.opt_out_keywords`.
2. Si matchea: `UPDATE clients SET opted_out = true, opted_out_at = now() WHERE phone = $1`,
   responder con un texto fijo (el de `rules.md §5`, sin pasar por el modelo), y
   **terminar el flujo**. No se llama a `flow-agent`, no se gasta un token.
3. Si no matchea: sigue el camino normal.

**Trampa importante.** **No** pongas `conversations.state = 'opted_out'`. El flujo
`flow-agent` frena cuando el estado no es `active`, y `rules.md` dice explícitamente
que si la clienta escribe de nuevo se la atiende normal. El opt-out corta los
mensajes que inicia el sistema, no las respuestas. `clients.opted_out` solo.

**Extra.** Agregá también la contrapartida: si un cliente con `opted_out = true`
escribe pidiendo un turno, el flujo lo vuelve a poner en `false` (escribir es
consentir de nuevo) y lo deja registrado.

**Test que agregar.** `26_optout_blocks_reminders.test.sql`: cliente con
`opted_out = true` y un turno confirmado dentro de la ventana de recordatorio no
aparece en la query de `flow-reminder`. (Copiá la query del nodo `Buscar turnos a
recordar` al test.)

---

## B2 · Conectar el validador de parámetros

**Problema verificado.** `scripts/lib/validate-tool-call.mjs` son 316 líneas
sólidas que validan tipos, formatos de fecha, E.164, UUID, enums y requeridos.
Cuatro de los 20 tests verdes lo cubren. **Ningún flujo lo usa.** El camino real en
producción es: salida del modelo → `Ejecutar herramienta (armar)` (un `switch` por
nombre) → SQL. Sin una sola validación en el medio.

O sea que 4 de los 20 tests verdes cubren código que no corre. Eso es peor que no
tener el validador, porque el tablero dice que estás cubierto.

**Qué hacer.**

1. Nodo Code nuevo en `flow-agent.json`, entre `¿Pidió herramienta?` y
   `Ejecutar herramienta (armar)`.
2. Portá la lógica de `validate-tool-call.mjs` a ese nodo. Los nodos Code de n8n no
   pueden importar archivos del repo, así que el código va inline y la spec de
   herramientas entra por el marcador `__AGENT_TOOLS__` que ya existe.
3. Si la validación falla: **no** se va a la base. Se arma un resultado de error
   (`{ error: "..." }`) y se lo devuelve al modelo como resultado de la herramienta,
   para que reintente o pregunte. Reusá el camino de `Componer resultado tool`.
4. Registrá el rechazo en `runs.error` para poder medir después cuántas veces pasa.

**Deuda que estás creando y hay que dejar anotada.** Ahora la lógica de validación
vive en dos lugares: el `.mjs` (que testean 17–20) y el nodo Code. Agregá al final
de `validate-tool-call.mjs` un comentario que diga que el flujo tiene una copia y
que los dos se tocan juntos. Es feo, es lo que hay con n8n, mejor explícito que
sorpresa.

---

## B3 · Unificar el match de servicios

**Problema verificado.** En `flow-agent.json`, nodo `Ejecutar herramienta (armar)`:

```
consultar_disponibilidad → lower(name) = lower($2)       ✓ case-insensitive
sumar_lista_espera       → lower(name) = lower($2)       ✓ case-insensitive
crear_turno              → name = ANY(ARRAY[...])        ✗ case-sensitive
```

Con "corte" en minúscula: la consulta de disponibilidad devuelve 1 match y la
reserva devuelve 0 → el `array_agg` queda NULL → `book_appointment` responde
"Se requiere al menos un servicio". El error que ve la clienta no tiene ninguna
relación con la causa.

**Qué hacer.** Que `crear_turno` matchee con `lower(name) = lower(...)`, igual que
las otras dos. Aprovechá y hacé lo mismo con `professionals`, que tiene el mismo
patrón inconsistente. Un solo criterio en todo el archivo.

---

## B4 · Bucle de herramientas y matar el `'Listo.'`

**Problema verificado.** Dos cosas en `flow-agent.json`:

1. `Ejecutar herramienta (armar)` toma `norm.toolCalls[0]`. Si el modelo pide dos
   herramientas, se ejecuta una y la otra se pierde en silencio.
2. Hay **una sola ronda** de herramientas. `Modelo · Normalizar 2` extrae solo el
   texto e ignora cualquier `tool_use` de la segunda llamada, y cierra con
   `text.trim() || 'Listo.'`.

La consecuencia de (2) es el peor fallo posible en un bot de turnos: si el modelo
responde en la segunda vuelta únicamente con una llamada a herramienta y sin texto,
**la clienta recibe la palabra "Listo."** y no se hizo absolutamente nada. Parece
una confirmación.

**Qué hacer.**

1. Convertir el tramo modelo → herramienta → modelo en un **bucle de hasta 3 rondas**.
   En n8n se hace con un nodo IF que vuelve al nodo de construcción del request
   mientras haya `toolCalls` y el contador sea menor a 3. Llevá el contador en el
   item.
2. Ejecutar **todas** las `toolCalls` de cada ronda, no solo la primera.
3. Al agotar las 3 rondas sin texto final, o ante cualquier respuesta vacía:
   **derivar a humano**, nunca inventar una confirmación. Reusá `Resp · fallback`,
   que ya hace exactamente eso.
4. Borrar el `|| 'Listo.'` de `Modelo · Normalizar 2`.

**Cuidado.** El límite de 3 no es decorativo: cada ronda es una llamada al modelo
con las 9 herramientas en el payload. Sin tope, una conversación rara te come tokens
y latencia.

---

## B5 · Sacar el tope de 3 servicios

**Problema.** En `crear_turno`, la query arma el array con
`NULLIF($3,''), NULLIF($4,''), NULLIF($5,'')` — tres posiciones fijas.
`agent/tools.json` no pone tope. Si el modelo manda cuatro servicios, el cuarto
desaparece sin error, sin log, y el turno queda más corto que lo acordado.

**Qué hacer.** Pasar el array de nombres como un solo parámetro
(`$3::text[]`) y resolverlo con `WHERE lower(name) = ANY(SELECT lower(unnest($3::text[])))`.
Sin posiciones fijas.

**Y validá la pérdida.** Si la cantidad de ids resueltos no coincide con la cantidad
de nombres pedidos, devolvé error nombrando cuál no se encontró. Un servicio que no
matchea nunca puede degradar en silencio a un turno más corto.

**Test que agregar.** `27_book_four_services.test.sql`: reservar 4 servicios y
verificar que la duración total del turno es la suma de los 4.

**Test que agregar.** `28_book_unknown_service_fails.test.sql`: reservar con un
nombre de servicio inexistente tira excepción en vez de crear un turno corto.

> **Corte de bloque.** Al terminar B, `node scripts/test-unit.js` tiene que dar
> **28/28**. Si da 20/20, te faltaron los tests nuevos.

---

# Bloque C — Adaptación a consultorios odontológicos

> El template está escrito para peluquerías y se nota en el idioma: el seed es
> "Bella Studio" con Corte, Color y Manicura, y `identity.md` y `rules.md` dicen
> "la clienta" en femenino a lo largo de todo el prompt.

## C1 · Lenguaje neutro

**Archivos:** `agent/identity.md`, `agent/rules.md`, y de paso los comentarios de
`database/schema.sql` que dicen "la clienta".

**Qué hacer.** Reemplazar "la clienta" por "la persona" o "el paciente" según
contexto, y neutralizar los ejemplos. **Mantené el voseo rioplatense**: eso está
bien y es parte del valor.

**Cuidado con los ejemplos de `identity.md`.** Los pares mal/bien están escritos con
vocabulario de peluquería ("te agendo corte con Caro el viernes"). Reescribilos con
vocabulario de consultorio, no los borres: son lo que más le enseña el tono al modelo.

**No toques** la estructura de tres capas ni el orden de las reglas. Solo el idioma.

---

## C2 · Regla dura de no-respuesta clínica

**Contexto.** `rules.md §3` ya tiene la categoría "consejos fuera de alcance" y la
cubre casi entera. Falta hacerla explícita para salud, que es donde el costo de
equivocarse deja de ser una discusión y pasa a ser un problema del odontólogo.

**Qué agregar a `agent/rules.md`:**

1. El asistente **no** responde nada clínico: si un tratamiento corresponde, cuánto
   va a doler, cuánto tarda en sanar, si un síntoma es grave, si un implante es
   viable. Nada. Reencauza al turno o deriva.
2. **Sí** responde: precios de lista, duración de la consulta, obras sociales que se
   atienden, horarios, dirección, formas de pago.
3. Ante cualquier mención de dolor agudo, sangrado, hinchazón o urgencia →
   `derivar_a_humano` con categoría `fuera_de_alcance`, en el primer mensaje, sin
   intentar resolver. Agregá esto como **sexto disparador** en la sección 4.

**Y una vuelta de tuerca de producto.** En odontología el handoff importa más que el
agendamiento: alguien que pregunta por un implante quiere hablar con una persona.
Antes de derivar, el agente tiene que haber capturado el nombre y el motivo en una
línea, para que el `razon` que recibe el dueño sirva de algo. Ajustá la descripción
del parámetro `razon` en `agent/tools.json` para pedir eso explícitamente.

---

## C3 · Seed de demo "Consultorio Demo"

**Archivo nuevo:** `database/seed-demo-odonto.sql`. **No borres** `seed-demo.sql`:
el de peluquería sigue sirviendo para otros rubros y varios tests de `test-eval.js`
asumen Corte/Color.

**Qué tiene que crear.**

- Negocio "Consultorio Demo", TZ Argentina, política de cancelación 24 h.
- Servicios con precios reales del rubro a septiembre 2026: *Consulta de
  diagnóstico* (30 min), *Limpieza* (45 min), *Implante — primera consulta*
  (45 min), *Ortodoncia — primera consulta* (45 min). Precios de consulta, no del
  tratamiento completo — el implante completo va de $550.000 a $650.000 ARS y ese
  número no se pone como precio de un turno.
- Dos profesionales con especialidades distintas, para que se ejercite el filtro de
  `professional_services`.
- Horario de lunes a viernes con **turno partido** (9–13 y 15–19): es lo normal en
  un consultorio y además ejercita el caso que más se rompe.
- Un feriado cargado en `schedule_exceptions` dentro de los próximos 30 días.
- Una agenda parcialmente ocupada, para que el demo no muestre todo libre —
  seguí el criterio de `reset-demo.js`, que ya hace esto para peluquería.

**Actualizá `scripts/reset-demo.js`** para que acepte `--rubro=odonto` y use este
seed. Default sigue siendo peluquería.

---

# Bloque D — Dejar el demo mostrable

## D1 · `install.sh`

**Problema.** `README.md` dice
`curl -fsSL https://raw.githubusercontent.com/.../install.sh | bash` y **ese archivo
no existe en el repo**. Es lo primero que va a intentar cualquiera a quien le
muestres esto.

**Qué hacer.** Lo más simple que sea honesto: un `install.sh` que verifique Docker,
Docker Compose y Node 18+, clone el repo, copie `.env.template` a `.env` si no
existe, e imprima el próximo paso (`/crear-agente-turnos` en Claude Code). Que
**no** intente configurar nada solo: la configuración es conversacional, así está
diseñado el `SKILL.md` y está bien así.

Si te parece que no vale la pena, la alternativa aceptable es sacar esa sección del
README. Lo que no puede quedar es la promesa rota.

---

## D2 · Puesta en marcha del demo

**Archivo nuevo:** `walkthroughs/07-demo-odontologia.md`.

**El punto que decide todo esto, leelo antes de escribir nada.** El número de prueba
que da Meta gratis **solo puede conversar con hasta 5 destinatarios verificados a
mano**. Sirve para que vos pruebes, no sirve para que un prospecto le escriba desde
su celular sin que vos lo agregues antes. Para un demo que se manda por WhatsApp en
una reunión hacen falta **dos etapas**, y el walkthrough tiene que decirlo con todas
las letras:

**Etapa 1 — validación interna (número de prueba de Meta).**
Gratis, inmediato. Agregás tu número y uno más como destinatarios verificados,
levantás el stack local con `docker compose up -d`, corrés el proceso `crear` del
`SKILL.md` con el seed de C3, y chateás de verdad. Sirve para verificar que todo el
circuito funciona punta a punta.

**Etapa 2 — demo para prospectos (número real).**
Un número propio —una línea aparte, no tu WhatsApp personal— registrado en la
WhatsApp Business Platform. Recibir e iniciar conversaciones no tiene costo dentro
de la ventana de 24 h, así que un demo de bajo volumen sale prácticamente cero.
Este es el número que le pasás al odontólogo en la reunión.

**Timing, que es lo que más importa.** Las 4 plantillas de
`walkthroughs/03-plantillas-whatsapp.md` tardan **de horas a días** en aprobarse.
El walkthrough tiene que abrir diciendo que **esto se arranca el día 1, en paralelo
con el bloque A**, no al final. Si dejás las plantillas para el último día, el demo
se atrasa una semana por un trámite.

**Cerrá el archivo con un checklist de "demo listo":**

- [ ] Un desconocido le escribe al número y agenda un turno sin ayuda.
- [ ] Pide un horario fuera del horario de atención y el bot lo rechaza bien (bloque A).
- [ ] Pregunta algo clínico y el bot deriva sin opinar (C2).
- [ ] Escribe BAJA y deja de recibir recordatorios (B1).
- [ ] Cancela dentro de las 24 h y el bot deriva a humano en vez de cancelar solo.
- [ ] Llega el recordatorio con sus tres botones.

---

# Bloque E — Higiene

## E1 · Doble recordatorio y rotación de tablas

**Dos cosas chicas, un solo commit.**

**1. `reminders_sent` se registra después de enviar.** En `flow-reminder.json` el
orden es: mandar el WhatsApp → insertar la fila. Si el envío sale bien y el INSERT
falla, la hora siguiente el cron lo manda de nuevo. Invertí el orden: insertá
primero (el `UNIQUE (appointment_id, reminder_type)` te hace de candado) y borrá la
fila si el envío falla.

**2. Rotación.** `database/docs/schema-decisions.md` documenta que `runs` y
`processed_messages` se pueden rotar, pero no está implementado. En el plan gratuito
de Supabase el disco es un límite que llega antes de lo que uno cree. Agregá un
`flow-cleanup` con cron diario que borre `processed_messages` de más de 7 días y
`runs` de más de 90. Anotá los dos números en `config/project.json → runtime` para
que sean configurables.

---

# Lo que NO se hace en este plan

Está acá para que no lo empieces por iniciativa propia a mitad de camino.

| | Por qué no ahora | Cuándo |
|---|---|---|
| **Multi-tenant** (`business_id` en cada tabla, resolución de inquilino por `phone_number_id`) | Es un día y medio hoy y una semana con clientes en producción. Pero hacerlo ahora es construir sobre suposiciones que tres clientes reales te van a corregir. | Cliente 5 |
| **Panel web para el dueño** | Toda la operación pasa hoy por Claude Code y por WhatsApp. El panel es lo que se pide antes de tener a quién dárselo. | Cliente 10 |
| **Facturación automática** | Con menos de 10 clientes, cobrar a mano es más rápido que integrarlo. | Cliente 10 |
| **RLS en Supabase** | Está bien desactivada mientras todo entre por n8n con la service key. Se activa cuando exista el panel. | Junto con el panel |
| **Segundo rubro** | El valor del template está en que el cliente 15 se configure igual que el 3. | No antes de 10 clientes odontológicos |

---

# Orden y tiempos

| Bloque | Tareas | Estimado | Se puede en paralelo |
|---|---|---|---|
| A | A1 · A2 · A3 | 1,5 días | No — es la base de todo |
| B | B1 · B2 · B3 · B4 · B5 | 1,5 días | No |
| C | C1 · C2 · C3 | 0,5 día | Sí, con A y B |
| D | D1 · D2 | 2 días | **Sí — arrancá D2 el día 1** |
| E | E1 | 0,5 día | Sí, al final |

**Total: unos 4 días de trabajo efectivo**, repartidos en una semana calendario si
las plantillas de Meta se aprueban rápido.

**Si tenés que cortar por tiempo**, el orden de sacrificio es: E, después D1,
después C1. Lo que **no** se saca nunca: A completo, B1 y B4. Esos cuatro son los
que rompen delante de un cliente.

---

# Hallazgos nuevos

> Si encontrás algo que no está en este plan, anotalo acá con el archivo y la línea
> en vez de arreglarlo de una. Se revisa al cerrar cada bloque.

_(vacío)_
