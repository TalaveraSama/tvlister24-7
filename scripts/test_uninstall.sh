#!/usr/bin/env bash
# ==============================================================================
# Prueba del desinstalador (scripts/uninstall.sh) — no toca el sistema real.
#
# Monta instalaciones FALSAS dentro de un directorio temporal (TVLISTER_SYSROOT)
# y comprueba qué se borra, qué se guarda y qué NO se toca.
#
#   bash scripts/test_uninstall.sh
# ==============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
UNINSTALL="$ROOT/scripts/uninstall.sh"
WORK=$(mktemp -d /tmp/tvl_uninstall_test.XXXXXX)
FAILS=0
OKS=0

ok()   { OKS=$((OKS + 1));   printf 'ok    %s\n' "$1"; }
fail() { FAILS=$((FAILS + 1)); printf 'FALLO %s\n' "$1"; }
check() { if [ "$2" = "1" ]; then ok "$1"; else fail "$1"; fi; }
exists() { [ -e "$1" ] && echo 1 || echo 0; }
gone()   { [ ! -e "$1" ] && echo 1 || echo 0; }

trap 'rm -rf "$WORK"' EXIT

# ------------------------------------------------------------------------------
# Instalación falsa: sistema (SYSROOT) + carpeta del panel
# ------------------------------------------------------------------------------
build_fixture() {
  local sys="$1" app="$2"
  rm -rf "$sys" "$app"
  mkdir -p "$sys"/etc/systemd/system/tvlister24-7.service.d "$sys"/etc/cron.d \
           "$sys"/usr/local/bin "$sys"/usr/bin \
           "$sys"/var/lib/tvlister24-7/hls "$sys"/var/lib/tvlister24-7/playlists \
           "$sys"/etc/nginx/conf.d "$sys"/etc/nginx/sites-available "$sys"/etc/nginx/sites-enabled \
           "$sys"/home/xui/bin/nginx/conf/servers "$sys"/etc/tvlister/tls "$sys"/root \
           "$app"/server "$app"/data/xui_uploads "$app"/dist "$app"/node_modules/express "$app"/scripts
  printf '[Unit]\nDescription=x\n' > "$sys/etc/systemd/system/tvlister24-7.service"
  printf '[Service]\n' > "$sys/etc/systemd/system/tvlister24-7.service.d/cloudflare.conf"
  printf '0 3 * * * root x\n' > "$sys/etc/cron.d/tvlister24-7-backup"
  printf '#!/bin/bash\n' > "$sys/usr/local/bin/tvlister-admin"
  ln -s /usr/local/bin/tvlister-admin "$sys/usr/bin/tvlister-admin"
  printf '#EXTM3U\n' > "$sys/var/lib/tvlister24-7/hls/index.m3u8"
  printf 'x' > "$sys/var/lib/tvlister24-7/playlists/lista.m3u"
  printf 'server{}\n' > "$sys/etc/nginx/conf.d/tvlister247-panel.conf"
  printf 'server{}\n' > "$sys/etc/nginx/sites-available/tvlister247.conf"
  ln -s /etc/nginx/sites-available/tvlister247.conf "$sys/etc/nginx/sites-enabled/tvlister247.conf"
  # Lo que puso el panel en el nginx de XUI.one … y un canal REAL de XUI.one al lado
  printf 'server{}\n' > "$sys/home/xui/bin/nginx/conf/servers/tvlister-panel.conf"
  printf 'server{}\n' > "$sys/home/xui/bin/nginx/conf/servers/tvlister-streams.conf"
  printf 'server{}\n' > "$sys/home/xui/bin/nginx/conf/servers/a0ed.conf"
  printf 'cert\n' > "$sys/etc/tvlister/tls/fullchain.pem"
  printf 'server{}\n' > "$sys/root/tvlister247_tv.midominio.com.nginx.conf"
  printf 'backup viejo\n' > "$sys/root/tvlister_backup_viejo.tar.gz"
  printf '{"name":"tvlister24-7","version":"2.6.50"}' > "$app/package.json"
  printf '// panel\n' > "$app/server/index.js"
  python3 - "$app/data/tvlister.db" <<'PY'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute("create table lines(username text)")
c.execute("insert into lines values('prueba')")
c.commit()
PY
  printf 'subido' > "$app/data/xui_uploads/peli.mp4"
  printf 'bundle' > "$app/dist/index.html"
  cp -f "$UNINSTALL" "$app/scripts/uninstall.sh"
  chmod +x "$app/scripts/uninstall.sh"
}

run_uninstall() { # sys app [args...]
  local sys="$1" app="$2"; shift 2
  APP_DIR="$app" TVLISTER_SYSROOT="$sys" bash "$app/scripts/uninstall.sh" "$@" 3>&1 1>/dev/null 2>&1
}

dbfile_has_rows() { # ruta_db
  python3 - "$1" <<'PY'
import sqlite3, sys
try:
    c = sqlite3.connect(sys.argv[1])
    print(1 if c.execute("select count(*) from lines").fetchone()[0] == 1 else 0)
except Exception:
    print(0)
PY
}

