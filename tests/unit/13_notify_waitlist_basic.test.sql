-- Test: notify_waitlist devuelve al primer candidato válido y no cambia estados
BEGIN;
SELECT seed_minimal();

DO $$
DECLARE
  v_ana   uuid := 'c1111111-1111-1111-1111-111111111111';
  v_carla uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_corte uuid := '11111111-1111-1111-1111-111111111111';
  v_color uuid := '22222222-2222-2222-2222-222222222222';
  v_bea uuid := gen_random_uuid();
  v_wait uuid := gen_random_uuid();
  v_appt uuid;
  v_row  record;
BEGIN
  -- Turno de Color (120min) con Carla mañana
  v_appt := book_appointment(v_ana, v_carla, ARRAY[v_color], local_ts(next_dow(6), '15:00'));

  -- Bea en waitlist: Corte con Carla en el rango
  INSERT INTO clients (id, phone, name) VALUES (v_bea, '5491100000099', 'Bea');
  INSERT INTO waitlist (id, client_id, service_id, professional_id, date_from, date_to)
  VALUES (v_wait, v_bea, v_corte, v_carla, CURRENT_DATE, CURRENT_DATE + 7);

  SELECT * INTO v_row FROM notify_waitlist(v_appt) LIMIT 1;
  PERFORM assert_equals(v_row.waitlist_id::text, v_wait::text, 'debe devolver el waitlist de Bea');
  PERFORM assert_equals(v_row.client_id::text, v_bea::text, 'client_id debe ser Bea');
  PERFORM assert_equals(v_row.service_name, 'Corte', 'service_name debe ser Corte');

  -- notify_waitlist NO cambia estados (es solo lectura)
  PERFORM assert_equals(
    (SELECT status::text FROM waitlist WHERE id = v_wait),
    'waiting',
    'notify_waitlist no debe cambiar status'
  );
END $$;

ROLLBACK;
