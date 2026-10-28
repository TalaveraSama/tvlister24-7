#!/usr/bin/env bash
# ==============================================================================
# Panel TVLister 24/7 — Instalador Standalone de Nodo Cabecera Remoto (Astra / ProLiant)
# Cero uso de apt-get: descarga Node.js 22 LTS + FFmpeg estático + Agente Headend.
# Uso:
#   curl -fsSL "http://IP_PANEL_NUBE:8095/api/headend/install.sh?token=hdn_xxx&port=8097" | sudo bash
# ==============================================================================
set -euo pipefail

MASTER_URL="${MASTER_URL:-}"
HEADEND_TOKEN="${HEADEND_TOKEN:-}"
HEADEND_PORT="${HEADEND_PORT:-8097}"
HEADEND_DIR="/opt/tvlister-headend"
RUNTIME_BIN="${HEADEND_DIR}/.runtime/bin"
NODE_VERSION="v22.23.4"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --master) MASTER_URL="$2"; shift 2 ;;
    --token)  HEADEND_TOKEN="$2"; shift 2 ;;
    --port)   HEADEND_PORT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [[ -z "$MASTER_URL" || -z "$HEADEND_TOKEN" ]]; then
  echo "Uso: bash install_headend_node.sh --master <URL_PANEL_NUBE> --token <HEADEND_TOKEN> [--port 8097]"
  exit 1
fi

ARCH_RAW="$(uname -m)"
case "$ARCH_RAW" in
  x86_64|amd64) NODE_ARCH="x64"; FF_ARCH="amd64" ;;
  aarch64|arm64) NODE_ARCH="arm64"; FF_ARCH="arm64" ;;
  *) echo "Arquitectura no soportada: $ARCH_RAW"; exit 1 ;;
esac

mkdir -p "$RUNTIME_BIN"
NODE_BIN="${HEADEND_DIR}/.runtime/node/bin/node"

if [[ ! -x "$NODE_BIN" ]]; then
  echo "[1/4] Descargando Node.js ${NODE_VERSION} aislado..."
  TAR_URL="https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz"
  curl -fsSL "$TAR_URL" -o /tmp/tvlister_headend_node.tar.gz
  rm -rf "${HEADEND_DIR}/.runtime/node"
  mkdir -p "${HEADEND_DIR}/.runtime/node"
  tar -xzf /tmp/tvlister_headend_node.tar.gz -C "${HEADEND_DIR}/.runtime/node" --strip-components=1
  rm -f /tmp/tvlister_headend_node.tar.gz
fi

FFMPEG_READY=0
if [[ -x "${RUNTIME_BIN}/ffmpeg" ]] && "${RUNTIME_BIN}/ffmpeg" -version >/dev/null 2>&1; then
  FFMPEG_READY=1
fi

if [[ "$FFMPEG_READY" -eq 0 ]]; then
  for SYS_FF in "/usr/local/bin/ffmpeg" "/usr/bin/ffmpeg"; do
    if [[ -f "$SYS_FF" && -x "$SYS_FF" ]] && "$SYS_FF" -version >/dev/null 2>&1; then
      ln -sf "$SYS_FF" "${RUNTIME_BIN}/ffmpeg"
      FFMPEG_READY=1
      echo "[2/4] FFmpeg del sistema vinculado (${SYS_FF})."
      break
    fi
  done
fi

if [[ "$FFMPEG_READY" -eq 0 ]]; then
  GH_FF_ARCH="x64"
  if [[ "$FF_ARCH" == "arm64" ]]; then GH_FF_ARCH="arm64"; fi
  echo "[2/4] Descargando FFmpeg 6.1 estático aislado (${GH_FF_ARCH})..."
  if curl -fsSL --retry 3 --max-time 90 "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-${GH_FF_ARCH}.gz" | gunzip > "${RUNTIME_BIN}/ffmpeg" 2>/dev/null; then
    chmod +x "${RUNTIME_BIN}/ffmpeg"
    if "${RUNTIME_BIN}/ffmpeg" -version >/dev/null 2>&1; then
      FFMPEG_READY=1
    else
      rm -f "${RUNTIME_BIN}/ffmpeg"
    fi
  fi
fi

if [[ "$FFMPEG_READY" -eq 0 ]] && command -v xz >/dev/null 2>&1; then
  echo "[2/4] Descargando FFmpeg estático alternativo (${FF_ARCH})..."
  TMP_FF="$(mktemp -d)"
  if curl -fsSL --max-time 90 "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${FF_ARCH}-static.tar.xz" -o "${TMP_FF}/ffmpeg.tar.xz"; then
    tar -xJf "${TMP_FF}/ffmpeg.tar.xz" --strip-components=1 -C "$TMP_FF" || true
    if [[ -f "${TMP_FF}/ffmpeg" ]]; then
      cp "${TMP_FF}/ffmpeg" "${RUNTIME_BIN}/ffmpeg"
      chmod +x "${RUNTIME_BIN}/ffmpeg"
      FFMPEG_READY=1
    fi
  fi
  rm -rf "$TMP_FF"
fi

if [[ "$FFMPEG_READY" -eq 0 ]]; then
  NPM_FF_ARCH="x64"
  if [[ "$FF_ARCH" == "arm64" ]]; then NPM_FF_ARCH="arm64"; fi
  echo "[2/4] Descargando FFmpeg estático vía espejo CDN..."
  if curl -fsSL --max-time 60 "https://registry.npmjs.org/@ffmpeg-installer/linux-${NPM_FF_ARCH}/-/linux-${NPM_FF_ARCH}-4.1.0.tgz" | tar -xz -C "${RUNTIME_BIN}" --strip-components=1 package/ffmpeg 2>/dev/null; then
    chmod +x "${RUNTIME_BIN}/ffmpeg"
    if "${RUNTIME_BIN}/ffmpeg" -version >/dev/null 2>&1; then
      FFMPEG_READY=1
    fi
  fi
fi

echo "[3/4] Descargando Agente Cabecera desde Panel Nube (${MASTER_URL})..."
curl -fsSL "${MASTER_URL%/}/api/headend/agent.js" -o "${HEADEND_DIR}/headend-agent.js"
chmod +x "${HEADEND_DIR}/headend-agent.js"

echo "[4/4] Configurando servicio systemd tvlister-headend..."
cat > /etc/systemd/system/tvlister-headend.service <<EOF
[Unit]
Description=Panel TVLister 24/7 — Nodo Cabecera Remoto (Astra / Transcoder)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${HEADEND_DIR}
Environment=MASTER_URL=${MASTER_URL%/}
Environment=HEADEND_TOKEN=${HEADEND_TOKEN}
Environment=HEADEND_PORT=${HEADEND_PORT}
Environment=FFMPEG_PATH=${RUNTIME_BIN}/ffmpeg
ExecStart=${NODE_BIN} ${HEADEND_DIR}/headend-agent.js
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable tvlister-headend
systemctl restart tvlister-headend

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "${HEADEND_PORT}/tcp" >/dev/null 2>&1 || true
fi

echo "======================================================================"
echo "✅ Nodo Cabecera Remoto (Astra / Transcoder) ACTIVO en puerto ${HEADEND_PORT}"
echo "🔗 Enlazado al Panel Nube: ${MASTER_URL}"
echo "💾 Segmentos HLS en RAMDisk: /dev/shm/tvlister_headend_hls"
echo "📊 Ver estado: systemctl status tvlister-headend --no-pager"
echo "======================================================================"
