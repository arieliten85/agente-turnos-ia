# Blueprints de n8n

Piezas para armar los flujos del agente en n8n. Dos carpetas:

- **`fragments/`** — grupos de nodos reutilizables. No son flujos importables por sí
  solos: son la fuente canónica de cada pieza (buffer, lock, llamada al modelo,
  envío por WhatsApp, etc). Corregir una pieza acá y recomponer es más seguro que
  parchear un JSON monolítico.
- **`flows/`** — los 5 flujos completos, importables en n8n. Cada uno ya trae
  copiados los nodos de los fragments que compone.

## Marcadores

`setup.js` reemplaza estos marcadores al crear un proyecto (búsqueda literal de
texto sobre el JSON). Todos con la forma `__NOMBRE__`.

| Marcador | Qué es | Default |
|---|---|---|
| `__CRED_POSTGRES__` | Nombre de la credencial Postgres de n8n (Supabase del proyecto) | — |
| `__CRED_REDIS__` | Nombre de la credencial Redis de n8n | — |
| `__CRED_WHATSAPP__` | Credencial HTTP Header Auth con el token de Meta (`Authorization: Bearer <token>`) | — |
| `__CRED_MODEL__` | Credencial HTTP Header Auth con la API key del modelo | — |
| `__WEBHOOK_PATH__` | Segmento de path del webhook (aleatorio por instalación) | — |
| `__WA_VERIFY_TOKEN__` | Token de verificación del webhook de Meta | — |
| `__WA_API_BASE__` | Base de la API de envío. En prod la Graph API; en dev, la URL del capture server de `simulator.js` (ej `http://host.docker.internal:3999`) | `https://graph.facebook.com` |
| `__WA_GRAPH_VERSION__` | Versión de la Graph API | `v21.0` |
| `__WA_PHONE_NUMBER_ID__` | Phone Number ID de Meta | — |
| `__WA_TEMPLATE_LANG__` | Locale de las plantillas aprobadas | `es_AR` |
| `__WA_TEMPLATE_REMINDER__` | Nombre de la plantilla "recordatorio de turno" | — |
| `__WA_TEMPLATE_CANCELLATION__` | Nombre de la plantilla "cancelación que libera hueco" | — |
| `__WA_TEMPLATE_WAITLIST__` | Nombre de la plantilla "notificación de lista de espera" | — |
| `__WA_TEMPLATE_REENGAGEMENT__` | Nombre de la plantilla "re-engagement de handoff" | — |
| `__HANDOFF_PHONE_DIGITS__` | WhatsApp del dueño en E.164 sin `+` (para detectar sus respuestas) | — |
| `__REDIS_PREFIX__` | Namespace de las claves de Redis | `turnos` |
| `__MODEL_PROVIDER__` | `gemini` o `claude` | `gemini` |
| `__MODEL_NAME__` | ID del modelo (ej `gemini-flash-lite-latest`, `claude-sonnet-5`) | `gemini-flash-lite-latest` |
| `__BUFFER_SECONDS__` | Espera de debounce del webhook | `2.5` |
| `__BUFFER_TTL_SECONDS__` | TTL de las claves de buffer y contador | `60` |
| `__RECOVERY_STALE_SECONDS__` | Antigüedad para que recovery reprocese un buffer | `30` |
| `__REMINDER_TYPE__` | Etiqueta del recordatorio en `reminders_sent` | `24h` |
| `__AGENT_IDENTITY__` | `agent/identity.md` (capa 1) inyectado como literal string JS (`JSON.stringify` del contenido) | — |
| `__AGENT_RULES__` | `agent/rules.md` (capa 2) inyectado igual que identity | — |
| `__FLOW_AGENT_ID__` | ID del workflow `flow-agent` ya importado en n8n | — |
| `__FLOW_HANDOFF_ID__` | ID del workflow `flow-handoff` ya importado en n8n | — |

Los secretos (tokens, API keys, contraseña de la base) viven en **credenciales de
n8n**, nunca en el JSON. El resto de la configuración entra por marcador.

## Claves de Redis

`waId` = WhatsApp ID de la clienta = teléfono en dígitos (`from` del webhook).

| Clave | Uso | TTL |
|---|---|---|
| `__REDIS_PREFIX__:buffer:{waId}` | Array JSON de mensajes entrantes sin procesar | `__BUFFER_TTL_SECONDS__` |
| `__REDIS_PREFIX__:count:{waId}` | Contador de debounce (`INCR` por mensaje) | `__BUFFER_TTL_SECONDS__` |
| `__REDIS_PREFIX__:lock:{waId}` | Lock de conversación (lo toma `flow-agent`) | 120 s |
| `__REDIS_PREFIX__:pending:{waId}` | ISO ts de la actividad en buffer; lo borra `flow-agent` al responder; lo escanea `flow-recovery` | `__BUFFER_TTL_SECONDS__` |

## Modelo configurable

`fragments/llamada-modelo.json` arma el request según `__MODEL_PROVIDER__`:

- **gemini** → `POST .../v1beta/models/__MODEL_NAME__:generateContent`, herramientas
  como `function_declarations`, `system_instruction` aparte.
- **claude** → `POST https://api.anthropic.com/v1/messages`, herramientas nativas,
  header `anthropic-version`.

El contrato de herramientas sale de `agent/tools.json`. La auth va por
`__CRED_MODEL__`.

## Límites conocidos (del brief)

- **Buffer como string JSON**, no como lista Redis: el nodo Redis de n8n no expone
  `LRANGE`. `flow-webhook` hace GET+append+SET. La ventana de carrera entre dos
  webhooks casi simultáneos es de milisegundos; la cubren el bajo volumen, el lock
  de `flow-agent` y `flow-recovery`.
- **Lock sin `SET NX`**: mismo motivo. Se hace GET y luego SET. Peor caso: un
  mensaje respondido con demora, nunca sin responder.
- Cada mensaje entrante levanta una ejecución que espera en el `Wait`. Irrelevante
  para volumen de salón; si un cliente crece, se migra a un consumidor dedicado.
