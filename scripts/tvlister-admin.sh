#!/usr/bin/env bash
# ==============================================================================
# tvlister-admin — Consola CLI para el Administrador del Sistema Linux (Root)
# Gestión de estado, puertos, firewall, reseteo de clave admin, logs y backups
# ==============================================================================
{
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
  echo "  Base de Datos   : ${APP_DIR}/data/tvlister.db"
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
  local ts out dbfile
  ts=$(date +%Y%m%d_%H%M%S)
  out="/root/tvlister247_backup_${ts}.db"
  dbfile="${APP_DIR}/data/tvlister.db"
  cp "$dbfile" "$out"
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
    import { db, initDb, resetPanelCatalog } from "./server/db.js";
    initDb();
    resetPanelCatalog({ wipeCategories: true, wipeResellers: true });
    db.exec("PRAGMA wal_checkpoint(PASSIVE);");
    console.log("✅ Panel dejado 100% limpio para producción. Super Admin y perfiles FFmpeg conservados.");
  '
  systemctl restart "$SERVICE_NAME" 2>/dev/null || true
}

cmd_import_xui() {
  local sql_arg="${1:-}"
  cd "$APP_DIR"
  echo "🔄 Iniciando importación de Streams y Usuarios desde XUI.one..."
  XUI_SQL_FILE="$sql_arg" "$NODE_BIN" --no-warnings --input-type=module -e '
    import { db, initDb } from "./server/db.js";
    import { executeXuiImport } from "./server/xuiImporter.js";
    initDb();
    const sqlPath = process.env.XUI_SQL_FILE || "";
    const conn = sqlPath ? { mode: "sql", sqlFilePath: sqlPath } : { mode: "auto" };
    const res = await executeXuiImport(conn, {
      importCategories: true,
      importStreams: true,
      importVod: true,
      importSeries: true,
      importBouquets: true,
      importLines: true,
      importResellers: true
    });
    db.exec("PRAGMA wal_checkpoint(PASSIVE);");
    console.log("✅ Importación XUI.one completada desde:", res.sourceLabel);
    console.log("   • Streams nuevos/actualizados :", res.stats.streamsCreated, "/", res.stats.streamsUpdated);
    console.log("   • Líneas nuevas/actualizadas  :", res.stats.linesCreated, "/", res.stats.linesUpdated);
    console.log("   • Categorías / Bouquets       :", res.stats.categoriesCreated + res.stats.categoriesUpdated, "/", res.stats.bouquetsSynced);
    console.log("   • Películas VOD / Series      :", res.stats.vodCreated + res.stats.vodUpdated, "/", res.stats.seriesCreated + res.stats.seriesUpdated);
  '
  systemctl restart "$SERVICE_NAME" 2>/dev/null || true
}

cmd_shield() {
  cd "$APP_DIR"
  "$NODE_BIN" --no-warnings --input-type=module -e '
    import { db, initDb } from "./server/db.js";
    initDb();
    const upsert = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    upsert.run("proxy_direct_ts", "true");
    upsert.run("anti_restreaming", "true");
    upsert.run("flood_limit_per_min", "240");
    db.exec("PRAGMA wal_checkpoint(PASSIVE);");
    console.log("✅ Blindaje Stream Shield Proxy (TS + HLS), Anti-Restreaming y protección CGNAT activados.");
  '
  systemctl restart "$SERVICE_NAME" 2>/dev/null || true
}

