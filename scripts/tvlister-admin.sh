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
        console.log("  Copiar el de XUI.one a la carpeta del panel: tvlister-admin ffmpeg import-xui");
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
    import-xui)
      # Copia el FFmpeg de XUI.one DENTRO de la carpeta del panel (.runtime/bin) para
      # que el motor no dependa de /home/xui ni de que XUI.one esté instalado.
      local src="" cand xui_dir
      xui_dir="${XUI_DIR:-/home/xui}"
      mkdir -p "$APP_DIR/.runtime/bin" "$APP_DIR/.runtime/lib"
      for cand in \
        "$xui_dir/bin/ffmpeg_bin/4.4/ffmpeg" \
        "$xui_dir/bin/ffmpeg_bin/4.3/ffmpeg" \
        "$xui_dir/bin/ffmpeg_bin/4.0/ffmpeg" \
        "$xui_dir/bin/ffmpeg_bin/4.4/ffmpeg_bin" \
        "$xui_dir/bin/ffmpeg_bin/4.3/ffmpeg_bin" \
        "$xui_dir/bin/ffmpeg_bin/4.0/ffmpeg_bin" \
        "$xui_dir/bin/ffmpeg/ffmpeg" \
        "$xui_dir/bin/ffmpeg_bin" \
        "$xui_dir/bin/ffmpeg"; do
        if [ -f "$cand" ] && [ -x "$cand" ] && "$cand" -version >/dev/null 2>&1; then
          src="$cand"
          break
        fi
      done

      if [ -z "$src" ]; then
        echo "  [AVISO] No hay ningún FFmpeg ejecutable de XUI.one en ${xui_dir}."
        echo "          El panel sigue usando el binario de .runtime o el empaquetado."
        echo "          Instala uno propio con: tvlister-admin ffmpeg install"
        return 1
      fi

      echo "  Origen: $src"
      if [ -f "$APP_DIR/.runtime/bin/ffmpeg" ]; then
        cp -f "$APP_DIR/.runtime/bin/ffmpeg" "$APP_DIR/.runtime/bin/ffmpeg.bak.$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
      fi
      cp -f "$src" "$APP_DIR/.runtime/bin/ffmpeg"
      chmod +x "$APP_DIR/.runtime/bin/ffmpeg"

      # Algunas compilaciones de XUI.one enlazan libs de /home/xui/lib: se copian
      # junto al binario del panel y el motor las busca en .runtime/lib.
      local missing
      # ldd sale con 1 en binarios estáticos ("not a dynamic executable"): no debe
      # tumbar el script por set -e.
      missing=$(ldd "$APP_DIR/.runtime/bin/ffmpeg" 2>/dev/null | awk '/not found/{print $1}' | sort -u || true)
      if [ -n "$missing" ]; then
        echo "  Copiando librerías que faltan: $(echo "$missing" | tr '\n' ' ')"
        local lib found
        for lib in $missing; do
          found=$(find "$xui_dir" -name "$lib" -type f 2>/dev/null | head -n1)
          if [ -n "$found" ]; then
            cp -f "$found" "$APP_DIR/.runtime/lib/$lib"
          else
            echo "  [AVISO] No se encontró $lib en /home/xui"
          fi
        done
        if LD_LIBRARY_PATH="$APP_DIR/.runtime/lib" ldd "$APP_DIR/.runtime/bin/ffmpeg" 2>/dev/null | grep -q 'not found'; then
          echo "  [AVISO] Quedan librerías sin resolver; el motor probará el binario y, si falla, usará otro."
        fi
      fi

      if ! "$APP_DIR/.runtime/bin/ffmpeg" -version >/dev/null 2>&1; then
        if TG_LIB="$APP_DIR/.runtime/lib" LD_LIBRARY_PATH="$APP_DIR/.runtime/lib:${LD_LIBRARY_PATH:-}" "$APP_DIR/.runtime/bin/ffmpeg" -version >/dev/null 2>&1; then
          echo "  [OK] Copiado, pero necesita LD_LIBRARY_PATH=$APP_DIR/.runtime/lib (ya está en el servicio)."
        else
          echo "  [ERROR] El binario copiado no ejecuta. Se conserva el anterior."
          local prev
          prev=$(ls -1t "$APP_DIR"/.runtime/bin/ffmpeg.bak.* 2>/dev/null | head -n1 || true)
          if [ -n "$prev" ]; then cp -f "$prev" "$APP_DIR/.runtime/bin/ffmpeg"; fi
          return 1
        fi
      fi

      echo "  [OK] Binario de XUI.one instalado en $APP_DIR/.runtime/bin/ffmpeg"
      "$APP_DIR/.runtime/bin/ffmpeg" -version 2>/dev/null | head -n1 | sed 's/^/       /'

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
  esac
}

