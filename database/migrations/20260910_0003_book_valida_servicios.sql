-- ============================================================================
-- Migración: 20260910_0003_book_valida_servicios
-- ============================================================================
-- B5 (parte SQL) · book_appointment nunca degrada en silencio a un turno más
-- corto. Antes: si un id de p_service_ids no resolvía a un servicio activo, la
-- suma de duración simplemente lo ignoraba y el turno quedaba más corto que lo
-- acordado. Ahora: si la cantidad de servicios activos resueltos no coincide con
-- la cantidad pedida, se lanza excepción.
--
-- Además se reordena la validación: primero se verifica que los servicios
-- existan y estén activos, y recién después que el profesional pueda hacerlos.
-- Así el mensaje de error apunta a la causa real.
--
-- Se refleja en database/schema.sql.
-- ============================================================================

BEGIN;


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
  v_requested      integer;
  v_found          integer;
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
acorta el turno en silencio), que el profesional pueda hacerlos y que el rango
entre en el horario (slot_fits_schedule). Confía en la restricción de exclusión
de appointments para atomicidad. p_force es de uso humano (handoff); el agente
nunca lo manda en true. En v1 todos los servicios del bloque van con el mismo
profesional.';


INSERT INTO schema_migrations (id, template_version_when_applied, checksum)
VALUES ('20260910_0003_book_valida_servicios', '1.0.0', 'CALCULATED_BY_UPDATE_SCRIPT');

COMMIT;
