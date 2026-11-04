#!/usr/bin/env bash
# ==============================================================================
# TVLister 24/7 — DESINSTALADOR
# ------------------------------------------------------------------------------
# Quita el panel del servidor sin tocar nada más: ni XUI.one, ni nginx del
# sistema, ni el firewall, ni FFmpeg de otros programas.
#
# Uso (como root):
#
#   sudo bash scripts/uninstall.sh                 # desinstala y guarda los datos
#   sudo bash scripts/uninstall.sh --purge         # desinstala y borra TODO (sin copia)
#   sudo bash scripts/uninstall.sh --dry-run       # sólo enseña lo que haría
#   sudo bash scripts/uninstall.sh --yes           # sin preguntar
#   sudo bash scripts/uninstall.sh --app-dir /opt/otra-carpeta
#
# Qué guarda por defecto: la base de datos y los archivos subidos, en
# /root/tvlister-backup-AAAAMMDD-HHMM/ (la carpeta data del panel).
#
# Qué NO toca nunca: /home/xui, el firewall (ufw/iptables), /etc/nginx salvo
# los server blocks que puso el panel, y los backups que ya tuvieras en /root.
# ==============================================================================
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/tvlister24-7}"
SERVICE_NAME="tvlister24-7"
# Prefijo para pruebas en un directorio de mentira (en un servidor real va vacío).
SYSROOT="${TVLISTER_SYSROOT:-}"

PURGE=0
ASSUME_YES=0
DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --purge|--borrar-todo) PURGE=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -n|--dry-run|--simular) DRY=1; shift ;;
    --app-dir|--dir) APP_DIR="${2:-}"; shift 2 ;;
    -h|--help|--ayuda)
      sed -n '3,26p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "[ERROR] Opción desconocida: $1"
      echo "        Uso: bash scripts/uninstall.sh [--purge] [--dry-run] [--yes] [--app-dir RUTA]"
      exit 1 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
step() { printf '\n▶ %s\n' "$*"; }
did()  { printf '   ✓ %s\n' "$*"; }
skip() { printf '   · %s\n' "$*"; }

run() {
  # Ejecuta (o sólo enseña, con --dry-run) un comando.
  if [ "$DRY" -eq 1 ]; then
    printf '   [simulado] %s\n' "$*"
    return 0
  fi
  "$@" >/dev/null 2>&1 || true
}

# ------------------------------------------------------------------------------
# 0. Comprobaciones previas
# ------------------------------------------------------------------------------
# Con TVLISTER_SYSROOT se está simulando en una carpeta: no hace falta root.
if [ "$DRY" -eq 0 ] && [ "$(id -u)" -ne 0 ] && [ -z "$SYSROOT" ]; then
  echo "[ERROR] Ejecuta el desinstalador como root: sudo bash scripts/uninstall.sh"
  exit 1
fi

