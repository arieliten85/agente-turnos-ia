# 05 · API key del modelo

_Última actualización: 2026-09-09_

El modelo interpreta los mensajes y redacta las respuestas. Nunca calcula fechas,
disponibilidad ni precios: eso lo hacen las funciones SQL.

- **Desarrollo y demo → Gemini Flash.** Tiene free tier generoso.
- **Producción → Claude.** Más consistente en los casos difíciles.

Se cambia de uno a otro con dos variables del `.env`, sin tocar los flujos.

---

## Opción A — Gemini (Google AI Studio)

1. Entrá a <https://aistudio.google.com/apikey> con tu cuenta de Google.
2. **Create API key** → elegí o creá un proyecto de Google Cloud.
3. Copiá la key.

En el `.env`:

```
MODEL_PROVIDER=gemini
MODEL_NAME=gemini-flash-lite-latest
GEMINI_API_KEY=AIza...
```

`gemini-flash-lite-latest` responde rápido con el payload completo (identidad +
reglas + 9 tools) y el alias `-latest` no se pincha cuando Google jubila una
versión (a `gemini-2.0-flash`, por ejemplo, ya le devuelve `404`).

> **Riesgo asumido:** el free tier de Gemini puede recortarse sin aviso y tira
> `503 "high demand"` de forma intermitente. Los flujos ya reintentan; si el
> problema persiste, cambiá a Claude editando `MODEL_PROVIDER` y `MODEL_NAME` y
> recreando la credencial del modelo en n8n. El resto no se toca.

---

## Opción B — Claude (Anthropic)

1. Entrá a <https://console.anthropic.com/settings/keys>.
2. **Create Key** → copiala (no se vuelve a mostrar).
3. Cargá saldo en **Billing** si la cuenta es nueva.

En el `.env`:

```
MODEL_PROVIDER=claude
MODEL_NAME=claude-sonnet-5
ANTHROPIC_API_KEY=sk-ant-...
```

---

## Cómo lo usa n8n

El fragmento `llamada-modelo` arma el request según `MODEL_PROVIDER`:

- `gemini` → `POST .../v1beta/models/<MODEL_NAME>:generateContent`
- `claude` → `POST https://api.anthropic.com/v1/messages`

La API key va en una **credencial HTTP Header Auth** de n8n
(`turnos · Modelo`), que el setup crea a partir del `.env`. La key no queda en
ningún JSON.

## Datos que quedan en el `.env`

| Variable | Valor |
|---|---|
| `MODEL_PROVIDER` | `gemini` o `claude` |
| `MODEL_NAME` | `gemini-flash-lite-latest` / `claude-sonnet-5` |
| `GEMINI_API_KEY` o `ANTHROPIC_API_KEY` | según el provider |
