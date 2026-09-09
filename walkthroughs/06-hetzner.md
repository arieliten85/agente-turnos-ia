# 06 · Hetzner (solo producción)

_Última actualización: 2026-09-09_

Para la demo y el desarrollo, el stack corre en tu máquina con Docker. Para
**producción** (un cliente real con su número real) hace falta un servidor prendido
24/7. Usamos Hetzner Cloud por precio y simpleza.

> Este paso **no** se hace para la demo. Lo corre la operación **promover** cuando
> aparece el primer cliente pagando.

## 1. Crear el servidor

1. <https://console.hetzner.cloud> → creá un proyecto.
2. **Add Server**:
   - **Location**: la más cercana a tus clientes (para Argentina, `Ashburn, VA` es
     lo más cercano de Hetzner hoy).
   - **Image**: `Ubuntu 24.04`.
   - **Type**: `CX22` (2 vCPU, 4 GB) alcanza y sobra para volumen de salón.
   - **SSH key**: subí tu clave pública.
3. Anotá la IP.

## 2. Preparar el servidor

```bash
ssh root@<IP>

apt update && apt upgrade -y
curl -fsSL https://get.docker.com | sh
apt install -y git

# Firewall: solo SSH. El tráfico web entra por el túnel de Cloudflare, no por puertos abiertos.
ufw allow OpenSSH
ufw --force enable
```

## 3. Traer el proyecto y configurar

```bash
git clone <repo-del-cliente> /opt/agente-turnos
cd /opt/agente-turnos
cp .env.template .env
```

Editá `.env` con los valores de **producción**:

- `DATABASE_URL`, `SUPABASE_*` → el **proyecto de Supabase de producción** (otro,
  no el de la demo).
- `MODEL_PROVIDER=claude` y `ANTHROPIC_API_KEY`.
- `WA_PHONE_NUMBER_ID`, `WA_TOKEN` → el **número real** del cliente (ya migrado a
  la Cloud API y verificado).
- `WA_API_BASE=https://graph.facebook.com` (sin capture server acá).
- `WEBHOOK_URL` → el hostname de Cloudflare de producción.
- `N8N_ENCRYPTION_KEY` → uno nuevo, propio de este servidor.

## 4. Levantar

```bash
docker compose --profile tunnel up -d
docker compose logs -f n8n
```

Importá los flujos (los toma la operación **promover**, que reemplaza los
marcadores con los valores de producción antes de subirlos).

## 5. Apuntar el túnel

En el dashboard de Cloudflare, el túnel de producción publica el hostname del
cliente contra `n8n:5678` de **este** servidor. Actualizá el **Callback URL** en
Meta al hostname de producción.

## 6. Checklist de corte

- [ ] `test-unit.js` en verde contra la base de producción (esquema).
- [ ] `test-eval.js` por encima de los umbrales.
- [ ] Prueba real: mandar un mensaje desde un teléfono y recibir respuesta.
- [ ] `project.json` con `"environment": "production"`.
- [ ] Rollback a mano probado (bajar el stack, restaurar `.env` anterior).