# Este script vive DENTRO de la carpeta que se va a borrar: se copia a /tmp y se
# sigue desde ahí (bash lee el archivo mientras corre).
if [ -f "$0" ] && case "$(readlink -f "$0" 2>/dev/null)" in "$(readlink -f "$APP_DIR" 2>/dev/null)"/*) true ;; *) false ;; esac; then
  TMP_SELF=$(mktemp /tmp/tvlister_uninstall.XXXXXX.sh)
  cp -f "$0" "$TMP_SELF"
  chmod +x "$TMP_SELF"
  args=()
  [ "$PURGE" -eq 1 ] && args+=(--purge)
  [ "$ASSUME_YES" -eq 1 ] && args+=(--yes)
  [ "$DRY" -eq 1 ] && args+=(--dry-run)
  args+=(--app-dir "$APP_DIR")
  APP_DIR="$APP_DIR" TVLISTER_SYSROOT="$SYSROOT" exec bash "$TMP_SELF" "${args[@]}"
fi

APP_REAL=$(readlink -f "$APP_DIR" 2>/dev/null || echo "$APP_DIR")
UNIT_FILE="${SYSROOT}/etc/systemd/system/${SERVICE_NAME}.service"
UNIT_DROPIN="${SYSROOT}/etc/systemd/system/${SERVICE_NAME}.service.d"
DATA_DIR="${APP_REAL}/data"
STAMP=$(date +%Y%m%d-%H%M)
BACKUP_DIR="${SYSROOT}/root/tvlister-backup-${STAMP}"

say "============================================================"
say "  TVLister 24/7 — Desinstalador"
say "============================================================"
say "  Carpeta del panel : ${APP_REAL}"
if [ "$PURGE" -eq 1 ]; then
  say "  Modo              : BORRAR TODO (sin copia de la base de datos)"
else
  say "  Modo              : normal (la base de datos se guarda en un respaldo)"
fi
[ "$DRY" -eq 1 ] && say "  Simulación        : sí (no se cambia nada)"

if [ ! -d "$APP_REAL" ] && [ ! -f "$UNIT_FILE" ]; then
  say ""
  say "No parece haber nada instalado en ${APP_REAL} ni el servicio ${SERVICE_NAME}."
  say "Si lo instalaste en otra carpeta:  --app-dir /ruta/de/la/instalacion"
  exit 0
fi

# Sólo se borra una carpeta que de verdad sea del panel.
if [ -d "$APP_REAL" ]; then
  if ! { [ -f "$APP_REAL/server/index.js" ] && grep -q '"name": *"tvlister24-7"' "$APP_REAL/package.json" 2>/dev/null; }; then
    say ""
    say "[ERROR] ${APP_REAL} no parece una instalación de TVLister."
    say "        (no tiene server/index.js + package.json con name tvlister24-7)."
    say "        No se borra nada para no llevarse por delante otra cosa."
    exit 1
  fi
fi

if [ "$ASSUME_YES" -eq 0 ] && [ "$DRY" -eq 0 ]; then
  say ""
  say "Se van a quitar el servicio, su unidad de systemd, el comando tvlister-admin"
  say "y los bloques de nginx que puso el panel."
  if [ "$PURGE" -eq 1 ]; then
    say "Y se BORRARÁ la base de datos (canales, líneas, VOD, access codes): sin vuelta atrás."
  else
    say "La base de datos y lo subido se guardan en: ${BACKUP_DIR}"
  fi
  say ""
  printf '¿Seguir? escribe SI para continuar: '
  read -r answer || answer=""
  case "$answer" in
    SI|si|Sí|sí|S|s|YES|yes|Y|y) ;;
    *) say "Cancelado. No se ha tocado nada."; exit 0 ;;
  esac
fi

# ------------------------------------------------------------------------------
# 1. Parar y quitar el servicio
# ------------------------------------------------------------------------------
step "Servicio ${SERVICE_NAME}"
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    run systemctl stop "$SERVICE_NAME"
    did "servicio detenido"
  else
    skip "no estaba corriendo"
  fi
  run systemctl disable "$SERVICE_NAME"
  skip "arranque automático desactivado"
else
  skip "sin systemd activo en este entorno"
fi

if [ -f "$UNIT_FILE" ]; then
  run rm -f "$UNIT_FILE"
  did "unidad ${UNIT_FILE} borrada"
else
  skip "no había unidad de systemd"
fi
if [ -d "$UNIT_DROPIN" ]; then
  run rm -rf "$UNIT_DROPIN"
  did "ajustes extra del servicio (cloudflare.conf) borrados"
fi
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  run systemctl daemon-reload
  run systemctl reset-failed "$SERVICE_NAME"
fi

# ------------------------------------------------------------------------------
# 2. Procesos que hayan quedado sueltos (motor FFmpeg, HLS)
# ------------------------------------------------------------------------------
step "Procesos del panel"
# Sólo se matan procesos cuyo ejecutable REAL es node/ffmpeg del panel y que
# llevan su ruta en los argumentos. Nunca una shell ni nada ajeno.
ancestors=" $$ "
p=$$
while [ "$p" != "0" ] && [ "$p" != "1" ] && [ -n "$p" ]; do
  p=$(awk '{print $4}' "/proc/$p/stat" 2>/dev/null || echo 0)
  [ -n "$p" ] && ancestors="$ancestors$p "
done

is_our_binary() {
  local exe
  exe=$(readlink -f "/proc/$1/exe" 2>/dev/null || true)
  [ -n "$exe" ] || return 1
  case "$(basename "$exe")" in
    node|nodejs|ffmpeg|ffprobe) return 0 ;;
    *) return 1 ;;
  esac
}

LEFT=0
if command -v pgrep >/dev/null 2>&1; then
  for pat in "${APP_REAL}/server/index.js" "${APP_REAL}/.runtime/" "/var/lib/tvlister24-7/hls"; do
    for pid in $(pgrep -f -- "$pat" 2>/dev/null || true); do
      [ -z "$pid" ] && continue
      case "$ancestors" in *" $pid "*) continue ;; esac
      is_our_binary "$pid" || continue
      cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
      if [ "$DRY" -eq 1 ]; then
        say "   [simulado] kill ${pid} — ${cmd:0:90}"
      else
        kill "$pid" >/dev/null 2>&1 || true
        sleep 0.2
        kill -9 "$pid" >/dev/null 2>&1 || true
        say "   ✓ detenido el proceso ${pid} (${cmd:0:70}…)"
      fi
      LEFT=$((LEFT + 1))
    done
  done
fi
[ "$LEFT" -eq 0 ] && skip "no quedaban procesos sueltos"

# ------------------------------------------------------------------------------
# 3. Comando tvlister-admin
# ------------------------------------------------------------------------------
step "Comando de consola"
for CLI in "${SYSROOT}/usr/local/bin/tvlister-admin" "${SYSROOT}/usr/bin/tvlister-admin"; do
  if [ -e "$CLI" ] || [ -L "$CLI" ]; then
    run rm -f "$CLI"
    did "${CLI} borrado"
  fi
done
[ -e "${SYSROOT}/usr/local/bin/tvlister-admin" ] || skip "no quedan enlaces de tvlister-admin"

# ------------------------------------------------------------------------------
# 4. Bloques de nginx que puso el panel (los de XUI.one incluidos)
# ------------------------------------------------------------------------------
step "nginx (sólo los bloques del panel)"
NGINX_TOUCHED=0
for F in \
  "${SYSROOT}/home/xui/bin/nginx/conf/servers/tvlister-panel.conf" \
  "${SYSROOT}/home/xui/bin/nginx/conf/servers/tvlister-streams.conf" \
  "${SYSROOT}/etc/nginx/conf.d/tvlister247-panel.conf" \
  "${SYSROOT}/etc/nginx/conf.d/tvlister247-streams.conf" \
  "${SYSROOT}/etc/nginx/conf.d/tvlister-cloudflare-realip.conf" \
  "${SYSROOT}/etc/nginx/sites-available/tvlister247.conf" \
  "${SYSROOT}/etc/nginx/sites-available/tvlister247-panel.conf" \
  "${SYSROOT}/etc/nginx/sites-available/tvlister247-streams.conf" ; do
  if [ -f "$F" ]; then
    run rm -f "$F"
    did "borrado ${F#${SYSROOT}}"
    NGINX_TOUCHED=1
  fi
done
for L in \
  "${SYSROOT}/etc/nginx/sites-enabled/tvlister247.conf" \
  "${SYSROOT}/etc/nginx/sites-enabled/tvlister247-panel.conf" \
  "${SYSROOT}/etc/nginx/sites-enabled/tvlister247-streams.conf" ; do
  if [ -L "$L" ] || [ -f "$L" ]; then
    run rm -f "$L"
    did "borrado el enlace ${L#${SYSROOT}}"
    NGINX_TOUCHED=1
  fi
done
# Recarga de nginx (sin cortar nada): el de XUI.one y el del sistema.
if [ "$DRY" -eq 0 ] && [ "$NGINX_TOUCHED" -eq 1 ]; then
  if [ -x "${SYSROOT}/home/xui/bin/nginx/sbin/nginx" ]; then
    "${SYSROOT}/home/xui/bin/nginx/sbin/nginx" -s reload >/dev/null 2>&1 && did "nginx de XUI.one recargado"
  fi
  if command -v nginx >/dev/null 2>&1; then
    nginx -t >/dev/null 2>&1 && { systemctl reload nginx >/dev/null 2>&1 || nginx -s reload >/dev/null 2>&1; did "nginx del sistema recargado"; }
  fi
fi
[ "$NGINX_TOUCHED" -eq 0 ] && skip "el panel no había dejado bloques de nginx"

# Ficheros sueltos que generó el asistente de dominios.
for F in "${SYSROOT}"/root/tvlister247_*.nginx.conf; do
  [ -f "$F" ] || continue
  run rm -f "$F"
  did "borrado ${F#${SYSROOT}}"
done

# ------------------------------------------------------------------------------
# 5. Respaldo automático programado
# ------------------------------------------------------------------------------
step "Tareas programadas"
for F in "${SYSROOT}/etc/cron.d/tvlister24-7-backup" "${SYSROOT}/etc/cron.d/tvlister24-7"; do
  if [ -f "$F" ]; then
    run rm -f "$F"
    did "borrado ${F#${SYSROOT}}"
  fi
done

# ------------------------------------------------------------------------------
# 6. Caché de HLS y playlists (se regenera solo; no son datos del cliente)
# ------------------------------------------------------------------------------
step "Caché de vídeo"
if [ -d "${SYSROOT}/var/lib/tvlister24-7" ]; then
  run rm -rf "${SYSROOT}/var/lib/tvlister24-7"
  did "borrado ${SYSROOT}/var/lib/tvlister24-7 (HLS y playlists temporales)"
else
  skip "no había caché en /var/lib/tvlister24-7"
fi

# ------------------------------------------------------------------------------
# 7. Base de datos: copia (o borrado con --purge)
# ------------------------------------------------------------------------------
step "Datos"
if [ -d "$DATA_DIR" ]; then
  if [ "$PURGE" -eq 1 ]; then
    say "   · --purge: la base de datos se borra con la carpeta (sin copia)"
  else
    if [ "$DRY" -eq 1 ]; then
      say "   [simulado] copiar ${DATA_DIR} → ${BACKUP_DIR}"
    else
      mkdir -p "$BACKUP_DIR" 2>/dev/null || true
      cp -a "$DATA_DIR/." "$BACKUP_DIR/" 2>/dev/null || true
      if [ -f "$BACKUP_DIR/tvlister.db" ]; then
        did "base de datos guardada en ${BACKUP_DIR}"
      else
        say "   ! no se pudo copiar la base de datos a ${BACKUP_DIR}: se deja la carpeta ${DATA_DIR} intacta"
        KEEP_DATA=1
      fi
    fi
  fi
else
  skip "no había carpeta de datos"
fi

# ------------------------------------------------------------------------------
# 8. La carpeta del panel
# ------------------------------------------------------------------------------
step "Carpeta del panel"
if [ -d "$APP_REAL" ]; then
  if [ "${KEEP_DATA:-0}" = "1" ]; then
    # Se borra todo menos data/ (la copia falló: no se pierde nada).
    if [ "$DRY" -eq 1 ]; then
      say "   [simulado] borrar ${APP_REAL} salvo data/"
    else
      find "$APP_REAL" -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} + 2>/dev/null || true
      say "   ✓ ${APP_REAL} borrada, salvo data/ (la base de datos se queda ahí)"
    fi
  else
    run rm -rf "$APP_REAL"
    did "${APP_REAL} borrada"
  fi
else
  skip "la carpeta ya no estaba"
fi

# ------------------------------------------------------------------------------
# 9. Certificados TLS (--purge) y restos de /tmp
# ------------------------------------------------------------------------------
if [ "$PURGE" -eq 1 ] && [ -d "${SYSROOT}/etc/tvlister" ]; then
  step "Certificados"
  run rm -rf "${SYSROOT}/etc/tvlister"
  did "borrado ${SYSROOT}/etc/tvlister"
fi
if [ "$DRY" -eq 0 ]; then
  rm -f /tmp/tvlister_update.* 2>/dev/null || true
  rm -f /tmp/tvlister_install.* 2>/dev/null || true
fi

# ------------------------------------------------------------------------------
# 10. Resumen
# ------------------------------------------------------------------------------
say ""
say "============================================================"
if [ "$DRY" -eq 1 ]; then
  say "  Simulación terminada: no se ha cambiado nada."
else
  say "  ✅ TVLister 24/7 desinstalado de este servidor."
fi
say "============================================================"
if [ "$PURGE" -eq 0 ] && [ -d "${BACKUP_DIR}" ]; then
  say "  Respaldo de la base de datos: ${BACKUP_DIR}"
  say "  (para volver a instalarlo con todo: copia esa carpeta en data/ al terminar)"
fi
say "  Lo que NO se ha tocado:"
say "   · /home/xui (XUI.one y su nginx siguen igual)"
say "   · el firewall (ufw/iptables): las reglas que abrió el instalador se quedan"
if [ "$PURGE" -eq 1 ]; then
  say "   · /etc/tvlister ya no está (se borró con --purge)"
else
  say "   · /etc/tvlister (certificados TLS, si los tenías)"
fi
say "   · tus backups: /root/tvlister_backup_*.tar.gz"
say ""
say "  Si también quieres cerrar los puertos que abrió el instalador:"
say "    ufw status numbered        # mira el número y: ufw delete <n>"
say "    (el 80/443 son de XUI.one: no los cierres si lo usas)"
say ""
say "  Y para volver a instalarlo, cuando quieras:"
say "    curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/latest/download/install.sh | sudo bash"
say "============================================================"
exit 0
