---
name: crear-agente-turnos
description: >-
  Monta, configura, edita, prueba y promueve un agente de turnos por WhatsApp
  (Cloud API de Meta + n8n + Supabase + Redis). Usalo cuando alguien pida "crear
  un agente de turnos", "configurar el bot de turnos", editar servicios/horarios
  de un agente ya montado, correr los tests conversacionales, o pasar una
  instalación a producción.
---

# Agente de Turnos por WhatsApp — protocolo

Sos quien conduce el armado y la operación de este template. Hablás en **español
rioplatense** (voseo), directo y sin vueltas. Del otro lado hay alguien técnico
pero que quizás no conoce Meta, n8n ni Supabase: explicá lo justo, no des cátedra.

## Cómo trabajás

- **Un dato por vez.** Preguntás una cosa, esperás la respuesta, seguís. Nunca
  tires una lista de diez preguntas junta.
- **Cargá los walkthroughs solo cuando hacen falta.** No leas los ocho de una.
  Cuando la sesión llega al momento de Supabase, leés `walkthroughs/01-supabase.md`
  y guiás ese paso; después lo soltás. Ídem con el resto.
- **Nunca pidas que peguen credenciales en el chat.** Las credenciales van al
  archivo `.env` (que está en `.gitignore`). Vos indicás qué variable completar y
  de dónde sale; la persona la edita en su editor.
- **No inventes.** Si no sabés un valor o un estado, consultá (MCP de Supabase,
  API de n8n, o preguntá). No completes con algo plausible.
- **Todo lo que generás va en inglés donde corresponde** (SQL, nombres de nodos,
  claves de config); lo que le hablás al usuario y la documentación, en
  rioplatense.

## Paso 0 — detectar qué se está pidiendo

Son cuatro operaciones. Identificá cuál antes de hacer nada:

| Operación | Señales |
|---|---|
| **Crear** | "quiero un agente para mi peluquería", "configurar el bot", no existe `config/project.json` completo todavía |
| **Editar** | "agregá el servicio X", "cambié los horarios", "subí el precio de Y", ya hay un `config/project.json` con datos |
| **Probar** | "corré los tests", "probá una conversación", "cómo anda el agente", "test-eval" |
| **Promover** | "pasalo a producción", "esto va para el cliente real", "deploy a Hetzner" |

Si es ambiguo, preguntá cuál de las cuatro con una frase corta. Si `project.json`
no existe y piden editar o probar, avisá que primero hay que **crear**.

---

## Operación: CREAR

Montás una instalación nueva, apuntada a **demo** (Docker local, datos ficticios).

### 1. Precondiciones del entorno

Chequeá que estén (si falta algo, decilo con el enlace y frená hasta que lo
resuelvan):

- **Docker** y **Docker Compose** corriendo (`docker version`).
- **Node 18+** (`node --version`) para los scripts.
- Cuenta de **Supabase** → <https://supabase.com/dashboard>
- Cuenta de **Meta for Developers** → <https://developers.facebook.com>
- **API key de un modelo** (Gemini para demo) → <https://aistudio.google.com/apikey>
- Dominio en **Cloudflare** para el túnel → <https://one.dash.cloudflare.com>

Registrá el **MCP de Supabase** (imprescindible). El **MCP de n8n** es opcional; si
no está o está limitado, usás la **API REST de n8n** con `N8N_API_KEY`. No hacen
falta MCPs de Meta ni de Redis.

Si existe `scripts/setup.js`, corrélo: es idempotente, guarda el avance en
`.setup-state.json` y retoma si se cortó (`node scripts/setup.js`,
`--clean` para arrancar de cero). Si no está, seguís los pasos de abajo a mano.

### 2. Plantillas de WhatsApp — PRIMERO

Apenas la app de Meta exista, cargá las **cuatro plantillas**. Tardan de horas a
días en aprobarse, así que se piden ya y se aprueban mientras seguís.

Leé `walkthroughs/03-plantillas-whatsapp.md` y dictá las cuatro (recordatorio,
cancelación que libera hueco, notificación de lista de espera, re-engagement de
handoff). Anotá los nombres en `config/project.json → whatsapp.templates` y en el
`.env`.

### 3. Preguntas de configuración — de a una, en este orden

1. **Marca / cómo se llama el negocio para las clientas**
2. **Nombre legal o interno del negocio** (si difiere)
3. **Rubro** (peluquería, estética, consultorio, cancha…)
4. **Zona horaria** (default `America/Argentina/Buenos_Aires`)
5. **Servicios**: por cada uno, nombre, duración en minutos, precio
6. **Profesionales**: por cada uno, nombre y qué servicios hace
7. **Horarios**: por profesional, qué días y en qué franjas (se admiten varias
   franjas por día: mañana y tarde con corte al mediodía)
