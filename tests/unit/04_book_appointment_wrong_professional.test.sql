-- Test: reservar Manicura con Carla (que no hace manicura) debe fallar
BEGIN;
SELECT seed_minimal();

DO $$
DECLARE
  v_ana   uuid := 'c1111111-1111-1111-1111-111111111111';
  v_carla uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_mani  uuid := '33333333-3333-3333-3333-333333333333';
  v_error text;
BEGIN
  BEGIN
    PERFORM book_appointment(
      v_ana, v_carla, ARRAY[v_mani],
      local_ts(next_dow(6), '10:00')
    );
    PERFORM assert(false, 'Debía fallar por profesional incompatible con el servicio');
  EXCEPTION
    WHEN sqlstate 'P0001' THEN
      GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
      PERFORM assert_error_like(v_error, 'no puede realizar',
        'Mensaje de error debe indicar profesional incompatible');
  END;
END $$;

ROLLBACK;
