-- Test: book_appointment rechaza un turno a las 03:00 (fuera del horario laboral)
BEGIN;
SELECT seed_minimal();

DO $$
DECLARE
  v_ana   uuid := 'c1111111-1111-1111-1111-111111111111';
  v_carla uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_corte uuid := '11111111-1111-1111-1111-111111111111';
  v_error text;
BEGIN
  -- Carla atiende sábado 9-19; 03:00 queda antes de la apertura
  BEGIN
    PERFORM book_appointment(
      v_ana, v_carla, ARRAY[v_corte],
      local_ts(next_dow(6), '03:00')
    );
    PERFORM assert(false, 'Debía rechazar un turno fuera del horario laboral');
  EXCEPTION
    WHEN sqlstate 'P0001' THEN
      GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
      PERFORM assert_error_like(v_error, 'apertura',
        'El error debe indicar que el turno cae fuera del horario');
  END;

  -- No se creó ningún turno
  PERFORM assert_equals(
    (SELECT count(*) FROM appointments WHERE professional_id = v_carla),
    0::bigint,
    'no debe quedar ningún turno creado tras el rechazo'
  );
END $$;

ROLLBACK;
