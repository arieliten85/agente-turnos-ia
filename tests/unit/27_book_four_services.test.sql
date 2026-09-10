-- Test: book_appointment con 4 servicios calcula la duración como la suma de los 4
-- (sin tope de 3 posiciones fijas).
BEGIN;
SELECT seed_minimal();

DO $$
DECLARE
  v_ana     uuid := 'c1111111-1111-1111-1111-111111111111';
  v_carla   uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_corte   uuid := '11111111-1111-1111-1111-111111111111';
  v_color   uuid := '22222222-2222-2222-2222-222222222222';
  v_mani    uuid := '33333333-3333-3333-3333-333333333333';
  v_peinado uuid := '44444444-4444-4444-4444-444444444444';
  v_appt    uuid;
  v_row     record;
BEGIN
  -- 4º servicio + Carla habilitada para los 4
  INSERT INTO services (id, name, duration_minutes, price)
  VALUES (v_peinado, 'Peinado', 30, 3000);
  INSERT INTO professional_services VALUES
    (v_carla, v_mani),
    (v_carla, v_peinado);

  -- 45 + 120 + 60 + 30 = 255 minutos; arranca 09:00 y entra en la ventana 9-19
  v_appt := book_appointment(
    v_ana, v_carla,
    ARRAY[v_corte, v_color, v_mani, v_peinado],
    local_ts(next_dow(6), '09:00')
  );

  SELECT * INTO v_row FROM appointments WHERE id = v_appt;
  PERFORM assert_equals(
    (v_row.ends_at - v_row.starts_at),
    interval '255 minutes',
    'la duración del turno tiene que ser la suma de los 4 servicios'
  );
  PERFORM assert_equals(
    (SELECT count(*) FROM appointment_services WHERE appointment_id = v_appt),
    4::bigint,
    'tienen que quedar registrados los 4 servicios del turno'
  );
END $$;

ROLLBACK;
