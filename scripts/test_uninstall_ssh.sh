#!/usr/bin/env bash
# ==============================================================================
# Prueba del lanzador SSH (scripts/uninstall_ssh.sh) — no sale de este equipo.
#
# Pone un `ssh` de mentira en el PATH que ejecuta el comando "remoto" en este
# mismo equipo contra una instalación FALSA (TVLISTER_SYSROOT), y comprueba que
# el lanzador:
#   · valida los argumentos y la ayuda
#   · pide confirmación aquí y pasa --yes al servidor
#   · envía el script por la entrada estándar (y también el modo --descargar)
#   · no añade --yes con --dry-run
#   · aborta sin tocar nada si el servidor no es root y no hay sudo
#   · comprueba al final que no queda nada
#
#   bash scripts/test_uninstall_ssh.sh
# ==============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
LAUNCHER="$ROOT/scripts/uninstall_ssh.sh"
UNINSTALL="$ROOT/scripts/uninstall.sh"
WORK=$(mktemp -d /tmp/tvl_ssh_test.XXXXXX)
BIN="$WORK/bin"
mkdir -p "$BIN" "$WORK/app" "$WORK/sys"

FAILS=0; OKS=0
ok()   { OKS=$((OKS + 1));   printf 'ok    %s\n' "$1"; }
fail() { FAILS=$((FAILS + 1)); printf 'FALLO %s\n' "$1"; }
check(){ if [ "$2" = "1" ]; then ok "$1"; else fail "$1"; fi; }
exists(){ [ -e "$1" ] && echo 1 || echo 0; }
gone()  { [ ! -e "$1" ] && echo 1 || echo 0; }

trap 'rm -rf "$WORK"' EXIT

# --- ssh de mentira -----------------------------------------------------------
cat > "$BIN/ssh" <<'STUB'
#!/usr/bin/env bash
# Ejecuta el "comando remoto" aquí mismo. FAKE_UID dice qué usuario se simula.
while [ $# -gt 0 ]; do
  case "$1" in
    -p|-o|-i|-l|-F) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
TARGET="$1"; shift
CMD="$*"
ORIG="$CMD"
UID_SIM="${FAKE_UID:-0}"
SUDO_OK="${FAKE_SUDO:-1}"

case "$CMD" in
  *"id -un"*)
    if [ "$UID_SIM" = "0" ]; then printf 'root\n0\n'; else printf 'usuario\n1000\n'; fi
    exit 0 ;;
  "sudo -n true")
    [ "$SUDO_OK" = "1" ] && exit 0 || exit 1 ;;
esac