cmd_doctor() {
  local port ip
  port=$(get_current_port)
  ip=$(get_server_ip)
  cd "$APP_DIR"
  echo "============================================================"
  echo "  TVLister 24/7 — Auditoría de Producción Total (doctor)    "
  echo "============================================================"
  PANEL_PORT="$port" PANEL_IP="$ip" "$NODE_BIN" --no-warnings --input-type=module -e '
    import fs from "node:fs";
    import { db, initDb, verifyPassword } from "./server/db.js";
    import { isFfmpegAvailable, getFfmpegBin } from "./server/streamEngine.js";
    initDb();
    const admin = db.prepare("SELECT password_hash FROM users WHERE username = ?").get("admin");
    const pwdChanged = admin ? !verifyPassword("admin123", admin.password_hash) : true;
    const shield = db.prepare("SELECT value FROM settings WHERE key = ?").get("proxy_direct_ts")?.value === "true";
    const streams = db.prepare("SELECT COUNT(*) as c FROM streams").get().c;
    const vod = db.prepare("SELECT COUNT(*) as c FROM vod_items").get().c;
    const lines = db.prepare("SELECT COUNT(*) as c FROM lines").get().c;
    const cronOk = fs.existsSync("/etc/cron.d/tvlister24-7-backup");
    const ffOk = isFfmpegAvailable();

    console.log(pwdChanged ? "  [OK]   1. Clave Super Admin personalizada" : "  [FALTA] 1. Clave Super Admin sigue en admin123 -> Ejecuta: tvlister-admin reset-admin TU_CLAVE");
    console.log(shield     ? "  [OK]   2. Stream Shield Proxy activo (oculta fuentes TS/HLS + IP-Lock)" : "  [AVISO] 2. Stream Shield Proxy apagado (modo 302) -> Actívalo con: tvlister-admin shield");
    console.log((streams > 0 || vod > 0) && lines > 0
      ? `  [OK]   3. Catálogo cargado (${streams} canales, ${vod} VOD, ${lines} líneas)`
      : `  [AVISO] 3. Catálogo vacío (${streams} canales, ${lines} líneas) -> Ejecuta: tvlister-admin import-xui`);
    console.log(ffOk       ? `  [OK]   4. Motor FFmpeg operativo (${getFfmpegBin()})` : "  [AVISO] 4. FFmpeg no detectado (modo Direct Stream)");
    console.log(cronOk     ? "  [OK]   5. Respaldo diario automático 03:00 AM activo" : "  [AVISO] 5. Cron diario aún no activado -> Ejecuta: tvlister-admin enable-cron");
    console.log(fs.existsSync("./dist/index.html") ? "  [OK]   6. Build de producción compilado (dist/)" : "  [FALTA] 6. Ejecuta npm run build");
  '
  if curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
    echo "  [OK]   7. Endpoint /api/health respondiendo en http://${ip}:${port}"
  else
    echo "  [FALTA] 7. Servicio no responde en 127.0.0.1:${port} -> Ejecuta: tvlister-admin restart"
  fi
  echo "============================================================"
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
    client_max_body_size 250M;

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

cmd_ffmpeg() {
  local sub="${1:-status}"
  cd "$APP_DIR"
  case "$sub" in
    status | "")
      "$NODE_BIN" --no-warnings --input-type=module -e '
        import { getFfmpegBinInfo } from "./server/streamEngine.js";
        const info = getFfmpegBinInfo();
        console.log("============================================================");
        console.log("  TVLister 24/7 — Motor FFmpeg                            ");
        console.log("============================================================");
        console.log("  Binario en uso : " + (info.available ? info.bin : "NO DETECTADO (Modo Direct Stream)"));
        console.log("  Versión        : " + (info.version || "—"));
        console.log("  Procedencia    : " + info.label);
        console.log("  Preferencia    : " + info.preference + "  (auto = orden del motor)");
        console.log("  XUI.one        : " + (info.xuiInstalled > 0
          ? info.xuiInstalled + " compilación(es) ejecutables en " + info.xuiPath
          : "no detectado en " + info.xuiPath));
        console.log("");
        console.log("  Candidatos (id · etiqueta · versión):");
        for (const b of info.binaries) {
          const inUse = b.path && b.path === info.bin;
          const mark = inUse ? "  <== EN USO" : "";
          console.log("   " + (b.ok ? "[OK]  " : "[--]  ") + b.id.padEnd(10) + " " + b.label.padEnd(36) + " " + (b.ok ? (b.version || "ok") : (b.error || "no disponible")) + mark);
          if (b.path) console.log("             " + b.path);
        }
        console.log("");
        console.log("  Elegir otro:   tvlister-admin ffmpeg use <id|auto|xui>");
        console.log("  Descargar uno: tvlister-admin ffmpeg install");
        console.log("============================================================");
      '
      ;;
    use)
      local target="${2:-}"
      if [ -z "$target" ]; then
        echo "Uso: tvlister-admin ffmpeg use <auto|xui|xui44|xui43|xui40|xuilegacy|runtime|bundled|system>"
        return 1
      fi
      FF_TARGET="$target" "$NODE_BIN" --no-warnings --input-type=module -e '
        import { db, initDb } from "./server/db.js";
        import { isValidFfmpegPreference, detectFfmpegBinaries } from "./server/streamEngine.js";
        initDb();
        let target = String(process.env.FF_TARGET || "").trim();
        const bins = detectFfmpegBinaries({ force: true });
        if (target === "xui") {
          const pick = ["xui44", "xui43", "xui40", "xuilegacy"].find((id) => bins.some((b) => b.id === id && b.ok));
          if (!pick) {
            console.error("[ERROR] XUI.one no tiene ningún FFmpeg ejecutable en /home/xui/bin/ffmpeg_bin");
            process.exit(1);
          }
          target = pick;
        }
        if (!isValidFfmpegPreference(target)) {
          console.error("[ERROR] Binario desconocido: " + target);
          process.exit(1);
        }
        db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run("ffmpeg_bin_preference", target);
        const chosen = bins.find((b) => b.id === target);
        console.log("  Preferencia guardada: " + target + (chosen ? "  (" + chosen.path + ")" : ""));
        if (chosen && !chosen.ok) {
          console.log("  [AVISO] Ese binario no ejecuta ahora mismo: el motor usará el orden automático.");
        }
        console.log("  Aplica el cambio con: tvlister-admin restart");
      '
      ;;
    install)
      local arch tmp dl_ok version
      arch=$(uname -m)
      case "$arch" in
        x86_64 | amd64) arch=x64 ;;
        aarch64 | arm64) arch=arm64 ;;
        *)
          echo "[ERROR] Arquitectura no soportada: $arch"
          return 1
          ;;
      esac
      tmp=$(mktemp -d)
      mkdir -p "$APP_DIR/.runtime/bin"
      dl_ok=0

      # Espejo 1: GitHub (ffmpeg 6.x estático, sin dependencias del sistema)
      echo "  Descargando FFmpeg estático (${arch}) desde GitHub…"
      if curl -fL --retry 3 --max-time 300 \
        "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-${arch}.gz" \
        -o "$tmp/ffmpeg.gz" 2>/dev/null; then
        if gunzip -c "$tmp/ffmpeg.gz" >"$tmp/ffmpeg" 2>/dev/null; then
          chmod +x "$tmp/ffmpeg"
          if "$tmp/ffmpeg" -version >/dev/null 2>&1; then
            dl_ok=1
          fi
        fi
      fi

      # Espejo 2: johnvansickle (última compilación estática)
      if [ "$dl_ok" -eq 0 ] && command -v xz >/dev/null 2>&1; then
        echo "  GitHub no respondió; probando johnvansickle.com…"
        local ff_arch
        case "$arch" in
          x64) ff_arch=amd64 ;;
          *) ff_arch=arm64 ;;
        esac
        if curl -fL --retry 3 --max-time 300 \
          "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${ff_arch}-static.tar.xz" \
          -o "$tmp/ffmpeg.tar.xz" 2>/dev/null; then
          tar -xJf "$tmp/ffmpeg.tar.xz" --strip-components=1 -C "$tmp" 2>/dev/null || true
          if [ -f "$tmp/ffmpeg" ]; then
            chmod +x "$tmp/ffmpeg"
            if "$tmp/ffmpeg" -version >/dev/null 2>&1; then
              dl_ok=1
            fi
          fi
        fi
      fi

      # Espejo 3: paquete npm (mismo binario estático que ya usa TVLister)
      if [ "$dl_ok" -eq 0 ]; then
        echo "  Probando el paquete npm @ffmpeg-installer…"
        if curl -fsSL --retry 3 --max-time 300 \
          "https://registry.npmjs.org/@ffmpeg-installer/linux-${arch}/-/linux-${arch}-4.1.0.tgz" \
          -o "$tmp/ffmpeg.tgz" 2>/dev/null; then
          tar -xzf "$tmp/ffmpeg.tgz" -C "$tmp" package/ffmpeg 2>/dev/null || true
          if [ -f "$tmp/package/ffmpeg" ]; then
            chmod +x "$tmp/package/ffmpeg" || true
            if "$tmp/package/ffmpeg" -version >/dev/null 2>&1; then
              cp -f "$tmp/package/ffmpeg" "$tmp/ffmpeg"
              dl_ok=1
            fi
          fi
        fi
      fi

      if [ "$dl_ok" -eq 0 ]; then
        echo "[ERROR] No se pudo descargar un FFmpeg ejecutable."
        echo "        Alternativa sin descargar nada: tvlister-admin ffmpeg use xui"
        rm -rf "$tmp"
        return 1
      fi

      if [ -f "$APP_DIR/.runtime/bin/ffmpeg" ]; then
        cp -f "$APP_DIR/.runtime/bin/ffmpeg" "$APP_DIR/.runtime/bin/ffmpeg.bak.$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
      fi
      cp -f "$tmp/ffmpeg" "$APP_DIR/.runtime/bin/ffmpeg"
      chmod +x "$APP_DIR/.runtime/bin/ffmpeg"
      version=$("$APP_DIR/.runtime/bin/ffmpeg" -version | head -n1)
      echo "  [OK] Instalado en $APP_DIR/.runtime/bin/ffmpeg"
      echo "       $version"
      rm -rf "$tmp"

      FF_TARGET=runtime "$NODE_BIN" --no-warnings --input-type=module -e '
        import { db, initDb } from "./server/db.js";
        import { invalidateFfmpegBinCache, getFfmpegBinInfo } from "./server/streamEngine.js";
        initDb();
        db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run("ffmpeg_bin_preference", "runtime");
        invalidateFfmpegBinCache(true);
        const info = getFfmpegBinInfo();
        console.log("  Preferencia: runtime → " + info.bin + (info.version ? " (" + info.version + ")" : ""));
        console.log("  Aplica el cambio con: tvlister-admin restart");
      '
      ;;
    *)
      echo "Uso: tvlister-admin ffmpeg [status|use <id>|install]"
      return 1
      ;;
  esac
}