# ==============================================================================
echo "== 1. Desinstalación normal: se lleva el panel y guarda la base de datos"
sys="$WORK/s1"; app="$WORK/a1"
build_fixture "$sys" "$app"
run_uninstall "$sys" "$app" --yes
check "la carpeta del panel ya no está"            "$(gone "$app")"
check "la unidad de systemd se borró"              "$(gone "$sys/etc/systemd/system/tvlister24-7.service")"
check "los ajustes de Cloudflare se borraron"      "$(gone "$sys/etc/systemd/system/tvlister24-7.service.d")"
check "el comando tvlister-admin se borró"         "$(gone "$sys/usr/local/bin/tvlister-admin")"
check "el enlace de /usr/bin se borró"             "$(gone "$sys/usr/bin/tvlister-admin")"
check "la caché de HLS se borró"                   "$(gone "$sys/var/lib/tvlister24-7")"
check "el cron del backup se borró"                "$(gone "$sys/etc/cron.d/tvlister24-7-backup")"
check "el bloque del panel en nginx de XUI se fue" "$(gone "$sys/home/xui/bin/nginx/conf/servers/tvlister-panel.conf")"
check "el bloque de streams de XUI se fue"         "$(gone "$sys/home/xui/bin/nginx/conf/servers/tvlister-streams.conf")"
check "el bloque del nginx del sistema se fue"     "$(gone "$sys/etc/nginx/conf.d/tvlister247-panel.conf")"
check "el enlace de sites-enabled se fue"          "$(gone "$sys/etc/nginx/sites-enabled/tvlister247.conf")"
check "el .conf que dejó el asistente de dominios" "$(gone "$sys/root/tvlister247_tv.midominio.com.nginx.conf")"
check "el canal a0ed de XUI.one SIGUE intacto"     "$(exists "$sys/home/xui/bin/nginx/conf/servers/a0ed.conf")"
check "los certificados TLS se conservan"          "$(exists "$sys/etc/tvlister/tls/fullchain.pem")"
check "los backups viejos de /root se conservan"   "$(exists "$sys/root/tvlister_backup_viejo.tar.gz")"
BK=$(ls -d "$sys"/root/tvlister-backup-* 2>/dev/null | head -1)
check "se guardó un respaldo con la base de datos" "$(exists "${BK:-/nada}/tvlister.db")"
check "el respaldo trae lo subido"                 "$(exists "${BK:-/nada}/xui_uploads/peli.mp4")"
check "la base de datos del respaldo conserva sus filas" "$(dbfile_has_rows "${BK:-/nada}/tvlister.db")"

# ==============================================================================
echo ""
echo "== 2. --purge: no deja ni la base de datos"
sys="$WORK/s2"; app="$WORK/a2"
build_fixture "$sys" "$app"
run_uninstall "$sys" "$app" --purge --yes
check "la carpeta del panel ya no está"       "$(gone "$app")"
check "no se creó ningún respaldo"            "$([ -z "$(ls -d "$sys"/root/tvlister-backup-* 2>/dev/null)" ] && echo 1 || echo 0)"
check "los certificados TLS se borraron"      "$(gone "$sys/etc/tvlister")"
check "el canal a0ed de XUI.one sigue ahí"    "$(exists "$sys/home/xui/bin/nginx/conf/servers/a0ed.conf")"

# ==============================================================================
echo ""
echo "== 3. --dry-run: no cambia absolutamente nada"
sys="$WORK/s3"; app="$WORK/a3"
build_fixture "$sys" "$app"
BEFORE=$( (find "$sys" "$app" | sort; find "$app" -type f -exec md5sum {} + 2>/dev/null | sort) | md5sum)
run_uninstall "$sys" "$app" --dry-run
AFTER=$( (find "$sys" "$app" | sort; find "$app" -type f -exec md5sum {} + 2>/dev/null | sort) | md5sum)
check "el árbol queda idéntico con --dry-run" "$([ "$BEFORE" = "$AFTER" ] && echo 1 || echo 0)"

# ==============================================================================
echo ""
echo "== 4. Sin confirmar (sin escribir SI) no se borra nada"
sys="$WORK/s4"; app="$WORK/a4"
build_fixture "$sys" "$app"
APP_DIR="$app" TVLISTER_SYSROOT="$sys" bash "$app/scripts/uninstall.sh" </dev/null >/dev/null 2>&1
check "la instalación sigue en su sitio" "$(exists "$app/server/index.js")"
check "su unidad de systemd sigue ahí"   "$(exists "$sys/etc/systemd/system/tvlister24-7.service")"

# ==============================================================================
echo ""
echo "== 5. Una carpeta que no es del panel: se niega"
sys="$WORK/s5"; app="$WORK/a5"
mkdir -p "$app/server"
printf '{"name":"otra-cosa"}' > "$app/package.json"
printf 'x' > "$app/server/index.js"
APP_DIR="$app" TVLISTER_SYSROOT="$sys" bash "$UNINSTALL" --yes >/dev/null 2>&1
check "no borra una carpeta ajena" "$(exists "$app/server/index.js")"

# ==============================================================================
echo ""
echo "== 6. El motor node del panel se detiene; la shell que lo lanzó no"
sys="$WORK/s6"; app="$WORK/a6"
build_fixture "$sys" "$app"
node -e "setTimeout(()=>{},120000)" "$app/server/index.js" >/dev/null 2>&1 &
MOTOR=$!
sleep 1
run_uninstall "$sys" "$app" --yes
sleep 0.5
if kill -0 "$MOTOR" 2>/dev/null; then
  # Un proceso ya muerto pero sin recoger puede seguir apareciendo: se mira /proc.
  if [ -r "/proc/$MOTOR/stat" ] && [ "$(awk '{print $3}' "/proc/$MOTOR/stat")" != "Z" ]; then
    fail "el motor node del panel se detuvo (sigue vivo: $MOTOR)"
  else
    ok "el motor node del panel se detuvo"
  fi
else
  ok "el motor node del panel se detuvo"
fi
check "la carpeta del panel ya no está" "$(gone "$app")"
check "esta prueba sigue corriendo (no se mató la shell)" 1

# ==============================================================================
echo ""
if [ "$FAILS" -eq 0 ]; then
  echo "TODO OK ($OKS comprobaciones)"
  exit 0
fi
echo "$FAILS fallo(s) de $OKS comprobaciones"
exit 1