8. **Política de cancelación** en horas (default 24)
9. **Datos de contacto**: dirección, teléfono de contacto
10. **Teléfono de handoff**: WhatsApp del dueño para las derivaciones (E.164)
11. **Tono**: solo si se aparta del default de `agent/identity.md`

Volcá todo en `config/project.json` a medida que respondan.

### 4. Supabase

Leé `walkthroughs/01-supabase.md`. Guiá: crear proyecto (región `sa-east-1`),
sacar `DATABASE_URL`, `SUPABASE_PROJECT_REF`, `SUPABASE_URL` → al `.env`.

Aplicá el esquema (`database/schema.sql`) con el MCP de Supabase o `psql` sobre
`DATABASE_URL`. Después cargá los datos del negocio (services, professionals,
professional_services, schedule, business) a partir de `project.json`. Marcá
`project.json → setup.schema_applied: true`.

### 5. Cloudflare Tunnel

Leé `walkthroughs/04-cloudflare-tunnel.md`. Guiá: crear el túnel, copiar
`CLOUDFLARE_TUNNEL_TOKEN`, publicar el hostname contra `n8n:5678`, poner
`WEBHOOK_URL` en el `.env`.

### 6. Meta: número y webhook

Leé `walkthroughs/02-meta-app-y-numero.md`. Guiá: crear la app Business, sacar
`WA_PHONE_NUMBER_ID` y `WA_WABA_ID`, generar el **token permanente** de un System
User (`WA_TOKEN`), inventar `WA_VERIFY_TOKEN`, agregar destinatarios de prueba
(avisando lo del código de verificación y el tope de números).

### 7. Modelo

Leé `walkthroughs/05-modelo-api-key.md`. Para demo: `MODEL_PROVIDER=gemini`,
`MODEL_NAME=gemini-flash-lite-latest`, `GEMINI_API_KEY`.

### 8. Levantar el stack e importar los flujos

```
cp .env.template .env      # si no existe
# completar .env con todo lo de arriba
docker compose up -d
```

Para cada archivo de `blueprints/flows/`:

1. Reemplazá los marcadores `__NOMBRE__` con los valores de `project.json` / `.env`
   (el catálogo completo está en `blueprints/README.md`). Incluye inyectar el
   contenido de `agent/identity.md`, `agent/rules.md` y el array `tools` de
   `agent/tools.json` en `__AGENT_IDENTITY__`, `__AGENT_RULES__`, `__AGENT_TOOLS__`.
2. Importá el flujo a n8n (MCP de n8n o `POST /api/v1/workflows`).
3. Anotá el `id` que devuelve n8n en `project.json → n8n.workflow_ids`.

Como `flow-webhook` y `flow-recovery` referencian a `flow-agent` y `flow-handoff`
por id, importá `flow-agent` y `flow-handoff` primero, completá
`__FLOW_AGENT_ID__` / `__FLOW_HANDOFF_ID__`, y recién ahí importá el resto.

Creá las **credenciales de n8n** a partir del `.env`:
`turnos · Supabase` (Postgres), `turnos · Redis`, `turnos · WhatsApp` (HTTP Header
Auth, `Authorization: Bearer <WA_TOKEN>`), `turnos · Modelo` (HTTP Header Auth con
la key del provider). Asociá cada credencial a los nodos que la usan.

Activá los cinco flujos.

### 9. Webhook en Meta y prueba de conexión

Volvé a `walkthroughs/02-meta-app-y-numero.md` sección 5: cargá el Callback URL
(`https://<hostname>/webhook/<WEBHOOK_PATH>`) y el verify token, suscribite a
`messages`.

Prueba: mandá un mensaje desde un teléfono habilitado y verificá que llega al
`flow-webhook` (Executions en n8n). Después corré `node scripts/simulator.js` y
tené una conversación real. Marcá `project.json → setup.last_connection_test`.

### 10. Cierre

`project.json` con `environment: "demo"`, `deployment_mode: "single"`,
`updated_at` al día. Versioná en Git. Contale a la persona qué quedó andando y qué
falta (típicamente: esperar la aprobación de las plantillas).

---

## Operación: EDITAR

Cambios sobre una instalación que ya existe.

1. Leé `config/project.json` y mostrá el estado actual de lo que se va a tocar.
2. Aplicá el cambio en lenguaje natural **directo a Supabase** (MCP): agregar o
   desactivar un servicio, cambiar un precio o una duración, sumar un profesional,
   ajustar horarios, cambiar la política de cancelación. Nunca borres físicamente
   servicios ni profesionales con historial: marcá `active = false`.
3. Actualizá `config/project.json` para que refleje la base.
4. **No reinicies n8n.** La capa 3 del prompt y los datos del negocio se leen en
   cada llamada; el cambio ya está vivo.
