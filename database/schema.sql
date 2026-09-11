-- ============================================================================
-- Template Agente de Turnos por WhatsApp
-- schema.sql — definición canónica del esquema
-- ============================================================================
-- Este archivo describe el estado deseado de la base. Se puede correr entero
-- sobre una base vacía para reproducir el esquema (útil para test-unit.js con
-- base efímera).
--
-- Para instalaciones nuevas de clientes, se corre la migración inicial en
-- migrations/20260909_0001_initial.sql, que envuelve este mismo contenido en
-- una transacción y registra la entrada en schema_migrations.
--
-- Convención: nombres de tablas y columnas en inglés (estándar SQL);
-- comentarios y mensajes de error en español rioplatense (idioma del producto).
-- ============================================================================


-- ============================================================================
-- 0. Extensiones necesarias
-- ============================================================================

-- pgcrypto para gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- btree_gist para poder combinar igualdad (=) con solapamiento (&&) en la
-- restricción de exclusión de rangos temporales de appointments.
CREATE EXTENSION IF NOT EXISTS btree_gist;


-- ============================================================================
-- 1. Función utilitaria: updated_at automático
-- ============================================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ============================================================================
-- 2. Tabla: business
-- ============================================================================
-- Configuración del negocio. En v1 es singleton por proyecto Supabase
-- (un cliente = un proyecto).

