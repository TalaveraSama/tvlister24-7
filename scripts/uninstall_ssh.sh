#!/usr/bin/env bash
# ==============================================================================
# TVLister 24/7 — DESINSTALAR POR SSH
# ------------------------------------------------------------------------------
# Lanza el desinstalador completo en un servidor remoto sin entrar a mano:
# le envía el scripts/uninstall.sh de tu PC (o baja el último publicado) y lo
# ejecuta allí. Al terminar comprueba que el panel ya no está.
#
# Uso:
#   bash scripts/uninstall_ssh.sh root@192.168.200.8
#   bash scripts/uninstall_ssh.sh root@192.168.200.8 --purge
#   bash scripts/uninstall_ssh.sh root@192.168.200.8 --dry-run
#   bash scripts/uninstall_ssh.sh root@mi-servidor --yes       # sin preguntar
#   bash scripts/uninstall_ssh.sh root@mi-servidor --descargar # último de GitHub
#   bash scripts/uninstall_ssh.sh root@mi-vps --puerto 2222 --clave ~/.ssh/id_ed25519
#
# Opciones de ESTE lanzador:
#   --puerto N     puerto SSH (por defecto 22)
#   --clave RUTA   archivo de clave SSH (equivale a ssh -i)
#   --descargar    no envía el script local: baja el último release en el servidor
#   --tag vX.Y.Z   versión concreta a descargar (junto con --descargar)
#
# Todo lo demás se pasa tal cual al desinstalador que corre en el servidor:
#   --purge  --dry-run  --yes  --keep-data  --keep-certs  --keep-firewall
#   --keep-backups  --app-dir RUTA  --ports "8095 8554"
# ==============================================================================
set -uo pipefail

REPO="TalaveraSama/tvlister24-7"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
LOCAL_SCRIPT="${HERE}/uninstall.sh"

TARGET=""
SSH_PORT="22"
SSH_KEY=""
DOWNLOAD=0
TAG="latest"
REMOTE_ARGS=()

usage() {
  cat <<'TXT'
Desinstalar TVLister en un servidor remoto por SSH

  bash scripts/uninstall_ssh.sh usuario@servidor [opciones]

Opciones de este lanzador:
  --puerto N        puerto SSH (por defecto 22)
  --clave RUTA      archivo de clave SSH (equivale a ssh -i)
  --descargar       usa el último desinstalador publicado en GitHub
  --tag vX.Y.Z      versión concreta a descargar (con --descargar)

Opciones que se pasan al desinstalador del servidor:
  --purge           desinstala sin guardar copia de la base de datos
  --dry-run         sólo enseña lo que haría
  --yes             sin preguntar (si no hay terminal)
  --keep-data --keep-certs --keep-firewall --keep-backups
  --app-dir RUTA    instalación en otra carpeta

Ejemplos:
  bash scripts/uninstall_ssh.sh root@192.168.200.8
  bash scripts/uninstall_ssh.sh root@192.168.200.8 --purge --yes
  bash scripts/uninstall_ssh.sh admin@mi-vps --puerto 2222 --clave ~/.ssh/id_ed25519
  bash scripts/uninstall_ssh.sh root@mi-vps --descargar --yes
TXT
}

die() { echo "[ERROR] $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help|--ayuda) usage; exit 0 ;;
    --puerto|--port)   [ $# -ge 2 ] || die "Falta el número de puerto."; SSH_PORT="$2"; shift 2 ;;
    --clave|--key|-i)  [ $# -ge 2 ] || die "Falta la ruta de la clave."; SSH_KEY="$2"; shift 2 ;;
    --descargar|--remote) DOWNLOAD=1; shift ;;
    --tag)             [ $# -ge 2 ] || die "Falta la versión."; TAG="$2"; DOWNLOAD=1; shift 2 ;;
    --app-dir|--dir)   [ $# -ge 2 ] || die "Falta la carpeta."; REMOTE_ARGS+=("--app-dir" "$2"); shift 2 ;;
    --ports)           [ $# -ge 2 ] || die "Falta la lista de puertos."; REMOTE_ARGS+=("--ports" "$2"); shift 2 ;;
    --purge|--borrar-todo|-y|--yes|--si|-n|--dry-run|--simular|\
    --keep-data|--keep-certs|--keep-firewall|--keep-backups)
      REMOTE_ARGS+=("$1"); shift ;;
    -*) echo "[ERROR] Opción desconocida: $1" >&2; echo >&2; usage >&2; exit 1 ;;
    *)
      [ -z "$TARGET" ] || die "Sobra un argumento: $1"
      TARGET="$1"; shift ;;
  esac
