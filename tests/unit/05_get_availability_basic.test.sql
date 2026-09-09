-- Test: get_availability un día laborable devuelve slots dentro del horario
BEGIN;
SELECT seed_minimal();

DO $$
DECLARE
  v_carla uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_corte uuid := '11111111-1111-1111-1111-111111111111';
  v_target date := next_dow(6);  -- próximo sábado
  v_first  timestamptz;
  v_last   timestamptz;
  v_count  bigint;
BEGIN
  SELECT count(*), min(slot_start), max(slot_start)
    INTO v_count, v_first, v_last
    FROM get_availability(v_target, v_corte, v_carla);

  PERFORM assert(v_count > 0, 'debe haber slots disponibles un sábado laborable');

  -- El primer slot debe ser a las 9:00 local (inicio de horario) o después
  PERFORM assert(
    (v_first AT TIME ZONE 'America/Argentina/Buenos_Aires')::time >= time '09:00',
    'primer slot debe ser >= 9:00 local (obtenido: ' || (v_first AT TIME ZONE 'America/Argentina/Buenos_Aires')::text || ')'
  );

  -- El último slot no puede terminar después de las 19:00
  PERFORM assert(
    ((v_last + interval '45 minutes') AT TIME ZONE 'America/Argentina/Buenos_Aires')::time <= time '19:00',
    'último slot no puede terminar después de las 19:00'
  );
END $$;

ROLLBACK;
