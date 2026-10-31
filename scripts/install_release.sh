#!/usr/bin/env bash
# ==============================================================================
# TVLister 24/7 — Instalador desde RELEASE publicado en GitHub
# ------------------------------------------------------------------------------
# Descarga el paquete oficial (tarball con checksum) y ejecuta el instalador
# aislado que ya conoces (scripts/install_ubuntu.sh), sin clonar ramas de git.
#
# Uso normal (servidor nuevo o existente, como root):
#
#   curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/latest/download/install.sh | bash
#
# Fijando una versión concreta:
#
#   curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/download/v2.3.0/install.sh \
#     | bash -s -- --tag v2.3.0 --port 8095
#
# Opciones:
#   --tag <vX.Y.Z>   Instala una versión exacta (por defecto: la última publicada)
#   --port <n>       Puerto del panel (por defecto: 8095 si está libre, si no automático)
#   --dir <ruta>     Carpeta de instalación (por defecto /opt/tvlister24-7)
#   --no-verify      No verificar el SHA256 del paquete (no recomendado)
#   --help           Esta ayuda
#
# Variables de entorno equivalentes: TVLISTER_VERSION, PORT, APP_DIR
# ==============================================================================
set -euo pipefail

REPO="TalaveraSama/tvlister24-7"
API="https://api.github.com/repos/${REPO}/releases"
DL="https://github.com/${REPO}/releases/download"

TAG="${TVLISTER_VERSION:-latest}"
PORT_ARG="${PORT:-}"
APP_DIR="${APP_DIR:-/opt/tvlister24-7}"
VERIFY=1
TMP_DIR=""

log()  { printf '[TVLister] %s\n' "$*"; }
fail() { printf '[TVLister][ERROR] %s\n' "$*" >&2; exit 1; }
cleanup() {
  if [ -n "${TMP_DIR:-}" ]; then rm -rf "$TMP_DIR"; fi
  return 0
}
trap cleanup EXIT

while [ $# -gt 0 ]; do
  case "$1" in
    --tag|--version) TAG="${2:-}"; shift 2 ;;
    --port)          PORT_ARG="${2:-}"; shift 2 ;;
    --dir|--path)    APP_DIR="${2:-}"; shift 2 ;;
    --no-verify)     VERIFY=0; shift ;;
    -h|--help)
      cat <<'USAGE'
TVLister 24/7 — instalador desde release

  curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/latest/download/install.sh | sudo bash
  curl -fsSL .../releases/download/v2.3.0/install.sh | sudo bash -s -- --tag v2.3.0 --port 8095

Opciones:
  --tag <vX.Y.Z>   Instala una versión exacta (por defecto: la última publicada)
  --port <n>       Puerto del panel (por defecto: 8095 si está libre; si no, automático)
  --dir <ruta>     Carpeta de instalación (por defecto /opt/tvlister24-7)
  --no-verify      No verificar el SHA256 del paquete (no recomendado)
  --help           Esta ayuda
USAGE
      exit 0
      ;;
    *) fail "Opción desconocida: $1 (usa --help)" ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  fail "Ejecuta como root: curl -fsSL <install.sh> | sudo bash"
fi

if ! command -v curl >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y >/dev/null 2>&1 || true
  apt-get install -y curl ca-certificates >/dev/null 2>&1 || true
  command -v curl >/dev/null 2>&1 || fail "No se pudo instalar curl."
fi

# ------------------------------------------------------------------------------
# 1. Resolver la versión a instalar
# ------------------------------------------------------------------------------
if [ "$TAG" = "latest" ] || [ -z "$TAG" ]; then
  log "Buscando la última versión publicada en GitHub..."
  TAG=$(curl -fsSL --connect-timeout 20 "${API}/latest" 2>/dev/null \
    | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' || true)
  if [ -z "$TAG" ]; then
    # Respaldo sin API (por si hay límite de peticiones): sigue la redirección /latest
    TAG=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/${REPO}/releases/latest" 2>/dev/null \
      | sed -E 's#.*/tag/##' || true)
  fi
  [ -n "$TAG" ] && [ "$TAG" != "latest" ] || fail "No se pudo determinar la última versión. Indica --tag vX.Y.Z"
fi
case "$TAG" in v*) : ;; *) TAG="v${TAG}" ;; esac
log "Versión a instalar: ${TAG}"

PKG="tvlister24-7-${TAG}.tar.gz"
PKG_URL="${DL}/${TAG}/${PKG}"

TMP_DIR=$(mktemp -d /tmp/tvlister-release.XXXXXX)

# ------------------------------------------------------------------------------
# 2. Descargar el paquete y verificar el checksum
# ------------------------------------------------------------------------------
log "Descargando ${PKG} ..."
curl -fL --retry 3 --connect-timeout 20 --progress-bar -o "${TMP_DIR}/${PKG}" "$PKG_URL" \
  || fail "No se pudo descargar el paquete del release ${TAG}. Revisa tu conexión o el tag."

if [ "$VERIFY" -eq 1 ]; then
  SHA_URL="${DL}/${TAG}/SHA256SUMS"
  if curl -fsSL --retry 2 -o "${TMP_DIR}/SHA256SUMS" "$SHA_URL" 2>/dev/null; then
    EXPECTED=$(grep -E "[[:space:]]\*?${PKG}$" "${TMP_DIR}/SHA256SUMS" | awk '{print $1}' | head -n1)
    if [ -n "$EXPECTED" ]; then
      ACTUAL=$(sha256sum "${TMP_DIR}/${PKG}" | awk '{print $1}')
      if [ "$EXPECTED" != "$ACTUAL" ]; then
        fail "El SHA256 del paquete no coincide (esperado ${EXPECTED:0:16}…, obtenido ${ACTUAL:0:16}…)."
      fi
      log "Checksum SHA256 verificado."
    else
      log "[AVISO] SHA256SUMS no incluye ${PKG}; se continúa sin verificar."
    fi
  else
    log "[AVISO] No se pudo descargar SHA256SUMS; se continúa sin verificar."
  fi
fi

# ------------------------------------------------------------------------------
# 3. Extraer y lanzar el instalador aislado del release
# ------------------------------------------------------------------------------
log "Extrayendo paquete..."
tar -xzf "${TMP_DIR}/${PKG}" -C "$TMP_DIR"
SRC_DIR=$(find "$TMP_DIR" -maxdepth 2 -name package.json -not -path '*/node_modules/*' -printf '%h\n' 2>/dev/null | head -n1)
[ -n "$SRC_DIR" ] || fail "El paquete no contiene package.json (descarga corrupta)."
[ -f "${SRC_DIR}/scripts/install_ubuntu.sh" ] || fail "El paquete no incluye scripts/install_ubuntu.sh."

export TVLISTER_SOURCE_DIR="$SRC_DIR"
export TVLISTER_RELEASE="$TAG"
export TVLISTER_TARBALL_SHA256=""
export APP_DIR
if [ -n "$PORT_ARG" ]; then
  export PORT="$PORT_ARG"
fi

log "Ejecutando el instalador aislado (Node.js y FFmpeg en ${APP_DIR}/.runtime, sin apt)..."
exec bash "${SRC_DIR}/scripts/install_ubuntu.sh"
