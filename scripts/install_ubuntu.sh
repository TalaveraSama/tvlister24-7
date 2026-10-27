#!/usr/bin/env bash
# ==============================================================================
# TVLister 24/7 — Midnight Edition | Instalador Aislado Ubuntu / Debian VPS
# Compatible 100% con servidores que ya tienen XUI.one, Xtream UI, Nginx o Docker
# No modifica paquetes apt existentes, ni MariaDB, ni puertos ocupados.
# ==============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/tvlister24-7}"
RUNTIME_DIR="${APP_DIR}/.runtime"
NODE_DIR="${RUNTIME_DIR}/node"
RUNTIME_BIN="${RUNTIME_DIR}/bin"
SERVICE_NAME="tvlister24-7"
REPO_URL="https://github.com/TalaveraSama/tvlister24-7.git"
FALLBACK_BRANCH="arena/85cc9902-tvlister24-7"
NODE_VERSION="v22.23.4"

echo "============================================================"
echo "  Instalando TVLister 24/7 (Modo Aislado / Coexistencia)    "
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
  echo "      curl, git y tar ya están instalados (se omite apt-get para evitar conflictos de paquetes retenidos)."
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
if [ -x "${NODE_DIR}/bin/node" ]; then
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

export PATH="${RUNTIME_BIN}:${NODE_DIR}/bin:${PATH}"

# 3. Detectar FFmpeg existente (incluyendo /home/xui/bin/ffmpeg) o instalar binario estático
echo "[3/6] Configurando FFmpeg sin tocar librerías del sistema..."
FFMPEG_READY=0

if [ -x "/home/xui/bin/ffmpeg" ]; then
  cat >"${RUNTIME_BIN}/ffmpeg" <<'EOF'
#!/usr/bin/env bash
export LD_LIBRARY_PATH="/home/xui/lib:${LD_LIBRARY_PATH:-}"
exec /home/xui/bin/ffmpeg "$@"
EOF
  chmod +x "${RUNTIME_BIN}/ffmpeg"
  if "${RUNTIME_BIN}/ffmpeg" -version >/dev/null 2>&1; then
    FFMPEG_READY=1
    echo "      Vinculado FFmpeg existente de XUI.one (/home/xui/bin/ffmpeg) en modo solo-lectura."
  else
    rm -f "${RUNTIME_BIN}/ffmpeg"
  fi
fi

if [ "$FFMPEG_READY" -eq 0 ] && command -v ffmpeg >/dev/null 2>&1; then
  SYS_FFMPEG=$(command -v ffmpeg)
  if "$SYS_FFMPEG" -version >/dev/null 2>&1; then
    ln -sf "$SYS_FFMPEG" "${RUNTIME_BIN}/ffmpeg"
    FFMPEG_READY=1
    echo "      FFmpeg del sistema detectado en ${SYS_FFMPEG}."
  fi
fi

if [ "$FFMPEG_READY" -eq 0 ] && command -v xz >/dev/null 2>&1; then
  echo "      Descargando binario estático independiente de FFmpeg..."
  TMP_FF=$(mktemp -d)
  if curl -fsSL --max-time 60 "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${FF_ARCH}-static.tar.xz" -o "${TMP_FF}/ffmpeg.tar.xz"; then
    tar -xJf "${TMP_FF}/ffmpeg.tar.xz" --strip-components=1 -C "$TMP_FF" || true
    if [ -f "${TMP_FF}/ffmpeg" ]; then
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

# 4. Descargar código fuente de TVLister 24/7 preservando .runtime y data
echo "[4/6] Descargando código fuente de TVLister 24/7..."
if [ -f "./package.json" ] && grep -q '"tvlister24-7"' "./package.json" 2>/dev/null; then
  SRC_REAL=$(pwd -P)
  DST_REAL=$(cd "$APP_DIR" && pwd -P)
  if [ "$SRC_REAL" != "$DST_REAL" ]; then
    tar --exclude='./node_modules' --exclude='./dist' --exclude='./data' --exclude='./.runtime' -cf - . | tar -xf - -C "$APP_DIR"
  fi
