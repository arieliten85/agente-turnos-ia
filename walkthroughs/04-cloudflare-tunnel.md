# 04 · Cloudflare Tunnel

_Última actualización: 2026-09-09_

Meta necesita mandarle los webhooks a una URL pública y **estable**. El túnel de
Cloudflare te da un hostname fijo que apunta a tu n8n local, sin abrir puertos en
el router y sin que la URL cambie en cada reinicio.

> Por qué no ngrok: la URL de ngrok cambia cada vez que lo reiniciás, y habría que
> reconfigurar el webhook en Meta cada vez. Con Cloudflare el hostname es fijo.

## Requisito

Un **dominio en Cloudflare**. Si no tenés, registrás uno (los `.com` salen unos
USD 10/año) y lo apuntás a los nameservers de Cloudflare, o usás un dominio que ya
tengas y lo agregás a tu cuenta de Cloudflare (plan Free alcanza).

## 1. Crear el túnel

1. Entrá a <https://one.dash.cloudflare.com> → **Networks** → **Tunnels** →
   **Create a tunnel**.
2. Tipo **Cloudflared**. Ponele un nombre (ej `turnos-bella-studio`).
3. En la pantalla de instalación, Cloudflare te muestra un **token** (una cadena
   larga que empieza con `eyJ...`). Copialo → `CLOUDFLARE_TUNNEL_TOKEN` en el
   `.env`.
4. **No** hace falta que instales `cloudflared` a mano: lo levanta
   `docker compose --profile tunnel up -d` con ese token.

## 2. Publicar el hostname

En la config del túnel, pestaña **Public Hostnames** → **Add a public hostname**:

- **Subdomain**: `turnos` (o lo que quieras)
- **Domain**: tu dominio
- **Type**: `HTTP`
- **URL**: `n8n:5678`
  (es el nombre del servicio en `docker-compose.yml`; el túnel corre en la misma
  red de Docker)

Guardá. En un minuto `https://turnos.tudominio.com` resuelve y llega a n8n.

## 3. Cargar la URL en el `.env`

```
WEBHOOK_URL=https://turnos.tudominio.com
```

Sin barra al final. n8n usa esta URL para armar las direcciones de sus webhooks, y
es la base del **Callback URL** que vas a poner en Meta:

```
https://turnos.tudominio.com/webhook/wa-turnos
```

## Comprobar

Con el stack levantado:

```
curl -I https://turnos.tudominio.com/healthz
```

Tenés que recibir una respuesta de n8n (un `200`). Si da error de DNS, esperá un
minuto más; si da `502`, el túnel está pero n8n todavía no arrancó.