CREATE TABLE business (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  timezone            text NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
  address             text,
  handoff_phone       text,          -- E.164, WhatsApp del dueño para reenvíos
  cancellation_hours  integer NOT NULL DEFAULT 24 CHECK (cancellation_hours >= 0),
  reminder_hours      integer NOT NULL DEFAULT 24 CHECK (reminder_hours >= 0),
  buffer_seconds      numeric(4,1) NOT NULL DEFAULT 2.5 CHECK (buffer_seconds > 0),
  slot_granularity_min integer NOT NULL DEFAULT 15 CHECK (slot_granularity_min > 0),
  opt_out_keywords    text[] NOT NULL DEFAULT ARRAY['BAJA','STOP','NO MOLESTAR'],
  custom_tone         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER business_updated_at
BEFORE UPDATE ON business
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE business IS 'Configuración del negocio. Singleton en v1.';
COMMENT ON COLUMN business.timezone IS 'IANA TZ. Todas las horas se guardan en UTC; esto define el reloj del negocio.';
COMMENT ON COLUMN business.slot_granularity_min IS 'Granularidad en minutos con la que get_availability propone huecos.';


-- ============================================================================
-- 3. Tabla: services
-- ============================================================================

CREATE TABLE services (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  duration_minutes  integer NOT NULL CHECK (duration_minutes > 0),
  price             numeric(10,2),
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER services_updated_at
BEFORE UPDATE ON services
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX services_active_idx ON services(active) WHERE active = true;


-- ============================================================================
-- 4. Tabla: professionals
-- ============================================================================

CREATE TABLE professionals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER professionals_updated_at
BEFORE UPDATE ON professionals
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX professionals_active_idx ON professionals(active) WHERE active = true;


-- ============================================================================
-- 5. Tabla: professional_services (N:N)
-- ============================================================================
-- Qué profesional puede hacer qué servicio.

CREATE TABLE professional_services (
  professional_id  uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  service_id       uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (professional_id, service_id)
);

CREATE INDEX professional_services_service_idx ON professional_services(service_id);


-- ============================================================================
-- 6. Tabla: schedule (horario recurrente)
-- ============================================================================
-- Un profesional puede tener varias filas por día de semana (ej: mañana y
-- tarde con corte al mediodía).

CREATE TABLE schedule (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  professional_id  uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  day_of_week      smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  time_from        time NOT NULL,
  time_to          time NOT NULL,
  CHECK (time_from < time_to)
);

CREATE INDEX schedule_prof_day_idx ON schedule(professional_id, day_of_week);

COMMENT ON COLUMN schedule.day_of_week IS '0=domingo, 1=lunes, ..., 6=sábado (compatible con EXTRACT(DOW))';


-- ============================================================================
-- 7. Tabla: schedule_exceptions
-- ============================================================================
-- Feriados, vacaciones, francos y bloqueos manuales.
-- professional_id NULL => aplica a todo el negocio (feriado nacional).
-- time_from/time_to NULL => día completo.

CREATE TABLE schedule_exceptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  professional_id  uuid REFERENCES professionals(id) ON DELETE CASCADE,
  date_from        date NOT NULL,
  date_to          date NOT NULL,
  time_from        time,
  time_to          time,
  exception_type   text NOT NULL CHECK (exception_type IN ('holiday','vacation','day_off','manual_block')),
  reason           text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (date_to >= date_from),
  CHECK (
    (time_from IS NULL AND time_to IS NULL)
    OR (time_from IS NOT NULL AND time_to IS NOT NULL AND time_from < time_to)
  )
);

CREATE INDEX schedule_exceptions_date_idx ON schedule_exceptions(date_from, date_to);
CREATE INDEX schedule_exceptions_prof_idx ON schedule_exceptions(professional_id);


-- ============================================================================
-- 8. Tabla: clients
-- ============================================================================

CREATE TABLE clients (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone             text NOT NULL UNIQUE,
  name              text,
  notes             text,
  opted_out         boolean NOT NULL DEFAULT false,
  opted_out_at      timestamptz,
  consent_shown_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER clients_updated_at
BEFORE UPDATE ON clients
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX clients_opted_out_idx ON clients(opted_out) WHERE opted_out = false;

COMMENT ON COLUMN clients.phone IS 'Formato E.164 sin + (ej: 5491122334455). Formato del webhook de Meta.';
COMMENT ON COLUMN clients.consent_shown_at IS 'Cuándo se le mostró el mensaje de consentimiento por primera vez.';


-- ============================================================================
-- 9. Tabla: appointments
-- ============================================================================
-- Restricción de exclusión: dos turnos "confirmed" del mismo profesional no
-- pueden solaparse. Postgres lo rechaza automáticamente al insertar.

CREATE TABLE appointments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid NOT NULL REFERENCES clients(id),
  professional_id  uuid NOT NULL REFERENCES professionals(id),
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'confirmed'
                     CHECK (status IN ('confirmed','cancelled','completed','no_show')),
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  -- La clave del motor: nada de doble reserva del mismo profesional.
  -- Rango '[)' = incluye inicio, excluye fin (turno de 15:00-16:00 no choca con 16:00-17:00).
  EXCLUDE USING gist (
    professional_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status = 'confirmed')
);

CREATE TRIGGER appointments_updated_at
BEFORE UPDATE ON appointments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX appointments_prof_starts_idx ON appointments(professional_id, starts_at);
CREATE INDEX appointments_client_starts_idx ON appointments(client_id, starts_at);
CREATE INDEX appointments_status_starts_idx ON appointments(status, starts_at);


-- ============================================================================
-- 10. Tabla: appointment_services
-- ============================================================================
-- Servicios de un turno. Un turno puede tener varios servicios (ej: corte + color).
-- En v1 professional_id de cada servicio siempre coincide con appointments.professional_id.
-- La columna existe preparada para v2 (servicios con profesionales distintos en el mismo bloque).

CREATE TABLE appointment_services (
  appointment_id   uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  service_id       uuid NOT NULL REFERENCES services(id),
  professional_id  uuid NOT NULL REFERENCES professionals(id),
  order_index      smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (appointment_id, service_id, order_index)
);

CREATE INDEX appointment_services_service_idx ON appointment_services(service_id);


-- ============================================================================
-- 11. Tabla: waitlist
-- ============================================================================

CREATE TABLE waitlist (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  service_id          uuid NOT NULL REFERENCES services(id),
  professional_id     uuid REFERENCES professionals(id),  -- NULL = cualquiera
  date_from           date NOT NULL,
  date_to             date NOT NULL,
  status              text NOT NULL DEFAULT 'waiting'
                        CHECK (status IN ('waiting','notified','expired','fulfilled','cancelled')),
  notified_at         timestamptz,
  notified_response_deadline timestamptz,  -- cuándo se le libera al siguiente si no responde
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (date_to >= date_from)
);

CREATE INDEX waitlist_status_dates_idx ON waitlist(status, date_from, date_to);
CREATE INDEX waitlist_client_idx ON waitlist(client_id);


-- ============================================================================
-- 12. Tabla: conversations
-- ============================================================================

CREATE TABLE conversations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  phone             text NOT NULL,  -- desnormalizado para búsqueda rápida
  state             text NOT NULL DEFAULT 'active'
                      CHECK (state IN ('active','paused_by_human','paused_by_complaint','opted_out')),
  last_message_at   timestamptz,  -- último mensaje ENTRANTE (define ventana 24h de Meta)
  last_outbound_at  timestamptz,  -- último mensaje SALIENTE del negocio
  summary           text,          -- resumen conversacional para inyectar como contexto
  paused_at         timestamptz,
  paused_until      timestamptz,   -- reactivación automática (default 3h)
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id)  -- una conversación por cliente en v1
);

