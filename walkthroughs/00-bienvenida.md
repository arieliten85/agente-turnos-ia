# 00 · Bienvenida

_Última actualización: 2026-09-09_

Vas a montar un agente de turnos por WhatsApp: recibe mensajes, agenda, consulta,
reprograma y cancela turnos, manda recordatorios y, cuando no puede resolver algo,
se lo pasa a una persona.

## Qué necesitás tener a mano

Cuentas (todas tienen plan gratuito para arrancar):

1. **Supabase** — la base de datos. → `walkthroughs/01-supabase.md`
2. **Meta for Developers** — el número de WhatsApp y la API. → `walkthroughs/02-meta-app-y-numero.md`
3. **Cloudflare** — el túnel que expone el webhook con una URL estable. → `walkthroughs/04-cloudflare-tunnel.md`
4. **Google AI Studio** (Gemini, para desarrollo) o **Anthropic** (Claude, para producción). → `walkthroughs/05-modelo-api-key.md`

En la máquina:

- **Docker** y **Docker Compose** (viene con Docker Desktop).
- **Node 18+** para correr los scripts de `scripts/`.

## El orden

1. **Plantillas de WhatsApp primero.** Meta tarda de horas a días en aprobarlas.
   Se cargan apenas tenés la app creada, así se aprueban mientras seguís con el
   resto. → `walkthroughs/03-plantillas-whatsapp.md`
2. Supabase (base y esquema).
3. Cloudflare Tunnel (URL pública estable).
4. Meta: número, webhook, token.
5. Modelo: API key.
6. `docker compose up` y la importación de los flujos a n8n.
7. Prueba de conexión y `scripts/simulator.js`.

Todo esto lo conduce el `SKILL.md`: te va pidiendo un dato por vez y te manda al
walkthrough que corresponde en cada momento.

## Dos avisos importantes

- **El número de prueba de Meta tiene un tope de destinatarios**, y agregar uno le
  manda un código de verificación que esa persona tiene que pasarte. No es
  silencioso: si vas a hacer una demo, avisale antes al prospecto y sumá su número
  con anticipación. Detalle en `walkthroughs/02-meta-app-y-numero.md`.
- **El plan gratuito de Supabase pausa el proyecto después de 7 días sin
  actividad.** Para la demo conviene dejar un ping automático (una GitHub Action
  gratis alcanza). Detalle en `walkthroughs/01-supabase.md`.

## Nada de ngrok

La URL del webhook tiene que ser **estable**. Con ngrok cambia en cada reinicio y
hay que reconfigurar el webhook en Meta cada vez. Por eso usamos Cloudflare Tunnel,
que te da un hostname fijo.
