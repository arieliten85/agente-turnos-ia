-- Test: notify_waitlist excluye clientes en opt-out, servicios que el profesional
-- no puede hacer, y fechas fuera de rango
BEGIN;
SELECT seed_minimal();

DO $$
DECLARE
  v_ana   uuid := 'c1111111-1111-1111-1111-111111111111';
  v_carla uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_corte uuid := '11111111-1111-1111-1111-111111111111';
  v_color uuid := '22222222-2222-2222-2222-222222222222';
  v_mani  uuid := '33333333-3333-3333-3333-333333333333';
  v_bea uuid := gen_random_uuid();
  v_cami uuid := gen_random_uuid();
  v_dana uuid := gen_random_uuid();
  v_appt uuid;
  v_count bigint;
BEGIN
  v_appt := book_appointment(v_ana, v_carla, ARRAY[v_color], local_ts(next_dow(6), '15:00'));

  INSERT INTO clients (id, phone, name, opted_out) VALUES
    (v_bea,  '5491100000096', 'Bea',  true),   -- opt-out
    (v_cami, '5491100000095', 'Cami', false),
    (v_dana, '5491100000094', 'Dana', false);

  -- Bea (opt-out) quiere Corte con Carla → debe excluirse
  INSERT INTO waitlist (client_id, service_id, professional_id, date_from, date_to)
  VALUES (v_bea, v_corte, v_carla, CURRENT_DATE, CURRENT_DATE + 7);

  -- Cami quiere Manicura → Carla no la hace, debe excluirse
  INSERT INTO waitlist (client_id, service_id, professional_id, date_from, date_to)
  VALUES (v_cami, v_mani, NULL, CURRENT_DATE, CURRENT_DATE + 7);

  -- Dana quiere Corte pero el mes que viene → fuera de rango
  INSERT INTO waitlist (client_id, service_id, professional_id, date_from, date_to)
  VALUES (v_dana, v_corte, v_carla, CURRENT_DATE + 30, CURRENT_DATE + 45);

  SELECT count(*) INTO v_count FROM notify_waitlist(v_appt);
  PERFORM assert_equals(v_count, 0::bigint,
    'las tres candidatas deben quedar excluidas (opt-out, servicio incompatible, fuera de rango)');
END $$;

ROLLBACK;
