# Agente de Turnos IA — WhatsApp

Skill para Claude Code que levanta un agente de turnos por WhatsApp de punta a punta.

## Qué hace

- Crea, configura y despliega un agente conversacional en WhatsApp
- Gestiona turnos: agendar, consultar, modificar, cancelar
- Soporta múltiples servicios por visita y múltiples profesionales
- Recordatorios automáticos con botones de confirmación
- Lista de espera que se activa cuando se libera un turno
- Handoff a humano cuando el bot no puede resolver
- Multi-rubro: peluquerías, estética, consultorios, canchas, y cualquier negocio que venda turnos

## Stack

- **WhatsApp**: Cloud API de Meta (oficial)
- **Orquestación**: n8n self-hosted en Docker
- **Base de datos**: Supabase (Postgres)
- **Buffer y locks**: Redis
- **IA**: Gemini Flash en desarrollo, Claude en producción
- **Túnel**: Cloudflare Tunnel (URL estable, sin ngrok)

## Estado actual

🚧 En construcción — siguiendo el orden de build definido en el brief.

| Paso | Descripción | Estado |
|------|-------------|--------|
| 1 | Schema SQL + funciones + migración | ✅ |
| 2 | test-unit.js + suite de tests | 🔄 En progreso |
| 3 | tools.json + validación de parámetros | ⏳ |
| 4 | Prompt del agente (3 capas) | ⏳ |
| 5 | Fragments de n8n + flujos completos | ⏳ |
| 6 | simulator.js | ⏳ |
| 7 | test-eval.js | ⏳ |
| 8 | setup.js + walkthroughs + SKILL.md | ⏳ |
| 9 | update.js + promote.js + reset-demo.js | ⏳ |

## Uso (cuando esté listo)

```bash
curl -fsSL https://raw.githubusercontent.com/arieliten85/agente-turnos-ia/main/install.sh | bash
```

Luego en Claude Code:

```
/crear-agente-turnos
```

## Licencia

Privado — todos los derechos reservados.
