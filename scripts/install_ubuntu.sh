#!/usr/bin/env bash
# ==============================================================================
# TVLister 24/7 Panel | Instalador Aislado Ubuntu / Debian VPS
# Compatible 100% con servidores que ya tienen XUI.one, Xtream UI, Nginx o Docker
# Idempotente: puede ejecutarse múltiples veces para instalar o actualizar sin perder datos.
# ==============================================================================
set -euo pipefail
trap 'case "${0:-}" in /tmp/tvlister_update.*) rm -f "$0" ;; esac' EXIT

APP_DIR="${APP_DIR:-/opt/tvlister24-7}"
RUNTIME_DIR="${APP_DIR}/.runtime"
NODE_DIR="${RUNTIME_DIR}/node"
RUNTIME_BIN="${RUNTIME_DIR}/bin"
SERVICE_NAME="tvlister24-7"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
REPO_URL="https://github.com/TalaveraSama/tvlister24-7.git"
FALLBACK_BRANCH="arena/85cc9902-tvlister24-7"
NODE_VERSION="v22.23.4"

echo "============================================================"
echo "  Instalando / Actualizando TVLister 24/7 (Modo Aislado)    "
echo "============================================================"

if [ "$(id -u)" -ne 0 ]; then
  echo "[ERROR] Ejecuta este instalador como root (sudo bash)."
  exit 1
fi

XUI_DETECTED=0
if [ -d "/home/xui" ] || [ -f "/etc/systemd/system/xui.service" ]; then
  XUI_DETECTED=1
  echo "[INFO] Panel XUI.one detectado en este servidor."
  echo "       -> Modo seguro activado: NO se tocarán paquetes apt, MariaDB, Nginx ni puertos de XUI.one."
fi

# 1. Solo usar apt si faltan herramientas básicas (curl, git, tar)
echo "[1/6] Verificando herramientas base (curl, git, tar)..."
if ! command -v curl >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y || true
  apt-get install -y curl git tar ca-certificates
else
  echo "      curl, git y tar ya están instalados (se omite apt-get)."
fi

# 2. Instalar Node.js 22 LTS aislado en /opt/tvlister24-7/.runtime/node
echo "[2/6] Configurando motor aislado Node.js ${NODE_VERSION} (con SQLite integrado)..."
mkdir -p "$NODE_DIR" "$RUNTIME_BIN" "$APP_DIR/data"

ARCH_RAW=$(uname -m)
case "$ARCH_RAW" in
  x86_64|amd64) NODE_ARCH="x64"; FF_ARCH="amd64" ;;
  aarch64|arm64) NODE_ARCH="arm64"; FF_ARCH="arm64" ;;
  *) echo "[ERROR] Arquitectura de CPU no soportada: ${ARCH_RAW}"; exit 1 ;;
esac

NEED_STANDALONE_NODE=1
if [ -f "${NODE_DIR}/bin/node" ] && [ -x "${NODE_DIR}/bin/node" ]; then
  CUR_VER=$("${NODE_DIR}/bin/node" -v | sed 's/^v//')
  CUR_MAJ=$(echo "$CUR_VER" | cut -d. -f1)
  CUR_MIN=$(echo "$CUR_VER" | cut -d. -f2)
  if [ "$CUR_MAJ" -gt 22 ] || { [ "$CUR_MAJ" -eq 22 ] && [ "$CUR_MIN" -ge 5 ]; }; then
    NEED_STANDALONE_NODE=0
    echo "      Node.js aislado v${CUR_VER} ya disponible."
  fi
fi

if [ "$NEED_STANDALONE_NODE" -eq 1 ]; then
  NODE_TARBALL="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz"
  NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_TARBALL}"
  TMP_NODE=$(mktemp -d)
  echo "      Descargando ${NODE_TARBALL} desde nodejs.org..."
  curl -fL --retry 3 "$NODE_URL" -o "${TMP_NODE}/${NODE_TARBALL}"
  rm -rf "${NODE_DIR:?}/"*
  tar -xzf "${TMP_NODE}/${NODE_TARBALL}" --strip-components=1 -C "$NODE_DIR"
  rm -rf "$TMP_NODE"
  echo "      Node.js $("${NODE_DIR}/bin/node" -v) instalado en ${NODE_DIR}."
fi

# 3. Detectar FFmpeg de forma 100% idempotente (antes de modificar PATH)
echo "[3/6] Configurando FFmpeg sin tocar librerías del sistema..."
FFMPEG_READY=0

# Si ya tenemos un binario/wrapper válido en RUNTIME_BIN de una instalación previa, reutilizarlo
if [ -f "${RUNTIME_BIN}/ffmpeg" ] && [ -x "${RUNTIME_BIN}/ffmpeg" ]; then
  if "${RUNTIME_BIN}/ffmpeg" -version >/dev/null 2>&1; then
    FFMPEG_READY=1
    echo "      FFmpeg aislado ya configurado y operativo en ${RUNTIME_BIN}/ffmpeg."
  else
    rm -f "${RUNTIME_BIN}/ffmpeg"
  fi
