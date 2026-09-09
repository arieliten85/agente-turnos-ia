-- Test: feriado (professional_id NULL) bloquea a TODOS los profesionales
BEGIN;
SELECT seed_minimal();

DO $$
DECLARE
  v_corte uuid := '11111111-1111-1111-1111-111111111111';
  v_target date := next_dow(6);
  v_slots bigint;
BEGIN
  -- Feriado nacional el sábado
  INSERT INTO schedule_exceptions
    (professional_id, date_from, date_to, time_from, time_to, exception_type, reason)
  VALUES
    (NULL, v_target, v_target, NULL, NULL, 'holiday', 'Feriado');

  -- No debe haber slots para nadie
  SELECT count(*) INTO v_slots
    FROM get_availability(v_target, v_corte, NULL);

  PERFORM assert_equals(v_slots, 0::bigint,
    'feriado general debe bloquear todos los slots del día');
END $$;

ROLLBACK;
