-- ============================================================================
-- seed-demo-odonto.sql — datos base de la demo "Consultorio Demo" (odontología)
-- ============================================================================
-- Variante del seed de demo para consultorios odontológicos. No reemplaza a
-- seed-demo.sql (peluquería): reset-demo.js elige uno u otro según --rubro.
--
-- Solo INSERTs, con UUIDs fijos para que la demo sea reproducible. Los turnos
-- "vivos" (una agenda parcialmente ocupada, relativa a hoy) los arma
-- reset-demo.js.
--
-- Precios: valores INDICATIVOS del rubro para Argentina, a septiembre 2026, y
-- son PRECIOS DE CONSULTA, no del tratamiento. El implante completo va de
-- $550.000 a $650.000 ARS y ese número nunca se carga como precio de un turno.
-- Ajustá estos montos con los del consultorio real antes de la demo.
-- ============================================================================

INSERT INTO business (name, timezone, address, handoff_phone, cancellation_hours, reminder_hours, buffer_seconds, slot_granularity_min)
VALUES ('Consultorio Demo', 'America/Argentina/Buenos_Aires', 'Av. Corrientes 1234, CABA', '5491133334444', 24, 24, 2.5, 15);

INSERT INTO services (id, name, duration_minutes, price) VALUES
  ('e0000000-0000-0000-0000-000000000001', 'Consulta de diagnóstico',        30, 18000),
  ('e0000000-0000-0000-0000-000000000002', 'Limpieza',                       45, 38000),
  ('e0000000-0000-0000-0000-000000000003', 'Implante — primera consulta',    45, 25000),
  ('e0000000-0000-0000-0000-000000000004', 'Ortodoncia — primera consulta',  45, 22000);

-- Dos profesionales con especialidades distintas: el implante solo lo evalúa
-- Duarte, la ortodoncia solo Rossi. Así se ejercita el filtro de
-- professional_services al elegir profesional.
INSERT INTO professionals (id, name) VALUES
  ('e1000000-0000-0000-0000-000000000001', 'Dra. Rossi'),
  ('e1000000-0000-0000-0000-000000000002', 'Dr. Duarte');

INSERT INTO professional_services (professional_id, service_id) VALUES
  ('e1000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001'),  -- Rossi: diagnóstico
  ('e1000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000002'),  -- Rossi: limpieza
  ('e1000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000004'),  -- Rossi: ortodoncia
  ('e1000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001'),  -- Duarte: diagnóstico
  ('e1000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000002'),  -- Duarte: limpieza
  ('e1000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000003');  -- Duarte: implante

-- Lunes (1) a viernes (5), turno partido 9-13 y 15-19, ambos profesionales.
-- El turno partido es lo normal en un consultorio y ejercita el caso que más se
-- rompe (un turno tiene que caber entero en UNA franja).
INSERT INTO schedule (professional_id, day_of_week, time_from, time_to)
SELECT p.id, d, f.time_from, f.time_to
FROM (VALUES
  ('e1000000-0000-0000-0000-000000000001'::uuid),
  ('e1000000-0000-0000-0000-000000000002'::uuid)
) AS p(id)
CROSS JOIN generate_series(1, 5) AS d
CROSS JOIN (VALUES
  ('09:00'::time, '13:00'::time),
  ('15:00'::time, '19:00'::time)
) AS f(time_from, time_to);

-- Un feriado de todo el negocio dentro de los próximos 30 días (día completo).
INSERT INTO schedule_exceptions (professional_id, date_from, date_to, time_from, time_to, exception_type, reason)
VALUES (NULL, CURRENT_DATE + 12, CURRENT_DATE + 12, NULL, NULL, 'holiday', 'Feriado');

-- Personas base de la demo (para que consultar_turnos_cliente y los
-- recordatorios tengan a quién mostrar).
INSERT INTO clients (id, phone, name) VALUES
  ('e2000000-0000-0000-0000-000000000001', '5491100000001', 'Ana'),
  ('e2000000-0000-0000-0000-000000000002', '5491100000002', 'Beto'),
  ('e2000000-0000-0000-0000-000000000003', '5491100000003', 'Cami'),
  ('e2000000-0000-0000-0000-000000000004', '5491100000004', 'Darío'),
  ('e2000000-0000-0000-0000-000000000005', '5491100000005', 'Emi');
