-- Test: schedule con dos filas por día (mañana + tarde) genera slots en ambos bloques
-- pero NO en el corte del mediodía
BEGIN;
SELECT seed_minimal();

DO $$
DECLARE
  v_carla uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_corte uuid := '11111111-1111-1111-1111-111111111111';
  v_target date := next_dow(6);
  v_slots_manana bigint;
  v_slots_tarde  bigint;
  v_slots_corte  bigint;
BEGIN
  -- Reemplazar horario continuo de Carla el sábado por dos bloques con corte 13-15
  DELETE FROM schedule
   WHERE professional_id = v_carla AND day_of_week = 6;

  INSERT INTO schedule (professional_id, day_of_week, time_from, time_to) VALUES
    (v_carla, 6, '09:00', '13:00'),  -- mañana
    (v_carla, 6, '15:00', '19:00');  -- tarde

  SELECT count(*) INTO v_slots_manana
    FROM get_availability(v_target, v_corte, v_carla)
    WHERE (slot_start AT TIME ZONE 'America/Argentina/Buenos_Aires')::time < time '13:00';

  SELECT count(*) INTO v_slots_tarde
    FROM get_availability(v_target, v_corte, v_carla)
    WHERE (slot_start AT TIME ZONE 'America/Argentina/Buenos_Aires')::time >= time '15:00';

  -- Slots que caen en el corte 13:00-15:00 (con solapamiento del rango del turno)
  SELECT count(*) INTO v_slots_corte
    FROM get_availability(v_target, v_corte, v_carla)
    WHERE tstzrange(slot_start, slot_end, '[)') &&
          tstzrange(local_ts(v_target, '13:00'), local_ts(v_target, '15:00'), '[)');

  PERFORM assert(v_slots_manana > 0, 'debe haber slots por la mañana');
  PERFORM assert(v_slots_tarde  > 0, 'debe haber slots por la tarde');
  PERFORM assert_equals(v_slots_corte, 0::bigint,
    'no debe haber slots en el corte del mediodía');
END $$;

ROLLBACK;
