-- Test: un cliente con opted_out = true no aparece en la query de recordatorios
-- de flow-reminder, aunque tenga un turno confirmado dentro de la ventana.
-- La query es copia textual del nodo "Buscar turnos a recordar" de
-- blueprints/flows/flow-reminder.json (con __REMINDER_TYPE__ resuelto a '24h').
BEGIN;
SELECT seed_minimal();

DO $$
DECLARE
  v_ana    uuid := 'c1111111-1111-1111-1111-111111111111';
  v_beto   uuid := 'c2222222-2222-2222-2222-222222222222';
  v_carla  uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_start  timestamptz := now() + interval '12 hours';
  v_appt_ana  uuid := gen_random_uuid();
  v_appt_beto uuid := gen_random_uuid();
  v_ids    uuid[];
BEGIN
  -- Beto pidió la baja
  INSERT INTO clients (id, phone, name, opted_out, opted_out_at)
  VALUES (v_beto, '5491100000002', 'Beto', true, now());

  -- Un turno confirmado para cada uno, ambos dentro de la ventana de 24 h
  INSERT INTO appointments (id, client_id, professional_id, starts_at, ends_at) VALUES
    (v_appt_ana,  v_ana,  v_carla, v_start,                        v_start + interval '45 minutes'),
    (v_appt_beto, v_beto, v_carla, v_start + interval '3 hours',   v_start + interval '3 hours 45 minutes');

  -- --- Query copiada de "Buscar turnos a recordar" (flow-reminder.json) ---
  SELECT array_agg(a.id) INTO v_ids
  FROM appointments a
  JOIN clients c ON c.id = a.client_id
  JOIN professionals p ON p.id = a.professional_id
  CROSS JOIN business b
  WHERE a.status = 'confirmed'
    AND c.opted_out = false
    AND a.starts_at BETWEEN now() AND now() + (b.reminder_hours || ' hours')::interval
    AND NOT EXISTS (
      SELECT 1 FROM reminders_sent r
      WHERE r.appointment_id = a.id AND r.reminder_type = '24h'
    );
  -- ----------------------------------------------------------------------

  PERFORM assert(
    v_appt_ana = ANY(COALESCE(v_ids, ARRAY[]::uuid[])),
    'el turno de la clienta activa sí entra en el recordatorio'
  );
  PERFORM assert(
    NOT (v_appt_beto = ANY(COALESCE(v_ids, ARRAY[]::uuid[]))),
    'el turno del cliente con opt-out NO entra en el recordatorio'
  );
END $$;

ROLLBACK;
