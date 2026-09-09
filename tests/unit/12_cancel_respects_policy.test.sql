-- Test: cancel_appointment falla dentro de la ventana de 24h,
-- pero con force=true permite cancelar (uso desde handoff humano)
BEGIN;
SELECT seed_minimal();

DO $$
DECLARE
  v_ana   uuid := 'c1111111-1111-1111-1111-111111111111';
  v_carla uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_appt  uuid;
  v_error text;
BEGIN
  -- Turno en 3 horas (dentro de la ventana de 24h)
  INSERT INTO appointments (id, client_id, professional_id, starts_at, ends_at)
  VALUES (gen_random_uuid(), v_ana, v_carla,
          now() + interval '3 hours', now() + interval '3 hours' + interval '45 minutes')
  RETURNING id INTO v_appt;

  -- Sin force: debe fallar
  BEGIN
    PERFORM cancel_appointment(v_appt);
    PERFORM assert(false, 'debía fallar por política de 24h');
  EXCEPTION
    WHEN sqlstate 'P0001' THEN
      GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
      PERFORM assert_error_like(v_error, '24', 'razón debe mencionar el límite');
  END;

  -- El turno sigue confirmado
  PERFORM assert_equals(
    (SELECT status::text FROM appointments WHERE id = v_appt),
    'confirmed',
    'debe seguir confirmado tras el intento sin force'
  );

  -- Con force: debe cancelar
  PERFORM cancel_appointment(v_appt, p_force := true);
  PERFORM assert_equals(
    (SELECT status::text FROM appointments WHERE id = v_appt),
    'cancelled',
    'debe cancelarse con force=true'
  );
END $$;

ROLLBACK;
