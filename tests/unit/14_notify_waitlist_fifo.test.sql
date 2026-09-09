-- Test: si dos candidatas son válidas, gana la que se anotó primero (FIFO por created_at)
BEGIN;
SELECT seed_minimal();

DO $$
DECLARE
  v_ana   uuid := 'c1111111-1111-1111-1111-111111111111';
  v_carla uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_corte uuid := '11111111-1111-1111-1111-111111111111';
  v_color uuid := '22222222-2222-2222-2222-222222222222';
  v_bea uuid := gen_random_uuid();
  v_emi uuid := gen_random_uuid();
  v_wait_bea uuid := gen_random_uuid();
  v_wait_emi uuid := gen_random_uuid();
  v_appt uuid;
  v_winner uuid;
BEGIN
  v_appt := book_appointment(v_ana, v_carla, ARRAY[v_color], local_ts(next_dow(6), '15:00'));

  INSERT INTO clients (id, phone, name) VALUES
    (v_bea, '5491100000098', 'Bea'),
    (v_emi, '5491100000097', 'Emi');

  -- Bea se anota primero
  INSERT INTO waitlist (id, client_id, service_id, professional_id, date_from, date_to, created_at)
  VALUES (v_wait_bea, v_bea, v_corte, v_carla, CURRENT_DATE, CURRENT_DATE + 7, now() - interval '1 hour');

  -- Emi después
  INSERT INTO waitlist (id, client_id, service_id, professional_id, date_from, date_to, created_at)
  VALUES (v_wait_emi, v_emi, v_corte, v_carla, CURRENT_DATE, CURRENT_DATE + 7, now());

  SELECT client_id INTO v_winner FROM notify_waitlist(v_appt) LIMIT 1;
  PERFORM assert_equals(v_winner::text, v_bea::text, 'FIFO: gana Bea (anotada primero)');
END $$;

ROLLBACK;
