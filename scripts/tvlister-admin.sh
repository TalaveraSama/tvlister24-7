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
  NEW_ADMIN_PASS="$new_pass" "$NODE_BIN" --no-warnings --input-type=module -e '
    import { db, initDb, hashPassword } from "./server/db.js";
    initDb();
    const pwd = process.env.NEW_ADMIN_PASS;
    const row = db.prepare("SELECT id FROM users WHERE username = ?").get("admin");
    if (row) {
      db.prepare("UPDATE users SET password_hash = ?, status = ? WHERE id = ?").run(hashPassword(pwd), "active", row.id);
    } else {
      db.prepare("INSERT INTO users (username, password_hash, role, credits, status) VALUES (?, ?, ?, 999999, ?)").run("admin", hashPassword(pwd), "admin", "active");
    }
    db.exec("PRAGMA wal_checkpoint(PASSIVE);");
    console.log("✅ Contraseña del Super Admin (admin) actualizada correctamente.");
  '
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
  find /root -maxdepth 1 -name "tvlister247_backup_*.db" -mtime +7 -delete 2>/dev/null || true
  echo "✅ Copia de seguridad guardada en: ${out}"
}

cmd_enable_cron() {
  cat > /etc/cron.d/tvlister24-7-backup <<EOF
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
0 3 * * * root /usr/local/bin/tvlister-admin backup >/dev/null 2>&1
EOF
  chmod 0644 /etc/cron.d/tvlister24-7-backup
  echo "✅ Respaldo diario automático programado a las 03:00 AM en /etc/cron.d/tvlister24-7-backup (retención 7 días)."
}

cmd_purge_demo() {
  cd "$APP_DIR"
  "$NODE_BIN" --no-warnings --input-type=module -e '
    import { db, initDb } from "./server/db.js";
    initDb();
    db.exec(`
      DELETE FROM active_connections;
      DELETE FROM client_claims;
      DELETE FROM osd_messages;
      DELETE FROM series_episodes;
      DELETE FROM series;
      DELETE FROM vod_items;
      DELETE FROM channels_247;
      DELETE FROM streams;
      DELETE FROM lines;
      DELETE FROM epg_programs;
      DELETE FROM users WHERE role = "reseller";
      UPDATE bouquets SET stream_ids_json = "[]", channel247_ids_json = "[]", vod_ids_json = "[]", series_ids_json = "[]";
      INSERT INTO settings (key, value) VALUES ("demo_purged", "true")
        ON CONFLICT(key) DO UPDATE SET value = "true";
      PRAGMA wal_checkpoint(PASSIVE);
    `);
    console.log("✅ Datos de demostración eliminados. Categorías, perfiles FFmpeg y Super Admin conservados.");
  '
  systemctl restart "$SERVICE_NAME" 2>/dev/null || true
}

cmd_setup_ssl() {
  local domain="${1:-}"
  local email="${2:-}"
  local port
  port=$(get_current_port)
  if [ -z "$domain" ]; then
    read -r -p "Ingresa el dominio apuntando a este servidor (ej. tv.midominio.com): " domain
  fi
  if [ -z "$domain" ]; then
    echo "[ERROR] Dominio requerido."
    exit 1
  fi
  if [ -z "$email" ]; then
    email="admin@${domain}"
  fi

  if [ -d "/etc/nginx/sites-available" ]; then
    cat > /etc/nginx/sites-available/tvlister247.conf <<EOF
server {
    listen 80;
    server_name ${domain};
    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_read_timeout 86400s;
    }
}
EOF
    ln -sf /etc/nginx/sites-available/tvlister247.conf /etc/nginx/sites-enabled/tvlister247.conf
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx
      echo "✅ VirtualHost Nginx activado para http://${domain} -> 127.0.0.1:${port}"
    else
      echo "[WARN] nginx -t reportó advertencia. Revisa /etc/nginx/sites-available/tvlister247.conf"
    fi

    if command -v certbot >/dev/null 2>&1; then
      certbot --nginx -d "$domain" --non-interactive --agree-tos -m "$email" --redirect
      echo "✅ Certificado HTTPS Let's Encrypt activo en https://${domain}"
    else
      echo "ℹ️ Nginx ya enruta ${domain}. Para instalar SSL sin tocar apt de XUI.one, ejecuta acme.sh:"
      echo "   curl https://get.acme.sh | sh -s email=${email} && ~/.acme.sh/acme.sh --issue -d ${domain} --nginx"
    fi
  else
    echo "ℹ️ /etc/nginx/sites-available no detectado (XUI.one usa su propio nginx interno en /home/xui/bin/nginx)."
    echo "   Archivo generado en /root/tvlister247_${domain}.nginx.conf listo para incluir en tu proxy frontal."
    cat > "/root/tvlister247_${domain}.nginx.conf" <<EOF
server {
    listen 80;
    server_name ${domain};
    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_buffering off;
    }
}
EOF
  fi
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
  enable-cron)
    cmd_enable_cron
    ;;
  purge-demo)
    cmd_purge_demo
    ;;
  setup-ssl)
    cmd_setup_ssl "${2:-}" "${3:-}"
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
    echo "  7) Programar backup diario automático 03:00 AM (enable-cron)"
    echo "  8) Purgar datos demo y dejar limpio para producción (purge-demo)"
    echo "  9) Configurar Dominio Nginx + SSL Let's Encrypt (setup-ssl)"
    echo " 10) Actualizar panel desde GitHub sin perder datos (update)"
    echo " 11) Ver logs en vivo (logs)"
    echo "  0) Salir"
    echo "============================================================"
    read -r -p "Selecciona una opción [0-11]: " opt
    case "$opt" in
      1) cmd_status ;;
      2) cmd_reset_admin "" ;;
      3) cmd_set_port "" ;;
      4) cmd_open_firewall "" ;;
      5) systemctl restart "$SERVICE_NAME" && echo "✅ Servicio reiniciado." ;;
      6) cmd_backup ;;
      7) cmd_enable_cron ;;
      8) cmd_purge_demo ;;
      9) cmd_setup_ssl "" "" ;;
      10) cmd_update ;;
      11) journalctl -u "$SERVICE_NAME" -n 50 -f ;;
      *) exit 0 ;;
    esac
    ;;
esac
