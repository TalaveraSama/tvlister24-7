#!/usr/bin/env bash
# ==============================================================================
# TVLister 24/7 — Midnight Edition | Instalador Automático Ubuntu / Debian VPS
# 100% Código Abierto y Auditable (Node.js 22 LTS + FFmpeg + SQLite + systemd)
# ==============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/tvlister24-7}"
SERVICE_NAME="tvlister24-7"
PORT="${PORT:-8080}"
REPO_URL="https://github.com/TalaveraSama/tvlister24-7.git"
FALLBACK_BRANCH="arena/85cc9902-tvlister24-7"

echo "============================================================"
echo "  Instalando TVLister 24/7 (Midnight OTT/VOD & 24/7 Panel)  "
echo "============================================================"

if [ "$(id -u)" -ne 0 ]; then
  echo "[ERROR] Debes ejecutar este instalador como root (usa: sudo bash scripts/install_ubuntu.sh)"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "[1/6] Actualizando paquetes del sistema e instalando FFmpeg..."
apt-get update -y
apt-get install -y curl git ca-certificates gnupg ffmpeg sqlite3 tar

echo "[2/6] Verificando versión de Node.js (se requiere Node.js >= 22.5)..."
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v | sed 's/^v//')
  NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
  NODE_MINOR=$(echo "$NODE_VER" | cut -d. -f2)
  if [ "$NODE_MAJOR" -gt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -ge 5 ]; }; then
    NEED_NODE=0
    echo "      Node.js v${NODE_VER} detectado correctamente."
  fi
fi

if [ "$NEED_NODE" -eq 1 ]; then
  echo "      Instalando Node.js 22 LTS oficial desde NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "[3/6] Preparando código fuente en ${APP_DIR}..."
mkdir -p "$APP_DIR"

if [ -f "./package.json" ] && grep -q '"tvlister24-7"' "./package.json" 2>/dev/null; then
  SRC_REAL=$(pwd -P)
  DST_REAL=$(cd "$APP_DIR" && pwd -P)
  if [ "$SRC_REAL" != "$DST_REAL" ]; then
    tar --exclude='./node_modules' --exclude='./dist' --exclude='./data' -cf - . | tar -xf - -C "$APP_DIR"
  fi
else
  if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" fetch --all --prune
  else
    TMP_CLONE=$(mktemp -d)
    git clone "$REPO_URL" "$TMP_CLONE"
    if [ ! -f "$TMP_CLONE/package.json" ]; then
      git -C "$TMP_CLONE" checkout "$FALLBACK_BRANCH"
    fi
    tar --exclude='./data' -cf - -C "$TMP_CLONE" . | tar -xf - -C "$APP_DIR"
    rm -rf "$TMP_CLONE"
  fi

  if [ ! -f "$APP_DIR/package.json" ]; then
    git -C "$APP_DIR" checkout "$FALLBACK_BRANCH"
  fi
fi

cd "$APP_DIR"

echo "[4/6] Instalando dependencias NPM y compilando interfaz de producción..."
npm install
npm run build

mkdir -p /var/lib/tvlister24-7/hls /var/lib/tvlister24-7/playlists "$APP_DIR/data"

echo "[5/6] Configurando servicio systemd (${SERVICE_NAME}.service)..."
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
Environment=PORT=${PORT}
Environment=PANEL_SECRET=${PANEL_SECRET}
ExecStart=/usr/bin/env node --no-warnings server/index.js
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

# Abrir puerto en UFW únicamente si UFW ya está activo
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow "${PORT}/tcp" >/dev/null 2>&1 || true
fi

echo "[6/6] Verificando arranque del servidor..."
sleep 2
SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -z "$SERVER_IP" ]; then
  SERVER_IP="TU_IP_SERVIDOR"
fi

echo ""
echo "============================================================"
echo "  ✅ TVLister 24/7 instalado y ejecutándose correctamente   "
echo "============================================================"
echo "  🌐 URL del Panel & WebTV : http://${SERVER_IP}:${PORT}"
echo "  👤 Usuario Admin         : admin"
echo "  🔑 Contraseña inicial    : admin123"
echo "  📺 Lista M3U Demo        : http://${SERVER_IP}:${PORT}/get.php?username=demo&password=demo123&type=m3u_plus&output=hls"
echo "  📅 Guía EPG XMLTV        : http://${SERVER_IP}:${PORT}/xmltv.php?username=demo&password=demo123"
echo "------------------------------------------------------------"
echo "  Comandos útiles:"
echo "    Ver estado : sudo systemctl status ${SERVICE_NAME}"
echo "    Ver logs   : sudo journalctl -u ${SERVICE_NAME} -f"
echo "    Reiniciar  : sudo systemctl restart ${SERVICE_NAME}"
echo "============================================================"
