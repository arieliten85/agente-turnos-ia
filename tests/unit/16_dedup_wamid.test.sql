-- Test: insertar el mismo wamid dos veces viola el PK (mecanismo de dedup del webhook)
BEGIN;
SELECT seed_minimal();

DO $$
DECLARE
  v_wamid text := 'wamid.ABC123XYZ';
  v_error text;
BEGIN
  INSERT INTO processed_messages (wamid) VALUES (v_wamid);

  BEGIN
    INSERT INTO processed_messages (wamid) VALUES (v_wamid);
    PERFORM assert(false, 'insertar el mismo wamid dos veces debía violar el PK');
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
      -- OK: violación de unicidad es el mecanismo que usa el flow-webhook
  END;

  -- La tabla sigue teniendo una sola fila
  PERFORM assert_equals(
    (SELECT count(*) FROM processed_messages WHERE wamid = v_wamid),
    1::bigint,
    'debe haber una sola fila con ese wamid'
  );
END $$;

ROLLBACK;
