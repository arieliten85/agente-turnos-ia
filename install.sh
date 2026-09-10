#!/usr/bin/env sh
# ============================================================================
# install.sh — prepara la máquina para levantar el agente de turnos.
# ============================================================================
# Lo que hace, y NADA más:
#   1. Verifica Docker, Docker Compose y Node 18+.
#   2. Clona el repo (si no lo estás corriendo ya adentro de una copia).
#   3. Copia .env.template a .env si todavía no existe.
#   4. Te dice el próximo paso.
#
# NO configura nada solo: la configuración es conversacional y la conduce el
# SKILL.md desde Claude Code (/crear-agente-turnos). Así está diseñado.
#
# Uso:
#   curl -fsSL https://raw.githubusercontent.com/arieliten85/agente-turnos-ia/main/install.sh | sh
#   # o, dentro de una copia del repo:
#   ./install.sh
# ============================================================================

set -eu

REPO_URL="https://github.com/arieliten85/agente-turnos-ia.git"
REPO_DIR="agente-turnos-ia"

RED=$(printf '\033[31m'); GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m'); RESET=$(printf '\033[0m')
ok()   { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()  { printf '%s✗%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }

# ── 1. Requisitos ──────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "Falta Docker. Instalalo: https://docs.docker.com/get-docker/"
ok "Docker: $(docker --version 2>/dev/null || echo presente)"

if docker compose version >/dev/null 2>&1; then
  ok "Docker Compose: $(docker compose version --short 2>/dev/null || echo 'v2')"
elif command -v docker-compose >/dev/null 2>&1; then
  ok "Docker Compose: $(docker-compose version --short 2>/dev/null || echo 'v1')"
else
  die "Falta Docker Compose (viene con Docker Desktop, o instalá el plugin compose)."
fi

command -v node >/dev/null 2>&1 || die "Falta Node. Necesitás Node 18 o mayor: https://nodejs.org/"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 18 ] 2>/dev/null || die "Node $(node -v 2>/dev/null) es viejo. Necesitás 18 o mayor."
ok "Node: $(node -v)"

command -v git >/dev/null 2>&1 || die "Falta git."

# ── 2. Repo ───────────────────────────────────────────────────────────────
if [ -f SKILL.md ] && [ -f config/project.json ]; then
  ok "Ya estás dentro del repo ($(pwd))."
elif [ -d "$REPO_DIR" ]; then
  warn "La carpeta $REPO_DIR ya existe. No la vuelvo a clonar."
  cd "$REPO_DIR"
else
  ok "Clonando $REPO_URL"
  git clone --depth 1 "$REPO_URL" "$REPO_DIR"
  cd "$REPO_DIR"
fi

# ── 3. .env ───────────────────────────────────────────────────────────────
if [ -f .env ]; then
  warn ".env ya existe. No lo toco."
elif [ -f .env.template ]; then
  cp .env.template .env
  ok "Copié .env.template a .env (todavía vacío: lo completás con el SKILL.md)."
else
  die "No encuentro .env.template. ¿El repo se clonó completo?"
fi

# ── 4. Próximo paso ──────────────────────────────────────────────────────
printf '\n'
ok "Listo. La máquina tiene lo necesario."
printf '\n'
printf 'Próximo paso — en Claude Code, dentro de esta carpeta:\n\n'
printf '    %s/crear-agente-turnos%s\n\n' "$GREEN" "$RESET"
printf 'El SKILL.md te va a pedir un dato por vez y te manda al walkthrough que\n'
printf 'corresponde (Supabase, Meta, Cloudflare, modelo). No configures nada a mano.\n'
