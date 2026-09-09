-- Test: book_appointment crea un turno con starts_at, ends_at correcto y estado 'confirmed'
BEGIN;
SELECT seed_minimal();

DO $$
DECLARE
  v_ana   uuid := 'c1111111-1111-1111-1111-111111111111';
  v_carla uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_corte uuid := '11111111-1111-1111-1111-111111111111';
  v_appt  uuid;
  v_row   record;
BEGIN
  -- Reservar Corte con Carla el próximo sábado a las 10 local
  v_appt := book_appointment(
    v_ana, v_carla, ARRAY[v_corte],
    local_ts(next_dow(6), '10:00')
  );

  PERFORM assert(v_appt IS NOT NULL, 'book_appointment devolvió NULL');

  SELECT * INTO v_row FROM appointments WHERE id = v_appt;
  PERFORM assert_equals(v_row.status::text, 'confirmed', 'status del turno recién creado');
  PERFORM assert_equals(v_row.professional_id::text, v_carla::text, 'profesional del turno');
  PERFORM assert_equals(
    (v_row.ends_at - v_row.starts_at),
    interval '45 minutes',
    'duración del turno debe ser 45 min (Corte)'
  );

  -- Debe haber una fila en appointment_services
  PERFORM assert_equals(
    (SELECT count(*) FROM appointment_services WHERE appointment_id = v_appt),
    1::bigint,
    'appointment_services debe tener una fila'
  );
END $$;

ROLLBACK;