done

[ -n "$TARGET" ] || { echo "[ERROR] Falta el servidor."; echo "        Uso: bash scripts/uninstall_ssh.sh root@TU_IP [opciones]"; echo; usage; exit 1; }
command -v ssh >/dev/null 2>&1 || die "No hay cliente ssh en este equipo."

SSH_OPTS=(-p "$SSH_PORT" -o ConnectTimeout=10 -o ServerAliveInterval=15)
[ -n "$SSH_KEY" ] && SSH_OPTS+=(-i "$SSH_KEY")

# Cómo se pasa cada opción al servidor (con comillas si lleva espacios).
build_args_str() {
  local a out=""
  for a in "$@"; do out+="$(printf '%q' "$a") "; done
  printf '%s' "${out% }"
}

has_arg() { local w="$1" a; for a in ${REMOTE_ARGS[@]+"${REMOTE_ARGS[@]}"}; do [ "$a" = "$w" ] && return 0; done; return 1; }

# URL del desinstalador publicado.
if [ "$TAG" = "latest" ]; then
  REMOTE_URL="https://github.com/${REPO}/releases/latest/download/uninstall.sh"
else
  REMOTE_URL="https://github.com/${REPO}/releases/download/${TAG}/uninstall.sh"
fi

echo "============================================================"
echo "  TVLister 24/7 — desinstalar por SSH"
echo "============================================================"
echo "  Servidor : ${TARGET} (puerto ${SSH_PORT})"

if [ "$DOWNLOAD" -eq 0 ] && [ ! -f "$LOCAL_SCRIPT" ]; then
  echo "  ! No encuentro ${LOCAL_SCRIPT}: se usará el último publicado."
  DOWNLOAD=1
fi
if [ "$DOWNLOAD" -eq 1 ]; then
  echo "  Método   : descargar en el servidor ${REMOTE_URL}"
else
  echo "  Método   : enviar ${LOCAL_SCRIPT} ($(wc -c < "$LOCAL_SCRIPT") bytes) por SSH"
fi
echo ""

# --- Comprobación de acceso ---------------------------------------------------
REMOTE_ID=$(ssh "${SSH_OPTS[@]}" -o BatchMode=yes "$TARGET" 'id -un; id -u' 2>&1)
if [ $? -ne 0 ]; then
  echo "[ERROR] No se pudo entrar por SSH sin contraseña."
  echo ""
  echo "  Revisa:"
  echo "   · que ${TARGET} sea correcto y el puerto ${SSH_PORT} esté abierto"
  echo "   · que tu clave esté autorizada:  ssh-copy-id ${TARGET}"
  echo "   · si el servidor pide contraseña, entra a mano y ejecuta allí:"
  echo "       curl -fsSL https://github.com/${REPO}/releases/latest/download/uninstall.sh | sudo bash -s -- --yes"
  echo ""
  echo "  Detalle: $(echo "$REMOTE_ID" | tr '\n' ' ')"
  exit 1
fi
REMOTE_USER=$(echo "$REMOTE_ID" | sed -n 1p)
REMOTE_UID=$(echo "$REMOTE_ID" | sed -n 2p)
echo "Conectado como ${REMOTE_USER} (uid ${REMOTE_UID})."

