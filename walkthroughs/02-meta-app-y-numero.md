# 02 · Meta: app, número y webhook

_Última actualización: 2026-09-09_

Acá creás la app de WhatsApp, conseguís el número de prueba y los tokens, y
conectás el webhook a n8n.

> Antes de esto conviene tener el túnel de Cloudflare andando
> (`walkthroughs/04-cloudflare-tunnel.md`), porque el webhook necesita una URL
> pública. Si todavía no lo tenés, hacé ese primero y volvé.

## 1. Crear la app

1. Entrá a <https://developers.facebook.com/apps> con tu cuenta de Facebook.
2. **Create App** → tipo **Business** → dale un nombre (ej `Turnos Bella Studio`).
3. En el panel de la app, **Add Product** → **WhatsApp** → **Set up**.
4. Meta crea automáticamente una **cuenta de WhatsApp Business (WABA)** de prueba y
   un **número de prueba**.

## 2. Datos del número

En **WhatsApp → API Setup**:

- **Phone number ID** → va en `WA_PHONE_NUMBER_ID`.
- **WhatsApp Business Account ID** → va en `WA_WABA_ID`.
- Hay un **token temporal de 24 h** para probar rápido. Para algo estable necesitás
  el token permanente del paso 4.

## 3. Agregar destinatarios de prueba

El número de prueba **solo puede escribirle a números que agregues a mano**, y hay
un tope (unos 5).

1. En **API Setup**, sección **To**, **Manage phone number list** → **Add phone
   number**.
2. Meta le manda un **código de verificación por WhatsApp** a ese número. La persona
   te lo tiene que pasar y vos lo cargás.
3. Recién ahí el agente puede escribirle.

> Para una demo con un prospecto: sumá su número **con anticipación** y avisale que
> le va a llegar un código. No es silencioso.

## 4. Token permanente (System User)

1. <https://business.facebook.com/settings/system-users>
2. **Add** → creá un System User con rol **Admin**.
3. **Assign assets** → asigná la app y la WABA con permisos completos.
4. **Generate new token** → elegí la app → permisos:
   `whatsapp_business_messaging` y `whatsapp_business_management`.
5. Elegí **token sin expiración**. Copialo (no se vuelve a mostrar) → `WA_TOKEN`.

## 5. Conectar el webhook a n8n

1. Inventá una cadena larga y aleatoria para `WA_VERIFY_TOKEN` (por ejemplo, la
   salida de `openssl rand -hex 24`). Ponela en el `.env`.
2. Levantá el stack (`docker compose up -d`) e importá los flujos. El path del
   webhook es `WEBHOOK_PATH` (default `wa-turnos`).
3. En la app de Meta: **WhatsApp → Configuration → Webhook** → **Edit**:
   - **Callback URL**: `https://<tu-hostname-de-cloudflare>/webhook/<WEBHOOK_PATH>`
   - **Verify token**: el mismo `WA_VERIFY_TOKEN`.
   - **Verify and save**. Si el flow-webhook está activo, Meta valida al toque.
4. En **Webhook fields**, suscribite a **messages**.

## 6. Probar la conexión

Escribile al número de prueba desde un teléfono habilitado. En n8n, **Executions**
del `flow-webhook`, tenés que ver la ejecución entrando. El agente todavía no
responde bien hasta terminar el resto del setup, pero el webhook ya llega.

## Datos que quedan en el `.env`

| Variable | De dónde |
|---|---|
| `WA_PHONE_NUMBER_ID` | WhatsApp → API Setup |
| `WA_WABA_ID` | WhatsApp → API Setup |
| `WA_TOKEN` | System User → token sin expiración |
| `WA_VERIFY_TOKEN` | lo inventás vos, el mismo en Meta y en `.env` |
