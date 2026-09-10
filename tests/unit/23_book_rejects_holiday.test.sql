-- Test: book_appointment rechaza un turno en un feriado cargado en schedule_exceptions
BEGIN;
SELECT seed_minimal();

DO $$
DECLARE
  v_ana    uuid := 'c1111111-1111-1111-1111-111111111111';
  v_carla  uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_corte  uuid := '11111111-1111-1111-1111-111111111111';
  v_target date := next_dow(6);
  v_error  text;
BEGIN
  -- Feriado de todo el negocio (professional_id NULL, día completo)
  INSERT INTO schedule_exceptions
    (professional_id, date_from, date_to, time_from, time_to, exception_type, reason)
  VALUES
    (NULL, v_target, v_target, NULL, NULL, 'holiday', 'Feriado nacional');

  BEGIN
    PERFORM book_appointment(
      v_ana, v_carla, ARRAY[v_corte],
      local_ts(v_target, '10:00')
    );
    PERFORM assert(false, 'Debía rechazar un turno en un feriado');
  EXCEPTION
    WHEN sqlstate 'P0001' THEN
      GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
      PERFORM assert_error_like(v_error, 'bloqueado',
        'El error debe indicar que el día está bloqueado');
      PERFORM assert_error_like(v_error, 'Feriado nacional',
        'El error debe incluir el motivo de la excepción');
  END;

  PERFORM assert_equals(
    (SELECT count(*) FROM appointments WHERE professional_id = v_carla),
    0::bigint,
    'no debe quedar ningún turno creado tras el rechazo'
  );
END $$;

ROLLBACK;