if [ "$REMOTE_UID" = "0" ]; then
  RUN_PREFIX=""
else
  if ssh "${SSH_OPTS[@]}" -o BatchMode=yes "$TARGET" 'sudo -n true' >/dev/null 2>&1; then
    RUN_PREFIX="sudo -n "
  else
    echo ""
    echo "[ERROR] ${REMOTE_USER} no es root y no puede usar sudo sin contraseña."
    echo "        Entra como root (ssh root@...) o lanza el desinstalador a mano allí."
    exit 1
  fi
fi

# --- Confirmación (aquí, en tu PC; el servidor se ejecuta con --yes) ----------
is_dry=0
if has_arg "--dry-run" || has_arg "-n" || has_arg "--simular"; then is_dry=1; fi
is_yes=0
if has_arg "--yes" || has_arg "-y" || has_arg "--si"; then is_yes=1; fi

if [ "$is_dry" -eq 0 ] && [ "$is_yes" -eq 0 ]; then
  echo ""
  echo "Se va a desinstalar TVLister en ${TARGET}:"
  echo "  servicio, comando, carpeta del panel, caché, cron, nginx, certificados"
  echo "  y reglas de firewall del panel (NUNCA el 80/443 ni /home/xui)."
  echo "La base de datos se guarda en /root/tvlister-backup-… del servidor."
  printf '¿Continuar? [s/N]: '
  go=""
  if [ -r /dev/tty ]; then read -r go < /dev/tty || go=""; else read -r go || go=""; fi
  case "$go" in
    s|S|si|SI|sí|Sí|y|Y|yes|YES) ;;
    *) echo "Cancelado. No se ha tocado nada."; exit 0 ;;
  esac
  # El servidor no tiene terminal: se le pasa --yes (aquí ya se confirmó).
  REMOTE_ARGS+=("--yes")
fi

ARGS_STR=$(build_args_str ${REMOTE_ARGS[@]+"${REMOTE_ARGS[@]}"})
echo "  Opciones : ${ARGS_STR:-ninguna}"
echo ""

# --- Ejecución ----------------------------------------------------------------
if [ "$DOWNLOAD" -eq 1 ]; then
  # Se baja el script en el servidor y se ejecuta allí (queda borrado después).
  REMOTE_CMD="curl -fsSL '${REMOTE_URL}' -o /tmp/tvlister-uninstall.sh && ${RUN_PREFIX}bash /tmp/tvlister-uninstall.sh ${ARGS_STR}; rc=\$?; rm -f /tmp/tvlister-uninstall.sh; exit \$rc"
  ssh "${SSH_OPTS[@]}" "$TARGET" "$REMOTE_CMD"
  RC=$?
else
  # El script viaja por la entrada estándar de ssh: no hace falta scp.
  ssh "${SSH_OPTS[@]}" "$TARGET" "${RUN_PREFIX}bash -s -- ${ARGS_STR}" < "$LOCAL_SCRIPT"
  RC=$?
fi

# --- Verificación -------------------------------------------------------------
echo ""
echo "  Comprobando el servidor…"
if ! ssh "${SSH_OPTS[@]}" -o BatchMode=yes "$TARGET" 'test ! -d /opt/tvlister24-7 && test ! -f /etc/systemd/system/tvlister24-7.service && test ! -e /usr/local/bin/tvlister-admin' 2>/dev/null; then
  echo "  ! Todavía queda algo. Para ver qué queda:"
  echo "      ssh ${TARGET} 'systemctl status tvlister24-7; ls -la /opt/tvlister24-7'"
fi

echo ""
if [ "$RC" -eq 0 ]; then
  echo "✅ Listo: el desinstalador terminó sin errores en ${TARGET}."
else
  echo "❌ El desinstalador terminó con código ${RC} en ${TARGET}."
  echo "   Revisa las líneas de arriba (permisos, unidad en uso, etc.)."
fi
exit "$RC"
