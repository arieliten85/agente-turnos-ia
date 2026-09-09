# 99 · Troubleshooting

_Última actualización: 2026-09-09_

Los errores más comunes y cómo salir.

## El webhook de Meta no verifica

**Síntoma:** al hacer "Verify and save" en Meta, dice que falla.

- El `WA_VERIFY_TOKEN` del `.env` tiene que ser **idéntico** al que ponés en Meta.
- El `flow-webhook` tiene que estar **activo** en n8n (toggle arriba a la derecha).
- La Callback URL es
  `https://<hostname>/webhook/<WEBHOOK_PATH>` — sin `/webhook-test/`, que es la URL
  de prueba de n8n y no sirve para producción.
- Probá a mano:
  `curl "https://<hostname>/webhook/<WEBHOOK_PATH>?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=123"`
  → tiene que devolver `123`.

## "Template not found" al mandar un recordatorio

- El nombre en el `.env` (`WA_TEMPLATE_*`) tiene que ser **exacto** al de Meta.
- El idioma tiene que coincidir: `WA_TEMPLATE_LANG=es_AR` y la plantilla en
  `Spanish (ARG)`.
- La plantilla tiene que estar **Approved**, no `In review`.

## Una plantilla quedó "Rejected"

Casi siempre: categoría `Marketing` en vez de `Utility`, o texto que suena a
promoción. Editá y reenviá. Ver `walkthroughs/03-plantillas-whatsapp.md`.

## El agente no responde

1. **n8n → Executions del `flow-webhook`**: ¿entra la ejecución? Si no, el webhook
   no llega (revisá el túnel y la suscripción a `messages` en Meta).
2. **Executions del `flow-agent`**: ¿se dispara? ¿en qué nodo falla?
3. **Tabla `runs`** en Supabase: cada procesamiento deja una fila con `error` si
   hubo. `SELECT created_at, error, response_text FROM runs ORDER BY created_at DESC LIMIT 10;`
4. **Lock pegado:** si un `flow-agent` crasheó a mitad, puede quedar la clave
   `turnos:lock:<numero>` en Redis. Tiene TTL de 120 s, pero si querés forzar:
   `docker compose exec redis redis-cli DEL turnos:lock:<numero>`.

## Responde dos veces al mismo mensaje

El dedup por `wamid` no está funcionando. Verificá que la tabla
`processed_messages` existe y que el `flow-webhook` hace el INSERT **antes** del
buffer. Meta reintenta los webhooks; sin ese INSERT hay respuestas dobles.

## "mensaje fuera de la ventana de 24 h"

WhatsApp rechaza mensajes libres si pasaron más de 24 h desde el último mensaje
entrante de esa persona. El agente consulta `check_message_window` antes de mandar
algo libre; si da `false`, tiene que usar una plantilla. Si ves este error en un
recordatorio, es esperado: el recordatorio **siempre** va por plantilla.

## Gemini devuelve `429`

Se recortó el free tier. Cambiá a Claude:

```
MODEL_PROVIDER=claude
MODEL_NAME=claude-sonnet-5
ANTHROPIC_API_KEY=sk-ant-...
```

Recreá la credencial `turnos · Modelo` en n8n con la key de Anthropic. Nada más se
toca.

## n8n no arranca

- **`N8N_ENCRYPTION_KEY` cambió**: n8n no puede desencriptar las credenciales
  viejas. Volvé a la key anterior, o borrá el volumen `n8n-data` y reimportá todo.
- Puerto ocupado: cambiá `N8N_PORT` en el `.env`.
- `docker compose logs n8n` casi siempre dice qué pasa.

## "Connection refused" a Redis

El servicio `redis` no levantó o n8n arrancó antes. `docker compose ps` para ver el
estado; `docker compose restart n8n`. El `depends_on` con healthcheck debería
evitarlo.

## El proyecto de Supabase está pausado

Plan gratuito, 7 días sin actividad. Entrá al dashboard y hacé **Restore**. Para
que no vuelva a pasar, dejá el ping automático de
`walkthroughs/01-supabase.md`.

## simulator.js no recibe la respuesta

- n8n tiene que poder alcanzar el capture server. En Linux, `docker-compose.yml` ya
  mapea `host.docker.internal`; verificá que `WA_API_BASE` de los flujos apunte a
  `http://host.docker.internal:<SIMULATOR_CAPTURE_PORT>`.
- El `flow-agent` tiene que estar activo.
- Subí el `--timeout-ms`: la primera respuesta del modelo a veces tarda.

## test-eval falla casi todo

- ¿Está el seed de demo cargado? Varios casos asumen servicios `Corte`/`Color` y
  horario de martes a sábado.
- Corré primero `scripts/simulator.js` a mano y mirá qué contesta el agente: las
  aserciones de `test-eval.js` son heurísticas y puede que haya que ajustar alguna
  al tono real del modelo que estés usando.
