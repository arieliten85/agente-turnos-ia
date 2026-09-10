-- ============================================================================
-- Migración: 20260910_0002_validacion_ventana
-- ============================================================================
-- Mueve la validación de ventana horaria del lado de la lectura (get_availability)
-- al lado de la escritura (book_appointment). Cubre las tres tareas del bloque A
-- del plan de trabajo:
--
--   A1 · slot_fits_schedule(): extrae la lógica de horario + excepciones que
--        vivía duplicada dentro de get_availability y la deja como función
--        reutilizable.
--   A2 · book_appointment ahora llama a slot_fits_schedule() antes del INSERT y
--        rechaza turnos fuera de horario, en días no laborables o en feriados.
--        Nuevo parámetro p_force (uso humano) para saltar la validación.
--   A3 · get_availability pasa a recibir un array de servicios y suma sus
--        duraciones. Se mantiene una sobrecarga con la firma vieja (un solo
--        uuid) que delega en la nueva.
--
-- Todo el contenido se refleja además en database/schema.sql (snapshot canónico).
-- ============================================================================

BEGIN;


-- ----------------------------------------------------------------------------
-- A1 · slot_fits_schedule
-- ----------------------------------------------------------------------------
-- Responde si un rango [p_starts_at, p_ends_at) cae entero dentro del horario
-- laboral del profesional y no pisa ninguna excepción aplicable.
--
--   fits   — true si el turno entra sin problemas
--   reason — texto claro cuando fits = false (NULL cuando fits = true)
--
-- Ojo con los turnos partidos: el rango tiene que caber entero dentro de UNA
-- franja de schedule, no repartido entre la mañana y la tarde.

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
-- A3 · get_availability (array de servicios)
-- ----------------------------------------------------------------------------
-- Devuelve los inicios posibles de turno para el CONJUNTO de servicios dado en
-- una fecha, respetando horario, excepciones y turnos existentes.
--
--   p_date            — fecha del negocio (en su TZ), no timestamp
--   p_service_ids     — servicios deseados; la duración es la SUMA de todos
--   p_professional_id — profesional específico, o NULL para "cualquiera que pueda
--                       hacer TODOS los servicios del array"
--
-- Devuelve filas (professional_id, professional_name, slot_start, slot_end)
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
    -- No puede empezar en el pasado (útil para el día "hoy")
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
-- A2 · book_appointment valida la ventana
-- ----------------------------------------------------------------------------
-- Reserva un turno con uno o más servicios para el MISMO profesional (v1).
--
-- p_force: uso HUMANO. El dueño, por vía handoff, puede meter un turno fuera de
-- horario. El agente NUNCA lo manda en true — es un parámetro de escape manual,
-- igual que el de cancel_appointment.

CREATE OR REPLACE FUNCTION book_appointment(
  p_client_id       uuid,
  p_professional_id uuid,
  p_service_ids     uuid[],
  p_starts_at       timestamptz,
  p_notes           text DEFAULT NULL,
  p_force           boolean DEFAULT false
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
BEGIN
  -- Validaciones básicas
  IF p_service_ids IS NULL OR array_length(p_service_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'Se requiere al menos un servicio';
  END IF;

  IF p_starts_at <= now() THEN
    RAISE EXCEPTION 'La hora de inicio debe ser futura';
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

  -- Calcular duración total sumando los servicios
  SELECT COALESCE(SUM(s.duration_minutes), 0) INTO v_total_duration
    FROM services s
    WHERE s.id = ANY(p_service_ids) AND s.active = true;

  IF v_total_duration = 0 THEN
    RAISE EXCEPTION 'Ninguno de los servicios está activo';
  END IF;

  v_ends_at := p_starts_at + (v_total_duration || ' minutes')::interval;

  -- Validar que el turno cae dentro del horario del profesional y no pisa
  -- ninguna excepción. p_force lo saltea (autorización humana explícita).
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
'Crea un turno. Valida la ventana horaria con slot_fits_schedule() antes de
insertar y confía en la restricción de exclusión de appointments para atomicidad.
p_force es de uso humano (handoff); el agente nunca lo manda en true.
En v1 todos los servicios del bloque van con el mismo profesional.';


-- Registro de aplicación. update.js recalcula el checksum real al aplicar.
INSERT INTO schema_migrations (id, template_version_when_applied, checksum)
VALUES ('20260910_0002_validacion_ventana', '1.0.0', 'CALCULATED_BY_UPDATE_SCRIPT');

COMMIT;