fi

# Probar las compilaciones de XUI.one. XUI instala 4.4 / 4.3 / 4.0 en
# /home/xui/bin/ffmpeg_bin/<versión>/ffmpeg (más las rutas antiguas bin/ffmpeg).
# Se genera un wrapper AUTO-REPARABLE: revalida en cada ejecución, así una
# actualización de XUI.one (que cambia de versión) no deja el canal sin FFmpeg.
XUI_FF_FOUND=""
for XUI_FF in \
  "/home/xui/bin/ffmpeg_bin/4.4/ffmpeg" \
  "/home/xui/bin/ffmpeg_bin/4.3/ffmpeg" \
  "/home/xui/bin/ffmpeg_bin/4.0/ffmpeg" \
  "/home/xui/bin/ffmpeg/ffmpeg"; do
  if [ -f "$XUI_FF" ] && [ -x "$XUI_FF" ] && "$XUI_FF" -version >/dev/null 2>&1; then
    XUI_FF_FOUND="$XUI_FF"
    break
  fi
done

if [ "$FFMPEG_READY" -eq 0 ] && [ -n "$XUI_FF_FOUND" ]; then
  rm -f "${RUNTIME_BIN}/ffmpeg"
  cat >"${RUNTIME_BIN}/ffmpeg" <<'EOF'
#!/usr/bin/env bash
# Wrapper FFmpeg de XUI.one generado por TVLister 24/7.
# Revalida en cada arranque: si XUI.one cambia de versión, sigue funcionando.
for FF in \
  /home/xui/bin/ffmpeg_bin/4.4/ffmpeg \
  /home/xui/bin/ffmpeg_bin/4.3/ffmpeg \
  /home/xui/bin/ffmpeg_bin/4.0/ffmpeg \
  /home/xui/bin/ffmpeg/ffmpeg; do
  if [ -x "$FF" ]; then
    export LD_LIBRARY_PATH="$(dirname "$FF"):/home/xui/bin/ffmpeg:/home/xui/lib:${LD_LIBRARY_PATH:-}"
    exec "$FF" "$@"
  fi
done
echo "TVLister: XUI.one no tiene un FFmpeg ejecutable. Ejecuta: tvlister-admin ffmpeg install" >&2
exit 127
EOF
  chmod +x "${RUNTIME_BIN}/ffmpeg"
  if "${RUNTIME_BIN}/ffmpeg" -version >/dev/null 2>&1; then
    FFMPEG_READY=1
    echo "      Vinculado FFmpeg de XUI.one (${XUI_FF_FOUND}) en modo solo-lectura (wrapper auto-reparable)."
  else
    rm -f "${RUNTIME_BIN}/ffmpeg"
  fi
fi

# Probar FFmpeg del sistema (evitando apuntarse a sí mismo)
if [ "$FFMPEG_READY" -eq 0 ]; then
  for SYS_FF in "/usr/local/bin/ffmpeg" "/usr/bin/ffmpeg"; do
    if [ -f "$SYS_FF" ] && [ -x "$SYS_FF" ] && [ "$SYS_FF" != "${RUNTIME_BIN}/ffmpeg" ]; then
      if "$SYS_FF" -version >/dev/null 2>&1; then
        rm -f "${RUNTIME_BIN}/ffmpeg"
        ln -s "$SYS_FF" "${RUNTIME_BIN}/ffmpeg"
        FFMPEG_READY=1
        echo "      FFmpeg del sistema detectado en ${SYS_FF}."
        break
      fi
    fi
  done
fi

# Si no existe ninguno, descargar binario estático independiente
if [ "$FFMPEG_READY" -eq 0 ] && command -v xz >/dev/null 2>&1; then
  echo "      Descargando binario estático independiente de FFmpeg..."
  TMP_FF=$(mktemp -d)
  if curl -fsSL --max-time 60 "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${FF_ARCH}-static.tar.xz" -o "${TMP_FF}/ffmpeg.tar.xz"; then
    tar -xJf "${TMP_FF}/ffmpeg.tar.xz" --strip-components=1 -C "$TMP_FF" || true
    if [ -f "${TMP_FF}/ffmpeg" ]; then
      rm -f "${RUNTIME_BIN}/ffmpeg"
      cp "${TMP_FF}/ffmpeg" "${RUNTIME_BIN}/ffmpeg"
      chmod +x "${RUNTIME_BIN}/ffmpeg"
      FFMPEG_READY=1
      echo "      FFmpeg estático instalado en ${RUNTIME_BIN}/ffmpeg."
    fi
  fi
  rm -rf "$TMP_FF"
