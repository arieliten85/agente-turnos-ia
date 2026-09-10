-- Test: book_appointment con p_force := true mete un turno fuera de horario (uso humano)
BEGIN;
SELECT seed_minimal();

DO $$
DECLARE
  v_ana    uuid := 'c1111111-1111-1111-1111-111111111111';
  v_carla  uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_corte  uuid := '11111111-1111-1111-1111-111111111111';
  v_appt   uuid;
  v_row    record;
BEGIN
  -- 03:00 un sábado: sin p_force esto lo rechaza (ver test 21).
  -- El dueño, por vía handoff, tiene que poder forzarlo.
  v_appt := book_appointment(
    v_ana, v_carla, ARRAY[v_corte],
    local_ts(next_dow(6), '03:00'),
    p_notes  => 'Excepción autorizada por el dueño',
    p_force  => true
  );

  PERFORM assert(v_appt IS NOT NULL, 'con p_force el turno se tiene que crear');

  SELECT * INTO v_row FROM appointments WHERE id = v_appt;
  PERFORM assert_equals(v_row.status::text, 'confirmed', 'turno forzado queda confirmado');
  PERFORM assert_equals(
    (v_row.ends_at - v_row.starts_at),
    interval '45 minutes',
    'la duración sigue siendo la del servicio (45 min)'
  );
END $$;

ROLLBACK;