CREATE TRIGGER conversations_updated_at
BEFORE UPDATE ON conversations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX conversations_phone_idx ON conversations(phone);
CREATE INDEX conversations_last_message_idx ON conversations(last_message_at);
CREATE INDEX conversations_state_idx ON conversations(state) WHERE state != 'active';


-- ============================================================================
-- 13. Tabla: messages
-- ============================================================================
-- Historial conversacional para armar contexto del modelo.

CREATE TABLE messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction        text NOT NULL CHECK (direction IN ('inbound','outbound')),
  content          text,
  message_type     text NOT NULL DEFAULT 'text'
                     CHECK (message_type IN ('text','audio','image','video','document','button','interactive','template')),
  wamid            text,  -- WhatsApp Message ID; NULL para mensajes internos
  metadata         jsonb, -- payload adicional (botones tocados, template usada, etc.)
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX messages_conv_created_idx ON messages(conversation_id, created_at);
CREATE INDEX messages_wamid_idx ON messages(wamid) WHERE wamid IS NOT NULL;


-- ============================================================================
-- 14. Tabla: processed_messages (dedup de webhook)
-- ============================================================================
-- Meta reintenta webhooks: sin esta tabla el agente responde dos veces.
-- El flow-webhook intenta insertar el wamid antes de procesar; si viola el
-- PRIMARY KEY, ya fue procesado y se descarta silencioso devolviendo 200.

CREATE TABLE processed_messages (
  wamid         text PRIMARY KEY,
  processed_at  timestamptz NOT NULL DEFAULT now()
);

-- Se puede purgar wamids viejos con un cron; no es urgente porque es tabla chica.
CREATE INDEX processed_messages_at_idx ON processed_messages(processed_at);


-- ============================================================================
-- 15. Tabla: reminders_sent
-- ============================================================================
-- Evita mandar el mismo recordatorio dos veces.

CREATE TABLE reminders_sent (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id  uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  reminder_type   text NOT NULL,  -- '24h', '2h', etc. Configurable en business.
  sent_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (appointment_id, reminder_type)
);


-- ============================================================================
-- 16. Tabla: runs (observabilidad)
-- ============================================================================
-- Un registro por cada vez que el flow-agent procesa un buffer.

CREATE TABLE runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id    uuid REFERENCES conversations(id) ON DELETE SET NULL,
  inbound_messages   jsonb,   -- array con los mensajes que se juntaron en el buffer
  model_used         text,
  tokens_in          integer,
  tokens_out         integer,
  tools_called       jsonb,   -- [{name, input, output, duration_ms}]
  response_text      text,
  total_latency_ms   integer,
  error              text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX runs_conv_created_idx ON runs(conversation_id, created_at);
CREATE INDEX runs_error_idx ON runs(created_at) WHERE error IS NOT NULL;


-- ============================================================================
-- 17. Tabla: schema_migrations
-- ============================================================================
-- Fuente de verdad de qué migraciones corrieron. La operación "actualizar"
-- del skill compara esta tabla contra los archivos en /database/migrations/.

CREATE TABLE schema_migrations (
  id                             text PRIMARY KEY,          -- nombre del archivo
  applied_at                     timestamptz NOT NULL DEFAULT now(),
  template_version_when_applied  text,
  checksum                       text                       -- para detectar alteración manual
);


-- ============================================================================
-- FUNCIONES SQL — toda la lógica pesada vive acá.
-- La IA nunca calcula fechas, disponibilidad ni precios.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- spanish_weekday · spanish_date_label
-- ----------------------------------------------------------------------------
-- Nombre del día / fecha legible en español para un timestamp YA convertido
-- al huso del negocio (parámetro `timestamp` sin tz, no `timestamptz`: el
-- llamador convierte primero con `AT TIME ZONE <huso>`; si la función tomara
-- `timestamptz`, pasarle ese resultado haría que Postgres lo reinterprete en
-- el huso de la SESIÓN al convertirlo de vuelta — un round-trip que corre la
-- hora en silencio). El modelo repite estos strings; nunca arma la fecha por
-- su cuenta.

CREATE OR REPLACE FUNCTION spanish_weekday(p_local_ts timestamp)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT (ARRAY['domingo','lunes','martes','miércoles','jueves','viernes','sábado'])[EXTRACT(DOW FROM p_local_ts)::int + 1];
$$;

