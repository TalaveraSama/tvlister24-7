#!/usr/bin/env bash
# ==============================================================================
# tvlister-admin — Consola CLI para el Administrador del Sistema Linux (Root)
# Gestión de estado, puertos, firewall, reseteo de clave admin, logs y backups
# ==============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/tvlister24-7}"
NODE_BIN="${APP_DIR}/.runtime/node/bin/node"
SERVICE_FILE="/etc/systemd/system/tvlister24-7.service"
SERVICE_NAME="tvlister24-7"

if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN=$(command -v node || true)
fi

get_current_port() {
  if [ -f "$SERVICE_FILE" ]; then
    grep -E '^Environment=PORT=' "$SERVICE_FILE" | head -n1 | cut -d= -f3 || echo "8095"
  else
    echo "8095"
  fi
}

get_server_ip() {
  local ip
  ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -n1 || true)
  if [ -z "$ip" ]; then
    ip=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")
  fi
  echo "$ip"
}

cmd_status() {
  local port ip
  port=$(get_current_port)
  ip=$(get_server_ip)
  echo "============================================================"
  echo "  TVLister 24/7 — Estado del Sistema"
  echo "============================================================"
  echo "  URL Panel Admin : http://${ip}:${port}"
  echo "  Directorio      : ${APP_DIR}"
  echo "  Base de Datos   : ${APP_DIR}/data/midnight_tvlister.db"
  if [ -d "/home/xui" ]; then
    echo "  Coexistencia    : XUI.one detectado (/home/xui intacto)"
  fi
  echo "------------------------------------------------------------"
  systemctl status "$SERVICE_NAME" --no-pager -l | head -n 16 || true
  echo "============================================================"
}

cmd_reset_admin() {
  local new_pass="${1:-}"
  if [ -z "$new_pass" ]; then
    read -r -p "Ingresa la nueva contraseña para 'admin': " new_pass
  fi
  if [ "${#new_pass}" -lt 5 ]; then
    echo "[ERROR] La contraseña debe tener al menos 5 caracteres."
    exit 1
  fi
  cd "$APP_DIR"
  "$NODE_BIN" --no-warnings --input-type=module -e '
    import { db, hashPassword } from "./server/db.js";
    const pwd = process.argv[1];
    const row = db.prepare("SELECT id FROM users WHERE username = ?").get("admin");
    if (row) {
      db.prepare("UPDATE users SET password_hash = ?, status = '\''active'\'' WHERE id = ?").run(hashPassword(pwd), row.id);
    } else {
      db.prepare("INSERT INTO users (username, password_hash, role, credits, status) VALUES ('\''admin'\'', ?, '\''admin'\'', 999999, '\''active'\'')").run(hashPassword(pwd));
    }
    console.log("✅ Contraseña del Super Admin (admin) actualizada correctamente.");
  ' "$new_pass"
}

cmd_open_firewall() {
  local port="${1:-$(get_current_port)}"
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow "${port}/tcp" >/dev/null 2>&1 || true
    echo "✅ Puerto ${port}/tcp permitido en UFW."
  fi
  if command -v iptables >/dev/null 2>&1; then
    iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport "$port" -j ACCEPT
    echo "✅ Regla ACCEPT para puerto TCP ${port} verificada en iptables."
  fi
}

cmd_set_port() {
  local new_port="${1:-}"
  if [ -z "$new_port" ]; then
    read -r -p "Ingresa el nuevo puerto TCP (ej. 8095, 8895, 9080): " new_port
  fi
  if ! [[ "$new_port" =~ ^[0-9]+$ ]] || [ "$new_port" -lt 80 ] || [ "$new_port" -gt 65535 ]; then
    echo "[ERROR] Puerto inválido: $new_port"
    exit 1
  fi
  if [ ! -f "$SERVICE_FILE" ]; then
    echo "[ERROR] No se encontró ${SERVICE_FILE}"
    exit 1
  fi
  sed -i "s/^Environment=PORT=.*/Environment=PORT=${new_port}/" "$SERVICE_FILE"
  systemctl daemon-reload
  systemctl restart "$SERVICE_NAME"
  cmd_open_firewall "$new_port"
  echo "✅ Panel movido y reiniciado en: http://$(get_server_ip):${new_port}"
}

cmd_backup() {
  local ts out
  ts=$(date +%Y%m%d_%H%M%S)
  out="/root/tvlister247_backup_${ts}.db"
  cp "${APP_DIR}/data/midnight_tvlister.db" "$out"
  echo "✅ Copia de seguridad guardada en: ${out}"
}

cmd_update() {
  local port
  port=$(get_current_port)
  echo "🔄 Actualizando TVLister 24/7 desde GitHub (conservando base de datos y puerto ${port})..."
  curl -fsSL "https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/arena/85cc9902-tvlister24-7/scripts/install_ubuntu.sh?ts=$(date +%s)" | PORT="$port" bash
}

ACTION="${1:-menu}"

case "$ACTION" in
  status)
    cmd_status
    ;;
  reset-admin)
    cmd_reset_admin "${2:-}"
    ;;
  set-port)
    cmd_set_port "${2:-}"
    ;;
  open-firewall)
    cmd_open_firewall "${2:-}"
    ;;
  restart)
    systemctl restart "$SERVICE_NAME"
    echo "✅ Servicio ${SERVICE_NAME} reiniciado."
    ;;
  logs)
    journalctl -u "$SERVICE_NAME" -n 50 -f
    ;;
  backup)
    cmd_backup
    ;;
  update)
    cmd_update
    ;;
  *)
    echo "============================================================"
    echo "  TVLister 24/7 — Consola de Administración del Sistema     "
    echo "============================================================"
    echo "  1) Ver estado, IP y puerto actual (status)"
    echo "  2) Cambiar contraseña de 'admin' (reset-admin)"
    echo "  3) Cambiar puerto TCP del panel (set-port)"
    echo "  4) Abrir puerto en Firewall / iptables (open-firewall)"
    echo "  5) Reiniciar motor TVLister 24/7 (restart)"
    echo "  6) Crear backup de base de datos en /root (backup)"
    echo "  7) Actualizar panel desde GitHub sin perder datos (update)"
    echo "  8) Ver logs en vivo (logs)"
    echo "  0) Salir"
    echo "============================================================"
    read -r -p "Selecciona una opción [0-8]: " opt
    case "$opt" in
      1) cmd_status ;;
      2) cmd_reset_admin "" ;;
      3) cmd_set_port "" ;;
      4) cmd_open_firewall "" ;;
      5) systemctl restart "$SERVICE_NAME" && echo "✅ Servicio reiniciado." ;;
      6) cmd_backup ;;
      7) cmd_update ;;
      8) journalctl -u "$SERVICE_NAME" -n 50 -f ;;
      *) exit 0 ;;
    esac
    ;;
esac
