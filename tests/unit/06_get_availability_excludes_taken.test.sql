-- Test: reservar un turno reduce los slots disponibles en get_availability
BEGIN;
SELECT seed_minimal();

DO $$
DECLARE
  v_ana   uuid := 'c1111111-1111-1111-1111-111111111111';
  v_carla uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_corte uuid := '11111111-1111-1111-1111-111111111111';
  v_target date := next_dow(6);
  v_slots_antes bigint;
  v_slots_despues bigint;
  v_conflicts bigint;
BEGIN
  SELECT count(*) INTO v_slots_antes
    FROM get_availability(v_target, v_corte, v_carla);

  -- Reservar Corte 15:00-15:45 con Carla
  PERFORM book_appointment(v_ana, v_carla, ARRAY[v_corte], local_ts(v_target, '15:00'));

  SELECT count(*) INTO v_slots_despues
    FROM get_availability(v_target, v_corte, v_carla);

  PERFORM assert(
    v_slots_despues < v_slots_antes,
    format('reservar debe reducir slots. Antes: %s, después: %s', v_slots_antes, v_slots_despues)
  );

  -- Ningún slot devuelto se pisa con 15:00-15:45
  SELECT count(*) INTO v_conflicts
    FROM get_availability(v_target, v_corte, v_carla)
    WHERE tstzrange(slot_start, slot_end, '[)') &&
          tstzrange(local_ts(v_target, '15:00'), local_ts(v_target, '15:45'), '[)');

  PERFORM assert_equals(v_conflicts, 0::bigint,
    'ningún slot debe solaparse con el turno recién creado');
END $$;

ROLLBACK;
