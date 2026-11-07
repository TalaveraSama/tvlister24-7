#!/usr/bin/env bash
# ==============================================================================
# TVLister 24/7 — DESINSTALADOR COMPLETO
# ------------------------------------------------------------------------------
# Quita TODO lo que el instalador y `tvlister-admin` ponen en el servidor:
# servicio, unidad de systemd, comando de consola, carpeta del panel, runtime
# de Node/FFmpeg, caché HLS, cron del backup, bloques de nginx, certificados de
# /etc/tvlister y las reglas de firewall que abrió. NO toca XUI.one.
#
# Por defecto GUARDA la base de datos en /root/tvlister-backup-AAAAMMDD-HHMM.
#
# Uso:
#   sudo bash uninstall.sh                 # desinstala completo (guarda la BD)
#   sudo bash uninstall.sh --purge         # completo y sin copia de la BD
#   sudo bash uninstall.sh --dry-run       # sólo enseña lo que haría
#   sudo bash uninstall.sh --yes           # sin preguntar (para SSH / scripts)
#   sudo bash uninstall.sh --keep-certs    # deja /etc/tvlister
#   sudo bash uninstall.sh --keep-firewall # no toca ufw/iptables
#   sudo bash uninstall.sh --keep-backups  # deja los respaldos de /root
#   sudo bash uninstall.sh --app-dir /opt/otra
#
# Por SSH, en una sola línea (no depende de nada del servidor):
#   ssh root@TU_IP 'curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/latest/download/uninstall.sh | sudo bash -s -- --yes'
#
# Lo que NUNCA toca: /home/xui, el nginx de XUI.one (salvo los bloques del
# panel), los puertos 80/443 del firewall, ni archivos de otros programas.
# ==============================================================================
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/tvlister24-7}"
SERVICE_NAME="tvlister24-7"
# Prefijo para pruebas en un árbol de mentira (en un servidor real va vacío).
SYSROOT="${TVLISTER_SYSROOT:-}"
# Origen del script cuando se ejecuta por SSH (se sobreescribe con --url).
RELEASE_REPO="TalaveraSama/tvlister24-7"

PURGE=0
ASSUME_YES=0
DRY=0
KEEP_CERTS=0
KEEP_FIREWALL=0
KEEP_BACKUPS=0
KEEP_DATA=0
EXTRA_PORTS=""

say()  { printf '%s\n' "$*"; }
step() { printf '\n▶ %s\n' "$*"; }
did()  { printf '   ✓ %s\n' "$*"; }
skip() { printf '   · %s\n' "$*"; }
warn() { printf '   ! %s\n' "$*"; }

usage() {
  cat <<'TXT'
TVLister 24/7 — desinstalador completo

  sudo bash uninstall.sh [opciones]

Opciones:
  --purge            Desinstala y no guarda copia de la base de datos (borra
                     también /root/tvlister_backup_*.tar.gz y respaldos viejos).
  --yes, -y          No pregunta nada (para SSH o scripts). Obligatorio si no
                     hay terminal interactiva (por ejemplo `curl | bash`).
  --dry-run, -n      Sólo enseña lo que haría. No cambia nada.
  --keep-data        Deja la carpeta data/ del panel (base de datos y subidas)
                     donde está y borra el resto.
  --keep-certs       No borra /etc/tvlister (certificados TLS).
  --keep-firewall    No toca las reglas de ufw/iptables.
  --keep-backups     No borra los respaldos de /root.
  --app-dir RUTA     Instalación en otra carpeta (por defecto /opt/tvlister24-7).

Ejemplos:
  sudo bash uninstall.sh
  sudo bash uninstall.sh --dry-run
  sudo bash uninstall.sh --purge --yes
  ssh root@1.2.3.4 'bash -s -- --yes' < uninstall.sh
TXT
}

