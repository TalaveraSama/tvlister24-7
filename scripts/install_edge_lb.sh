#!/usr/bin/env bash
# ==============================================================================
# TVLister 24/7 — Instalador Standalone de Nodo Edge Load Balancer (Sin apt)
# Uso:
#   bash install_edge_lb.sh --master http://69.30.212.194:8095 --token edge_xxx --port 8096
# ==============================================================================
set -euo pipefail

MASTER_URL=""
EDGE_TOKEN=""
EDGE_PORT="8096"
EDGE_DIR="/opt/tvlister-edge"
NODE_VERSION="v22.23.4"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --master) MASTER_URL="$2"; shift 2 ;;
    --token)  EDGE_TOKEN="$2"; shift 2 ;;
    --port)   EDGE_PORT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [[ -z "$MASTER_URL" || -z "$EDGE_TOKEN" ]]; then
  echo "Uso: bash install_edge_lb.sh --master <URL_MASTER> --token <API_TOKEN> [--port 8096]"
  exit 1
fi

ARCH_RAW="$(uname -m)"
case "$ARCH_RAW" in
  x86_64|amd64) NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *) echo "Arquitectura no soportada: $ARCH_RAW"; exit 1 ;;
esac

mkdir -p "$EDGE_DIR/.runtime"
NODE_BIN="$EDGE_DIR/.runtime/node/bin/node"

if [[ ! -x "$NODE_BIN" ]]; then
  echo "[1/3] Descargando Node.js ${NODE_VERSION} aislado..."
  TAR_URL="https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz"
  curl -fsSL "$TAR_URL" -o /tmp/tvlister_edge_node.tar.gz
  rm -rf "$EDGE_DIR/.runtime/node"
  mkdir -p "$EDGE_DIR/.runtime/node"
  tar -xzf /tmp/tvlister_edge_node.tar.gz -C "$EDGE_DIR/.runtime/node" --strip-components=1
  rm -f /tmp/tvlister_edge_node.tar.gz
fi

echo "[2/3] Descargando agente Edge desde Master (${MASTER_URL})..."
curl -fsSL "${MASTER_URL}/api/lb/edge-agent.js" -o "$EDGE_DIR/edge-agent.js"
chmod +x "$EDGE_DIR/edge-agent.js"

echo "[3/3] Configurando servicio systemd tvlister-edge..."
cat > /etc/systemd/system/tvlister-edge.service <<EOF
[Unit]
Description=TVLister 24/7 Edge Load Balancer Relay Agent
After=network.target

[Service]
Type=simple
WorkingDirectory=${EDGE_DIR}
Environment=MASTER_URL=${MASTER_URL}
Environment=EDGE_API_TOKEN=${EDGE_TOKEN}
Environment=EDGE_PORT=${EDGE_PORT}
ExecStart=${NODE_BIN} ${EDGE_DIR}/edge-agent.js
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable tvlister-edge
systemctl restart tvlister-edge

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "${EDGE_PORT}/tcp" >/dev/null 2>&1 || true
fi

echo "================================================================="
echo "✅ Nodo Edge Load Balancer activo en puerto ${EDGE_PORT}"
echo "🔗 Master vinculado: ${MASTER_URL}"
echo "📊 Estado: systemctl status tvlister-edge --no-pager"
echo "================================================================="
