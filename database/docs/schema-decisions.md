# Decisiones de diseño del esquema

Este documento explica por qué el esquema está como está, para que dentro de seis meses (o cuando alguien más lo lea) las decisiones sigan siendo entendibles.

## Zona horaria

Todas las horas se guardan en `timestamptz` (UTC internamente). El "reloj del negocio" vive en `business.timezone` (IANA, ej `America/Argentina/Buenos_Aires`). Las funciones SQL convierten a la zona del negocio al calcular "qué día es hoy" o "qué hora es 15:00".

Motivo: un cliente puede estar en Ushuaia y otro en Salta. Y si un día el país vuelve al horario de verano, el mismo `timestamptz` sigue siendo correcto — solo cambia la conversión.

## La restricción de exclusión de appointments

```sql
EXCLUDE USING gist (
  professional_id WITH =,
  tstzrange(starts_at, ends_at, '[)') WITH &&
) WHERE (status = 'confirmed')
```

Esta es la pieza central del motor. Le dice a Postgres: "no puede haber dos filas con el mismo `professional_id` cuyos rangos temporales se solapen, siempre y cuando estén confirmados".

Consecuencias:

- Si dos clientas piden el mismo horario con un segundo de diferencia, la segunda transacción falla con `exclusion_violation`. `book_appointment` la traduce a un mensaje entendible.
- Se puede cancelar un turno (status pasa a `cancelled`) y crear otro en el mismo slot — el WHERE excluye los cancelados de la restricción.
- El rango `[)` incluye el inicio y excluye el fin: un turno de 15:00 a 16:00 no choca con uno de 16:00 a 17:00. Sin `[)` chocarían.

Requiere `btree_gist` porque se combina igualdad de UUID (`=`) con solapamiento de rango (`&&`) en un mismo índice.

## Un profesional por turno en v1

`appointments.professional_id` es único por fila. `appointment_services` tiene su propio `professional_id`, preparado para el día que soportemos servicios con profesionales distintos en el mismo bloque (corte con Carla + cejas con Marina), pero **en v1 siempre es igual al del turno**.

Motivo: cubre el 90% del rubro y mantiene la restricción de exclusión simple. Cambiarlo después es agregar validación, no rehacer.

## `schedule` permite múltiples filas por día

Un profesional puede trabajar mañana y tarde con corte al mediodía. En vez de complicar el esquema con "descanso", se cargan dos filas para el mismo `day_of_week` (9-13 y 15-19). `get_availability` las une naturalmente.

## `schedule_exceptions` con niveles

`professional_id` es nullable. NULL significa "aplica a todo el negocio" — feriado nacional, vacaciones colectivas, cierre por reforma. Con valor significa "solo ese profesional" — vacaciones personales, día libre.

`time_from/time_to` también nullables. NULL = día completo. Con valor = bloqueo parcial ("Carla no atiende el martes de 15 a 17").

Postgres se encarga de que ambos sean consistentes con el CHECK.

## `processed_messages` como PRIMARY KEY sobre `wamid`

Meta reintenta webhooks. Sin dedup, el agente responde dos veces. El PRIMARY KEY es la barrera natural: el flow-webhook intenta insertar el `wamid` **antes** de procesar. Si viola el PK, es duplicado, descarta silencioso, devuelve 200.

No es una tabla que crezca preocupante: cada fila son unos 30 bytes. Un cron puede borrar wamids de hace más de una semana si el volumen crece.

## `conversations.last_message_at` vs `last_outbound_at`

Dos columnas distintas porque miden dos cosas distintas:

- `last_message_at`: último mensaje **entrante** (de la clienta). Define la ventana de 24 h de Meta.
- `last_outbound_at`: último mensaje **saliente** (nuestro). Útil para saber si el agente ya respondió, para métricas, y para detectar handoffs colgados.

## `runs` como observabilidad

Cada vez que el flow-agent procesa un buffer, deja un registro con todo: mensajes entrantes, tools llamadas, respuesta, latencia, error. Sirve para dos cosas:

1. Debuggear en vivo. Cuando algo salió raro, se busca la conversación y se ve el run.
2. Medir. Latencia p50/p95, tasa de handoff, tools más usadas, tokens promedio.

Es una tabla que sí puede crecer: se puede rotar (borrar runs de hace más de 90 días) sin perder nada crítico.

## RLS (Row Level Security)

**Desactivada en v1.** Todas las queries van desde n8n con la `service_role` key de Supabase, que bypassea RLS. No hay UI de usuario final que consulte la base directamente.

Cuando exista un dashboard para el dueño (v2+), se activa RLS y se agregan policies. Por ahora sumar RLS solo aporta complejidad.

## Sobre no borrar (soft delete)

Servicios y profesionales tienen `active` (boolean). Nunca se borran físicamente porque tienen relaciones con turnos históricos. Marcar `active = false` los saca de nuevos flujos pero preserva el historial.

Clientes tampoco se borran (podés necesitar el historial para atender un reclamo). Se marca `opted_out` para el que pidió baja.

## Migraciones incrementales

- `schema.sql` es el snapshot canónico del esquema deseado.
- `migrations/*.sql` son las evoluciones incrementales, cada una con `up` (aplica) y (donde tenga sentido) `down` (revierte).
- La tabla `schema_migrations` en la base del cliente es la **fuente de verdad** de qué se aplicó.
- La operación "actualizar" del skill compara `schema_migrations` con el directorio y aplica lo que falta.

La primera migración es autocontenida (crea todo el esquema). Las siguientes son deltas chicos.
