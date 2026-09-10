-- Test: get_availability con varios servicios usa la duración SUMADA para el corte de horario
BEGIN;
SELECT seed_minimal();

DO $$
DECLARE
  v_carla  uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_corte  uuid := '11111111-1111-1111-1111-111111111111';
  v_color  uuid := '22222222-2222-2222-2222-222222222222';
  v_target date := next_dow(6);
  v_slots_18   bigint;
  v_last_end   timestamptz;
BEGIN
  -- Corte (45) + Color (120) = 165 min. Carla cierra 19:00.
  -- Un inicio a las 18:00 terminaría 20:45: no puede aparecer.
  SELECT count(*) INTO v_slots_18
    FROM get_availability(v_target, ARRAY[v_corte, v_color], v_carla)
    WHERE (slot_start AT TIME ZONE 'America/Argentina/Buenos_Aires')::time = time '18:00';

  PERFORM assert_equals(v_slots_18, 0::bigint,
    'las 18:00 no puede ofrecerse: Corte+Color no entra antes del cierre');

  -- El último hueco ofrecido tiene que terminar 19:00 o antes
  SELECT max(slot_end) INTO v_last_end
    FROM get_availability(v_target, ARRAY[v_corte, v_color], v_carla);

  PERFORM assert(v_last_end IS NOT NULL, 'debe haber al menos un hueco para Corte+Color');
  PERFORM assert(
    v_last_end <= local_ts(v_target, '19:00'),
    'ningún hueco de Corte+Color puede terminar después del cierre (19:00)'
  );
END $$;

ROLLBACK;