cmd_catv() {
  # Comprobación de la salida UDP/CATV: qué envía el panel, qué lleva el CSV
  # y si el modulador es alcanzable. Uso: tvlister-admin catv [check] [id_equipo]
  local mode="${1:-check}"
  local unit_id="${2:-}"
  cd "$APP_DIR"
  case "$mode" in
    check | "" | show)
      CATV_UNIT_ID="$unit_id" "$NODE_BIN" --no-warnings --input-type=module -e '
        import { initDb } from "./server/db.js";
        import { verifyCatv } from "./server/catvVerify.js";
        initDb();
        const unitId = process.env.CATV_UNIT_ID ? Number(process.env.CATV_UNIT_ID) : null;
        const r = await verifyCatv({ unitId, ping: true, workerSource: "external" });
        if (r.error) {
          console.error("  " + r.error);
          process.exit(1);
        }
        if (!r.units.length) {
          console.log("  No hay moduladores dados de alta. Crea uno en UDP / CATV.");
          process.exit(0);
        }
        const mark = (c) => (c.ok ? "[OK] " : c.level === "error" ? "[!!] " : "[!]  ");
        for (const u of r.units) {
          const errs = u.checks.filter((c) => !c.ok && c.level === "error").length;
          const warns = u.checks.filter((c) => !c.ok && c.level === "warn").length;
          console.log("");
          console.log("============================================================");
          console.log("  " + u.unit.name + "  ·  " + u.unit.dest_ip + "  ·  " + u.carriers.length + " portadoras");
          console.log("============================================================");
          for (const c of u.checks) {
            console.log("  " + mark(c) + c.title);
            if (c.detail) console.log("         " + c.detail);
          }
          const assigned = u.carriers.filter((c) => c.has_source);
          console.log("");
          console.log("  Portadoras del equipo: " + u.carriers.length +
            "  ·  con canal asignado: " + assigned.length +
            "  ·  habilitadas: " + u.carriers.filter((c) => c.enabled).length);
          for (const c of u.carriers.slice(0, 6)) {
            console.log(
              "   P" + String(c.carrier).padEnd(3) +
              "CH" + String(c.catv_ch).padEnd(4) +
              String(c.freq_mhz + " MHz").padEnd(11) +
              (c.udp_host + ":" + c.udp_port).padEnd(23) +
              (c.has_source ? (c.enabled ? "ON  " : "off ") : "sin canal") +
              "  " + c.name
            );
          }
          console.log("");
          console.log("  --- Página CANALES del equipo (canal + frecuencia) ---");
          console.log("  P\tCanal\tMHz vídeo\tMHz audio\tNombre");
          for (const line of u.channelText.split("\n").slice(0, 6)) console.log("  " + line);
          if (u.carriers.length > 6) console.log("  ... (" + (u.carriers.length - 6) + " portadoras más)");
          console.log("");
          console.log("  --- Página ENTRADA / Input (grupo o IP + puerto UDP) ---");
          console.log("  P\tIP/Grupo\tPuerto\tCanal\tNombre");
          for (const line of u.mappingText.split("\n").slice(0, 6)) console.log("  " + line);
          if (u.carriers.length > 6) console.log("  ... (" + (u.carriers.length - 6) + " portadoras más)");
          console.log("");
          console.log("  Descargas: csv -> plan completo · channel -> página de canales");
          console.log("             input -> página de entrada UDP · Import -> plantilla del equipo");
          console.log("");
          console.log("  Resultado: " + (u.checks.length - errs - warns) + " OK, " + warns + " aviso(s), " + errs + " error(es)");
        }
        console.log("");
        console.log("  Recuerda: el CSV de canales cambia canal, frecuencia y nombre.");
        console.log("  La IP/puerto UDP se cargan en la página Input/Mapping del modulador.");
        console.log("  En multicast NO se hace ping al grupo: es normal que no responda.");
        console.log("============================================================");
      '
      ;;
    fill)
      # Llena las portadoras del plan con los canales del panel, en orden.
      # Por defecto sólo MUESTRA lo que haría; escribe con --apply.
      local apply="0" force="0" from="" to=""
      for a in "${@:2}"; do
        case "$a" in
          --apply) apply="1" ;;
          --force) force="1" ;;
          ""|--*) ;;
          *)
            if [ -z "$from" ]; then from="$a"; else to="$a"; fi
            ;;
        esac
      done
      from="${from:-2}"
      to="${to:-125}"
      CATV_APPLY="$apply" CATV_FORCE="$force" CATV_FROM="$from" CATV_TO="$to" \
        "$NODE_BIN" --no-warnings --input-type=module -e '
        import { initDb, db } from "./server/db.js";
        import { ensureCatvSlotsInitialized, unitChannelList, computeDefaultUdpAddress } from "./server/wk2500Manager.js";
        initDb();
        ensureCatvSlotsInitialized();
        const apply = process.env.CATV_APPLY === "1";
        const force = process.env.CATV_FORCE === "1";
        const from = Math.max(2, Number(process.env.CATV_FROM) || 2);
        const to = Math.min(125, Number(process.env.CATV_TO) || 125);

        const units = db.prepare("SELECT * FROM wk2500_units WHERE enabled = 1 ORDER BY id ASC").all();
        if (!units.length) {
          console.log("  No hay moduladores dados de alta. Crea los equipos primero.");
          process.exit(1);
        }
        const covered = new Set();
        const unitOf = new Map();
        for (const u of units) {
          for (const ch of unitChannelList(u)) {
            covered.add(Number(ch));
            unitOf.set(Number(ch), u);
          }
        }

        const slots = db.prepare("SELECT catv_ch, stream_id, enabled, udp_host, udp_port FROM wk2500_channels ORDER BY catv_ch ASC").all();

        // Reparar el destino de TODAS las portadoras del plan (con o sin canal):
        // si el equipo se creó antes de aplicar su base, quedaron en 239.25.0.x.
        let addrPlanFixed = 0;
        if (apply) {
          const fixAddr = db.prepare(
            "UPDATE wk2500_channels SET udp_host = ?, udp_port = ?, updated_at = CURRENT_TIMESTAMP WHERE catv_ch = ?"
          );
          db.exec("BEGIN IMMEDIATE;");
          try {
            for (const slot of slots) {
              const ch = Number(slot.catv_ch);
              if (ch < from || ch > to || !covered.has(ch)) continue;
              const u = unitOf.get(ch);
              const a = computeDefaultUdpAddress(ch, u.ip_mode, u.dest_ip, u.base_port);
              if (slot.udp_host !== a.udp_host || Number(slot.udp_port) !== Number(a.udp_port)) {
                fixAddr.run(a.udp_host, a.udp_port, ch);
                addrPlanFixed += 1;
              }
            }
            db.exec("COMMIT;");
          } catch (e) {
            db.exec("ROLLBACK;");
            throw e;
          }
        }
        const streams = db.prepare("SELECT id, name FROM streams ORDER BY sort_order ASC, id ASC").all();
        const already = slots.filter((s) => s.stream_id).length;

        // Los canales que ya están en otra portadora no se repiten: se usa la
        // lista de libres para que el fill continúe donde se quedó.
        const usedIds = new Set(slots.filter((s) => s.stream_id).map((s) => Number(s.stream_id)));
        const free = force ? streams.slice() : streams.filter((st) => !usedIds.has(Number(st.id)));
        const pending = [];
        let si = 0;
        for (const slot of slots) {
          const ch = Number(slot.catv_ch);
          if (ch < from || ch > to) continue;
          if (!covered.has(ch)) continue;
          if (slot.stream_id && !force) continue;
          if (si >= free.length) break;
          pending.push({ catv_ch: ch, stream: free[si], slot });
          si += 1;
        }

        console.log("");
        console.log("============================================================");
        console.log("  Asignar canales del panel a las portadoras del plan");
        console.log("============================================================");
        console.log("  Moduladores        : " + units.length + " (" + covered.size + " portadoras)");
        console.log("  Canales en el panel: " + streams.length);
        console.log("  Ya asignados       : " + already);
        console.log("  Rango              : CH " + from + " al " + to);
        console.log("  Canales libres     : " + free.length);
        console.log("  A asignar ahora    : " + pending.length + (force ? "  (--force: reemplaza los existentes)" : ""));
        const inRange = slots.filter(
          (x) => covered.has(Number(x.catv_ch)) && Number(x.catv_ch) >= from && Number(x.catv_ch) <= to
        ).length;
        if (pending.length && pending.length < inRange) {
          console.log("  (" + (inRange - pending.length) + " portadora(s) quedarían sin canal del panel)");
        }
        console.log("");

        if (!pending.length) {
          if (!streams.length) console.log("  [AVISO] El panel no tiene canales todavía. Impórtalos o créalos primero.");
          else console.log("  [OK] No queda nada por asignar en ese rango.");
          if (addrPlanFixed) {
            console.log("  [OK] " + addrPlanFixed + " destino(s) UDP corregidos con la base de cada modulador.");
          }
          console.log("============================================================");
          process.exit(0);
        }

        console.log("  Portadora  Canal  Canal del panel");
        for (const p of pending.slice(0, 12)) {
          console.log("   CH" + String(p.catv_ch).padEnd(6) + "  " + String(p.stream.id).padStart(4) + "   " + p.stream.name);
        }
        if (pending.length > 12) console.log("   ... (" + (pending.length - 12) + " más)");
        console.log("");

        if (!apply) {
          console.log("  Esto es sólo una vista previa. Para aplicarlo:");
          console.log("    tvlister-admin catv fill --apply      # asigna y marca para emitir");
          console.log("============================================================");
          process.exit(0);
        }

        const upd = db.prepare(
          "UPDATE wk2500_channels SET stream_id = ?, enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE catv_ch = ?"
        );
        // Si la portadora no tenía destino UDP (equipo creado sin aplicar), se
        // calcula con la IP/puerto base de su modulador.
        const updAddr = db.prepare(
          "UPDATE wk2500_channels SET stream_id = ?, enabled = 1, udp_host = ?, udp_port = ?, updated_at = CURRENT_TIMESTAMP WHERE catv_ch = ?"
        );
        let addrFixed = 0;
        db.exec("BEGIN IMMEDIATE;");
        try {
          for (const p of pending) {
            // El destino se recalcula con la base del modulador que sirve el
            // canal: si quedó con la dirección de fábrica (239.25.0.x) es un
            // plan a medio aplicar y aquí se corrige.
            const u = unitOf.get(Number(p.catv_ch));
            const a = computeDefaultUdpAddress(p.catv_ch, u.ip_mode, u.dest_ip, u.base_port);
            if (p.slot.udp_host !== a.udp_host || Number(p.slot.udp_port) !== Number(a.udp_port)) {
              updAddr.run(p.stream.id, a.udp_host, a.udp_port, p.catv_ch);
              addrFixed += 1;
            } else {
              upd.run(p.stream.id, p.catv_ch);
            }
          }
          db.exec("COMMIT;");
        } catch (e) {
          db.exec("ROLLBACK;");
          throw e;
        }
        const on = db.prepare("SELECT COUNT(*) c FROM wk2500_channels WHERE enabled = 1 AND stream_id IS NOT NULL").get().c;
        console.log("  [OK] Asignadas " + pending.length + " portadoras. Ahora hay " + on + " listas para emitir.");
        if (addrFixed + addrPlanFixed) {
          console.log(
            "       (" + (addrFixed + addrPlanFixed) +
              " destino(s) UDP del plan corregidos con la base de cada modulador)"
          );
        }
        console.log("");
        console.log("  Enciéndelas con:  tvlister-admin restart   (o el botón \"Iniciar todo\" en UDP / CATV)");
        console.log("  Comprueba con:    tvlister-admin catv check");
        console.log("============================================================");
      '
      ;;
    watch)
      # Mide de verdad lo que llega al grupo de cada modulador: se une al
      # multicast, cuenta bytes y paquetes durante N segundos y los desglosa
      # por PID. Detecta exceso de Mbps, desbalance entre canales y paquetes
      # duplicados (dos emisores al mismo grupo).
      # Uso: tvlister-admin catv watch [--secs N] [--ch 2,3,5] [--ip 192.168.200.8] [id_equipo]
      local secs="5" chans="" bind="" prev="" arg
      local -a posargs=()
      for arg in "${@:2}"; do
        case "$arg" in
          --secs=*) secs="${arg#*=}" ; prev="" ;;
          --ch=*) chans="${arg#*=}" ; prev="" ;;
          --ip=*) bind="${arg#*=}" ; prev="" ;;
          --secs | --ch | --ip) prev="$arg" ;;
          "")
            prev=""
            ;;
          *)
            case "$prev" in
              --secs) secs="$arg" ; prev="" ;;
              --ch) chans="$arg" ; prev="" ;;
              --ip) bind="$arg" ; prev="" ;;
              *) posargs+=("$arg") ; prev="" ;;
            esac
            ;;
        esac
      done
      # Un argumento suelto (sin --flag) se interpreta como id de equipo.
      if [ "${#posargs[@]}" -gt 0 ] && [ -z "$unit_id" ]; then
        unit_id="${posargs[0]}"
      fi
      CATV_SECS="$secs" CATV_CHANNELS="$chans" CATV_IP="$bind" CATV_UNIT_ID="$unit_id" \
        "$NODE_BIN" --no-warnings --input-type=module -e '
        import { initDb } from "./server/db.js";
        import { watchCatvOutput } from "./server/catvWatch.js";
        initDb();

        const secs = Math.max(1, Number(process.env.CATV_SECS) || 5);
        const rawCh = String(process.env.CATV_CHANNELS || "").trim();
        const channels = rawCh
          ? rawCh.split(",").map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n) && n > 0)
          : null;
        const unitId = process.env.CATV_UNIT_ID ? Number(process.env.CATV_UNIT_ID) : null;
        const bindIp = String(process.env.CATV_IP || "").trim();

        const pad = (s, n) => String(s).padEnd(n);
        const padl = (s, n) => String(s).padStart(n);
        const mbps = (kbps) => (Number(kbps || 0) / 1000).toFixed(2);

        const r = await watchCatvOutput({ unitId, channels, seconds: secs, bindIp });
        if (r.error) {
          console.error("  " + r.error);
          process.exit(1);
        }

        console.log("");
        console.log("============================================================");
        console.log("  TVLister 24/7 - Medición real del UDP hacia los moduladores");
        console.log("  " + r.results.length + " canal(es) · " + secs + " s cada uno (≈" +
          Math.ceil((r.results.length * secs) / 60) + " min en total) · interfaz: " +
          (bindIp || "automática (la del canal)"));
        console.log("  Se mide lo MISMO que recibe el modulador: se une al grupo y cuenta.");
        console.log("============================================================");
        console.log("");
        console.log("  " + pad("CANAL", 7) + pad("EQUIPO", 17) + pad("DESTINO UDP", 24) +
          padl("MEDIDO", 11) + padl("PKT/S", 8) + padl("DECLARADO", 12) + "  PIDs");

        const measured = [];
        for (const row of r.results) {
          const m = row.measured;
          const dest = row.udp_host + ":" + row.udp_port;
          const pids = (m.pids || []).filter((p) => p.kbps > 0).slice(0, 3)
            .map((p) => p.label).join(" ");
          const unitLabel = (row.unit_name || "-").slice(0, 16);
          console.log(
            "  CH" + pad(row.catv_ch, 5) +
            pad(unitLabel, 17) +
            pad(dest, 24) +
            padl(mbps(m.kbps) + " Mbps", 11) +
            padl(m.pps || 0, 8) +
            padl(mbps(row.declared_kbps) + " Mbps", 12) +
            "  " + (pids || "-")
          );
          if (m.kbps > 0) measured.push(m.kbps);
          for (const f of row.flags) {
            const tag = f.level === "error" ? "[!!]" : "[!] ";
            console.log("        " + tag + " " + f.text);
          }
          if (row.flags.length) {
            const src = String(row.source || "-");
            const srcShort = src.length > 74 ? src.slice(0, 71) + "..." : src;
            console.log("        origen: " + srcShort);
            console.log("        motor : " + (row.output_mode || "direct_spts") +
              " · muxrate (CBR): " + (Number(row.muxrate_kbps) || 0) + " kbps" +
              (Number(row.muxrate_kbps) ? "" : "  <- sin límite: la salida va al ritmo del origen"));
          }
          if (m.duplicates > 0) {
            console.log("        [!!] " + m.duplicates + " paquete(s) con el mismo continuity_counter → el mismo TS llega más de una vez");
          }
        }

        // Desbalance: desviación grande respecto a la mediana real del conjunto.
        const sorted = [...measured].sort((a, b) => a - b);
        const median = sorted.length
          ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2))
          : 0;
        if (measured.length >= 3 && median > 0) {
          const off = r.results.filter((x) => x.measured.kbps > 0 && (x.measured.kbps > median * 2 || x.measured.kbps < median * 0.5));
          console.log("");
          console.log("  Mediana del conjunto: " + mbps(median) + " Mbps");
          if (!off.length) {
            console.log("  [OK] Los canales están balanceados: ninguno se sale de ±2× la mediana.");
          } else {
            console.log("  [!!] DESBALANCEADOS (" + off.length + "): " +
              off.map((x) => "CH" + x.catv_ch + " " + mbps(x.measured.kbps) + " Mbps").join(" · "));
          }
        }

        const s = r.summary;
        console.log("");
        console.log("------------------------------------------------------------");
        console.log("  Total medido: " + mbps(s.total_kbps) + " Mbps · media " + mbps(s.average_kbps) +
          " Mbps · máximo " + mbps(s.max_kbps) + " Mbps · mínimo " + mbps(s.min_kbps) + " Mbps");
        console.log("  Canales con problema: " + s.with_problems + " de " + s.channels);
        console.log("");
        console.log("  Cómo se lee:");
        console.log("   - MEDIDO > DECLARADO por 2× o más  -> el emisor manda de más");
        console.log("     (fuente gorda, ráfagas al reconectar o dos motores al mismo grupo).");
        console.log("   - PAQUETES DUPLICADOS              -> hay OTRO emisor en el mismo grupo");
        console.log("     (Flussonic, otro TVLister o dos equipos con la misma dirección).");
        console.log("   - NO LLEGA NADA                    -> el grupo no entra por esta NIC;");
        console.log("     repite con --ip <IP de la NIC de los moduladores>.");
        console.log("============================================================");
      '
      ;;
    *)
      echo "Uso: tvlister-admin catv [check|fill|watch] [id_equipo] [--apply]"
      echo "     tvlister-admin catv watch [--secs 5] [--ch 2,3,5] [--ip 192.168.200.8]"
      return 1
      ;;
  esac
}

