# 01 · Supabase (base de datos)

_Última actualización: 2026-09-09_

Supabase es Postgres administrado. Acá vive toda la lógica pesada del agente
(disponibilidad, reservas, política de cancelación) en funciones SQL.

## 1. Crear la cuenta y el proyecto

1. Entrá a <https://supabase.com/dashboard> e iniciá sesión (con GitHub es lo más
   rápido).
2. **New project**.
   - **Name**: algo como `turnos-<marca>` (ej `turnos-bella-studio`).
   - **Database Password**: generá una fuerte y guardala. La vas a necesitar para
     `DATABASE_URL`.
   - **Region**: `South America (São Paulo)` → `sa-east-1`. Es la más cercana; baja
     la latencia de cada consulta.
3. Esperá 1–2 minutos a que termine de aprovisionar.

## 2. Sacar los datos de conexión

En el proyecto, **Project Settings** (el engranaje) → **Database**:

- **Connection string → URI**, modo **Direct connection** (no el pooler). Se ve así:

  ```
  postgresql://postgres:[PASSWORD]@db.<ref>.supabase.co:5432/postgres
  ```

  Reemplazá `[PASSWORD]` por la que generaste. Eso va en `DATABASE_URL` del `.env`.

- El **Project Reference** (`<ref>`, 20 caracteres) está en **Project Settings →
  General**. Va en `SUPABASE_PROJECT_REF`.

- La **Project URL** (`https://<ref>.supabase.co`) va en `SUPABASE_URL`.

> El esquema y las migraciones se aplican con la conexión directa. El agente en
> producción va a usar el MCP de Supabase; para eso alcanza con que el MCP esté
> registrado apuntando a este proyecto (lo hace el setup).

## 3. Aplicar el esquema

Lo hace el skill por vos con el MCP de Supabase (o, si no está, corriendo
`database/schema.sql` con `psql` sobre `DATABASE_URL`). No hace falta que toques
nada a mano.

Después de aplicarlo, en **Table Editor** tenés que ver las tablas `business`,
`services`, `professionals`, `appointments`, `waitlist`, `conversations`, etc.

## 4. Evitar que el proyecto se pause (solo demo)

El plan gratuito **pausa el proyecto tras 7 días sin actividad**. Para una demo que
tiene que estar siempre viva, dejá un ping automático:

1. Creá un repo (puede ser privado) con este workflow en
   `.github/workflows/ping.yml`:

   ```yaml
   name: ping-supabase
   on:
     schedule:
       - cron: "0 6 * * *"   # todos los días 06:00 UTC
     workflow_dispatch:
   jobs:
     ping:
       runs-on: ubuntu-latest
       steps:
         - run: curl -fsS "${{ secrets.SUPABASE_URL }}/rest/v1/business?select=id" -H "apikey: ${{ secrets.SUPABASE_ANON_KEY }}"
   ```

2. Cargá `SUPABASE_URL` y `SUPABASE_ANON_KEY` (Project Settings → API) como
   **secrets** del repo.

Con eso alcanza: una consulta diaria mantiene el proyecto activo.

## Datos que quedan en el `.env`

| Variable | De dónde |
|---|---|
| `DATABASE_URL` | Connection string (Direct), con tu password |
| `SUPABASE_PROJECT_REF` | Project Settings → General |
| `SUPABASE_URL` | `https://<ref>.supabase.co` |
