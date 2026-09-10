-- Test: book_appointment con un servicio inexistente tira excepción en vez de
-- crear un turno más corto (degradación silenciosa).
BEGIN;
SELECT seed_minimal();

DO $$
DECLARE
  v_ana   uuid := 'c1111111-1111-1111-1111-111111111111';
  v_carla uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_corte uuid := '11111111-1111-1111-1111-111111111111';
  v_fake  uuid := '99999999-9999-9999-9999-999999999999';
  v_error text;
BEGIN
  BEGIN
    PERFORM book_appointment(
      v_ana, v_carla,
      ARRAY[v_corte, v_fake],
      local_ts(next_dow(6), '10:00')
    );
    PERFORM assert(false, 'Debía fallar: uno de los servicios no existe');
  EXCEPTION
    WHEN sqlstate 'P0001' THEN
      GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
      PERFORM assert_error_like(v_error, 'inexistentes o inactivos',
        'El error debe indicar que un servicio no resolvió');
  END;

  PERFORM assert_equals(
    (SELECT count(*) FROM appointments WHERE professional_id = v_carla),
    0::bigint,
    'no debe quedar ningún turno (ni corto ni completo) tras el rechazo'
  );
END $$;

ROLLBACK;
