# 03 · Plantillas de WhatsApp

_Última actualización: 2026-09-09_

WhatsApp solo deja mandar mensajes **libres** dentro de las 24 h del último mensaje
de la clienta. Fuera de esa ventana hay que usar **plantillas aprobadas**. El
agente necesita cuatro.

> **Hacé esto apenas tengas la app creada.** La aprobación tarda de un rato a
> varios días. Si lo dejás para el final, te frena la demo.

Dónde: <https://business.facebook.com/wa/manage/message-templates> → **Create
template**. Para cada una:

- **Category**: `Utility`
- **Language**: `Spanish (ARG)` → código `es_AR` (tiene que coincidir con
  `WA_TEMPLATE_LANG`)
- El **nombre** que le pongas va tal cual en el `.env`.

Los `{{1}}`, `{{2}}`… son variables que el flujo completa en runtime.

---

## 1. Recordatorio de turno — `turno_recordatorio`

Variable en `.env`: `WA_TEMPLATE_REMINDER`

**Body:**

```
Hola {{1}}, te recordamos tu turno del {{2}} con {{3}}. ¿Confirmás?
```

**Buttons** (Quick reply, en este orden — el flujo depende del índice):

1. `Confirmar`
2. `Reprogramar`
3. `Cancelar`

---

## 2. Cancelación que libera hueco — `turno_cancelado_hueco`

Variable en `.env`: `WA_TEMPLATE_CANCELLATION`

**Body:**

```
Hola {{1}}, se liberó un turno el {{2}}. Si te sirve, escribinos y te lo agendamos.
```

---

## 3. Notificación de lista de espera — `turno_lista_espera`

Variable en `.env`: `WA_TEMPLATE_WAITLIST`

**Body:**

```
Hola {{1}}, se liberó un lugar para {{2}} el {{3}}. ¿Lo querés? Respondé este mensaje y te lo reservamos.
```

---

## 4. Re-engagement de handoff — `handoff_reengagement`

Variable en `.env`: `WA_TEMPLATE_REENGAGEMENT`

**Body:**

```
Tenés un mensaje de una clienta esperando respuesta. Abrí WhatsApp para verlo y contestarle.
```

Esta se le manda al **dueño**, no a la clienta, cuando el handoff cae fuera de la
ventana de 24 h.

---

## Mientras se aprueban

En **Message Templates** cada plantilla muestra su estado: `In review`, `Approved`
o `Rejected`. El agente funciona igual dentro de la ventana de 24 h; las plantillas
solo hacen falta para mensajes iniciados por el sistema (recordatorios, avisos de
lista de espera) y para responder fuera de ventana.

Si una queda **Rejected**, casi siempre es por categoría equivocada (tiene que ser
`Utility`, no `Marketing`) o por texto que parece promoción. Ajustá y reenviá.

Cargá los cuatro nombres en el `.env`:

```
WA_TEMPLATE_REMINDER=turno_recordatorio
WA_TEMPLATE_CANCELLATION=turno_cancelado_hueco
WA_TEMPLATE_WAITLIST=turno_lista_espera
WA_TEMPLATE_REENGAGEMENT=handoff_reengagement
```
