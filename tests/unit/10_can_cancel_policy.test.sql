-- Test: can_cancel devuelve true si el turno está a más de 24h y false si está antes
BEGIN;
SELECT seed_minimal();

DO $$
DECLARE
  v_ana   uuid := 'c1111111-1111-1111-1111-111111111111';
  v_carla uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_appt_lejos uuid;
  v_appt_cerca uuid;
  v_check record;
BEGIN
  -- Turno la semana que viene: debe permitir cancelar
  INSERT INTO appointments (id, client_id, professional_id, starts_at, ends_at)
  VALUES (gen_random_uuid(), v_ana, v_carla,
          now() + interval '7 days', now() + interval '7 days' + interval '45 minutes')
  RETURNING id INTO v_appt_lejos;

  SELECT * INTO v_check FROM can_cancel(v_appt_lejos) LIMIT 1;
  PERFORM assert_equals(v_check.allowed, true, 'turno a 7 días debe permitir cancelar');
  PERFORM assert(v_check.reason IS NULL, 'no debe haber razón si allowed=true');

  -- Turno en 3 horas: NO debe permitir cancelar (política de 24h)
  INSERT INTO appointments (id, client_id, professional_id, starts_at, ends_at)
  VALUES (gen_random_uuid(), v_ana, v_carla,
          now() + interval '3 hours', now() + interval '3 hours' + interval '45 minutes')
  RETURNING id INTO v_appt_cerca;

  SELECT * INTO v_check FROM can_cancel(v_appt_cerca) LIMIT 1;
  PERFORM assert_equals(v_check.allowed, false, 'turno a 3h no debe permitir cancelar solo');
  PERFORM assert(v_check.reason IS NOT NULL, 'debe explicar por qué');
  PERFORM assert_error_like(v_check.reason, '24 horas', 'razón debe mencionar el límite');

  -- Turno inexistente
  SELECT * INTO v_check FROM can_cancel(gen_random_uuid()) LIMIT 1;
  PERFORM assert_equals(v_check.allowed, false, 'turno inexistente no cancelable');
  PERFORM assert_error_like(v_check.reason, 'inexistente', 'razón debe indicar inexistencia');
END $$;

ROLLBACK;
