-- Test: book_appointment reserva normalmente cuando p_expected_dow coincide,
-- y el chequeo es insensible a mayúsculas/acentos (el modelo puede escribir
-- "Sábado" o "SABADO" sin acento).
BEGIN;
SELECT seed_minimal();

DO $$
DECLARE
  v_ana    uuid := 'c1111111-1111-1111-1111-111111111111';
  v_carla  uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_corte  uuid := '11111111-1111-1111-1111-111111111111';
  v_target date := next_dow(6); -- sábado
  v_appt1  uuid;
  v_appt2  uuid;
BEGIN
  v_appt1 := book_appointment(
    v_ana, v_carla, ARRAY[v_corte],
    local_ts(v_target, '10:00'),
    p_expected_dow := 'sábado'
  );
  PERFORM assert(v_appt1 IS NOT NULL, 'debe reservar cuando el día coincide exacto');
  PERFORM assert_equals(
    (SELECT status::text FROM appointments WHERE id = v_appt1), 'confirmed',
    'el turno queda confirmado'
  );

  -- Sin acento y en mayúsculas, otro horario para no chocar con el anterior
  v_appt2 := book_appointment(
    v_ana, v_carla, ARRAY[v_corte],
    local_ts(v_target, '11:00'),
    p_expected_dow := 'SABADO'
  );
  PERFORM assert(v_appt2 IS NOT NULL, 'debe reservar con "SABADO" sin acento y en mayúsculas');

  -- p_expected_dow NULL (el caso de siempre, no lo manda) sigue funcionando
  PERFORM assert(
    book_appointment(v_ana, v_carla, ARRAY[v_corte], local_ts(v_target, '12:00')) IS NOT NULL,
    'sin p_expected_dow no debe romper nada existente'
  );
END $$;

ROLLBACK;