cmd_release() {
  # Instala/actualiza desde un release publicado (paquete .tar.gz + checksum),
  # sin depender de la rama de git. Uso: tvlister-admin release [vX.Y.Z]
  local tag port tmp_script url
  tag="${1:-latest}"
  port=$(get_current_port)
  echo "📦 Instalando TVLister 24/7 desde release (${tag}) conservando datos y puerto ${port}..."
  if [ "$tag" = "latest" ]; then
    url="https://github.com/TalaveraSama/tvlister24-7/releases/latest/download/install.sh"
  else
    case "$tag" in v*) : ;; *) tag="v${tag}" ;; esac
    url="https://github.com/TalaveraSama/tvlister24-7/releases/download/${tag}/install.sh"
  fi
  tmp_script=$(mktemp /tmp/tvlister_release.XXXXXX.sh)
  if ! curl -fsSL --retry 3 "$url" -o "$tmp_script"; then
    echo "❌ No se pudo descargar el instalador del release ${tag}."
    echo "   Revisa la lista de versiones: https://github.com/TalaveraSama/tvlister24-7/releases"
    rm -f "$tmp_script"
    return 1
  fi
  PORT="$port" exec bash "$tmp_script" --tag "$tag"
}

cmd_update() {
  local port tmp_script
  port=$(get_current_port)
  echo "🔄 Actualizando TVLister 24/7 desde GitHub en tiempo real (conservando base de datos y puerto ${port})..."
  tmp_script=$(mktemp /tmp/tvlister_update.XXXXXX.sh)
  if ! curl -fsSL -H "Accept: application/vnd.github.raw" -H "Cache-Control: no-cache" \
    "https://api.github.com/repos/TalaveraSama/tvlister24-7/contents/scripts/install_ubuntu.sh?ref=arena/85cc9902-tvlister24-7" -o "$tmp_script" 2>/dev/null; then
    curl -fsSL "https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/arena/85cc9902-tvlister24-7/scripts/install_ubuntu.sh" -o "$tmp_script"
  fi
  PORT="$port" exec bash "$tmp_script"
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
  purge-demo|clean)
    cmd_purge_demo
    ;;
  import-xui)
    cmd_import_xui "${2:-}"
    ;;
  shield)
    cmd_shield
    ;;
  doctor)
    cmd_doctor
    ;;
  setup-ssl)
    cmd_setup_ssl "${2:-}" "${3:-}"
    ;;
  add-port)
    EXTRA_P="${2:-}"
    if [ -z "$EXTRA_P" ]; then
      read -r -p "Ingresa el puerto adicional a habilitar (ej. 8880, 25461): " EXTRA_P
    fi
    cmd_open_firewall "$EXTRA_P"
    cd "$APP_DIR"
    EXTRA_PORT_VAL="$EXTRA_P" "$NODE_BIN" --no-warnings --input-type=module -e '
      import { db, initDb } from "./server/db.js";
      initDb();
      const p = Number(process.env.EXTRA_PORT_VAL);
      if (!Number.isInteger(p) || p < 80 || p > 65535) { console.error("Puerto inválido"); process.exit(1); }
      const row = db.prepare("SELECT value FROM settings WHERE key = \x27extra_http_ports\x27").get();
      const set = new Set((row?.value || "").split(",").map(s => Number(s.trim())).filter(Boolean));
      set.add(p);
      const val = Array.from(set).sort((a,b)=>a-b).join(",");
      db.prepare("INSERT INTO settings (key, value) VALUES (\x27extra_http_ports\x27, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(val);
      console.log("✅ Puertos adicionales configurados:", val);
    '
    systemctl restart "$SERVICE_NAME"
    echo "✅ Servicio reiniciado con el nuevo puerto activo."
    ;;
  remove-port)
    REM_P="${2:-}"
    if [ -z "$REM_P" ]; then
      read -r -p "Ingresa el puerto adicional a cerrar: " REM_P
    fi
    cd "$APP_DIR"
    REM_PORT_VAL="$REM_P" "$NODE_BIN" --no-warnings --input-type=module -e '
      import { db, initDb } from "./server/db.js";
      initDb();
      const p = Number(process.env.REM_PORT_VAL);
      const row = db.prepare("SELECT value FROM settings WHERE key = \x27extra_http_ports\x27").get();
      const val = (row?.value || "").split(",").map(s => Number(s.trim())).filter(n => n && n !== p).join(",");
      db.prepare("INSERT INTO settings (key, value) VALUES (\x27extra_http_ports\x27, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(val);
      console.log("✅ Puertos adicionales restantes:", val || "(ninguno)");
    '
    systemctl restart "$SERVICE_NAME"
    ;;
  list-ports)
    echo "Puerto Principal : $(get_current_port)"
    cd "$APP_DIR"
    "$NODE_BIN" --no-warnings --input-type=module -e '
      import { db } from "./server/db.js";
      const row = db.prepare("SELECT value FROM settings WHERE key = \x27extra_http_ports\x27").get();
      console.log("Puertos Extra    :", row?.value || "(ninguno)");
    '
    ;;
  install-ingest)
    echo "Instalando motor aislado MediaMTX v1.21.3 (RTMP :1935, SRT :8890 UDP, RTSP :8554)..."
    cd "$APP_DIR"
    "$NODE_BIN" --no-warnings --input-type=module -e '
      import { installMediaMtxBinary } from "./server/ingestHub.js";
      const bin = await installMediaMtxBinary();
      console.log("✅ Binario instalado en:", bin);
    '
    cmd_open_firewall 1935
    cmd_open_firewall 8554
    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
      ufw allow 8890/udp >/dev/null 2>&1 || true
    fi
    if command -v iptables >/dev/null 2>&1; then
      iptables -C INPUT -p udp --dport 8890 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p udp --dport 8890 -j ACCEPT
    fi
    systemctl restart "$SERVICE_NAME"
    echo "✅ Servidor RTMP + SRT + RTSP activado y escuchando."
    ;;
  sync-vod)
    if [ -z "${2:-}" ]; then
      echo "Uso: tvlister-admin sync-vod /ruta/a/peliculas"
      exit 1
    fi
    cd "$APP_DIR"
    SYNC_DIR="$2" "$NODE_BIN" --no-warnings --input-type=module -e '
      import { db, initDb } from "./server/db.js";
      import { syncLocalVodFolder } from "./server/vodSyncTmdb.js";
      initDb();
      const st = await syncLocalVodFolder({
        folderPath: process.env.SYNC_DIR,
        contentMode: "auto",
        useSubfoldersAsCategories: true,
        autoTmdb: true,
        saveWatchFolder: true
      });
      db.exec("PRAGMA wal_checkpoint(PASSIVE);");
      console.log("✅ Carpeta sincronizada:", st.rootFolder);
      console.log("   • Películas nuevas / existentes :", st.moviesAdded, "/", st.moviesExisting);
      console.log("   • Series nuevas (+Episodios)    :", st.seriesAdded, "(+" + st.episodesAdded + ")");
      console.log("   • Carátulas TMDB descargadas    :", st.tmdbEnriched);
    '
    ;;
  update)
    cmd_update
    ;;
  release)
    cmd_release "${2:-latest}"
    ;;
  ffmpeg)
    cmd_ffmpeg "${2:-status}" "${3:-}"
    ;;
  *)
    echo "============================================================"
    echo "  TVLister 24/7 — Consola de Administración del Sistema     "
    echo "============================================================"
    echo "  1) Ver estado, IP y puerto actual (status)"
    echo "  2) Auditoría de Producción Total ¿Qué falta? (doctor)"
    echo "  3) Cambiar contraseña de 'admin' (reset-admin)"
    echo "  4) Activar Blindaje Stream Shield Proxy TS/HLS (shield)"
    echo "  5) Importar Streams y Usuarios desde XUI.one (import-xui)"
    echo "  6) Dejar panel 100% limpio para producción (clean)"
    echo "  7) Programar backup diario automático 03:00 AM (enable-cron)"
    echo "  8) Crear backup manual en /root (backup)"
    echo "  9) Configurar Dominio Nginx + SSL Let's Encrypt (setup-ssl)"
    echo " 10) Cambiar puerto principal TCP (set-port)"
    echo " 11) Agregar puerto adicional simultáneo (add-port)"
    echo " 12) Activar Servidor Ingesta RTMP/SRT/RTSP (install-ingest)"
    echo " 13) Actualizar panel desde GitHub sin perder datos (update)"
    echo " 14) Reiniciar motor TVLister 24/7 (restart)"
    echo " 15) Ver logs en vivo (logs)"
    echo " 16) Motor FFmpeg: ver, elegir o instalar binario (ffmpeg)"
    echo " 17) Instalar/actualizar desde un release publicado (release)"
    echo "  0) Salir"
    echo "============================================================"
    read -r -p "Selecciona una opción [0-17]: " opt
    case "$opt" in
      1) cmd_status ;;
      2) cmd_doctor ;;
      3) cmd_reset_admin "" ;;
      4) cmd_shield ;;
      5) cmd_import_xui "" ;;
      6) cmd_purge_demo ;;
      7) cmd_enable_cron ;;
      8) cmd_backup ;;
      9) cmd_setup_ssl "" "" ;;
      10) cmd_set_port "" ;;
      11) "$0" add-port ;;
      12) "$0" install-ingest ;;
      13) cmd_update ;;
      14) systemctl restart "$SERVICE_NAME" && echo "✅ Servicio reiniciado." ;;
      15) journalctl -u "$SERVICE_NAME" -n 50 -f ;;
      16) cmd_ffmpeg "status" "" ;;
      17) cmd_release "latest" ;;
      *) exit 0 ;;
    esac
    ;;
esac
exit 0
}