# Se cambia el servidor de verdad por la instalación falsa y la URL del release
# por el script local (curl acepta file://).
CMD=${CMD//https:\/\/github.com\/TalaveraSama\/tvlister24-7\/releases\/latest\/download\/uninstall.sh/file:\/\/$FAKE_UNINSTALL}
CMD=${CMD//https:\/\/github.com\/TalaveraSama\/tvlister24-7\/releases\/download\/v9.9.9\/uninstall.sh/file:\/\/$FAKE_UNINSTALL}
CMD=${CMD//\/opt\/tvlister24-7/$FAKE_APP}
CMD=${CMD//\/etc\/systemd\/system\/tvlister24-7.service/$FAKE_SYS/etc/systemd/system/tvlister24-7.service}
CMD=${CMD//\/usr\/local\/bin\/tvlister-admin/$FAKE_SYS/usr/local/bin/tvlister-admin}
CMD=${CMD//\/tmp\/tvlister-uninstall.sh/$FAKE_DL}
# En este equipo de pruebas no hay sudo: se ejecuta sin él (ya quedó en el log).
CMD=${CMD/#sudo -n /}

printf 'ssh %s :: %s\n' "$TARGET" "$ORIG" >> "$FAKE_LOG"
APP_DIR="$FAKE_APP" TVLISTER_SYSROOT="$FAKE_SYS" bash -c "$CMD"
STUB
chmod +x "$BIN/ssh"

# --- instalación falsa --------------------------------------------------------
build_fixture() {
  local sys="$1" app="$2"
  rm -rf "$sys" "$app"
  mkdir -p "$sys"/etc/systemd/system/tvlister24-7.service.d "$sys"/etc/cron.d \
           "$sys"/usr/local/bin "$sys"/usr/bin "$sys"/var/lib/tvlister24-7/hls \
           "$sys"/etc/tvlister/tls "$sys"/root "$app"/server "$app"/data "$app"/scripts
  printf '[Unit]\nEnvironment=PORT=8095\n' > "$sys/etc/systemd/system/tvlister24-7.service"
  printf '[Service]\n' > "$sys/etc/systemd/system/tvlister24-7.service.d/cloudflare.conf"
  printf '0 3 * * * root x\n' > "$sys/etc/cron.d/tvlister24-7-backup"
  printf '#!/bin/bash\n' > "$sys/usr/local/bin/tvlister-admin"
  printf '#EXTM3U\n' > "$sys/var/lib/tvlister24-7/hls/index.m3u8"
  printf 'cert\n' > "$sys/etc/tvlister/tls/fullchain.pem"
  printf 'viejo\n' > "$sys/root/tvlister_backup_viejo.tar.gz"
  printf '{"name":"tvlister24-7","version":"2.6.51"}' > "$app/package.json"
  printf '// panel\n' > "$app/server/index.js"
  printf 'db' > "$app/data/tvlister.db"
  cp -f "$UNINSTALL" "$app/scripts/uninstall.sh"
  chmod +x "$app/scripts/uninstall.sh"
}

export FAKE_UNINSTALL="$UNINSTALL"
export FAKE_LOG="$WORK/ssh.log"
export PATH="$BIN:$PATH"

run_launcher() { # app sys [args...]  (stdin cerrado: como un script sin terminal)
  local app="$1" sys="$2"; shift 2
  FAKE_APP="$app" FAKE_SYS="$sys" FAKE_DL="$WORK/dl-uninstall.sh" \
    bash "$LAUNCHER" "$@" </dev/null 2>&1
}

echo "== 1. Ayuda y argumentos"
OUT=$(bash "$LAUNCHER" --help 2>&1)
case "$OUT" in *"Desinstalar TVLister en un servidor remoto"*) check "la ayuda se muestra" 1 ;; *) check "la ayuda se muestra" 0 ;; esac
bash "$LAUNCHER" >/dev/null 2>&1;                       check "sin servidor: sale con error" "$([ $? -ne 0 ] && echo 1 || echo 0)"
bash "$LAUNCHER" root@x --inventada >/dev/null 2>&1;    check "opción desconocida: sale con error" "$([ $? -ne 0 ] && echo 1 || echo 0)"
bash "$LAUNCHER" root@x --puerto >/dev/null 2>&1;       check "--puerto sin valor: sale con error" "$([ $? -ne 0 ] && echo 1 || echo 0)"

echo ""
echo "== 2. Desinstalación completa con --yes (script enviado por SSH)"
sys="$WORK/s2"; app="$WORK/a2"
build_fixture "$sys" "$app"
: > "$FAKE_LOG"
OUT=$(run_launcher "$app" "$sys" root@servidor --yes); RC=$?
check "termina sin error"                          "$([ "$RC" -eq 0 ] && echo 1 || echo 0)"
check "la carpeta del panel ya no está"             "$(gone "$app")"
check "la unidad de systemd se borró"               "$(gone "$sys/etc/systemd/system/tvlister24-7.service")"
check "el comando tvlister-admin se borró"          "$(gone "$sys/usr/local/bin/tvlister-admin")"
check "la caché de HLS se borró"                    "$(gone "$sys/var/lib/tvlister24-7")"
check "el cron se borró"                            "$(gone "$sys/etc/cron.d/tvlister24-7-backup")"
check "los certificados se borraron"                "$(gone "$sys/etc/tvlister")"
BK=$(ls -d "$sys"/root/tvlister-backup-* 2>/dev/null | head -1)
check "se guardó el respaldo de la base de datos"   "$(exists "${BK:-/nada}/tvlister.db")"
check "los respaldos viejos se conservan"           "$(exists "$sys/root/tvlister_backup_viejo.tar.gz")"
check "se envió el script por la entrada estándar"  "$(grep -q 'bash -s -- --yes' "$FAKE_LOG" && echo 1 || echo 0)"
check "no usó curl cuando el script es local"       "$(grep -q 'curl -fsSL' "$FAKE_LOG" && echo 0 || echo 1)"
check "el mensaje final es de éxito"                "$(case "$OUT" in *"terminó sin errores"*) echo 1 ;; *) echo 0 ;; esac)"

echo ""
echo "== 3. --dry-run: no añade --yes y no borra nada"
sys="$WORK/s3"; app="$WORK/a3"
build_fixture "$sys" "$app"
: > "$FAKE_LOG"
OUT=$(run_launcher "$app" "$sys" root@servidor --dry-run)
check "no se pasó --yes al servidor"                "$(grep -q 'bash -s -- --dry-run' "$FAKE_LOG" && echo 1 || echo 0)"
check "la instalación sigue entera"                 "$(exists "$app/server/index.js")"
check "la unidad sigue ahí"                         "$(exists "$sys/etc/systemd/system/tvlister24-7.service")"
check "no se creó ningún respaldo"                  "$([ -z "$(ls -d "$sys"/root/tvlister-backup-* 2>/dev/null)" ] && echo 1 || echo 0)"

echo ""
echo "== 4. --purge llega al servidor"
sys="$WORK/s4"; app="$WORK/a4"
build_fixture "$sys" "$app"
OUT=$(run_launcher "$app" "$sys" root@servidor --purge --yes)
check "la carpeta del panel ya no está"             "$(gone "$app")"
check "no se guardó respaldo"                       "$([ -z "$(ls -d "$sys"/root/tvlister-backup-* 2>/dev/null)" ] && echo 1 || echo 0)"
check "el respaldo viejo también se fue"            "$(gone "$sys/root/tvlister_backup_viejo.tar.gz")"

echo ""
echo "== 5. --keep-certs se respeta"
sys="$WORK/s5"; app="$WORK/a5"
build_fixture "$sys" "$app"
OUT=$(run_launcher "$app" "$sys" root@servidor --keep-certs --yes)
check "los certificados se quedan"                  "$(exists "$sys/etc/tvlister/tls/fullchain.pem")"
check "el panel se fue igualmente"                  "$(gone "$app")"

echo ""
echo "== 6. Sin --yes y sin terminal: se cancela sin tocar nada"
sys="$WORK/s6"; app="$WORK/a6"
build_fixture "$sys" "$app"
OUT=$(run_launcher "$app" "$sys" root@servidor); RC=$?
check "sale con 0 (cancelado, no error)"            "$([ "$RC" -eq 0 ] && echo 1 || echo 0)"
check "avisa de que se ha cancelado"                "$(case "$OUT" in *Cancelado*) echo 1 ;; *) echo 0 ;; esac)"
check "la instalación sigue entera"                 "$(exists "$app/server/index.js")"
check "la unidad sigue ahí"                         "$(exists "$sys/etc/systemd/system/tvlister24-7.service")"

echo ""
echo "== 7. Servidor sin root y sin sudo: aborta con mensaje"
sys="$WORK/s7"; app="$WORK/a7"
build_fixture "$sys" "$app"
OUT=$(FAKE_UID=1000 FAKE_SUDO=0 run_launcher "$app" "$sys" root@servidor --yes); RC=$?
check "sale con error"                              "$([ "$RC" -ne 0 ] && echo 1 || echo 0)"
check "explica que falta root o sudo"               "$(case "$OUT" in *"no es root"*|*"sudo sin contraseña"*) echo 1 ;; *) echo 0 ;; esac)"
check "no se borró nada"                            "$(exists "$app/server/index.js")"

echo ""
echo "== 8. Servidor sin root pero con sudo: funciona"
sys="$WORK/s8"; app="$WORK/a8"
build_fixture "$sys" "$app"
: > "$FAKE_LOG"
OUT=$(FAKE_UID=1000 FAKE_SUDO=1 run_launcher "$app" "$sys" root@servidor --yes); RC=$?
check "termina sin error"                           "$([ "$RC" -eq 0 ] && echo 1 || echo 0)"
check "usó sudo en el servidor"                     "$(grep -q 'sudo -n bash -s' "$FAKE_LOG" && echo 1 || echo 0)"
check "la carpeta del panel ya no está"             "$(gone "$app")"

echo ""
echo "== 9. --descargar: baja el script en el servidor y lo ejecuta"
sys="$WORK/s9"; app="$WORK/a9"
build_fixture "$sys" "$app"
: > "$FAKE_LOG"
OUT=$(run_launcher "$app" "$sys" root@servidor --descargar --yes); RC=$?
check "termina sin error"                           "$([ "$RC" -eq 0 ] && echo 1 || echo 0)"
check "usó curl con la URL del release"             "$(grep -q 'curl -fsSL .*releases/latest/download/uninstall.sh' "$FAKE_LOG" && echo 1 || echo 0)"
check "dejó limpio el temporal del servidor"        "$(gone "$WORK/dl-uninstall.sh")"
check "la carpeta del panel ya no está"             "$(gone "$app")"

echo ""
echo "== 10. --tag usa la URL de esa versión"
sys="$WORK/s10"; app="$WORK/a10"
build_fixture "$sys" "$app"
: > "$FAKE_LOG"
OUT=$(run_launcher "$app" "$sys" root@servidor --tag v9.9.9 --yes)
check "descarga la versión indicada"                "$(case "$OUT" in *"releases/download/v9.9.9/uninstall.sh"*) echo 1 ;; *) echo 0 ;; esac)"

echo ""
if [ "$FAILS" -eq 0 ]; then
  echo "TODO OK ($OKS comprobaciones)"
  exit 0
fi
echo "$FAILS fallo(s) de $OKS comprobaciones"
exit 1