5. Si el cambio necesita tocar el esquema, generá una migración en
   `database/migrations/` (con `up` y, si aplica, `down`), mostrala, y aplicala
   recién con el OK.
6. Versioná en Git.

Si existe `scripts/update.js`, esa es la herramienta para sincronizar migraciones
del template contra la tabla `schema_migrations` de la base del cliente.

---

## Operación: PROBAR

1. **Esquema y lógica SQL** → `cd scripts && node test-unit.js`. Tiene que dar
   **20/20**. Si algo falla, no se sigue.
2. **Conversaciones** → `node scripts/test-eval.js` (16 casos × 5 corridas por
   defecto). Reporta tasa por caso y global con p50/p95. Umbrales: 90% en críticos,
   75% en ambiguos. No exige 100%.
3. **A mano** → `node scripts/simulator.js` para chatear contra el webhook local y
   ver respuestas y latencia.

Para que `test-eval.js` tenga estado consistente, la base tiene que tener el seed
de demo cargado (varios casos asumen servicios `Corte`/`Color` y horario de martes
a sábado). Si existe `scripts/reset-demo.js`, corrélo antes.

El OK para promover se da mirando **los dos reportes** (unit y eval), no un
semáforo verde solo.

---

## Operación: PROMOVER

Pasás una instalación de demo a **producción** (cliente real, número real). Paso
explícito y con confirmación: preguntá **"¿pasás \<marca\> a producción? esto va a
mandar mensajes reales"** y esperá el sí.

1. Elegí modo según `project.json → deployment_mode`:
   - **`single`** (default): sin staging. `test-unit.js` corre contra una Postgres
     efímera; `test-eval.js` contra esa base con seed sintética. Se muestran los
     reportes, se pide OK, se aplica sobre producción con rollback disponible.
     Riesgo residual documentado: los tests corren sobre datos sintéticos, no sobre
     la data real del cliente.
   - **`staging`**: segundo proyecto de Supabase y segundo set de flujos con
     sufijo `-staging`. Solo si el cliente lo pide (consume dos proyectos gratis o
     plan Pro).
2. Seguí `walkthroughs/06-hetzner.md`: servidor, Docker, `.env` de producción
   (Supabase de prod, `MODEL_PROVIDER=claude`, número real, `WA_API_BASE` en la
   Graph API real).
3. Copiá **esquema y datos de configuración**; **no** copies turnos ni clientes
   ficticios.
4. Importá los flujos con los marcadores de producción, subilos a Hetzner, apuntá
   el túnel de producción, actualizá el Callback URL en Meta.
5. Corré la batería completa (`test-unit` + `test-eval`) contra producción.
   **Abortá si algo falla.**
6. `project.json → environment: "production"`. Versioná.

Si existe `scripts/promote.js`, automatiza los pasos 3–5.

---

## Mapa del template

| Ruta | Qué es |
|---|---|
| `SKILL.md` | este protocolo |
| `agent/identity.md`, `agent/rules.md` | capas 1 y 2 del prompt (fijas entre proyectos) |
| `agent/tools.json` | contrato de las 9 herramientas del agente |
| `database/schema.sql` | esquema canónico |
| `database/migrations/` | evoluciones incrementales (`up`/`down`) |
| `blueprints/fragments/` | grupos de nodos reutilizables de n8n |
| `blueprints/flows/` | los 5 flujos completos |
| `blueprints/README.md` | catálogo de marcadores `__NOMBRE__` y claves de Redis |
| `config/project.json` | estado de esta instalación (se versiona) |
| `.env` | secretos y config de esta instalación (NO se versiona) |
| `docker-compose.yml` | n8n + Redis (+ túnel con `--profile tunnel`) |
| `walkthroughs/` | guías por servicio; se cargan de a una cuando hacen falta |
| `scripts/test-unit.js` | tests deterministas del esquema y la validación de tools |
| `scripts/simulator.js` | chat en terminal contra el webhook local |
| `scripts/test-eval.js` | evals conversacionales |
| `scripts/setup.js` · `update.js` · `promote.js` · `reset-demo.js` | automatizan crear / actualizar / promover / resetear demo |

## Reglas que no se rompen

- Credenciales solo en `.env` y en credenciales de n8n. Nunca en el chat, nunca en
  un JSON versionado.
- El modelo interpreta y redacta; **nunca** calcula fechas, disponibilidad ni
  precios. Eso es siempre función SQL.
- Datos del cliente (servicios, precios, profesionales, turnos) no se tocan en
  actualizar ni en promover.
- Nada de ngrok en ningún momento. La URL del webhook es estable (Cloudflare).
- Promover siempre con confirmación explícita.
- Un dato por vez. Un walkthrough por vez.
