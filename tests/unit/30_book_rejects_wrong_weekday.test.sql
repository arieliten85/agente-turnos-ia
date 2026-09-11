-- Test: book_appointment rechaza el turno si p_expected_dow no coincide con
-- el día real de p_starts_at (backstop de T0 para "viernes 14" cuando el 14
-- cae lunes).
BEGIN;
SELECT seed_minimal();

DO $$
DECLARE
  v_ana   uuid := 'c1111111-1111-1111-1111-111111111111';
  v_carla uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_corte uuid := '11111111-1111-1111-1111-111111111111';
  v_error text;
BEGIN
  -- next_dow(6) es sábado por definición; le mandamos "viernes" a propósito.
  BEGIN
    PERFORM book_appointment(
      v_ana, v_carla, ARRAY[v_corte],
      local_ts(next_dow(6), '10:00'),
      p_expected_dow := 'viernes'
    );
    PERFORM assert(false, 'Debía rechazar: la fecha es sábado, no viernes');
  EXCEPTION
    WHEN sqlstate 'P0001' THEN
      GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
      PERFORM assert_error_like(v_error, 'día de la semana no coincide',
        'El error debe señalar el desacuerdo día/fecha');
  END;

  PERFORM assert_equals(
    (SELECT count(*) FROM appointments WHERE professional_id = v_carla),
    0::bigint,
    'no debe quedar ningún turno creado tras el rechazo'
  );
END $$;

ROLLBACK;
