# 07 · Puesta en marcha del demo (consultorio odontológico)

_Última actualización: 2026-09-10_

Este walkthrough arma un demo al que un odontólogo le pueda escribir por WhatsApp
**desde su celular** en una reunión, y ver al agente agendar, rechazar un horario
fuera de hora, derivar una consulta clínica y procesar una baja.

> **Arrancá esto el día 1, en paralelo con el bloque A del plan de trabajo.**
> Las 4 plantillas de WhatsApp (`walkthroughs/03-plantillas-whatsapp.md`) tardan
> **de horas a varios días** en aprobarse. Si las dejás para el final, el demo se
> atrasa una semana por un trámite. Cargalas apenas tengas la app de Meta creada
> y seguí con el resto mientras Meta las revisa.

---

## El punto que decide todo esto

El número de prueba que Meta te da gratis **solo conversa con hasta 5
destinatarios verificados a mano**. Cada uno recibe un código que te tiene que
pasar. Sirve para que **vos** pruebes; **no** sirve para que un prospecto le
escriba desde su celular sin que lo agregues antes.

Para un demo que se manda por WhatsApp en una reunión hacen falta **dos etapas**.

---

## Etapa 1 — validación interna (número de prueba de Meta)

Gratis e inmediato. Es para verificar que todo el circuito funciona punta a punta
antes de gastar en un número real.

1. En Meta, agregá **tu número** y uno más como destinatarios verificados del
   número de prueba (`walkthroughs/02-meta-app-y-numero.md`).
2. Cargá las 4 plantillas si todavía no lo hiciste
   (`walkthroughs/03-plantillas-whatsapp.md`). No bloquean esta etapa, pero
   cuanto antes entren a revisión, mejor.
3. Levantá el stack local:

   ```bash
   docker compose up -d
   ```

4. Corré el proceso **crear** del `SKILL.md` (`/crear-agente-turnos` en Claude
   Code). Cuando pida los datos del negocio, usá el seed de consultorio:

   ```bash
   node scripts/reset-demo.js --rubro=odonto --yes
   ```

   Eso carga `database/seed-demo-odonto.sql` ("Consultorio Demo": Dra. Rossi y
   Dr. Duarte, turno partido 9–13 / 15–19 de lunes a viernes, un feriado dentro
   de los próximos 30 días) y deja una agenda parcialmente ocupada.

5. Chateá de verdad desde tu celular. Pasá el checklist de más abajo.

Si algo falla acá, se arregla acá — no en la reunión.

---

## Etapa 2 — demo para prospectos (número real)

Cuando la Etapa 1 pasa entera, registrás un **número propio** en la WhatsApp
Business Platform:

- Una **línea aparte**, no tu WhatsApp personal. Un chip nuevo o un número
  virtual dedicado.
- Registrado en la WhatsApp Business Platform (Cloud API), no en WhatsApp
  Business a secas.
- Recibir e iniciar conversaciones **no tiene costo dentro de la ventana de 24 h**.
  Un demo de bajo volumen sale prácticamente cero.

Este es el número que le pasás al odontólogo en la reunión. Como es Cloud API y no
el número de prueba, **no hay lista de 5 destinatarios**: cualquiera le escribe.

Cambiás en el `.env` los valores de WhatsApp (`WA_PHONE_NUMBER_ID`, `WA_WABA_ID`,
`WA_TOKEN`, `WA_VERIFY_TOKEN`) por los del número real, reconfigurás el webhook en
Meta apuntando al mismo hostname de Cloudflare, y `docker compose up -d` de nuevo.
El resto del stack no cambia.

---

## Checklist "demo listo"

Antes de mostrárselo a nadie, todo esto tiene que dar bien, escribiendo desde un
celular al número del demo:

- [ ] Un desconocido le escribe al número y agenda un turno sin ayuda.
- [ ] Pide un horario fuera del horario de atención y el bot lo rechaza bien
      (bloque A: `book_appointment` valida la ventana).
- [ ] Pregunta algo clínico ("¿me conviene un implante?", "¿cuánto duele?") y el
      bot no opina: reencauza al turno o deriva (C2).
- [ ] Escribe **BAJA** y deja de recibir recordatorios (B1).
- [ ] Cancela dentro de las 24 h y el bot deriva a un humano en vez de cancelar
      solo.
- [ ] Llega el recordatorio con sus tres botones (Confirmar / Reprogramar /
      Cancelar).

> **Verificación en vivo.** Los bloques A–E están implementados, pero los
> cambios de los blueprints de n8n (B1–B4, opt-out, bucle de herramientas,
> validación de parámetros) todavía no se corrieron dentro de n8n: solo se
> revisó el JSON y se probó el SQL. En la Etapa 1 hay que verificar cada ítem del
> checklist de verdad. Ver `PLAN-DE-TRABAJO-PENDIENTES.md` para la lista de
> puntos frágiles a mirar.

> **Recordá:** el plan gratuito de Supabase pausa el proyecto tras 7 días sin
> actividad. Para un demo que queda "vivo" varios días, dejá un ping automático
> (`walkthroughs/01-supabase.md`).

Después de cada demostración, `node scripts/reset-demo.js --rubro=odonto --yes`
deja la agenda como al principio.
