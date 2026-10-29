#!/usr/bin/env bash
# ==============================================================================
# TVLister 24/7 — Empaquetador de release
# ------------------------------------------------------------------------------
# Genera en ./release/ los artefactos que se publican en GitHub:
#
#   tvlister24-7-vX.Y.Z.tar.gz   código del panel (sin node_modules, data, .runtime)
#   install.sh                   instalador de una línea para el servidor
#   SHA256SUMS                   checksums de ambos archivos
#
# Uso:  bash scripts/build_release.sh [vX.Y.Z]
# Sin argumento toma la versión de package.json.
# ==============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

RAW_VERSION="${1:-}"
if [ -z "$RAW_VERSION" ]; then
  RAW_VERSION=$(node -p "require('./package.json').version")
fi
TAG="v${RAW_VERSION#v}"
NAME="tvlister24-7-${TAG}"
OUT="release"

# Sólo se empaqueta lo que está versionado en git: nada de node_modules, data,
# .runtime, dist ni bases de datos locales.
FILES=$(mktemp)
trap 'rm -f "$FILES"' EXIT
git ls-files \
  | grep -Ev '^(data/|dist/|release/|streams_runtime/|\.runtime/|node_modules/)' \
  | grep -Ev '(^|/)\.env($|\.)' \
  > "$FILES"

if ! grep -q '^package.json$' "$FILES"; then
  echo "[ERROR] No se encontró package.json entre los archivos versionados." >&2
  exit 1
fi

rm -rf "${OUT:?}/${NAME}"
mkdir -p "${OUT}/${NAME}"

while IFS= read -r f; do
  [ -f "$f" ] || continue
  mkdir -p "${OUT}/${NAME}/$(dirname "$f")"
  cp -p "$f" "${OUT}/${NAME}/$f"
done < "$FILES"

# Metadatos del release dentro del paquete
printf '%s\n' "$TAG" > "${OUT}/${NAME}/VERSION"
git rev-parse --short HEAD > "${OUT}/${NAME}/COMMIT" 2>/dev/null || true

chmod +x "${OUT}/${NAME}/scripts/install_ubuntu.sh" \
         "${OUT}/${NAME}/scripts/install_release.sh" \
         "${OUT}/${NAME}/scripts/tvlister-admin.sh" 2>/dev/null || true

tar -czf "${OUT}/${NAME}.tar.gz" -C "$OUT" "$NAME"
cp -p scripts/install_release.sh "${OUT}/install.sh"
chmod +x "${OUT}/install.sh"

(
  cd "$OUT"
  sha256sum "${NAME}.tar.gz" install.sh > SHA256SUMS
)

echo "Release ${TAG} empaquetado en ${OUT}/"
ls -lh "${OUT}/${NAME}.tar.gz" "${OUT}/install.sh" "${OUT}/SHA256SUMS" | awk '{print "  " $9 "  " $5}'
echo
echo "Publicar con:"
echo "  gh release create ${TAG} ${OUT}/${NAME}.tar.gz ${OUT}/install.sh ${OUT}/SHA256SUMS \\"
echo "     --title \"TVLister 24/7 ${TAG}\" --notes-file docs/RELEASE_NOTES_${TAG}.md"