while [ $# -gt 0 ]; do
  case "$1" in
    --purge|--borrar-todo)         PURGE=1; shift ;;
    -y|--yes|--si)                 ASSUME_YES=1; shift ;;
    -n|--dry-run|--simular)        DRY=1; shift ;;
    --keep-data)                   KEEP_DATA=1; shift ;;
    --keep-certs)                  KEEP_CERTS=1; shift ;;
    --keep-firewall)               KEEP_FIREWALL=1; shift ;;
    --keep-backups)                KEEP_BACKUPS=1; shift ;;
    --ports)                       EXTRA_PORTS="${2:-}"; shift 2 ;;
    --app-dir|--dir)               APP_DIR="${2:-}"; shift 2 ;;
    -h|--help|--ayuda)             usage; exit 0 ;;
    *)
      echo "[ERROR] Opción desconocida: $1"
      echo "        Prueba con: --help"
      exit 1 ;;
  esac
done

run() {
  # Ejecuta (o sólo enseña, con --dry-run) un comando.
  if [ "$DRY" -eq 1 ]; then
    printf '   [simulado] %s\n' "$*"
    return 0
  fi
  "$@" >/dev/null 2>&1 || true
}

# ------------------------------------------------------------------------------
# 0. Comprobaciones
# ------------------------------------------------------------------------------
# Si se ejecuta con `curl | bash`, $0 no es un archivo: hay que copiarse a /tmp
# para poder borrar la carpeta en la que se vive. Con tubería no hay nada que
# copiar (bash ya tiene el texto) y se sigue tal cual.
SELF=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SELF="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")"
fi

# Si somos la copia temporal en /tmp, nos borramos al terminar (pase lo que pase).
case "$SELF" in
  /tmp/tvlister_uninstall.*.sh) trap 'rm -f "$SELF"' EXIT ;;
esac

APP_REAL=$(readlink -f "$APP_DIR" 2>/dev/null || echo "$APP_DIR")

