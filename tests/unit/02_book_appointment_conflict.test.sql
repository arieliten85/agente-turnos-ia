-- Test: dos reservas simultáneas al mismo slot del mismo profesional → la segunda falla limpio
BEGIN;
SELECT seed_minimal();

DO $$
DECLARE
  v_ana   uuid := 'c1111111-1111-1111-1111-111111111111';
  v_carla uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_corte uuid := '11111111-1111-1111-1111-111111111111';
  v_ts    timestamptz := local_ts(next_dow(6), '10:00');
  v_error text;
BEGIN
  -- Primera reserva: OK
  PERFORM book_appointment(v_ana, v_carla, ARRAY[v_corte], v_ts);

  -- Segunda reserva mismo slot: debe fallar
  BEGIN
    PERFORM book_appointment(v_ana, v_carla, ARRAY[v_corte], v_ts);
    -- Si no falla, el test falla
    PERFORM assert(false, 'La segunda reserva no lanzó excepción');
  EXCEPTION
    WHEN sqlstate 'P0001' THEN
      GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
      PERFORM assert_error_like(v_error, 'ya está ocupado',
        'El mensaje de conflicto debe ser el amigable');
  END;

  -- El turno original sigue siendo el único confirmado
  PERFORM assert_equals(
    (SELECT count(*) FROM appointments
      WHERE professional_id = v_carla AND starts_at = v_ts AND status = 'confirmed'),
    1::bigint,
    'debe existir un único turno confirmado en ese slot'
  );
END $$;

ROLLBACK;
