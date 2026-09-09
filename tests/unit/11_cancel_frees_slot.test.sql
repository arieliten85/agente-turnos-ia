-- Test: cancelar un turno libera el slot para poder reservar de nuevo
BEGIN;
SELECT seed_minimal();

DO $$
DECLARE
  v_ana   uuid := 'c1111111-1111-1111-1111-111111111111';
  v_carla uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_corte uuid := '11111111-1111-1111-1111-111111111111';
  v_ts    timestamptz := local_ts(next_dow(6), '10:00');
  v_appt  uuid;
  v_new   uuid;
BEGIN
  v_appt := book_appointment(v_ana, v_carla, ARRAY[v_corte], v_ts);

  PERFORM cancel_appointment(v_appt);

  PERFORM assert_equals(
    (SELECT status::text FROM appointments WHERE id = v_appt),
    'cancelled',
    'el turno cancelado debe tener status=cancelled'
  );

  -- Ahora se puede reservar el mismo slot (la restricción de exclusión filtra por status=confirmed)
  v_new := book_appointment(v_ana, v_carla, ARRAY[v_corte], v_ts);
  PERFORM assert(v_new IS NOT NULL, 'debe poder reservarse el slot recién liberado');
  PERFORM assert(v_new != v_appt, 'debe ser un turno distinto al cancelado');
END $$;

ROLLBACK;
