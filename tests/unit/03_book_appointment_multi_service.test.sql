-- Test: un turno con dos servicios (Corte + Color) suma sus duraciones
-- 45 + 120 = 165 minutos, mismo profesional en v1
BEGIN;
SELECT seed_minimal();

DO $$
DECLARE
  v_ana   uuid := 'c1111111-1111-1111-1111-111111111111';
  v_carla uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_corte uuid := '11111111-1111-1111-1111-111111111111';
  v_color uuid := '22222222-2222-2222-2222-222222222222';
  v_appt  uuid;
  v_row   record;
BEGIN
  v_appt := book_appointment(
    v_ana, v_carla,
    ARRAY[v_corte, v_color],
    local_ts(next_dow(6), '10:00')
  );

  SELECT * INTO v_row FROM appointments WHERE id = v_appt;
  PERFORM assert_equals(
    (v_row.ends_at - v_row.starts_at),
    interval '165 minutes',
    'duración debe ser 45 + 120 = 165 min'
  );

  -- Debe haber dos filas en appointment_services, ambas con Carla
  PERFORM assert_equals(
    (SELECT count(*) FROM appointment_services WHERE appointment_id = v_appt),
    2::bigint,
    'appointment_services debe tener 2 filas'
  );

  PERFORM assert_equals(
    (SELECT count(DISTINCT professional_id) FROM appointment_services WHERE appointment_id = v_appt),
    1::bigint,
    'en v1 todos los servicios van con el mismo profesional'
  );
END $$;

ROLLBACK;
