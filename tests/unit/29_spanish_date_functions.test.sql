-- Test: spanish_weekday / spanish_date_label — nombres de día y fecha legible
-- en español, para timestamps ya en huso local (sin conversión implícita).
BEGIN;

DO $$
BEGIN
  -- 2026-09-14 es lunes (confirmado contra EXTRACT(DOW) en sesiones previas)
  PERFORM assert_equals(spanish_weekday('2026-09-14 10:00:00'::timestamp), 'lunes',
    'el 14 de septiembre de 2026 es lunes');
  -- 2026-09-18 es viernes (el ejemplo del propio plan: "viernes 18 de septiembre")
  PERFORM assert_equals(spanish_weekday('2026-09-18 10:00:00'::timestamp), 'viernes',
    'el 18 de septiembre de 2026 es viernes');
  PERFORM assert_equals(spanish_weekday('2026-09-12 00:00:00'::timestamp), 'sábado',
    'el 12 de septiembre de 2026 es sábado');
  PERFORM assert_equals(spanish_weekday('2026-09-13 23:59:00'::timestamp), 'domingo',
    'el 13 de septiembre de 2026 es domingo');

  PERFORM assert_equals(spanish_date_label('2026-09-18 11:00:00'::timestamp), 'viernes 18 de septiembre',
    'fecha legible sin año');
  PERFORM assert_equals(spanish_date_label('2026-09-18 11:00:00'::timestamp, true), 'viernes 18 de septiembre de 2026',
    'fecha legible con año');
  PERFORM assert_equals(spanish_date_label('2026-01-05 09:00:00'::timestamp), 'lunes 5 de enero',
    'mes de enero, día de un solo dígito');
  PERFORM assert_equals(spanish_date_label('2026-12-31 09:00:00'::timestamp, true), 'jueves 31 de diciembre de 2026',
    'diciembre, fin de año');
END $$;

ROLLBACK;