fi

if [ "$FFMPEG_READY" -eq 0 ]; then
  echo "      [AVISO] No se encontró FFmpeg; el panel funcionará en modo Direct Stream / Reloj 24-7 Virtual."
fi

# Instalar binario estático aislado MediaMTX v1.21.3 para ingesta RTMP/SRT/RTSP + CMAF fMP4 (Zero-Apt)
if [ ! -x "${RUNTIME_BIN}/mediamtx" ]; then
  MTX_ARCH="${FF_ARCH}"
  TMP_MTX=$(mktemp -d)
  if curl -fsSL --max-time 45 "https://github.com/bluenviron/mediamtx/releases/download/v1.21.3/mediamtx_v1.21.3_linux_${MTX_ARCH}.tar.gz" -o "${TMP_MTX}/mtx.tar.gz" 2>/dev/null; then
    tar -xzf "${TMP_MTX}/mtx.tar.gz" -C "${RUNTIME_BIN}" mediamtx 2>/dev/null || true
    chmod +x "${RUNTIME_BIN}/mediamtx" 2>/dev/null || true
    if [ -x "${RUNTIME_BIN}/mediamtx" ]; then
      echo "      Motor RTMP/SRT/RTSP (MediaMTX v1.21.3) instalado en ${RUNTIME_BIN}/mediamtx."
    fi
  fi
  rm -rf "$TMP_MTX"
fi

export PATH="${RUNTIME_BIN}:${NODE_DIR}/bin:${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"

# 4. Descargar código fuente actualizado preservando .runtime y data
#    SIEMPRE se clona desde GitHub para no reutilizar código viejo; la copia local
#    sólo se usa como respaldo si no hay salida a internet.
echo "[4/6] Descargando código fuente actualizado de TVLister 24/7..."
INSTALL_OK=0
TMP_CLONE=$(mktemp -d)
if git clone --quiet --depth 1 --branch "$FALLBACK_BRANCH" "$REPO_URL" "$TMP_CLONE" 2>/dev/null \
  || git clone --quiet --depth 1 "$REPO_URL" "$TMP_CLONE" 2>/dev/null; then
  if [ -f "${TMP_CLONE}/package.json" ] && grep -q '"tvlister24-7"' "${TMP_CLONE}/package.json" 2>/dev/null; then
    tar --exclude='./.git' --exclude='./data' --exclude='./.runtime' --exclude='./node_modules' -cf - -C "$TMP_CLONE" . | tar -xf - -C "$APP_DIR"
    echo "      Código sincronizado desde GitHub (rama ${FALLBACK_BRANCH})."
    INSTALL_OK=1
  fi
fi
rm -rf "$TMP_CLONE"

if [ "$INSTALL_OK" -ne 1 ]; then
  SRC_REAL=$(pwd -P)
  DST_REAL=$(cd "$APP_DIR" && pwd -P)
  if [ -f "./package.json" ] && grep -q '"tvlister24-7"' "./package.json" 2>/dev/null && [ "$SRC_REAL" != "$DST_REAL" ]; then
    echo "      [AVISO] Sin acceso a GitHub: usando el código del directorio actual."
    tar --exclude='./node_modules' --exclude='./dist' --exclude='./data' --exclude='./.runtime' -cf - . | tar -xf - -C "$APP_DIR"
  else
    echo "      [AVISO] No se pudo descargar el código (sin internet). Se reutiliza el código instalado."
  fi
fi

# Instalar atómicamente el comando CLI tvlister-admin (nuevo inodo con mv para no afectar procesos en curso)
if [ -f "${APP_DIR}/scripts/tvlister-admin.sh" ]; then
  cp "${APP_DIR}/scripts/tvlister-admin.sh" /usr/local/bin/tvlister-admin.tmp
  chmod 0755 /usr/local/bin/tvlister-admin.tmp
  mv -f /usr/local/bin/tvlister-admin.tmp /usr/local/bin/tvlister-admin
  ln -sf /usr/local/bin/tvlister-admin /usr/bin/tvlister-admin
fi

cd "$APP_DIR"

# 5. Compilar aplicación con el Node aislado
echo "[5/6] Instalando dependencias NPM y compilando panel de producción..."
"${NODE_DIR}/bin/npm" install --include=dev --no-audit --no-fund
"${NODE_DIR}/bin/npm" run build

mkdir -p /var/lib/tvlister24-7/hls /var/lib/tvlister24-7/playlists "$APP_DIR/data"

# 6. Selección automática de puerto libre (conservando puerto previo si ya existía) + systemd
echo "[6/6] Configurando puerto libre y servicio systemd..."
EXISTING_PORT=""
if [ -f "$SERVICE_FILE" ]; then
  EXISTING_PORT=$(grep -E '^Environment=PORT=' "$SERVICE_FILE" 2>/dev/null | head -n1 | cut -d= -f3 || true)
