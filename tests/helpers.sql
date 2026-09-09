-- ============================================================================
-- Helpers para tests unitarios
-- ============================================================================
-- Se aplican una sola vez, después del schema, antes de correr los tests.
-- Cada test .sql envuelve su lógica en BEGIN/ROLLBACK: usa estos helpers para
-- setear datos y aserciones, y al terminar (o fallar) deja la base limpia.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- assert(condition, message)
-- ----------------------------------------------------------------------------
-- Falla el test con un mensaje claro si la condición no se cumple.

CREATE OR REPLACE FUNCTION assert(p_condition boolean, p_message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_condition IS NULL OR p_condition = false THEN
    RAISE EXCEPTION 'ASSERTION FAILED: %', p_message
      USING ERRCODE = 'triggered_action_exception';
  END IF;
END;
$$;


-- ----------------------------------------------------------------------------
-- assert_equals(actual, expected, message)
-- ----------------------------------------------------------------------------
-- Falla mostrando ambos valores. Sobrecargada para varios tipos.

CREATE OR REPLACE FUNCTION assert_equals(p_actual text, p_expected text, p_message text DEFAULT '')
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'ASSERTION FAILED: % | esperado: % | obtenido: %',
      p_message, COALESCE(p_expected, 'NULL'), COALESCE(p_actual, 'NULL')
      USING ERRCODE = 'triggered_action_exception';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION assert_equals(p_actual bigint, p_expected bigint, p_message text DEFAULT '')
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'ASSERTION FAILED: % | esperado: % | obtenido: %',
      p_message, p_expected::text, p_actual::text
      USING ERRCODE = 'triggered_action_exception';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION assert_equals(p_actual boolean, p_expected boolean, p_message text DEFAULT '')
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'ASSERTION FAILED: % | esperado: % | obtenido: %',
      p_message, p_expected::text, p_actual::text
      USING ERRCODE = 'triggered_action_exception';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION assert_equals(p_actual interval, p_expected interval, p_message text DEFAULT '')
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'ASSERTION FAILED: % | esperado: % | obtenido: %',
      p_message, p_expected::text, p_actual::text
      USING ERRCODE = 'triggered_action_exception';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION assert_equals(p_actual timestamptz, p_expected timestamptz, p_message text DEFAULT '')
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'ASSERTION FAILED: % | esperado: % | obtenido: %',
      p_message, p_expected::text, p_actual::text
      USING ERRCODE = 'triggered_action_exception';
  END IF;
END;
$$;


-- ----------------------------------------------------------------------------
-- assert_error_like(sqlstate_or_message pattern, actual_message)
-- ----------------------------------------------------------------------------
-- Verifica que un mensaje de error contenga un patrón. Usado dentro de
-- bloques EXCEPTION para verificar que el error correcto fue lanzado.

CREATE OR REPLACE FUNCTION assert_error_like(p_actual_message text, p_pattern text, p_context text DEFAULT '')
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_actual_message NOT LIKE '%' || p_pattern || '%' THEN
    RAISE EXCEPTION 'ASSERTION FAILED: % | patrón esperado: "%" | obtenido: "%"',
      p_context, p_pattern, p_actual_message
      USING ERRCODE = 'triggered_action_exception';
  END IF;
END;
$$;


-- ----------------------------------------------------------------------------
-- seed_minimal()
-- ----------------------------------------------------------------------------
-- Setup mínimo consistente para tests. Devuelve nada; crea:
--   - business "Bella Studio" con TZ Argentina y política de 24h
--   - servicios: Corte (45), Color (120), Manicura (60)
--   - profesionales: Carla (Corte + Color), Sofía (Manicura)
--   - horario: ambas martes a sábado 9-19 (dow 2-6)
--   - cliente: Ana (número 5491100000001)

CREATE OR REPLACE FUNCTION seed_minimal()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_carla uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_sofia uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  v_corte uuid := '11111111-1111-1111-1111-111111111111';
  v_color uuid := '22222222-2222-2222-2222-222222222222';
  v_mani  uuid := '33333333-3333-3333-3333-333333333333';
  v_ana   uuid := 'c1111111-1111-1111-1111-111111111111';
  d smallint;
BEGIN
  INSERT INTO business (name, timezone, cancellation_hours, slot_granularity_min)
  VALUES ('Bella Studio', 'America/Argentina/Buenos_Aires', 24, 15);

  INSERT INTO services (id, name, duration_minutes, price) VALUES
    (v_corte, 'Corte',   45,  5000),
    (v_color, 'Color',   120, 15000),
    (v_mani,  'Manicura', 60, 4000);

  INSERT INTO professionals (id, name) VALUES
    (v_carla, 'Carla'),
    (v_sofia, 'Sofía');

  INSERT INTO professional_services VALUES
    (v_carla, v_corte),
    (v_carla, v_color),
    (v_sofia, v_mani);

  -- Martes(2) a sábado(6), 9-19, ambas profesionales
  FOR d IN 2..6 LOOP
    INSERT INTO schedule (professional_id, day_of_week, time_from, time_to) VALUES
      (v_carla, d, '09:00', '19:00'),
      (v_sofia, d, '09:00', '19:00');
  END LOOP;

  INSERT INTO clients (id, phone, name) VALUES
    (v_ana, '5491100000001', 'Ana');
END;
$$;


-- ----------------------------------------------------------------------------
-- next_dow(target_dow)
-- ----------------------------------------------------------------------------
-- Devuelve la próxima fecha (después de hoy) que sea el día de la semana dado.
-- Útil para tests que necesitan "el próximo sábado" sin importar cuándo corran.

CREATE OR REPLACE FUNCTION next_dow(p_target_dow integer)
RETURNS date
LANGUAGE sql
STABLE
AS $$
  SELECT CURRENT_DATE + (((p_target_dow - EXTRACT(DOW FROM CURRENT_DATE)::int + 7) % 7 + 7))::int;
$$;


-- ----------------------------------------------------------------------------
-- local_ts(date, time)
-- ----------------------------------------------------------------------------
-- Compone un timestamptz interpretando date + time en la TZ del negocio.

CREATE OR REPLACE FUNCTION local_ts(p_date date, p_time time)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_tz text;
BEGIN
  SELECT timezone INTO v_tz FROM business LIMIT 1;
  IF v_tz IS NULL THEN v_tz := 'America/Argentina/Buenos_Aires'; END IF;
  RETURN (p_date::text || ' ' || p_time::text)::timestamp AT TIME ZONE v_tz;
END;
$$;