COMMENT ON FUNCTION spanish_weekday IS
'Nombre del día de la semana en español para un timestamp ya convertido al
huso del negocio. "domingo" (0) a "sábado" (6), igual que EXTRACT(DOW).';


CREATE OR REPLACE FUNCTION spanish_date_label(p_local_ts timestamp, p_include_year boolean DEFAULT false)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT spanish_weekday(p_local_ts)
    || ' ' || EXTRACT(DAY FROM p_local_ts)::int || ' de ' ||
    (ARRAY['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'])[EXTRACT(MONTH FROM p_local_ts)::int]
    || CASE WHEN p_include_year THEN ' de ' || EXTRACT(YEAR FROM p_local_ts)::int ELSE '' END;
$$;

COMMENT ON FUNCTION spanish_date_label IS
'Fecha legible en español ("lunes 14 de septiembre", o con p_include_year
"lunes 14 de septiembre de 2026") para un timestamp ya convertido al huso del
negocio.';


-- ----------------------------------------------------------------------------
-- slot_fits_schedule
-- ----------------------------------------------------------------------------
-- Responde si un rango [p_starts_at, p_ends_at) cae entero dentro del horario
-- laboral del profesional y no pisa ninguna excepción aplicable.
--
--   fits   — true si el turno entra sin problemas
--   reason — texto claro cuando fits = false (NULL cuando fits = true)
--
-- Ojo con los turnos partidos: el rango tiene que caber entero dentro de UNA
-- franja de schedule, no repartido entre la mañana y la tarde.
-- Fuente única de la lógica de ventana: la usan get_availability (lectura) y
-- book_appointment (escritura).

CREATE OR REPLACE FUNCTION slot_fits_schedule(
  p_professional_id uuid,
  p_starts_at       timestamptz,
  p_ends_at         timestamptz
)
RETURNS TABLE (fits boolean, reason text)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_tz             text;
  v_date           date;
  v_dow            smallint;
  v_has_day        boolean;
  v_fits_window    boolean;
  v_ends_after     boolean;
  v_starts_before  boolean;
  v_exc            record;
BEGIN
  SELECT b.timezone INTO v_tz FROM business b LIMIT 1;
  IF v_tz IS NULL THEN
    RAISE EXCEPTION 'No hay negocio configurado en la tabla business';
  END IF;

  IF p_ends_at <= p_starts_at THEN
    RETURN QUERY SELECT false, 'El rango del turno es inválido'::text;
    RETURN;
  END IF;

  -- Día y hora locales del negocio
  v_date := (p_starts_at AT TIME ZONE v_tz)::date;
  v_dow  := EXTRACT(DOW FROM v_date)::smallint;

  -- ¿Hay alguna franja ese día que contenga el rango completo?
  SELECT
    bool_or(true),
    bool_or(win_start <= p_starts_at AND win_end >= p_ends_at),
    bool_or(win_start <= p_starts_at AND win_end <  p_ends_at),
    bool_or(win_start >  p_starts_at AND win_end >= p_ends_at)
  INTO v_has_day, v_fits_window, v_ends_after, v_starts_before
  FROM (
    SELECT
      ((v_date::text || ' ' || sch.time_from::text)::timestamp AT TIME ZONE v_tz) AS win_start,
      ((v_date::text || ' ' || sch.time_to::text)::timestamp   AT TIME ZONE v_tz) AS win_end
    FROM schedule sch
    WHERE sch.professional_id = p_professional_id
      AND sch.day_of_week = v_dow
  ) w;

  IF v_has_day IS NOT TRUE THEN
    RETURN QUERY SELECT false, 'El profesional no atiende ese día'::text;
    RETURN;
  END IF;

  IF v_fits_window IS NOT TRUE THEN
    IF v_ends_after IS TRUE THEN
      RETURN QUERY SELECT false, 'El turno termina después del cierre'::text;
    ELSIF v_starts_before IS TRUE THEN
      RETURN QUERY SELECT false, 'El turno empieza antes de la apertura'::text;
    ELSE
      RETURN QUERY SELECT false, 'El turno cae fuera del horario de atención'::text;
    END IF;
    RETURN;
  END IF;

  -- ¿Se pisa con alguna excepción aplicable?
  -- professional_id NULL  => feriado de todo el negocio
  -- time_from/time_to NULL => día completo
  FOR v_exc IN
    SELECT
      e.reason AS ex_reason,
      CASE WHEN e.time_from IS NULL
        THEN (v_date::text || ' 00:00')::timestamp AT TIME ZONE v_tz
        ELSE (v_date::text || ' ' || e.time_from::text)::timestamp AT TIME ZONE v_tz
      END AS ex_start,
      CASE WHEN e.time_to IS NULL
        THEN ((v_date + 1)::text || ' 00:00')::timestamp AT TIME ZONE v_tz
        ELSE (v_date::text || ' ' || e.time_to::text)::timestamp AT TIME ZONE v_tz
      END AS ex_end
    FROM schedule_exceptions e
    WHERE v_date BETWEEN e.date_from AND e.date_to
      AND (e.professional_id IS NULL OR e.professional_id = p_professional_id)
  LOOP
    IF tstzrange(p_starts_at, p_ends_at, '[)') && tstzrange(v_exc.ex_start, v_exc.ex_end, '[)') THEN
      RETURN QUERY SELECT false,
        COALESCE('Ese día está bloqueado: ' || v_exc.ex_reason, 'Ese día está bloqueado')::text;
      RETURN;
    END IF;
  END LOOP;

  RETURN QUERY SELECT true, NULL::text;