if [ -n "$SELF" ]; then
  case "$SELF" in
    "$APP_REAL"/*)
      # Vive dentro de la carpeta que se va a borrar: se copia fuera y sigue.
      TMP_SELF=$(mktemp /tmp/tvlister_uninstall.XXXXXX.sh) || exit 1
      cp -f "$SELF" "$TMP_SELF" && chmod +x "$TMP_SELF" || exit 1
      args=()
      [ "$PURGE" -eq 1 ] && args+=(--purge)
      [ "$ASSUME_YES" -eq 1 ] && args+=(--yes)
      [ "$KEEP_CERTS" -eq 1 ] && args+=(--keep-certs)
      [ "$KEEP_FIREWALL" -eq 1 ] && args+=(--keep-firewall)
      [ "$KEEP_BACKUPS" -eq 1 ] && args+=(--keep-backups)
      [ "$KEEP_DATA" -eq 1 ] && args+=(--keep-data)
      [ "$DRY" -eq 1 ] && args+=(--dry-run)
      args+=(--app-dir "$APP_DIR")
      APP_DIR="$APP_DIR" TVLISTER_SYSROOT="$SYSROOT" exec bash "$TMP_SELF" "${args[@]}"
      ;;
  esac
fi

# Con TVLISTER_SYSROOT se simula en una carpeta: no hace falta root.
if [ "$DRY" -eq 0 ] && [ "$(id -u)" -ne 0 ] && [ -z "$SYSROOT" ]; then
  echo "[ERROR] Ejecuta el desinstalador como root:"
  echo "        sudo bash uninstall.sh"
  exit 1
fi

UNIT_FILE="${SYSROOT}/etc/systemd/system/${SERVICE_NAME}.service"
UNIT_DROPIN="${SYSROOT}/etc/systemd/system/${SERVICE_NAME}.service.d"
DATA_DIR="${APP_REAL}/data"
STAMP=$(date +%Y%m%d-%H%M)
BACKUP_DIR="${SYSROOT}/root/tvlister-backup-${STAMP}"

# Puertos que abrió el instalador (nunca 80/443: son de XUI.one o del sistema).
PANEL_PORT=""
if [ -f "$UNIT_FILE" ]; then
  PANEL_PORT=$(grep -E '^Environment=PORT=' "$UNIT_FILE" 2>/dev/null | head -n1 | cut -d= -f3 || true)
fi
INGEST_TCP="1935 19350 8554"
INGEST_UDP="8890"

say "============================================================"
say "  TVLister 24/7 — Desinstalador completo"
say "============================================================"
say "  Carpeta del panel : ${APP_REAL}"
if [ -n "$PANEL_PORT" ]; then
  say "  Puerto del panel  : ${PANEL_PORT}"
fi
if [ "$PURGE" -eq 1 ]; then
  say "  Modo              : COMPLETO sin copia de la base de datos"
elif [ "$KEEP_DATA" -eq 1 ]; then
  say "  Modo              : completo, dejando data/ en su sitio"
else
  say "  Modo              : completo, con copia de la base de datos"
fi
[ -n "$SYSROOT" ] && say "  Simulación        : árbol ${SYSROOT}"
[ "$DRY" -eq 1 ] && say "  Ensayo            : sí (no se cambia nada)"

if [ ! -d "$APP_REAL" ] && [ ! -f "$UNIT_FILE" ] && [ ! -e "${SYSROOT}/usr/local/bin/tvlister-admin" ]; then
  say ""
  say "No parece haber nada instalado de TVLister en este servidor."
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

# ------------------------------------------------------------------------------
# Confirmación (por SSH o con `curl | bash` no hay terminal: hace falta --yes)
# ------------------------------------------------------------------------------
if [ "$ASSUME_YES" -eq 0 ] && [ "$DRY" -eq 0 ]; then
  say ""
  say "Se van a quitar de este servidor:"
  say "  · el servicio ${SERVICE_NAME} y su unidad de systemd"
  say "  · el comando tvlister-admin"
  say "  · la carpeta ${APP_REAL} (código, Node y FFmpeg propios)"
  say "  · /var/lib/tvlister24-7 (caché HLS y playlists)"
  say "  · el cron del respaldo automático"
  say "  · los bloques de nginx que puso el panel"
  if [ "$KEEP_CERTS" -eq 0 ]; then say "  · los certificados de /etc/tvlister"; fi
  if [ "$KEEP_FIREWALL" -eq 0 ]; then say "  · las reglas de firewall que abrió el instalador (nunca el 80/443)"; fi
  if [ "$PURGE" -eq 1 ]; then
    say "  · la base de datos, SIN copia (canales, líneas, VOD, access codes)"
  elif [ "$KEEP_DATA" -eq 1 ]; then
    say "  · todo menos data/ (la base de datos se queda donde está)"
  else
    say "  · todo, guardando antes la base de datos en ${BACKUP_DIR}"
  fi
  say ""
  if [ -r /dev/tty ]; then
    printf '¿Seguir? escribe SI para continuar: '
    read -r answer < /dev/tty || answer=""
    case "$answer" in
      SI|si|Sí|sí|S|s|YES|yes|Y|y) ;;
      *) say "Cancelado. No se ha tocado nada."; exit 0 ;;
    esac
  else
    say "Sin terminal para preguntar (¿estás por SSH con tubería?)."
    say "Vuelve a lanzarlo añadiendo --yes si de verdad quieres desinstalar:"
    say "   ... | sudo bash -s -- --yes"
    exit 1
  fi
fi

# ------------------------------------------------------------------------------
# 1. Servicio: parar, desactivar y borrar la unidad
# ------------------------------------------------------------------------------
step "Servicio ${SERVICE_NAME}"
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] && [ -z "$SYSROOT" ]; then
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
  did "unidad ${UNIT_FILE#${SYSROOT}} borrada"
else
  skip "no había unidad de systemd"
fi
if [ -d "$UNIT_DROPIN" ]; then
  run rm -rf "$UNIT_DROPIN"
  did "ajustes extra del servicio (cloudflare.conf) borrados"
fi
# Restos de unidades con otro nombre que hayan podido quedar.
for F in "${SYSROOT}/etc/systemd/system/tvlister"*.service "${SYSROOT}/etc/systemd/system/tvlister"*.service.d; do
  [ -e "$F" ] || continue
  case "$F" in
    "${SYSROOT}/etc/systemd/system/${SERVICE_NAME}.service"|"${SYSROOT}/etc/systemd/system/${SERVICE_NAME}.service.d") continue ;;
  esac
  run rm -rf "$F"
  did "resto de unidad ${F#${SYSROOT}} borrado"
done
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] && [ -z "$SYSROOT" ]; then
  run systemctl daemon-reload
  run systemctl reset-failed "$SERVICE_NAME"
fi

# ------------------------------------------------------------------------------
# 2. Procesos del panel (node / ffmpeg / ffprobe)
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
# 3. Comando de consola y accesos directos
# ------------------------------------------------------------------------------
step "Comando de consola"
CLI_FOUND=0
for CLI in "${SYSROOT}/usr/local/bin/tvlister-admin" "${SYSROOT}/usr/bin/tvlister-admin" \
           "${SYSROOT}/usr/sbin/tvlister-admin" "${SYSROOT}/bin/tvlister-admin"; do
  if [ -e "$CLI" ] || [ -L "$CLI" ]; then
    run rm -f "$CLI"
    did "${CLI#${SYSROOT}} borrado"
    CLI_FOUND=1
  fi
done
[ "$CLI_FOUND" -eq 0 ] && skip "no había comando instalado"

# ------------------------------------------------------------------------------
# 4. nginx: sólo los bloques que puso el panel
# ------------------------------------------------------------------------------
step "nginx (sólo los bloques del panel)"
NGINX_TOUCHED=0
for F in \
  "${SYSROOT}/home/xui/bin/nginx/conf/servers/tvlister-panel.conf" \
  "${SYSROOT}/home/xui/bin/nginx/conf/servers/tvlister-streams.conf" \
  "${SYSROOT}/home/xui/bin/nginx/conf/servers/tvlister-compat.conf" \
  "${SYSROOT}/etc/nginx/conf.d/tvlister247-panel.conf" \
  "${SYSROOT}/etc/nginx/conf.d/tvlister247-streams.conf" \
  "${SYSROOT}/etc/nginx/conf.d/tvlister247-panel.conf.disabled" \
  "${SYSROOT}/etc/nginx/conf.d/tvlister247-streams.conf.disabled" \
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
if [ "$DRY" -eq 0 ] && [ "$NGINX_TOUCHED" -eq 1 ] && [ -z "$SYSROOT" ]; then
  if [ -x /home/xui/bin/nginx/sbin/nginx ]; then
    /home/xui/bin/nginx/sbin/nginx -s reload >/dev/null 2>&1 && did "nginx de XUI.one recargado"
  fi
  if command -v nginx >/dev/null 2>&1; then
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx >/dev/null 2>&1 || nginx -s reload >/dev/null 2>&1
      did "nginx del sistema recargado"
    else
      warn "nginx -t falla: revisa /etc/nginx antes de recargarlo"
    fi
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
# 5. Tareas programadas
# ------------------------------------------------------------------------------
step "Tareas programadas"
CRON_FOUND=0
for F in "${SYSROOT}/etc/cron.d/tvlister24-7-backup" "${SYSROOT}/etc/cron.d/tvlister24-7"; do
  if [ -f "$F" ]; then
    run rm -f "$F"
    did "borrado ${F#${SYSROOT}}"
    CRON_FOUND=1
  fi
done
[ "$CRON_FOUND" -eq 0 ] && skip "no había cron del panel"

# ------------------------------------------------------------------------------
# 6. Firewall: sólo los puertos que abrió el instalador (nunca 80/443)
# ------------------------------------------------------------------------------
step "Firewall"
if [ "$KEEP_FIREWALL" -eq 1 ]; then
  skip "--keep-firewall: no se toca"
elif [ -n "$SYSROOT" ]; then
  skip "simulación: no se toca el firewall real"
else
  TCP_PORTS=""
  [ -n "$PANEL_PORT" ] && TCP_PORTS="$PANEL_PORT"
  for p in $INGEST_TCP $EXTRA_PORTS; do
    case " $TCP_PORTS " in *" $p "*) ;; *) TCP_PORTS="${TCP_PORTS:+$TCP_PORTS }$p" ;; esac
  done

  FW_DONE=0
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    for p in $TCP_PORTS; do
      if ufw status 2>/dev/null | grep -Eq "^${p}/tcp[[:space:]]+ALLOW"; then
        run ufw delete allow "${p}/tcp"
        did "ufw: cerrado ${p}/tcp"
        FW_DONE=1
      fi
    done
    for p in $INGEST_UDP; do
      if ufw status 2>/dev/null | grep -Eq "^${p}/udp[[:space:]]+ALLOW"; then
        run ufw delete allow "${p}/udp"
        did "ufw: cerrado ${p}/udp"
        FW_DONE=1
      fi
    done
  fi

  if command -v iptables >/dev/null 2>&1; then
    for p in $TCP_PORTS; do
      n=0
      while iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null; do
        if [ "$DRY" -eq 1 ]; then
          say "   [simulado] iptables -D INPUT -p tcp --dport ${p} -j ACCEPT"
          break
        fi
        iptables -D INPUT -p tcp --dport "$p" -j ACCEPT >/dev/null 2>&1 || break
        n=$((n + 1))
        [ "$n" -ge 10 ] && break
      done
      [ "$n" -gt 0 ] && { did "iptables: quitada la regla TCP ${p} (${n})"; FW_DONE=1; }
    done
    for p in $INGEST_UDP; do
      n=0
      while iptables -C INPUT -p udp --dport "$p" -j ACCEPT 2>/dev/null; do
        if [ "$DRY" -eq 1 ]; then
          say "   [simulado] iptables -D INPUT -p udp --dport ${p} -j ACCEPT"
          break
        fi
        iptables -D INPUT -p udp --dport "$p" -j ACCEPT >/dev/null 2>&1 || break
        n=$((n + 1))
        [ "$n" -ge 10 ] && break
      done
      [ "$n" -gt 0 ] && { did "iptables: quitada la regla UDP ${p} (${n})"; FW_DONE=1; }
    done
  fi
  [ "$FW_DONE" -eq 0 ] && skip "no había reglas del panel que quitar"
  skip "el 80/443 no se tocan (son de XUI.one / del sistema)"
fi

# ------------------------------------------------------------------------------
# 7. Certificados TLS
# ------------------------------------------------------------------------------
if [ "$KEEP_CERTS" -eq 1 ]; then
  step "Certificados"
  skip "--keep-certs: se queda /etc/tvlister"
elif [ -d "${SYSROOT}/etc/tvlister" ]; then
  step "Certificados"
  run rm -rf "${SYSROOT}/etc/tvlister"
  did "borrado ${SYSROOT}/etc/tvlister"
fi

# ------------------------------------------------------------------------------
# 8. Caché de vídeo (se regenera sola; no son datos del cliente)
# ------------------------------------------------------------------------------
step "Caché de vídeo"
if [ -d "${SYSROOT}/var/lib/tvlister24-7" ]; then
  run rm -rf "${SYSROOT}/var/lib/tvlister24-7"
  did "borrado ${SYSROOT}/var/lib/tvlister24-7 (HLS y playlists temporales)"
else
  skip "no había caché en /var/lib/tvlister24-7"
fi

# ------------------------------------------------------------------------------
# 9. Datos: copia (o borrado con --purge)
# ------------------------------------------------------------------------------
step "Datos"
KEEP_DATA_DIR=0
if [ -d "$DATA_DIR" ]; then
  if [ "$PURGE" -eq 1 ]; then
    skip "--purge: la base de datos se borra con la carpeta (sin copia)"
  elif [ "$KEEP_DATA" -eq 1 ]; then
    skip "--keep-data: data/ se queda en ${DATA_DIR}"
    KEEP_DATA_DIR=1
  elif [ "$DRY" -eq 1 ]; then
    say "   [simulado] copiar ${DATA_DIR} → ${BACKUP_DIR}"
    KEEP_DATA_DIR=0
  else
    mkdir -p "$BACKUP_DIR" 2>/dev/null || true
    cp -a "$DATA_DIR/." "$BACKUP_DIR/" 2>/dev/null || true
    if [ -f "$BACKUP_DIR/tvlister.db" ]; then
      did "base de datos guardada en ${BACKUP_DIR}"
    else
      warn "no se pudo copiar la base de datos: se deja ${DATA_DIR} intacta"
      KEEP_DATA_DIR=1
    fi
  fi
else
  skip "no había carpeta de datos"
fi

# ------------------------------------------------------------------------------
# 10. La carpeta del panel
# ------------------------------------------------------------------------------
step "Carpeta del panel"
if [ -d "$APP_REAL" ]; then
  if [ "$KEEP_DATA_DIR" -eq 1 ] || [ "$KEEP_DATA" -eq 1 ]; then
    if [ "$DRY" -eq 1 ]; then
      say "   [simulado] borrar ${APP_REAL} salvo data/"
    else
      find "$APP_REAL" -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} + 2>/dev/null || true
      did "${APP_REAL} borrada, salvo data/ (la base de datos se queda ahí)"
    fi
  else
    run rm -rf "$APP_REAL"
    did "${APP_REAL} borrada"
  fi
else
  skip "la carpeta ya no estaba"
fi

# ------------------------------------------------------------------------------
# 11. Respaldos de /root
# ------------------------------------------------------------------------------
step "Respaldos de /root"
if [ "$KEEP_BACKUPS" -eq 1 ]; then
  skip "--keep-backups: se quedan los respaldos"
elif [ "$PURGE" -eq 1 ]; then
  NB=0
  for F in "${SYSROOT}"/root/tvlister_backup_*.tar.gz "${SYSROOT}"/root/tvlister-backup-*; do
    [ -e "$F" ] || continue
    case "$F" in "$BACKUP_DIR") continue ;; esac
    run rm -rf "$F"
    did "borrado ${F#${SYSROOT}}"
    NB=$((NB + 1))
  done
  [ "$NB" -eq 0 ] && skip "no había respaldos viejos"
else
  skip "se conservan los respaldos (usa --purge para borrarlos)"
fi

# Restos temporales del instalador.
if [ "$DRY" -eq 0 ]; then
  rm -f /tmp/tvlister_update.* /tmp/tvlister_install.* /tmp/tvlister_release.* 2>/dev/null || true
fi

# ------------------------------------------------------------------------------
# 12. Resumen
# ------------------------------------------------------------------------------
say ""
say "============================================================"
if [ "$DRY" -eq 1 ]; then
  say "  Ensayo terminado: no se ha cambiado nada."
else
  say "  ✅ TVLister 24/7 desinstalado de este servidor."
fi
say "============================================================"
if [ "$PURGE" -eq 0 ] && [ "$DRY" -eq 0 ] && [ -f "${BACKUP_DIR}/tvlister.db" ]; then
  say "  Base de datos guardada en: ${BACKUP_DIR}"
  say "  Para recuperarla al volver a instalar, copia esa carpeta en data/."
fi
if [ "$KEEP_DATA" -eq 1 ]; then
  say "  La base de datos sigue en: ${DATA_DIR}"
fi
say "  Lo que NO se ha tocado:"
say "   · /home/xui (XUI.one, su nginx y sus canales, siguen igual)"
say "   · los puertos 80/443 del firewall (son de XUI.one o del sistema)"
if [ "$KEEP_CERTS" -eq 1 ]; then say "   · /etc/tvlister (certificados), por --keep-certs"; fi
if [ "$KEEP_BACKUPS" -eq 1 ]; then say "   · los respaldos /root/tvlister_backup_*.tar.gz, por --keep-backups"; fi
say ""
if [ "$KEEP_FIREWALL" -eq 1 ]; then
  say "  Te quedan las reglas de firewall (--keep-firewall). Para verlas y quitarlas:"
  say "    ufw status numbered      y después   ufw delete <n>"
fi
say "  Para volver a instalarlo, cuando quieras:"
say "    curl -fsSL https://github.com/${RELEASE_REPO}/releases/latest/download/install.sh | sudo bash"
say "============================================================"
exit 0