else
  TMP_CLONE=$(mktemp -d)
  git clone --quiet "$REPO_URL" "$TMP_CLONE"
  if [ ! -f "$TMP_CLONE/package.json" ]; then
    git -C "$TMP_CLONE" checkout --quiet "$FALLBACK_BRANCH"
  else
    # Si la rama arena tiene cambios más recientes que main, usar la rama activa si main aún está vacía
    git -C "$TMP_CLONE" checkout --quiet "$FALLBACK_BRANCH" 2>/dev/null || true
  fi
  tar --exclude='./data' --exclude='./.runtime' -cf - -C "$TMP_CLONE" . | tar -xf - -C "$APP_DIR"
  rm -rf "$TMP_CLONE"
fi

cd "$APP_DIR"

# 5. Compilar aplicación con el Node aislado
echo "[5/6] Instalando dependencias NPM y compilando panel..."
"${NODE_DIR}/bin/npm" install --no-audit --no-fund
"${NODE_DIR}/bin/npm" run build

mkdir -p /var/lib/tvlister24-7/hls /var/lib/tvlister24-7/playlists "$APP_DIR/data"

# 6. Selección automática de puerto libre (sin chocar con XUI.one) + Servicio systemd
echo "[6/6] Verificando puertos libres y activando servicio systemd..."
systemctl stop "${SERVICE_NAME}" >/dev/null 2>&1 || true

if [ -n "${PORT:-}" ]; then
  CANDIDATE_PORTS="$PORT 8095 8895 9080 9095"
elif [ "$XUI_DETECTED" -eq 1 ]; then
  # En servidores con XUI.one preferimos 8095 por defecto para no interferir con 80/8080 de XUI
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

echo "      Puerto libre seleccionado: ${FINAL_PORT}"

SECRET_FILE="$APP_DIR/data/.panel_secret"
if [ -f "$SECRET_FILE" ]; then
  PANEL_SECRET=$(cat "$SECRET_FILE")
else
  PANEL_SECRET=$(head -c 32 /dev/urandom | sha256sum | awk '{print $1}')
  echo "$PANEL_SECRET" > "$SECRET_FILE"
  chmod 600 "$SECRET_FILE"
fi

cat >/etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=TVLister 24/7 Midnight OTT/VOD Streaming Panel
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
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1
systemctl restart "${SERVICE_NAME}"

# Si UFW está activo, abrir el puerto elegido
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "${FINAL_PORT}/tcp" >/dev/null 2>&1 || true
fi

sleep 2
if curl -fsS "http://127.0.0.1:${FINAL_PORT}/" >/dev/null 2>&1; then
  STATUS_MSG="✅ Servicio respondiendo correctamente en el puerto ${FINAL_PORT}"
else
  STATUS_MSG="⚠️ Servicio iniciado; revisa logs con: journalctl -u ${SERVICE_NAME} -n 30"
fi

SERVER_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -n1)
if [ -z "$SERVER_IP" ]; then
  SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
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
echo "  🔑 Contraseña inicial  : admin123"
echo "  📺 Lista M3U Demo      : http://${SERVER_IP}:${FINAL_PORT}/get.php?username=demo&password=demo123&type=m3u_plus&output=hls"
echo "  📅 Guía EPG XMLTV      : http://${SERVER_IP}:${FINAL_PORT}/xmltv.php?username=demo&password=demo123"
if [ "$XUI_DETECTED" -eq 1 ]; then
  echo "------------------------------------------------------------"
  echo "  💡 Coexistencia con XUI.one:"
  echo "     - XUI.one sigue intacto en sus puertos originales."
  echo "     - Puedes importar tus canales desde XUI.one entrando a:"
  echo "       Canales en Vivo -> botón 'Importar M3U / XUI.one'."
fi
echo "============================================================"
