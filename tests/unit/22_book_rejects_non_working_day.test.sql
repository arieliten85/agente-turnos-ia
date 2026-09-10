-- Test: book_appointment rechaza un turno un domingo (Carla no tiene schedule ese día)
BEGIN;
SELECT seed_minimal();

DO $$
DECLARE
  v_ana   uuid := 'c1111111-1111-1111-1111-111111111111';
  v_carla uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_corte uuid := '11111111-1111-1111-1111-111111111111';
  v_error text;
BEGIN
  -- seed_minimal carga horario martes(2) a sábado(6); el domingo(0) no atiende
  BEGIN
    PERFORM book_appointment(
      v_ana, v_carla, ARRAY[v_corte],
      local_ts(next_dow(0), '10:00')
    );
    PERFORM assert(false, 'Debía rechazar un turno en un día no laborable');
  EXCEPTION
    WHEN sqlstate 'P0001' THEN
      GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
      PERFORM assert_error_like(v_error, 'no atiende ese día',
        'El error debe indicar que el profesional no atiende ese día');
  END;

  PERFORM assert_equals(
    (SELECT count(*) FROM appointments WHERE professional_id = v_carla),
    0::bigint,
    'no debe quedar ningún turno creado tras el rechazo'
  );
END $$;

ROLLBACK;