fi

systemctl stop "${SERVICE_NAME}" >/dev/null 2>&1 || true
pkill -f "/opt/tvlister24-7.*server/index.js" >/dev/null 2>&1 || true
sleep 1

if [ -n "${PORT:-}" ]; then
  CANDIDATE_PORTS="$PORT 8095 8895 9080 9095"
elif [ -n "$EXISTING_PORT" ]; then
  CANDIDATE_PORTS="$EXISTING_PORT 8095 8895 9080 9095"
elif [ "$XUI_DETECTED" -eq 1 ]; then
  CANDIDATE_PORTS="8095 8895 9080 9095 8080"
else
  CANDIDATE_PORTS="8080 8095 8895 9080 9095"
fi

FINAL_PORT=$("${NODE_DIR}/bin/node" -e '
const net = require("node:net");
const ports = process.argv[1].split(/\s+/).map(Number).filter(Boolean);
function check(idx) {
  if (idx >= ports.length) { console.log(8095); process.exit(0); }
  const p = ports[idx];
  const srv = net.createServer();
  srv.once("error", () => check(idx + 1));
  srv.once("listening", () => srv.close(() => { console.log(p); process.exit(0); }));
  srv.listen(p, "0.0.0.0");
}
check(0);
' "$CANDIDATE_PORTS")

echo "      Puerto activo asignado: ${FINAL_PORT}"

SECRET_FILE="$APP_DIR/data/.panel_secret"
if [ -f "$SECRET_FILE" ]; then
  PANEL_SECRET=$(cat "$SECRET_FILE")
else
  PANEL_SECRET=$(head -c 32 /dev/urandom | sha256sum | awk '{print $1}')
  echo "$PANEL_SECRET" > "$SECRET_FILE"
  chmod 600 "$SECRET_FILE"
fi

cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=TVLister 24/7 IPTV/OTT/VOD Streaming Panel
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=PORT=${FINAL_PORT}
Environment=PANEL_SECRET=${PANEL_SECRET}
Environment=PATH=${RUNTIME_BIN}:${NODE_DIR}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=FFMPEG_PATH=${RUNTIME_BIN}/ffmpeg
ExecStart=${NODE_DIR}/bin/node --no-warnings server/index.js
Restart=always
RestartSec=3
LimitNOFILE=524288
TasksMax=infinity

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1
systemctl restart "${SERVICE_NAME}"

# Si UFW está activo, abrir el puerto del panel y los puertos de ingesta RTMP/SRT/RTSP
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "${FINAL_PORT}/tcp" >/dev/null 2>&1 || true
  ufw allow 1935/tcp >/dev/null 2>&1 || true
  ufw allow 19350/tcp >/dev/null 2>&1 || true
  ufw allow 8554/tcp >/dev/null 2>&1 || true
  ufw allow 8890/udp >/dev/null 2>&1 || true
fi

# Asegurar que iptables permita tráfico entrante al puerto del panel e ingesta en vivo
if command -v iptables >/dev/null 2>&1; then
  for TCP_P in "${FINAL_PORT}" 1935 19350 8554; do
    iptables -C INPUT -p tcp --dport "${TCP_P}" -j ACCEPT 2>/dev/null || \
      iptables -I INPUT 1 -p tcp --dport "${TCP_P}" -j ACCEPT 2>/dev/null || true
  done
  iptables -C INPUT -p udp --dport 8890 -j ACCEPT 2>/dev/null || \
    iptables -I INPUT 1 -p udp --dport 8890 -j ACCEPT 2>/dev/null || true
fi

sleep 2
if curl -fsS "http://127.0.0.1:${FINAL_PORT}/api/health" >/dev/null 2>&1; then
  STATUS_MSG="✅ Producción activa y verificada (/api/health OK) en el puerto ${FINAL_PORT}"
else
  STATUS_MSG="⚠️ Servicio iniciado; revisa logs con: journalctl -u ${SERVICE_NAME} -n 30"
fi

SERVER_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -n1 || true)
if [ -z "$SERVER_IP" ]; then
  SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
fi
if [ -z "$SERVER_IP" ]; then
  SERVER_IP="TU_IP_SERVIDOR"
fi

echo ""
echo "============================================================"
echo "  ${STATUS_MSG}"
echo "============================================================"
echo "  🌐 Panel Admin & WebTV : http://${SERVER_IP}:${FINAL_PORT}"
echo "  👤 Usuario Admin       : admin"
echo "  🛠️  Consola SysAdmin    : tvlister-admin"
echo "  🔑 Cambiar clave Admin : tvlister-admin reset-admin TU_NUEVA_CLAVE"
echo "  📥 Importar BD XUI.one : tvlister-admin import-xui"
echo "  🩺 Auditoría Producción: tvlister-admin doctor"
echo "============================================================"