END;
$$;

COMMENT ON FUNCTION slot_fits_schedule IS
'Responde si un rango [starts_at, ends_at) cae entero dentro de una franja de
horario del profesional y no pisa ninguna excepción. Fuente única de la lógica
de ventana: la usan get_availability (lectura) y book_appointment (escritura).';


-- ----------------------------------------------------------------------------
-- get_availability
-- ----------------------------------------------------------------------------
-- Devuelve los inicios posibles de turno para el CONJUNTO de servicios dado en
-- una fecha, respetando horario, excepciones y turnos existentes.
--
-- Parámetros:
--   p_date            — fecha del negocio (en su TZ), no timestamp
--   p_service_ids     — servicios deseados; la duración es la SUMA de todos
--   p_professional_id — profesional específico, o NULL para "cualquiera que
--                       pueda hacer TODOS los servicios del array"
--
-- Devuelve filas: (professional_id, professional_name, slot_start, slot_end)
-- ordenadas por slot_start. Cada fila es un inicio POSIBLE, no un turno reservado.

CREATE OR REPLACE FUNCTION get_availability(
  p_date            date,
  p_service_ids     uuid[],
  p_professional_id uuid DEFAULT NULL
)
RETURNS TABLE (
  professional_id   uuid,
  professional_name text,
  slot_start        timestamptz,
  slot_end          timestamptz
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_tz               text;
  v_duration_min     integer;
  v_granularity_min  integer;
  v_dow              smallint;
  v_requested        integer;
  v_found            integer;
BEGIN
  -- Config del negocio
  SELECT b.timezone, b.slot_granularity_min
    INTO v_tz, v_granularity_min
    FROM business b
    LIMIT 1;

  IF v_tz IS NULL THEN
    RAISE EXCEPTION 'No hay negocio configurado en la tabla business';
  END IF;

  IF p_service_ids IS NULL OR array_length(p_service_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'Se requiere al menos un servicio';
  END IF;

  -- Duración total = suma de los servicios activos del array.
  -- Si algún id no resuelve a un servicio activo, es un error: no se degrada
  -- en silencio a un hueco más corto.
  SELECT count(DISTINCT s.id), COALESCE(SUM(s.duration_minutes), 0)
    INTO v_found, v_duration_min
    FROM services s
    WHERE s.id = ANY(p_service_ids) AND s.active = true;

  SELECT count(DISTINCT sid) INTO v_requested
    FROM unnest(p_service_ids) AS sid;

  IF v_found <> v_requested OR v_duration_min = 0 THEN
    RAISE EXCEPTION 'Uno o más servicios son inexistentes o inactivos';
  END IF;

  -- Día de la semana en el TZ del negocio (0=domingo)
  v_dow := EXTRACT(DOW FROM p_date)::smallint;

  RETURN QUERY
  WITH
  -- Candidatos: profesionales que pueden hacer TODOS los servicios del array
  candidates AS (
    SELECT p.id, p.name
      FROM professionals p
     WHERE p.active = true
       AND (p_professional_id IS NULL OR p.id = p_professional_id)
       AND NOT EXISTS (
         SELECT 1 FROM unnest(p_service_ids) AS sid
         WHERE NOT EXISTS (
           SELECT 1 FROM professional_services ps
           WHERE ps.professional_id = p.id AND ps.service_id = sid
         )
       )
  ),
  -- Ventanas de trabajo del día (una fila por franja de schedule)
  work_windows AS (
    SELECT
      c.id   AS pid,
      c.name AS pname,
      ((p_date::text || ' ' || sch.time_from::text)::timestamp AT TIME ZONE v_tz) AS win_start,
      ((p_date::text || ' ' || sch.time_to::text)::timestamp AT TIME ZONE v_tz)   AS win_end
    FROM candidates c
    JOIN schedule sch ON sch.professional_id = c.id AND sch.day_of_week = v_dow
  ),
  -- Turnos confirmados del día para los candidatos
  existing_appts AS (
    SELECT a.professional_id AS pid, a.starts_at, a.ends_at
    FROM appointments a
    JOIN candidates c ON c.id = a.professional_id
    WHERE a.status = 'confirmed'
      AND a.starts_at < ((p_date + 1)::text || ' 00:00')::timestamp AT TIME ZONE v_tz
      AND a.ends_at   > (p_date::text        || ' 00:00')::timestamp AT TIME ZONE v_tz
  ),
  -- Inicios candidatos en la granularidad configurada
  candidate_starts AS (
    SELECT
      w.pid,
      w.pname,
      gs AS slot_start,
      gs + (v_duration_min || ' minutes')::interval AS slot_end
    FROM work_windows w,
    LATERAL generate_series(
      w.win_start,
      w.win_end - (v_duration_min || ' minutes')::interval,
      (v_granularity_min || ' minutes')::interval
    ) AS gs
  )
  SELECT
    cs.pid,
    cs.pname,
    cs.slot_start,
    cs.slot_end
  FROM candidate_starts cs
  WHERE
    -- Entra en el horario y no pisa excepciones (misma lógica que la escritura)
    (SELECT sfs.fits FROM slot_fits_schedule(cs.pid, cs.slot_start, cs.slot_end) AS sfs)
    -- No se pisa con turnos existentes
    AND NOT EXISTS (
      SELECT 1 FROM existing_appts ea
      WHERE ea.pid = cs.pid
        AND tstzrange(cs.slot_start, cs.slot_end, '[)') && tstzrange(ea.starts_at, ea.ends_at, '[)')
    )
    -- Y no puede empezar en el pasado (útil para el día "hoy")
    AND cs.slot_start > now()
  ORDER BY cs.slot_start, cs.pname;
END;
$$;

COMMENT ON FUNCTION get_availability(date, uuid[], uuid) IS
'Calcula huecos disponibles para un conjunto de servicios (duración = suma).
Los candidatos son los profesionales que pueden hacer todos los servicios.
La IA nunca calcula esto; siempre llama a esta función.';


-- Sobrecarga con la firma vieja (un solo servicio). Delega en la nueva para no
-- romper llamadores que todavía manden un uuid suelto.
CREATE OR REPLACE FUNCTION get_availability(
  p_date            date,
  p_service_id      uuid,
  p_professional_id uuid DEFAULT NULL
)
RETURNS TABLE (
  professional_id   uuid,
  professional_name text,
  slot_start        timestamptz,
  slot_end          timestamptz
)
LANGUAGE sql
STABLE
AS $$
  SELECT * FROM get_availability(p_date, ARRAY[p_service_id], p_professional_id);
$$;

COMMENT ON FUNCTION get_availability(date, uuid, uuid) IS
'Sobrecarga de compatibilidad: un solo servicio. Delega en la versión de array.';


-- ----------------------------------------------------------------------------
-- book_appointment
-- ----------------------------------------------------------------------------
-- Reserva un turno con uno o más servicios para el MISMO profesional (v1).
-- La restricción de exclusión de appointments impide solapamientos; si hay
-- conflicto, esta función devuelve un error claro en vez del error críptico
-- de Postgres.

CREATE OR REPLACE FUNCTION book_appointment(
  p_client_id       uuid,
  p_professional_id uuid,
  p_service_ids     uuid[],
  p_starts_at       timestamptz,
  p_notes           text DEFAULT NULL,
  p_force           boolean DEFAULT false,
  p_expected_dow    text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_total_duration integer;
  v_ends_at        timestamptz;
  v_appt_id        uuid;
  v_service_id     uuid;
  v_order          smallint := 0;
  v_window         record;
  v_requested      integer;
  v_found          integer;
  v_tz             text;
  v_dia_real       text;
BEGIN
  -- Validaciones básicas
  IF p_service_ids IS NULL OR array_length(p_service_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'Se requiere al menos un servicio';
  END IF;

  IF p_starts_at <= now() THEN
    RAISE EXCEPTION 'La hora de inicio debe ser futura';
  END IF;

  -- Todos los servicios pedidos tienen que existir y estar activos. Si alguno
  -- no resuelve, es un error explícito: nunca se acorta el turno en silencio.
  SELECT count(DISTINCT s.id), COALESCE(SUM(s.duration_minutes), 0)
    INTO v_found, v_total_duration
    FROM services s
    WHERE s.id = ANY(p_service_ids) AND s.active = true;

  SELECT count(DISTINCT sid) INTO v_requested
    FROM unnest(p_service_ids) AS sid;

  IF v_found <> v_requested OR v_total_duration = 0 THEN
    RAISE EXCEPTION 'Uno o más servicios son inexistentes o inactivos';
  END IF;

  -- Verificar que el profesional puede hacer todos los servicios pedidos
  IF EXISTS (
    SELECT 1 FROM unnest(p_service_ids) AS sid
    WHERE NOT EXISTS (
      SELECT 1 FROM professional_services ps
      WHERE ps.professional_id = p_professional_id AND ps.service_id = sid
    )
  ) THEN
    RAISE EXCEPTION 'El profesional no puede realizar uno o más de los servicios pedidos';
  END IF;

  v_ends_at := p_starts_at + (v_total_duration || ' minutes')::interval;

  -- T0: si el llamador mandó un día de semana esperado, tiene que coincidir
  -- con el día real de p_starts_at. Backstop de base para "viernes 14" cuando
  -- el 14 cae lunes — el prompt/contexto ya debería haber frenado esto antes,
  -- esta es la última línea de defensa.
  IF p_expected_dow IS NOT NULL AND btrim(p_expected_dow) <> '' THEN
    SELECT timezone INTO v_tz FROM business LIMIT 1;
    v_dia_real := spanish_weekday(p_starts_at AT TIME ZONE COALESCE(v_tz, 'America/Argentina/Buenos_Aires'));
    IF translate(lower(btrim(p_expected_dow)), 'áéíóú', 'aeiou') IS DISTINCT FROM translate(v_dia_real, 'áéíóú', 'aeiou') THEN
      RAISE EXCEPTION 'El día de la semana no coincide: pediste % pero esa fecha es %. Confirmá cuál vale antes de reservar.',
        p_expected_dow, v_dia_real;
    END IF;
  END IF;

  -- Validar que el turno cae dentro del horario del profesional y no pisa
  -- ninguna excepción. p_force lo saltea (autorización humana explícita del
  -- handoff); el agente nunca lo manda en true.
  IF NOT p_force THEN
    SELECT * INTO v_window
      FROM slot_fits_schedule(p_professional_id, p_starts_at, v_ends_at) LIMIT 1;
    IF NOT v_window.fits THEN
      RAISE EXCEPTION '%', v_window.reason;
    END IF;
  END IF;

  -- Insertar el turno; la restricción de exclusión atrapa solapamientos
  BEGIN
    INSERT INTO appointments (client_id, professional_id, starts_at, ends_at, notes)
    VALUES (p_client_id, p_professional_id, p_starts_at, v_ends_at, p_notes)
    RETURNING id INTO v_appt_id;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'El horario ya está ocupado para ese profesional';
  END;

  -- Cargar los servicios del turno con el mismo profesional (v1)
  FOREACH v_service_id IN ARRAY p_service_ids LOOP
    INSERT INTO appointment_services (appointment_id, service_id, professional_id, order_index)
    VALUES (v_appt_id, v_service_id, p_professional_id, v_order);
    v_order := v_order + 1;
  END LOOP;

  RETURN v_appt_id;
END;
$$;

COMMENT ON FUNCTION book_appointment IS
'Crea un turno. Valida que todos los servicios existan y estén activos (nunca
acorta el turno en silencio), que el profesional pueda hacerlos, que el
p_expected_dow (si se manda) coincida con el día real de p_starts_at, y que el
rango entre en el horario (slot_fits_schedule). Confía en la restricción de
exclusión de appointments para atomicidad. p_force es de uso humano (handoff);
el agente nunca lo manda en true. En v1 todos los servicios del bloque van con el mismo
profesional.';


-- ----------------------------------------------------------------------------
-- can_cancel
-- ----------------------------------------------------------------------------
-- Devuelve si un turno puede cancelarse solo (sin intervención humana)
-- según la política de horas del negocio.

CREATE OR REPLACE FUNCTION can_cancel(p_appointment_id uuid)
RETURNS TABLE (allowed boolean, reason text)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_starts_at         timestamptz;
  v_status            text;
  v_cancellation_hrs  integer;
BEGIN
  SELECT a.starts_at, a.status INTO v_starts_at, v_status
    FROM appointments a WHERE a.id = p_appointment_id;

  IF v_starts_at IS NULL THEN
    RETURN QUERY SELECT false, 'Turno inexistente';
    RETURN;
  END IF;

  IF v_status != 'confirmed' THEN
    RETURN QUERY SELECT false, 'El turno no está confirmado';
    RETURN;
  END IF;

  SELECT b.cancellation_hours INTO v_cancellation_hrs FROM business b LIMIT 1;

  IF v_starts_at - now() < (v_cancellation_hrs || ' hours')::interval THEN
    RETURN QUERY SELECT false,
      format('Faltan menos de %s horas para el turno', v_cancellation_hrs);
    RETURN;
  END IF;

  RETURN QUERY SELECT true, NULL::text;
END;
$$;


-- ----------------------------------------------------------------------------
-- cancel_appointment
-- ----------------------------------------------------------------------------
-- Cancela un turno respetando política. p_force salta la validación (uso
-- interno del handoff cuando el humano autoriza).

CREATE OR REPLACE FUNCTION cancel_appointment(
  p_appointment_id uuid,
  p_force          boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_check record;
BEGIN
  IF NOT p_force THEN
    SELECT * INTO v_check FROM can_cancel(p_appointment_id) LIMIT 1;
    IF NOT v_check.allowed THEN
      RAISE EXCEPTION '%', v_check.reason;
    END IF;
  END IF;

  UPDATE appointments SET status = 'cancelled' WHERE id = p_appointment_id;
END;
$$;


-- ----------------------------------------------------------------------------
-- notify_waitlist
-- ----------------------------------------------------------------------------
-- Ante un turno recién liberado, devuelve el próximo candidato de la lista
-- de espera al que le sirve el hueco. No cambia estados: quien lo llame
-- (el flow-agent) marca 'notified' cuando efectivamente manda el mensaje.

CREATE OR REPLACE FUNCTION notify_waitlist(p_freed_appointment_id uuid)
RETURNS TABLE (
  waitlist_id  uuid,
  client_id    uuid,
  client_phone text,
  service_id   uuid,
  service_name text
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_pid         uuid;
  v_starts_at   timestamptz;
  v_ends_at     timestamptz;
  v_date_local  date;
  v_tz          text;
  v_duration    interval;
BEGIN
  SELECT a.professional_id, a.starts_at, a.ends_at, (a.ends_at - a.starts_at)
    INTO v_pid, v_starts_at, v_ends_at, v_duration
    FROM appointments a WHERE a.id = p_freed_appointment_id;

  IF v_pid IS NULL THEN
    RAISE EXCEPTION 'Turno inexistente: %', p_freed_appointment_id;
  END IF;

  SELECT b.timezone INTO v_tz FROM business b LIMIT 1;
  v_date_local := (v_starts_at AT TIME ZONE v_tz)::date;

  RETURN QUERY
  SELECT
    w.id,
    w.client_id,
    c.phone,
    w.service_id,
    s.name
  FROM waitlist w
  JOIN clients c   ON c.id = w.client_id
  JOIN services s  ON s.id = w.service_id
  WHERE w.status = 'waiting'
    AND v_date_local BETWEEN w.date_from AND w.date_to
    AND (w.professional_id IS NULL OR w.professional_id = v_pid)
    -- El servicio de la lista de espera cabe en el hueco liberado
    AND (s.duration_minutes || ' minutes')::interval <= v_duration
    -- El profesional puede hacer el servicio
    AND EXISTS (
      SELECT 1 FROM professional_services ps
      WHERE ps.professional_id = v_pid AND ps.service_id = w.service_id
    )
    -- La persona no está en opt-out
    AND c.opted_out = false
  ORDER BY w.created_at
  LIMIT 1;
END;
$$;


-- ----------------------------------------------------------------------------
-- check_message_window
-- ----------------------------------------------------------------------------
-- Devuelve true si la conversación está dentro de la ventana de 24 horas
-- de Meta (último mensaje ENTRANTE hace menos de 24 h). Cualquier flujo
-- que quiera mandar mensaje libre lo consulta antes; si está fuera, tiene
-- que usar plantilla aprobada.

CREATE OR REPLACE FUNCTION check_message_window(p_conversation_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    (SELECT last_message_at > now() - interval '24 hours'
       FROM conversations WHERE id = p_conversation_id),
    false
  );
$$;
