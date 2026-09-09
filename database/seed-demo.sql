-- ============================================================================
-- seed-demo.sql — datos base de la demo "Bella Studio"
-- ============================================================================
-- Solo INSERTs, con UUIDs fijos para que la demo sea reproducible. El borrado
-- previo lo hace reset-demo.js; los turnos "vivos" (jueves medio ocupado,
-- viernes a la tarde tapado) los genera reset-demo.js porque dependen de la
-- fecha de hoy.
-- ============================================================================

INSERT INTO business (name, timezone, address, handoff_phone, cancellation_hours, reminder_hours, buffer_seconds, slot_granularity_min)
VALUES ('Bella Studio', 'America/Argentina/Buenos_Aires', 'Av. Siempreviva 742, CABA', '5491133334444', 24, 24, 2.5, 15);

INSERT INTO services (id, name, duration_minutes, price) VALUES
  ('c0000000-0000-0000-0000-000000000001', 'Corte',    45,  5000),
  ('c0000000-0000-0000-0000-000000000002', 'Color',    120, 15000),
  ('c0000000-0000-0000-0000-000000000003', 'Brushing', 30,  4000),
  ('c0000000-0000-0000-0000-000000000004', 'Manicura', 60,  4500);

INSERT INTO professionals (id, name) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'Carla'),
  ('a0000000-0000-0000-0000-000000000002', 'Sofía');

INSERT INTO professional_services (professional_id, service_id) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001'),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000002'),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000003'),
  ('a0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000003'),
  ('a0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000004');

-- Martes (2) a sábado (6), 9 a 19, ambas profesionales.
INSERT INTO schedule (professional_id, day_of_week, time_from, time_to)
SELECT p.id, d, '09:00', '19:00'
FROM (VALUES
  ('a0000000-0000-0000-0000-000000000001'::uuid),
  ('a0000000-0000-0000-0000-000000000002'::uuid)
) AS p(id)
CROSS JOIN generate_series(2, 6) AS d;

-- Clientas base de la demo (para que consultar_turnos_cliente y los recordatorios
-- tengan a quién mostrar).
INSERT INTO clients (id, phone, name) VALUES
  ('d0000000-0000-0000-0000-000000000001', '5491100000001', 'Ana'),
  ('d0000000-0000-0000-0000-000000000002', '5491100000002', 'Bea'),
  ('d0000000-0000-0000-0000-000000000003', '5491100000003', 'Cami'),
  ('d0000000-0000-0000-0000-000000000004', '5491100000004', 'Dana'),
  ('d0000000-0000-0000-0000-000000000005', '5491100000005', 'Emi');
