-- ============================================================================
-- Migración: 20260911_0004_contexto_temporal
-- ============================================================================
-- T0 del plan de ajustes (PLAN-DE-AJUSTES.md). El agente aceptó "viernes 14"
-- para una fecha que caía lunes: sabe mes y año pero no resuelve la relación
-- día-de-semana ↔ fecha, y estaba haciendo esa cuenta por su cuenta. Mismo
-- criterio que ya se usó para la hora local (migración 0002/flow-agent): que
-- la cuenta la haga la base, nunca la IA.
--
-- Agrega:
--   - spanish_weekday(timestamp)              -> 'lunes', 'martes', ...
--   - spanish_date_label(timestamp, boolean)   -> 'lunes 14 de septiembre'
--     (o con año: 'lunes 14 de septiembre de 2026')
--   - book_appointment gana p_expected_dow: si el llamador manda un día de
--     semana, se valida contra la fecha real de p_starts_at y se rechaza el
--     turno si no coinciden (backstop además del prompt/contexto).
--
-- Los parámetros de spanish_weekday/spanish_date_label son `timestamp` SIN
-- huso, no `timestamptz`: el llamador tiene que convertir primero con
-- `AT TIME ZONE <huso del negocio>`. Si la función tomara `timestamptz`,
-- pasarle el resultado de ese `AT TIME ZONE` (que ya es un `timestamp` sin
-- huso) haría que Postgres lo reinterprete en el huso de la SESIÓN al
-- convertirlo de vuelta — un round-trip que corre la hora en silencio. Con
-- `timestamp` puro no hay conversión implícita: lo que entra es lo que se lee.
-- ============================================================================

BEGIN;


CREATE OR REPLACE FUNCTION spanish_weekday(p_local_ts timestamp)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT (ARRAY['domingo','lunes','martes','miércoles','jueves','viernes','sábado'])[EXTRACT(DOW FROM p_local_ts)::int + 1];
$$;

COMMENT ON FUNCTION spanish_weekday IS
'Nombre del día de la semana en español para un timestamp YA convertido al
huso del negocio (parámetro timestamp sin tz — ver nota de la migración
20260911_0004 sobre por qué no es timestamptz). "domingo 0" hasta "sábado 6",
igual que EXTRACT(DOW).';


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
negocio. El modelo repite este string; nunca arma la fecha por su cuenta.';


-- book_appointment gana p_expected_dow (7º parámetro). Cambia la lista de
-- parámetros: hay que borrar la firma de 6 antes de crear la de 7, si no
-- Postgres las deja coexistir como sobrecargas ambiguas (mismo problema que
-- ya se resolvió en la migración 20260910_0002 al pasar de 5 a 6).
DROP FUNCTION IF EXISTS book_appointment(uuid, uuid, uuid[], timestamptz, text, boolean);

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
  -- con el día real de p_starts_at. Es el backstop de base para el caso
  -- "viernes 14" cuando el 14 cae lunes — el prompt/contexto ya debería haber
  -- frenado esto antes, esta es la última línea de defensa.
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
el agente nunca lo manda en true. En v1 todos los servicios del bloque van con
el mismo profesional.';


INSERT INTO schema_migrations (id, template_version_when_applied, checksum)
VALUES ('20260911_0004_contexto_temporal', '1.2.0', 'CALCULATED_BY_UPDATE_SCRIPT');

COMMIT;