cmd_tune() {
  # Configuración recomendada según el hardware real de este servidor.
  # Uso: tvlister-admin tune [show|apply]
  local mode="${1:-show}"
  cd "$APP_DIR"
  case "$mode" in
    show | "")
      TUNE_MODE=show "$NODE_BIN" --no-warnings --input-type=module -e '
        import { initDb } from "./server/db.js";
        import { computeRecommendation } from "./server/tune.js";
        initDb();
        const r = computeRecommendation();
        const h = r.hardware;
        const w = r.workload;
        const pad = (s, n) => String(s).padEnd(n);
        console.log("============================================================");
        console.log("  TVLister 24/7 — Configuracion recomendada para este equipo");
        console.log("============================================================");
        console.log("  Nucleos            : " + h.cores);
        console.log("  RAM                : " + h.ramMb + " MB");
        console.log("  RAMDisk (/dev/shm) : " + (h.shm.exists
          ? h.shm.totalMb + " MB totales, " + h.shm.freeMb + " MB libres"
          : "no disponible (se usa disco)"));
        console.log("  Ventana HLS        : ~" + h.neededMb + " MB (peor caso: GOP de 4 s)");
        console.log("  Canales            : " + w.total + " (" + w.transcode + " en el motor, " +
          w.reencode + " re-codificando, " + w.audioLeveled + " con audio nivelado)");
        console.log("  Moduladores CATV   : " + w.units + " equipos, " + w.catvEnabled + "/" + w.catvSlots + " canales activos");
        console.log("  Perfil detectado   : " + r.summary.profile);
        console.log("");
        console.log("  Ajuste                 Actual        Recomendado");
        console.log("  ----------------------------------------------------------");
        for (const i of r.items) {
          const mark = i.changed ? " *" : "  ";
          console.log(mark + " " + pad(i.label, 34) + pad(i.current, 13) + i.recommended);
        }
        console.log("  ----------------------------------------------------------");
        console.log("  (*) = distinto de lo recomendado");
        console.log("");
        if (r.warnings.length) {
          console.log("  AVISOS:");
          for (const x of r.warnings) console.log("   - " + x);
          console.log("");
        }
        if (r.summary.upToDate) {
          console.log("  [OK] La configuracion ya es la recomendada.");
        } else {
          console.log("  Aplicar con: tvlister-admin tune apply");
        }
        console.log("============================================================");
      '
      ;;
    apply)
      TUNE_MODE=apply "$NODE_BIN" --no-warnings --input-type=module -e '
        import { initDb } from "./server/db.js";
        import { applyRecommendation } from "./server/tune.js";
        import { invalidateFfmpegEfficiencyCache } from "./server/streamEngine.js";
        initDb();
        const { applied, recommendation } = applyRecommendation();
        if (!applied.length) {
          console.log("  [OK] Nada que cambiar: ya estaba en los valores recomendados.");
        } else {
          console.log("  Aplicados " + applied.length + " ajuste(s):");
          for (const a of applied) {
            console.log("   - " + a.key + ": " + a.from + " -> " + a.to);
          }
        }
        invalidateFfmpegEfficiencyCache();
        for (const w of recommendation.warnings) console.log("  [AVISO] " + w);
        console.log("");
        console.log("  Aplica a todos los canales con: tvlister-admin restart");
      '
      ;;
    *)
      echo "Uso: tvlister-admin tune [show|apply]"
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
  catv)
    shift
    cmd_catv "$@"
    ;;  update)
    cmd_update
    ;;
  release)
    cmd_release "${2:-latest}"
    ;;
  tune)
    cmd_tune "${2:-show}"
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
    echo " 16) Motor FFmpeg: ver, elegir, instalar o copiar el de XUI.one (ffmpeg)"
    echo " 17) Instalar/actualizar desde un release publicado (release)"
    echo " 18) Configuracion recomendada segun el hardware (tune)"
    echo " 19) Comprobar salida UDP/CATV hacia los moduladores (catv check)"
    echo " 20) Asignar canales del panel a las portadoras CATV (catv fill)"
    echo " 21) Medir el UDP real que llega (Mbps, duplicados, desbalance) (catv watch)"
    echo "  0) Salir"
    echo "============================================================"
    read -r -p "Selecciona una opción [0-21]: " opt
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
      18) cmd_tune "show" ;;
      19) cmd_catv "check" "" ;;
      20) cmd_catv "fill" "" ;;
      21) cmd_catv "watch" "" ;;
      *) exit 0 ;;
    esac
    ;;
esac
exit 0
}
