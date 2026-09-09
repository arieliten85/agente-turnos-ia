-- Test: una excepción de calendario reduce slots dentro del rango bloqueado
BEGIN;
SELECT seed_minimal();

DO $$
DECLARE
  v_carla uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_corte uuid := '11111111-1111-1111-1111-111111111111';
  v_target date := next_dow(6);
  v_conflicts bigint;
BEGIN
  -- Bloquear a Carla el sábado de 14 a 16 (bloque manual)
  INSERT INTO schedule_exceptions
    (professional_id, date_from, date_to, time_from, time_to, exception_type, reason)
  VALUES
    (v_carla, v_target, v_target, '14:00', '16:00', 'manual_block', 'Reunión');

  -- Ningún slot devuelto debe solaparse con [14:00, 16:00)
  -- (un slot que empieza exactamente a las 16:00 es válido, no se pisa)
  SELECT count(*) INTO v_conflicts
    FROM get_availability(v_target, v_corte, v_carla)
    WHERE tstzrange(slot_start, slot_end, '[)') &&
          tstzrange(local_ts(v_target, '14:00'), local_ts(v_target, '16:00'), '[)');

  PERFORM assert_equals(v_conflicts, 0::bigint,
    'ningún slot debe solaparse con la excepción [14:00, 16:00)');
END $$;

ROLLBACK;
