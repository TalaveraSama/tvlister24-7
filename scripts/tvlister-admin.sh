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
  # Copia CONSISTENTE con el panel encendido (VACUUM INTO). Un `cp` del .db en
  # modo WAL se lleva la base sin lo que aún está en el .db-wal y puede salir
  # corrupto justo el día que hace falta.
  local ts out
  ts=$(date +%Y%m%d_%H%M%S)
  out="/root/tvlister247_backup_${ts}.db"
  cd "$APP_DIR"
  if OUT_PATH="$out" "$NODE_BIN" --no-warnings --input-type=module -e '
      import { initDb } from "./server/db.js";
      import { backupDatabaseTo } from "./server/backupScheduler.js";
      initDb();
      const r = backupDatabaseTo(process.env.OUT_PATH);
      console.log(`✅ Copia de seguridad consistente: ${r.path} (${r.sizeMb} MB)`);
    '; then
    :
  else
    echo "⚠️  No se pudo usar VACUUM INTO; copiando db + wal + shm juntos..."
    cp "${APP_DIR}/data/tvlister.db" "$out"
    cp "${APP_DIR}/data/tvlister.db-wal" "${out}-wal" 2>/dev/null || true
    echo "✅ Copia guardada en: ${out} (con su WAL)"
  fi
  find /root -maxdepth 1 -name "tvlister247_backup_*.db*" -mtime +7 -delete 2>/dev/null || true
  echo "   Retención: 7 días en /root"
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

cmd_health() {
  # Salud del sistema en producción 24/7: lo mismo que ve el panel en
  # /api/system/stability, pero desde la consola y con código de salida.
  local mode="${1:-}"
  local port
  port=$(get_current_port)
  cd "$APP_DIR"
  echo "============================================================"
  echo "  TVLister 24/7 — Salud del sistema (24/7)"
  echo "============================================================"
  case "$mode" in
    --vacuum)
      VAC_MODE=1 "$NODE_BIN" --no-warnings --input-type=module -e '
        import { initDb } from "./server/db.js";
        import { vacuumDatabase } from "./server/stability.js";
        initDb();
        const r = vacuumDatabase();
        console.log(`  Base compactada: ${r.beforeMb.toFixed(1)} MB -> ${r.afterMb.toFixed(1)} MB (espacio muerto ${(r.freeRatio*100).toFixed(0)} %)`);
      '
      echo "============================================================"
      return 0
      ;;
    --clean)
      CLEAN_MODE=1 "$NODE_BIN" --no-warnings --input-type=module -e '
        import { initDb } from "./server/db.js";
        import { cleanStaleWorkDirs, runDbMaintenance } from "./server/stability.js";
        initDb();
        const dirs = cleanStaleWorkDirs();
        const m = runDbMaintenance({ walThresholdMb: 0 });
        console.log(`  Directorios sin worker liberados: ${dirs.length}`);
        console.log(`  Conexiones zombis borradas       : ${m.purgedConnections}`);
        console.log(`  WAL recortado                    : ${m.walCheckpoint ? "sí" : "no hacía falta"}`);
      '
      echo "============================================================"
      return 0
      ;;
    --orphans)
      ORPH_MODE=1 "$NODE_BIN" --no-warnings --input-type=module -e '
        import { initDb } from "./server/db.js";
        import { countOrphanWorkers, reapOrphanWorkers } from "./server/stability.js";
        const before = await countOrphanWorkers();
        if (!before.length) { console.log("  Procesos huérfanos: ninguno"); process.exit(0); }
        console.log(`  Huérfanos encontrados: ${before.join(", ")} -> terminando...`);
        const r = await reapOrphanWorkers();
        console.log(`  Terminados: ${r.killed}`);
      '
      echo "============================================================"
      return 0
      ;;
  esac

  local rc=0
  # `set -e` está activo: el informe sale con código 1 si hay fallas, así que
  # se captura sin abortar la comprobación HTTP que viene después.
  PANEL_PORT="$port" "$NODE_BIN" --no-warnings --input-type=module -e '
    import { initDb } from "./server/db.js";
    import { getStabilityReport, startLoopMonitoring, countOrphanWorkers } from "./server/stability.js";
    initDb();
    startLoopMonitoring();
    await new Promise((r) => setTimeout(r, 300));
    const rep = await getStabilityReport({ deep: true });
    const tag = { ok: "[OK]  ", warn: "[AVISO]", fail: "[FALLA]" };
    for (const c of rep.checks) {
      console.log(`  ${tag[c.level] || "[?]"} ${c.label}: ${c.detail}`);
    }
    console.log("------------------------------------------------------------");
    console.log(`  Veredicto: ${rep.verdict === "ok" ? "todo en orden" : rep.verdict === "warn" ? "funciona, con avisos" : "hay fallas que corregir"}`);
    process.exit(rep.fails ? 1 : 0);
  ' || rc=$?
  if curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
    echo "  [OK]   HTTP: /api/health responde en el puerto ${port}"
  else
    echo "  [FALLA] HTTP: el panel no responde en 127.0.0.1:${port}"
    rc=1
  fi
  echo "============================================================"
  if [ "$rc" -ne 0 ]; then
    echo "  Hay puntos en FALLA. Revisa el detalle de arriba."
  else
    echo "  Sin fallas. Para mantenimiento: health --clean | health --vacuum | health --orphans"
  fi
  return "$rc"
}

# ==================== PRUEBA DE REPRODUCCIÓN (canal de punta a punta) ======
# Uso: tvlister-admin streams-check [usuario] [contraseña] [id_canal]
#
# Recorre el mismo camino que un cliente IPTV: pide get.php al panel, toma el
# primer canal de la lista, descarga ese enlace y después el primer segmento.
# Así se ve en qué eslabón se rompe: panel, dominio público, nginx, TLS, o la
# propia fuente del canal.
# ==================== CÓDIGOS DE ACCESO AL PANEL (estilo XUI.one) ==========
# Uso:
#   tvlister-admin access-code                 lista los códigos
#   tvlister-admin access-code add <codigo> [admin|admin_api|reseller] [nota]
#   tvlister-admin access-code on <codigo|id>
#   tvlister-admin access-code off [codigo|id]   (sin argumento: apaga todos)
#   tvlister-admin access-code rm <codigo|id>
#   tvlister-admin access-code url <codigo>      enlace con el código incluido
# ==================== PUERTO DE SALIDA DE LOS STREAMS ======================
# Uso:
#   tvlister-admin streams-port                 estado actual y por qué
#   tvlister-admin streams-port 80  [dominio]   enlaces por  http://dominio
#   tvlister-admin streams-port 443 [dominio]   enlaces por  https://dominio
#   tvlister-admin streams-port 8095 [dominio]  enlaces por  http://dominio:8095
#   tvlister-admin streams-port auto            sigue el host de la petición
#
# Los enlaces que se entregan en get.php/player_api.php salen por el MISMO
# host y puerto con el que el cliente pidió la lista (o por lo que diga el
# ajuste public_stream_base). Este comando fija ese ajuste.
cmd_streams_port() {
  local want="${1:-status}" domain="${2:-}"
  local port
  port=$(get_current_port)
  cd "$APP_DIR" || return 1

  local out
  out=$(SP_WANT="$want" SP_DOMAIN="$domain" SP_MAINPORT="$port" "$NODE_BIN" --no-warnings --input-type=module -e '
    import { initDb, db } from "./server/db.js";
    initDb();

    const want = String(process.env.SP_WANT || "status").trim().toLowerCase();
    const givenDomain = String(process.env.SP_DOMAIN || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    const mainPort = Number(process.env.SP_MAINPORT) || 8095;

    const get = (k) => String(db.prepare("SELECT value FROM settings WHERE key = ?").get(k)?.value || "").trim();
    const set = (k, v) => db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v);
    const del = (k) => db.prepare("DELETE FROM settings WHERE key = ?").run(k);

    const current = get("public_stream_base");
    const panelDomain = get("panel_domain");

    const showPort = (base) => {
      const m = String(base).match(/^([a-z]+):\/\/([^/:]+)(?::(\d+))?/i);
      if (!m) return null;
      const scheme = m[1].toLowerCase();
      const host = m[2];
      const explicit = m[3] ? Number(m[3]) : null;
      const port = explicit || (scheme === "https" ? 443 : 80);
      return { scheme, host, port, explicit, implicit: explicit === null };
    };

    if (want === "status" || want === "") {
      console.log("============================================================");
      console.log("  Puerto por donde salen los streams");
      console.log("============================================================");
      if (current) {
        const p = showPort(current);
        console.log("  Base pública fija : " + current);
        console.log("  Puerto            : " + (p ? p.port + (p.implicit ? " (" + p.scheme + " por defecto, sin :" + p.port + " en el enlace)" : "") : "?"));
        console.log("  Todos los enlaces de video (playlist, .m3u8, .ts, VOD) usan esa base,");
        console.log("  sin importar por qué puerto entre el cliente.");
      } else {
        console.log("  Sin base fija: los enlaces salen por el MISMO host y puerto de la petición.");
        console.log("");
        console.log("   el cliente abre                       los enlaces salen por");
        console.log("   ------------------------------------  --------------------------------");
        console.log("   http://DOMINIO/            (80)       http://DOMINIO/...            (80)");
        console.log("   https://DOMINIO/           (443)      https://DOMINIO/...           (443)");
        console.log("   http://IP:" + mainPort + "/            (8095)     http://IP:" + mainPort + "/...         (8095)");
        console.log("");
        console.log("  O sea: si entra por el dominio sin puerto, ya sale por el 80.");
      }
      console.log("");
      console.log("  Fijarlo a un puerto concreto:");
      console.log("     tvlister-admin streams-port 80  midominio.com      # el más común");
      console.log("     tvlister-admin streams-port 443 midominio.com");
      console.log("     tvlister-admin streams-port 8095 midominio.com");
      console.log("     tvlister-admin streams-port auto                  # quitar la fijación");
      console.log("============================================================");
      process.exit(0);
    }

    if (want === "auto" || want === "clear" || want === "off") {
      del("public_stream_base");
      console.log("✅ Sin base fija: los enlaces vuelven a seguir el host y puerto de la petición.");
      console.log("   (por el dominio sin puerto → 80; por https → 443; por IP:" + mainPort + " → " + mainPort + ")");
      process.exit(0);
    }

    const num = Number(want);
    if (![80, 443, 8095, 8080, 8880, 2052].includes(num) && !(num >= 1 && num <= 65535)) {
      console.error("❌ Puerto no válido: " + want);
      process.exit(1);
    }

    let host = givenDomain;
    if (!host) {
      const base = current ? showPort(current) : null;
      host = base?.host || panelDomain || "";
    }
    if (!host) {
      console.error("❌ Falta el dominio. Uso: tvlister-admin streams-port " + num + " midominio.com");
      console.error("   (o define antes el dominio del panel con: tvlister-admin cloudflare <panel> [streams])");
      process.exit(1);
    }

    const scheme = num === 443 ? "https" : "http";
    const base = num === 80 || num === 443 ? scheme + "://" + host : scheme + "://" + host + ":" + num;
    set("public_stream_base", base);

    console.log("✅ Base pública de streaming: " + base);
    console.log("   Todos los enlaces de video saldrán por el puerto " + num + ".");
    console.log("");
    if (num === 80) {
      console.log("   Requisitos en el puerto 80:");
      console.log("     · Un server block que atienda " + host + " y haga proxy a 127.0.0.1:" + mainPort + ".");
      console.log("       (lo crea: tvlister-admin cloudflare " + (panelDomain || "<dominio_del_panel>") + " " + host + ")");
      console.log("     · Ese nombre debe resolver al servidor (registro A) y NO estar en naranja en");
      console.log("       Cloudflare si se usa para video: el proxy de Cloudflare no sirve para");
      console.log("       streaming continuo. Déjalo en GRIS.");
    } else if (num === 443) {
      console.log("   Requisitos en el 443: server block con certificado válido para " + host + ".");
      console.log("     (Origin Certificate de Cloudflare + cloudflare ... --cert/--key, o Let\u2019s Encrypt)");
    } else {
      console.log("   El puerto " + num + " debe estar abierto en el firewall y ser alcanzable desde");
      console.log("   los clientes. Muchos reproductores y algunas redes bloquean puertos altos.");
      console.log("     tvlister-admin add-port " + num + "   # si el panel debe atenderlo él mismo");
    }
    console.log("");
    console.log("   Aplica al instante (se lee de la base en cada petición). Comprueba con:");
    console.log("     tvlister-admin streams-check");
  ' 2>&1)
  echo "$out"

  # --- Comprobaciones del mundo real: DNS y server block -------------------
  # Si la base acaba de quedar fijada, esto evita el clásico «puse el dominio
  # de los streams y no se ve nada»: o el nombre no resuelve, o ningún server
  # block lo atiende.
  local base_host
  base_host=$(printf '%s\n' "$out" | sed -n 's/.*Base pública de streaming: *[a-z]*:\/\/\([^\/:]*\).*/\1/p' | head -1)
  if [ -n "$base_host" ]; then
    if getent hosts "$base_host" >/dev/null 2>&1; then
      local dip sip
      dip=$(getent ahostsv4 "$base_host" 2>/dev/null | awk 'NR==1{print $1}')
      sip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)
      if [ -n "$sip" ] && [ -n "$dip" ] && [ "$sip" != "$dip" ]; then
        echo "   [AVISO] $base_host resuelve a $dip, no a este servidor ($sip)."
        echo "           Los clientes no llegarán al video hasta arreglar el registro A/DNS."
        if [ "$dip" != "" ] && printf '%s' "$dip" | grep -Eq '^(104\.|172\.6[4-9]\.|172\.7[0-1]\.|188\.114\.|162\.15[89]\.|173\.245\.|141\.101\.|108\.162\.|190\.93\.|198\.41\.|131\.0\.72\.|103\.2[12]\.|197\.234\.|103\.31\.)'; then
          echo "           Esa IP es de Cloudflare: el registro está en NARANJA (proxied)."
          echo "           Para video tiene que estar en GRIS (DNS only)."
        fi
      fi
    else
      echo "   [AVISO] $base_host no resuelve todavía. Crea el registro A en el DNS."
    fi
    local served=""
    for f in /home/xui/bin/nginx/conf/servers/*.conf /etc/nginx/conf.d/*.conf /etc/nginx/sites-enabled/*; do
      [ -f "$f" ] || continue
      if grep -Eq "^[[:space:]]*server_name[^;]*\b${base_host//./\\.}\b" "$f" 2>/dev/null; then served="$f"; break; fi
    done
    if [ -n "$served" ]; then
      echo "   [OK]    Server block que atiende $base_host: $served"
    else
      echo "   [AVISO] Ningún server block atiende $base_host todavía."
      echo "           Créalo con:  tvlister-admin cloudflare <dominio_del_panel> $base_host"
    fi
  fi
}

cmd_access_code() {
  local action="${1:-list}" arg1="${2:-}" arg2="${3:-}" arg3="${4:-}"
  cd "$APP_DIR" || return 1

  case "$action" in
    list | ls | "")
      AC_ACTION="list" "$NODE_BIN" --no-warnings --input-type=module -e '
        import { initDb, db } from "./server/db.js";
        import { listAccessCodes } from "./server/accessCodes.js";
        initDb();
        const rows = listAccessCodes();
        const state = {
          get: (k) => db.prepare("SELECT value FROM settings WHERE key = ?").get(k)
        };
        console.log("============================================================");
        console.log("  Códigos de acceso al panel (estilo XUI.one)");
        console.log("============================================================");
        if (!rows.length) {
          console.log("  No hay códigos: el panel está ABIERTO (solo el login lo protege).");
          console.log("  Crea uno con:  tvlister-admin access-code add micodigo admin");
          console.log("============================================================");
          process.exit(0);
        }
        for (const r of rows) {
          const estado = r.enabled ? "ON " : "OFF";
          const usos = String(r.uses).padStart(4, " ");
          const ultimo = r.last_used_at || "nunca";
          console.log(`  [${estado}] #${String(r.id).padEnd(3)} ${r.code.padEnd(24)} ${(r.typeLabel || r.type).padEnd(11)} usos:${usos}  último: ${ultimo}`);
          if (r.notes) console.log(`         nota: ${r.notes}`);
        }
        const activos = rows.filter((r) => r.enabled).length;
        const forzado = String(state.get("panel_gate_required")?.value || "") === "1";
        console.log("------------------------------------------------------------");
        if (activos > 0) {
          console.log(`  ${activos} código(s) activo(s): el panel pide código antes del login.`);
        } else if (forzado) {
          console.log("  Panel CERRADO (sin códigos): nadie puede entrar hasta que crees uno.");
          console.log("  Crea el primero con:  tvlister-admin access-code add micodigo admin");
        } else {
          console.log("  Ningún código activo: el panel está ABIERTO (solo el login lo protege).");
          console.log("  Ciérralo con:         tvlister-admin access-code close");
        }
        console.log(`  Alta de códigos desde el panel: ${String(state.get("access_code_ui_create")?.value || "") === "1" ? "PERMITIDA" : "NO (sólo terminal)"}`);
        console.log("  Se aplican al instante (no hace falta recargar nginx).");
        console.log("============================================================");
      '
      ;;

    add | crear)
      if [ -z "$arg1" ]; then
        echo "Uso: tvlister-admin access-code add <codigo> [admin|admin_api|reseller] [nota]"
        return 1
      fi
      AC_CODE="$arg1" AC_TYPE="${arg2:-admin}" AC_NOTES="$arg3" "$NODE_BIN" --no-warnings --input-type=module -e '
        import { initDb } from "./server/db.js";
        import { createAccessCode, setPanelSetting } from "./server/accessCodes.js";
        initDb();
        const res = createAccessCode({
          code: process.env.AC_CODE,
          type: process.env.AC_TYPE || "admin",
          notes: process.env.AC_NOTES || ""
        });
        if (res.error) {
          console.error("❌ " + res.error);
          process.exit(1);
        }
        setPanelSetting("panel_gate_required", "1");
        console.log(`✅ Código creado (#${res.id}): ${res.code}`);
        console.log("   Entra en:  /?access=" + encodeURIComponent(res.code));
        console.log("   Ya está activo: el panel pide código antes del login.");
      '
      ;;

    on | activar | enable)
      if [ -z "$arg1" ]; then
        echo "Uso: tvlister-admin access-code on <codigo|id>"
        return 1
      fi
      AC_TARGET="$arg1" AC_ENABLED="1" "$NODE_BIN" --no-warnings --input-type=module -e '
        import { initDb, db } from "./server/db.js";
        import { updateAccessCode } from "./server/accessCodes.js";
        initDb();
        const t = process.env.AC_TARGET;
        const row = db.prepare("SELECT id, code FROM access_codes WHERE code = ? COLLATE NOCASE OR id = ?").get(t, Number(t) || -1);
        if (!row) { console.error("❌ No existe el código " + t); process.exit(1); }
        updateAccessCode(row.id, { enabled: process.env.AC_ENABLED === "1" });
        console.log(`✅ ${row.code} ${process.env.AC_ENABLED === "1" ? "activado" : "desactivado"}.`);
      '
      ;;

    off | desactivar | disable)
      if [ -z "$arg1" ]; then
        AC_ALL="1" "$NODE_BIN" --no-warnings --input-type=module -e '
          import { initDb, db } from "./server/db.js";
          import { invalidateAccessCodeCache } from "./server/accessCodes.js";
          initDb();
          db.prepare("UPDATE access_codes SET enabled = 0").run();
          invalidateAccessCodeCache();
          console.log("✅ Todos los códigos desactivados: el panel vuelve a estar abierto (solo login).");
        '
        return 0
      fi
      AC_TARGET="$arg1" AC_ENABLED="0" "$NODE_BIN" --no-warnings --input-type=module -e '
        import { initDb, db } from "./server/db.js";
        import { updateAccessCode } from "./server/accessCodes.js";
        initDb();
        const t = process.env.AC_TARGET;
        const row = db.prepare("SELECT id, code FROM access_codes WHERE code = ? COLLATE NOCASE OR id = ?").get(t, Number(t) || -1);
        if (!row) { console.error("❌ No existe el código " + t); process.exit(1); }
        updateAccessCode(row.id, { enabled: false });
        console.log(`✅ ${row.code} desactivado.`);
      '
      ;;

    rm | del | borrar)
      if [ -z "$arg1" ]; then
        echo "Uso: tvlister-admin access-code rm <codigo|id>"
        return 1
      fi
      AC_TARGET="$arg1" "$NODE_BIN" --no-warnings --input-type=module -e '
        import { initDb, db } from "./server/db.js";
        import { deleteAccessCode } from "./server/accessCodes.js";
        initDb();
        const t = process.env.AC_TARGET;
        const row = db.prepare("SELECT id, code FROM access_codes WHERE code = ? COLLATE NOCASE OR id = ?").get(t, Number(t) || -1);
        if (!row) { console.error("❌ No existe el código " + t); process.exit(1); }
        deleteAccessCode(row.id);
        console.log(`✅ ${row.code} eliminado.`);
      '
      ;;

    close | cerrar | lock)
      AC_VAL="1" "$NODE_BIN" --no-warnings --input-type=module -e '
        import { initDb } from "./server/db.js";
        import { setPanelSetting, panelGateState } from "./server/accessCodes.js";
        initDb();
        setPanelSetting("panel_gate_required", process.env.AC_VAL || "1");
        const st = panelGateState();
        console.log("🔒 Panel cerrado: sin código de acceso no se ve ni la pantalla de login.");
        if (!st.active) {
          console.log("   Todavía no hay ningún código activo. Crea el primero AHORA:");
          console.log("     tvlister-admin access-code add micodigo admin");
          console.log("   (hasta entonces nadie puede entrar, ni tú: se abre con)");
          console.log("     tvlister-admin access-code open");
        }
      '
      ;;

    open | abrir | unlock)
      AC_VAL="0" "$NODE_BIN" --no-warnings --input-type=module -e '
        import { initDb } from "./server/db.js";
        import { setPanelSetting, panelGateState } from "./server/accessCodes.js";
        initDb();
        setPanelSetting("panel_gate_required", process.env.AC_VAL || "0");
        const st = panelGateState();
        console.log(st.active
          ? "✅ Candado forzado desactivado. Siguen mandando los códigos activos (" + st.active + ")."
          : "🔓 Panel abierto: vuelve a verse el login normal, sin código.");
      '
      ;;

    url | enlace)
      if [ -z "$arg1" ]; then
        echo "Uso: tvlister-admin access-code url <codigo>"
        return 1
      fi
      local ip port
      ip=$(get_server_ip); port=$(get_current_port)
      echo "  http://${ip}:${port}/?access=$arg1"
      echo "  (con dominio y HTTPS, cambia el host por el del panel)"
      ;;

    *)
      echo "Uso:"
      echo "  tvlister-admin access-code                    lista los códigos"
      echo "  tvlister-admin access-code add <codigo> [admin|admin_api|reseller] [nota]"
      echo "  tvlister-admin access-code on  <codigo|id>    activa"
      echo "  tvlister-admin access-code off [codigo|id]    desactiva (sin argumento: todos)"
      echo "  tvlister-admin access-code rm  <codigo|id>    elimina"
      echo "  tvlister-admin access-code close              cierra el panel (exige código siempre)"
      echo "  tvlister-admin access-code open               quita el cierre forzado"
      echo "  tvlister-admin access-code url <codigo>       enlace con el código"
      return 1
      ;;
  esac
}

cmd_streams_check() {
  local user="${1:-}" pass="${2:-}" pick="${3:-}"
  local port base code
  port=$(get_current_port)
  cd "$APP_DIR" || return 1

  echo "============================================================"
  echo "  TVLister 24/7 — Prueba de reproducción de canales"
  echo "============================================================"

  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${port}/api/health" 2>/dev/null || true)
  if [ "$code" != "200" ]; then
    echo "  [FALLA] El panel no responde en 127.0.0.1:${port} (HTTP: ${code:-sin respuesta})."
    echo "          Sin panel arriba no hay lista ni HLS: ningún canal se reproduce."
    echo "          -> systemctl status tvlister24-7   |   tvlister-admin restart"
    echo "============================================================"
    return 1
  fi
  echo "  [OK]    Panel arriba en 127.0.0.1:${port}"

  base=$("$NODE_BIN" --no-warnings --input-type=module -e '
    import { initDb, db } from "./server/db.js";
    initDb();
    console.log(db.prepare("SELECT value FROM settings WHERE key = ?").get("public_stream_base")?.value || "");
  ' 2>/dev/null | tail -1 || true)
  if [ -n "$base" ]; then
    echo "  [INFO]  Los enlaces de video salen por: ${base}"
  else
    echo "  [INFO]  Los enlaces de video salen por el dominio del panel"
  fi

  # --- Línea de prueba -----------------------------------------------------
  if [ -z "$user" ] || [ -z "$pass" ]; then
    local pair
    pair=$("$NODE_BIN" --no-warnings --input-type=module -e '
      import { initDb, db } from "./server/db.js";
      initDb();
      const l = db.prepare("SELECT username, password FROM lines WHERE status = ? ORDER BY id LIMIT 1").get("active");
      if (l) console.log(`${l.username}\t${l.password}`);
    ' 2>/dev/null | tail -1 || true)
    [ -z "$user" ] && user=$(printf '%s' "$pair" | cut -f1)
    [ -z "$pass" ] && pass=$(printf '%s' "$pair" | cut -f2)
  fi
  if [ -z "$user" ] || [ -z "$pass" ]; then
    echo "  [FALLA] No hay ninguna línea activa: sin línea el panel no entrega lista ni canales."
    echo "          -> crea una en el panel, o pasa usuario y contraseña:"
    echo "             tvlister-admin streams-check USUARIO CONTRASEÑA [ID_CANAL]"
    echo "============================================================"
    return 1
  fi
  echo "  [INFO]  Línea de prueba: ${user}"

  # --- 1. La lista que ve el cliente ---------------------------------------
  local pl
  pl=$(curl -s --max-time 25 "http://127.0.0.1:${port}/get.php?username=${user}&password=${pass}&type=m3u_plus&output=m3u8" 2>/dev/null || true)
  local chans
  chans=$(printf '%s\n' "$pl" | grep -c '^#EXTINF' || true)
  chans=${chans:-0}
  if [ "$chans" -eq 0 ]; then
    echo "  [FALLA] get.php no devolvió ningún canal."
    echo "          Respuesta del panel: $(printf '%s' "$pl" | head -c 300)"
    echo "          Causas típicas: línea suspendida/expirada, contraseña mal, o"
    echo "          catálogo vacío (tvlister-admin doctor, punto 3)."
    echo "============================================================"
    return 1
  fi
  echo "  [OK]    get.php entrega ${chans} canales a esta línea"

  local churl
  if [ -n "$pick" ]; then
    churl=$(printf '%s\n' "$pl" | grep -E "/${pick}\.(m3u8|ts)" | head -1)
    if [ -z "$churl" ]; then
      echo "  [FALLA] El canal ${pick} no está en la lista de esa línea."
      return 1
    fi
    echo "  [INFO]  Canal pedido: ${pick}"
  else
    churl=$(printf '%s\n' "$pl" | awk '/^https?:\/\// { print; exit }')
    if [ -z "$churl" ]; then
      churl=$(printf '%s\n' "$pl" | awk '/^#EXTINF/ { getline; if ($0 ~ /^https?:\/\//) { print; exit } }')
    fi
  fi
  echo "  [INFO]  Primer enlace: ${churl}"

  local chost
  chost=$(printf '%s' "$churl" | sed -E 's#^https?://##; s#/.*$##')
  if [ -n "$base" ]; then
    local bhost
    bhost=$(printf '%s' "$base" | sed -E 's#^https?://##; s#/.*$##')
    if [ "$chost" = "$bhost" ]; then
      echo "          Coincide con la base pública configurada."
    else
      echo "  [AVISO] El enlace NO usa la base pública (${bhost}): el panel está"
      echo "          sirviéndolo con su propio dominio. Revisa public_stream_base."
    fi
  fi

  # --- 2. Ese enlace, tal como lo pide un cliente --------------------------
  local hdr body
  hdr=$(mktemp); body=$(mktemp)
  local info
  local tmo=25 cerr emsg=""
  case "$churl" in *.ts) tmo=6 ;; esac
  cerr=$(mktemp)
  info=$(curl -sS --max-time "$tmo" -D "$hdr" -o "$body" -w '%{http_code}|%{content_type}|%{size_download}' "$churl" 2>"$cerr" || true)
  emsg=$(head -1 "$cerr" 2>/dev/null | sed 's/^curl: //' || true)
  rm -f "$cerr"
  local stype scode
  scode=$(printf '%s' "$info" | awk -F'|' '{ print $1 }')
  stype=$(printf '%s' "$info" | awk -F'|' '{ print $2 }')
  local server_hdr
  server_hdr=$(awk -F': ' 'tolower($1)=="server" { print $2; exit }' "$hdr" 2>/dev/null | tr -d '\r' || true)
  local cfray
  cfray=$(awk -F': ' 'tolower($1)=="cf-ray" { print $2; exit }' "$hdr" 2>/dev/null | tr -d '\r' || true)
  local loc
  loc=$(awk -F': ' 'tolower($1)=="location" { print $2; exit }' "$hdr" 2>/dev/null | tr -d '\r' || true)

  if [ -n "$cfray" ]; then
    echo "  [FALLA] Ese dominio de video está pasando por Cloudflare (cf-ray ${cfray})."
    echo "          El proxy de Cloudflare no sirve para video continuo: corta,"
    echo "          bufferiza y su contrato lo prohíbe. Pon el registro en GRIS."
  fi
  echo "  [INFO]  HTTP ${scode:-sin respuesta} · tipo: ${stype:-?} · servidor: ${server_hdr:-?}"

  case "$scode" in
    200) ;;
    301|302|303|307|308)
      echo "  [INFO]  Redirección a: ${loc:-?}"
      echo "          (modo 302: el cliente acaba yendo directo a la fuente del canal)"
      ;;
    401|403)
      echo "  [FALLA] Rechazado: la línea no tiene permiso sobre ese canal."
      echo "          Respuesta: $(head -c 200 "$body" 2>/dev/null)"
      ;;
    404)
      echo "  [FALLA] El canal no está al aire desde el panel."
      echo "          Respuesta: $(head -c 200 "$body" 2>/dev/null)"
      ;;
    429)
      echo "  [FALLA] Límite de conexiones de la línea alcanzado."
      echo "          Respuesta: $(head -c 200 "$body" 2>/dev/null)"
      ;;
    502|503|504)
      local sbody
      sbody=$(head -c 200 "$body" 2>/dev/null | tr '\n' ' ')
      echo "  [FALLA] Respondió ${scode}: ${sbody}"
      if printf '%s' "$sbody" | grep -qi 'transmisi\|fuente\|source\|ffmpeg\|encoder'; then
        echo "          El problema está en la FUENTE del canal: el servidor de origen no"
        echo "          lo está entregando ahora mismo. Los demás canales no se afectan."
        echo "          -> prueba con otro canal y revisa la fuente en el panel."
      else
        echo "          Si el panel tampoco abre en el navegador, nginx apunta a un puerto"
        echo "          equivocado o el servicio está caído (tvlister-admin status)."
      fi
      ;;
    000|"")
      echo "  [FALLA] No se pudo conectar con ese enlace."
      [ -n "$emsg" ] && echo "          curl: ${emsg}"
      case "$emsg" in
        *"Could not resolve"*)
          echo "          El dominio del video no existe en el DNS (o no resuelve desde"
          echo "          este servidor). Mientras eso pase, ningún cliente puede abrir"
          echo "          los canales: la lista entrega enlaces a un dominio muerto."
          echo "          -> vuelve al dominio del panel ya mismo:"
          echo "             tvlister-admin cloudflare --clear && tvlister-admin restart" ;;
        *"refused"*)
          echo "          Nadie escucha en ese puerto: el proxy no está levantado o el"
          echo "          enlace apunta a un puerto que el panel no usa." ;;
        *certificate*|*SSL*|*ssl*)
          echo "          El certificado del origen no es válido: el reproductor corta." ;;
        *"timed out"*|*"Timeout"*)
          echo "          Sin respuesta a tiempo: firewall o el origen no contesta." ;;
        *)
          echo "          Revisa DNS, firewall y TLS de ese dominio." ;;
      esac
      ;;
    *)
      echo "  [AVISO] Código HTTP inesperado: $(head -c 200 "$body" 2>/dev/null)"
      ;;
  esac

  if [ "$scode" = "200" ]; then
    if head -c 200 "$body" | grep -qi '<html\|<!doctype'; then
      echo "  [FALLA] Devolvió una página HTML, no un video."
      echo "          Suele ser el panel de Cloudflare, un 404 de nginx o un portal."
      echo "          Título: $(grep -o -m1 '<title>[^<]*' "$body" 2>/dev/null | cut -c8-)"
    elif grep -q '^#EXTM3U' "$body" 2>/dev/null; then
      # --- 2b. Seguir la cadena HLS hasta un trozo de vídeo de verdad ------
      # Una fuente puede devolver: playlist maestra -> variante -> segmento.
      # Antes se paraba en el primer nivel y llamaba "segmento" a otra
      # playlist (939 B de tipo mpegurl), dando un OK falso.
      resolve_url() {
        case "$2" in
          http*) printf '%s' "$2" ;;
          /*) printf '%s%s' "$(printf '%s' "$1" | sed -E 's#^([a-z]+://[^/]+).*#\1#')" "$2" ;;
          *) printf '%s/%s' "$(printf '%s' "$1" | sed -E 's#/[^/]*$##')" "$2" ;;
        esac
      }

      local cur_url="$churl" depth=0 final_ok=0
      while [ "$depth" -lt 4 ]; do
        depth=$((depth + 1))
        local nvar
        nvar=$(grep -c '^#EXT-X-STREAM-INF' "$body" 2>/dev/null || true)
        nvar=${nvar:-0}
        if [ "$nvar" -gt 0 ] 2>/dev/null; then
          local variant
          variant=$(awk '/^#EXT-X-STREAM-INF/ { f = 1; next } f && /^[^#]/ { print; exit }' "$body" 2>/dev/null || true)
          if [ -z "$variant" ]; then
            echo "  [FALLA] Playlist maestra sin ninguna variante utilizable."
            break
          fi
          cur_url=$(resolve_url "$cur_url" "$variant")
          echo "  [INFO]  La fuente entrega una playlist MAESTRA (${nvar} variante(s))."
          echo "          Nivel ${depth}: se sigue la primera -> ${cur_url}"
          local c2
          c2=$(curl -sS --max-time 20 -o "$body" -w '%{http_code}' "$cur_url" 2>/dev/null || true)
          if [ "$c2" != "200" ]; then
            echo "  [FALLA] La variante contesta ${c2:-000}: el reproductor no podrá elegir calidad."
            break
          fi
          continue
        fi

        local segs
        segs=$(grep -v '^#' "$body" 2>/dev/null | grep -v '^$' | wc -l | tr -d ' ' || true)
        segs=${segs:-0}
        if [ "$depth" -gt 1 ]; then
          echo "  [OK]    Nivel ${depth}: playlist HLS de medios (${segs} segmento(s))."
        else
          echo "  [OK]    Playlist HLS de medios (${segs} segmento(s) en el momento de la prueba)"
        fi
        if [ "$segs" -eq 0 ] 2>/dev/null; then
          echo "  [FALLA] La playlist no tiene segmentos: la fuente no está entregando."
          echo "          -> revisa la fuente del canal en el panel y 'tvlister-admin logs'"
          break
        fi

        local seg segurl sinfo s_sin
        seg=$(grep -v '^#' "$body" | grep -v '^$' | head -1)
        segurl=$(resolve_url "$cur_url" "$seg")
        sinfo=$(curl -sS --max-time 20 -o "$body" -w '%{http_code}|%{content_type}|%{size_download}' "$segurl" 2>/dev/null || true)
        s_sin=$(printf '%s' "$sinfo" | awk -F'|' '{ print $1 " · " $3 " B · " $2 }')

        # ¿Lo que llegó es otro nivel de playlist? Entonces hay que seguir.
        if head -c 7 "$body" 2>/dev/null | grep -q '#EXTM3U'; then
          local bytes
          bytes=$(wc -c < "$body" 2>/dev/null | tr -d ' ' || true)
          echo "  [INFO]  Nivel ${depth}: ese enlace es OTRA playlist (${bytes:-0} B), no vídeo."
          echo "          => ${segurl}"
          cur_url="$segurl"
          continue
        fi

        echo "  [INFO]  Trozo de vídeo real:"
        echo "          ${segurl}"
        echo "          ${s_sin}"
        case "$sinfo" in
          200*)
            local size
            size=$(printf '%s' "$sinfo" | awk -F'|' '{ print $3 }')
            if [ "${size:-0}" -gt 2000 ] 2>/dev/null; then
              echo "  [OK]    El segmento de vídeo llega completo: el canal se puede reproducir."
            else
              echo "  [AVISO] Llegó muy poco (${size} B): puede ser un segmento vacío."
            fi
            final_ok=1
            ;;
          *) echo "  [FALLA] El segmento de vídeo no llega (${s_sin}): el reproductor se queda en negro." ;;
        esac
        break
      done
      if [ "$depth" -ge 4 ] && [ "$final_ok" -eq 0 ]; then
        echo "  [AVISO] Se siguieron 4 niveles de playlist sin encontrar vídeo: la fuente"
        echo "          encadena playlists (revisa la URL del canal en el panel)."
      fi
    else
      local bsize
      bsize=$(wc -c < "$body" 2>/dev/null | tr -d ' ' || true)
      if [ "${bsize:-0}" -gt 10000 ] 2>/dev/null; then
        echo "  [OK]    Flujo MPEG-TS en crudo: ${bsize} bytes entregados en la prueba."
        echo "          (canal directo, sin playlist: se ve, pero no permite pausa/atrás)"
      else
        echo "  [AVISO] Respuesta no reconocida como M3U8 ni como HTML:"
        echo "          $(head -c 200 "$body" 2>/dev/null)"
      fi
    fi
  fi

  # --- 4. TLS, si la base es https -----------------------------------------
  if [ -n "$base" ] && printf '%s' "$base" | grep -q '^https://'; then
    local bhost2
    bhost2=$(printf '%s' "$base" | sed -E 's#^https://##; s#/.*$##')
    if ! getent hosts "$bhost2" >/dev/null 2>&1; then
      echo "  [FALLA] ${bhost2} no resuelve en el DNS: el dominio de video no existe."
      echo "          Es la causa más probable de que no se vea ningún canal."
      echo "          -> tvlister-admin cloudflare --clear   (vuelve al dominio del panel)"
    else
    local endate
    endate=$(echo | timeout 8 openssl s_client -servername "$bhost2" -connect "${bhost2}:443" 2>/dev/null \
      | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 || true)
    if [ -n "$endate" ]; then
      echo "  [OK]    TLS del dominio de video: certificado válido hasta ${endate}"
    else
      echo "  [FALLA] El dominio de video es https pero no hay certificado válido en el"
      echo "          origen: los reproductores rechazan la conexión."
      echo "          -> pon un Origin Certificate y ejecuta cloudflare ... --cert/--key,"
      echo "             o usa http:// en la base pública."
    fi
    fi
  fi

  rm -f "$hdr" "$body"
  echo "============================================================"
  echo "  Si todo sale [OK] y el cliente sigue en negro, el problema está en el"
  echo "  cliente o en su red (no en el servidor): comprueba DNS, firewall y el"
  echo "  reproductor. Para un canal concreto repite con sus datos de línea."
  echo "  Registro del panel: tvlister-admin logs"
  echo "============================================================"
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
    local xui_root=""
    for cand in /home/xui /root/xui /opt/xui /home/xui.one; do
      if [ -d "${cand}/bin/nginx" ]; then xui_root="$cand"; break; fi
    done
    echo "ℹ️  No hay certbot/nginx del sistema en esta máquina."
    if [ -n "$xui_root" ]; then
      echo "   Aquí manda el nginx interno de XUI.one (${xui_root}/bin/nginx)."
      echo "   Si el dominio va por Cloudflare, lo más rápido y sin tocar apt es un"
      echo "   Origin Certificate:"
      echo "     Cloudflare -> SSL/TLS -> Origin Server -> Create Certificate"
      echo "     (validez 15 años, no caduca, no hay que renovar)"
      echo "   Guarda el .pem y el .key y aplica el proxy con:"
      echo "     tvlister-admin cloudflare ${domain} stream.${domain} --cert /root/origin.pem --key /root/origin.key"
      echo "   Eso mete los server blocks en ${xui_root}/bin/nginx/conf/servers con ese"
      echo "   certificado, prueba con nginx -t y recarga."
    else
      echo "   Archivo generado en /root/tvlister247_${domain}.nginx.conf para tu proxy frontal."
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
  fi
}

cmd_cf_check() {
  # Comprueba que el reparto quedó bien: panel por Cloudflare, streams directos.
  # Uso: tvlister-admin cloudflare --check [dominio_panel] [dominio_streams]
  #
  # Todo lo que consulta la red va con `|| true`: `set -e` abortaría el informe
  # a la primera consulta fallida (era el motivo de que sólo saliera el panel).
  local panel="${1:-}"
  local stream="${2:-}"
  local fails=0
  local origin_ip
  cd "$APP_DIR"

  echo "============================================================"
  echo "  Comprobación del proxy (Cloudflare / streams)"
  echo "============================================================"

  # --- Base pública de streaming configurada en el panel -------------------
  local base=""
  base=$("$NODE_BIN" --no-warnings --input-type=module -e '
    import { initDb, db } from "./server/db.js";
    initDb();
    const r = db.prepare("SELECT value FROM settings WHERE key = ?").get("public_stream_base");
    console.log(r?.value || "");
  ' 2>/dev/null | tail -1 || true)
  if [ -n "$base" ]; then
    echo "  [OK]    Base pública de streaming: ${base}"
    local bscheme bport bnums
    bscheme=$(printf '%s' "$base" | sed -E 's#^([a-z]+)://.*#\1#')
    bport=$(printf '%s' "$base" | sed -E 's#^[a-z]+://[^/:]+:([0-9]+).*#\1#')
    case "$bport" in
      "$base") bport="" ;;  # no había :puerto
    esac
    [ -z "$bport" ] && [ "$bscheme" = "https" ] && bport=443
    [ -z "$bport" ] && bport=80
    echo "          Puerto de salida de los streams: ${bport} (${bscheme})"
    if [ "$bport" != "80" ] && [ "$bport" != "443" ]; then
      echo "          [AVISO] Puerto no estándar: algunos reproductores y redes lo bloquean."
      echo "                  Para usar el 80: tvlister-admin streams-port 80 stream_dominio"
    fi
    [ -z "$stream" ] && stream=$(printf '%s' "$base" | sed -E 's#^https?://##; s#/.*$##')
  else
    echo "  [AVISO] Sin base pública de streaming: los enlaces de video usan el dominio del panel"
    echo "          -> ejecuta: tvlister-admin cloudflare <dominio_panel> <dominio_streams>"
    fails=$((fails + 1))
  fi

  # IP del propio servidor (para hablar con el origen sin pasar por Cloudflare)
  origin_ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1 || true)
  [ -z "$origin_ip" ] && origin_ip=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  [ -n "$origin_ip" ] && echo "  Origen         : ${origin_ip} (se consulta directo, sin Cloudflare)"

  # --- Cabeceras de una URL completa ---------------------------------------
  headers_of() {
    curl -sS -o /dev/null -D - --max-time 12 "$1/" 2>/dev/null | tr -d '\r' || true
  }
  # Cabeceras del origen, forzando la IP del servidor con --resolve
  headers_from_origin() {
    local url="$1"
    [ -z "$origin_ip" ] && return 0
    local h p
    h=$(printf '%s' "$url" | sed -E 's#^[a-z]+://([^/:]+).*#\1#')
    p=$(printf '%s' "$url" | sed -E 's#^[a-z]+://[^/:]+:([0-9]+).*#\1#')
    [ "$p" = "$url" ] && p=""
    [ -z "$p" ] && { case "$url" in https://*) p=443 ;; *) p=80 ;; esac; }
    curl -sS -o /dev/null -D - --max-time 10 --resolve "${h}:${p}:${origin_ip}" "${url}/" 2>/dev/null | tr -d '\r' || true
    return 0
  }

  check_host() {
    local host="$1" role="$2" url="${3:-}"
    [ -z "$host" ] && return 0
    [ -z "$url" ] && url="https://${host}"
    local hdrs server cfray ip o_hdrs o_server o_cf ssl_state
    hdrs=$(headers_of "$url")
    if [ -z "$hdrs" ]; then
      echo "  ${role}: ${url}"
      echo "         [FALLA] No responde (DNS, firewall o nginx sin ese server_name)"
      fails=$((fails + 1))
      return 0
    fi
    server=$(printf '%s\n' "$hdrs" | awk 'tolower($0) ~ /^server:/ { sub(/^[^:]*:[[:space:]]*/, ""); print; exit }')
    cfray=$(printf '%s\n' "$hdrs" | grep -ci '^cf-ray:' || true)
    ip=$(getent hosts "$host" 2>/dev/null | awk 'NR==1{print $1}' || true)

    echo "  ${role}: ${url}"
    echo "         IP resuelta : ${ip:-?}  ·  Servidor: ${server:-?}"
    if [ "$cfray" -gt 0 ]; then
      if [ "$role" = "Streams" ]; then
        echo "         [FALLA] Los streams están pasando por Cloudflare. Pon ese registro"
        echo "                 en GRIS (DNS only): el video continuo no está permitido en"
        echo "                 planes self-serve y te pueden suspender el dominio."
        fails=$((fails + 1))
      else
        echo "         [OK]    El panel va por Cloudflare."
      fi
    else
      if [ "$role" = "Streams" ]; then
        echo "         [OK]    Directo al servidor (sin Cloudflare), como debe ser."
      else
        echo "         [AVISO] El panel NO está pasando por Cloudflare (nube gris)."
      fi
    fi

    # Origen: ¿nginx sirve ese dominio? (sin pasar por Cloudflare)
    if [ -n "$origin_ip" ]; then
      o_hdrs=$(headers_from_origin "$url")
      if [ -z "$o_hdrs" ]; then
        echo "         [FALLA] El origen (${origin_ip}:443) no responde para ${host}"
        echo "                 -> falta el server block o nginx no recarga"
        fails=$((fails + 1))
      else
        o_server=$(printf '%s\n' "$o_hdrs" | awk 'tolower($0) ~ /^server:/ { sub(/^[^:]*:[[:space:]]*/, ""); print; exit }')
        o_cf=$(printf '%s\n' "$o_hdrs" | grep -ci '^cf-ray:' || true)
        if [ "$o_cf" -gt 0 ]; then
          echo "         [AVISO] El origen contesta como Cloudflare: ¿${host} apunta a un proxy?"
        else
          echo "         [OK]    El origen (${origin_ip}) sirve ${host} directamente (${o_server:-nginx})."
        fi
      fi
    fi

    # Certificado que ve el usuario
    ssl_state=$(timeout 8 openssl s_client -servername "$host" -connect "${host}:443" </dev/null 2>/dev/null \
      | openssl x509 -noout -enddate 2>/dev/null | sed -n 's/^notAfter=//p' || true)
    if [ -n "$ssl_state" ]; then
      echo "         Certificado : caduca ${ssl_state}"
    else
      echo "         Certificado : no se pudo leer"
    fi
  }

  check_host "$panel" "Panel"

  # Qué URL usa el video: la base pública si está fijada (respetando su esquema y
  # su puerto) o, si no, el dominio de streams por https.
  local stream_url=""
  if [ -n "$base" ]; then
    stream_url=$(printf '%s' "$base" | sed -E 's#/+$##')
    stream=$(printf '%s' "$stream_url" | sed -E 's#^[a-z]+://##; s#/.*$##; s#:[0-9]+$##')
  fi
  if [ -n "$stream" ] && [ "$stream" != "$panel" ]; then
    check_host "$stream" "Streams" "${stream_url:-}"
  elif [ "$stream" = "$panel" ]; then
    echo "  Streams: ${stream_url:-https://$panel}"
    echo "         El video sale por el MISMO dominio del panel."
    if [ -n "$stream_url" ]; then
      local sp
      sp=$(printf '%s' "$stream_url" | sed -E 's#^[a-z]+://[^/:]+:([0-9]+).*#\1#')
      [ "$sp" = "$stream_url" ] && sp=""
      [ -z "$sp" ] && { case "$stream_url" in https://*) sp=443 ;; *) sp=80 ;; esac; }
      echo "         Puerto ${sp}. Si ese dominio está en naranja en Cloudflare, el video"
      echo "         pasaría por su proxy: déjalo en GRIS o usa un subdominio aparte."
    fi
  else
    echo "  [AVISO] No hay dominio de streams distinto del panel: el video sale por el panel."
    fails=$((fails + 1))
  fi

  # --- Piezas locales del proxy --------------------------------------------
  local xui_found="" xui_has=""
  for xr in /home/xui /root/xui /opt/xui /home/xui.one; do
    if [ -d "${xr}/bin/nginx/conf/servers" ]; then
      xui_found="$xr"
      if [ -f "${xr}/bin/nginx/conf/servers/tvlister-panel.conf" ]; then xui_has="yes"; fi
      break
    fi
  done

  if [ -f /etc/nginx/conf.d/tvlister-cloudflare-realip.conf ]; then
    echo "  [OK]    nginx (sistema): IP real del cliente desde los rangos de Cloudflare"
  elif [ -f /etc/nginx/conf.d/tvlister247-panel.conf ]; then
    echo "  [OK]    nginx del sistema (conf.d): server blocks de TVLister presentes"
  elif [ -n "$xui_found" ]; then
    if [ -n "$xui_has" ]; then
      echo "  [OK]    nginx de XUI.one: server blocks en ${xui_found}/bin/nginx/conf/servers"
    else
      echo "  [AVISO] nginx de XUI.one (${xui_found}) sin los server blocks de TVLister"
      echo "          -> ejecuta: tvlister-admin cloudflare <panel> <streams>"
      fails=$((fails + 1))
    fi
  elif [ -d /etc/nginx/sites-available ]; then
    echo "  [AVISO] Falta /etc/nginx/conf.d/tvlister-cloudflare-realip.conf"
    echo "          (todos los clientes se verían con IP de Cloudflare)"
    fails=$((fails + 1))
  fi

  if [ -f /etc/systemd/system/tvlister24-7.service.d/cloudflare.conf ]; then
    echo "  [OK]    Proxies de confianza declarados en el servicio (anti-spoofing)"
  else
    echo "  [AVISO] Sin drop-in de proxies de confianza: el panel sólo cree las cabeceras"
    echo "          de proxy si llegan de loopback o de la red privada"
  fi

  echo "============================================================"
  if [ "$fails" -gt 0 ]; then
    echo "  ${fails} punto(s) a corregir."
    return 1
  fi
  echo "  Todo en orden: panel por Cloudflare, video directo."
  return 0
}

cmd_cloudflare() {
  # Proxy inverso delante del panel, con Cloudflare (o sin él).
  #
  # Uso:
  #   tvlister-admin cloudflare <dominio_panel> [dominio_streams]
  #   tvlister-admin cloudflare <panel> <streams> --cert /ruta/cert.pem --key /ruta/key.pem
  #   tvlister-admin cloudflare --check [panel] [streams]
  #   tvlister-admin cloudflare --clear
  #
  # Regla de oro: por Cloudflare va el PANEL (HTML, API, WebSocket, VOD
  # pequeño). Los streams TS/HLS van por un subdominio SIN proxy (nube gris),
  # porque el tráfico de video continuo no está permitido en los planes
  # self-serve de Cloudflare y además el proxy no está hecho para eso.
  #
  # Detecta el nginx que haya: el del sistema (/etc/nginx) o el interno de
  # XUI.one (/home/xui/bin/nginx/conf/servers + sbin/nginx -s reload).
  local domain="${1:-}"
  local stream_domain="${2:-}"
  local third="${3:-}"
  local fourth="${4:-}"
  local fifth="${5:-}"
  local port
  port=$(get_current_port)

  if [ "$domain" = "--check" ]; then
    cmd_cf_check "$stream_domain" "$third"
    return $?
  fi

  if [ "$domain" = "--clear" ]; then
    cd "$APP_DIR"
    "$NODE_BIN" --no-warnings --input-type=module -e '
      import { initDb, db } from "./server/db.js";
      initDb();
      db.prepare("DELETE FROM settings WHERE key = ?").run("public_stream_base");
      console.log("✅ Base pública de streaming borrada: los enlaces de video vuelven a usar el dominio del panel.");
    '
    echo "   Aplica con: tvlister-admin restart"
    return 0
  fi

  # Certificado propio (por ejemplo el Origin Certificate de Cloudflare):
  #   tvlister-admin cloudflare panel.midominio.com stream.midominio.com \
  #       --cert /root/cf-origin.pem --key /root/cf-origin.key
  local cert_path="" key_path=""
  if [ "$third" = "--cert" ]; then
    cert_path="$fourth"
    # admite "RUTA --key RUTA" o "RUTA RUTA"
    if [ "$fifth" = "--key" ] || [ -z "$fifth" ]; then
      key_path="${6:-}"
    else
      key_path="$fifth"
    fi
  fi
  if [ -n "$cert_path" ] && { [ -z "$key_path" ] || [ ! -f "$key_path" ] || [ ! -f "$cert_path" ]; }; then
    echo "[ERROR] Falta la clave o el archivo no existe: $key_path"
    echo "Uso: tvlister-admin cloudflare <panel> <streams> --cert /ruta/cert.pem --key /ruta/key.pem"
    return 1
  fi

  if [ -z "$domain" ]; then
    echo "Uso: tvlister-admin cloudflare <dominio_panel> [dominio_streams] [--cert cert.pem --key key.pem]"
    echo "     tvlister-admin cloudflare --check [dominio_panel] [dominio_streams]"
    echo "     tvlister-admin cloudflare --clear"
    echo "Ej.:  tvlister-admin cloudflare tv.midominio.com stream.midominio.com"
    return 1
  fi
  if [ -z "$stream_domain" ] || [ "$stream_domain" = "--cert" ]; then
    stream_domain="stream.${domain}"
  fi

  echo "============================================================"
  echo "  TVLister 24/7 — Proxy inverso para Cloudflare"
  echo "============================================================"
  echo "  Panel   (por Cloudflare)  : ${domain}  ->  127.0.0.1:${port}"
  echo "  Streams (sin Cloudflare)  : ${stream_domain}  ->  127.0.0.1:${port}"
  echo ""

  # --- Rangos de Cloudflare (para la IP real y para confiar en el proxy) ----
  local cf_v4 cf_v6
  cf_v4=$(curl -fsS --max-time 6 https://www.cloudflare.com/ips-v4 2>/dev/null | tr '\n' ' ' || true)
  cf_v6=$(curl -fsS --max-time 6 https://www.cloudflare.com/ips-v6 2>/dev/null | tr '\n' ' ' || true)
  if [ -z "$cf_v4" ]; then
    cf_v4="173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22"
  fi

  # --- Certificado: el pasado, el que ya use XUI.one o el de Let's Encrypt --
  local ssl_block="" cert_src="ninguno (sólo HTTP)"
  local xui_ssl=/home/xui/bin/nginx/conf/ssl.conf
  if [ -n "$cert_path" ] && [ -f "$cert_path" ]; then
    ssl_block="    ssl_certificate ${cert_path};
    ssl_certificate_key ${key_path};"
    cert_src="$cert_path"
  elif [ -f "$xui_ssl" ]; then
    local xcert xkey
    xcert=$(awk '/^[[:space:]]*ssl_certificate[[:space:]]/ { print $2; exit }' "$xui_ssl" 2>/dev/null | tr -d ';' || true)
    xkey=$(awk '/^[[:space:]]*ssl_certificate_key[[:space:]]/ { print $2; exit }' "$xui_ssl" 2>/dev/null | tr -d ';' || true)
    if [ -n "$xcert" ] && [ -n "$xkey" ] && [ -f "$xcert" ] && [ -f "$xkey" ]; then
      ssl_block="    ssl_certificate ${xcert};
    ssl_certificate_key ${xkey};"
      cert_src="${xcert} (el que ya usa XUI.one)"
    fi
  fi
  if [ -z "$ssl_block" ] && [ -f "/etc/letsencrypt/live/${domain}/fullchain.pem" ]; then
    ssl_block="    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;"
    cert_src="/etc/letsencrypt/live/${domain}"
  fi
  [ -n "$ssl_block" ] && echo "  Certificado               : ${cert_src}"
  if [ -z "$ssl_block" ]; then
    echo "  Certificado               : ninguno todavía (se genera sólo HTTP:80)"
    echo "     Con Cloudflare en \"Full (strict)\" hace falta un certificado en el origen."
    echo "     Lo más rápido: Cloudflare -> SSL/TLS -> Origin Server -> Create Certificate,"
    echo "     pega el .pem y el .key en el servidor y repite con:"
    echo "        tvlister-admin cloudflare ${domain} ${stream_domain} --cert /root/origin.pem --key /root/origin.key"
  fi
  echo ""

  # --- Contenido de los dos server blocks ----------------------------------
  build_panel_conf() {
    cat <<EOF
# TVLister 24/7 — panel. Va por Cloudflare (nube naranja).
# Generado por: tvlister-admin cloudflare
server {
    listen 80;
    $( [ -n "$ssl_block" ] && echo "listen 443 ssl;" )
    server_name ${domain};
    client_max_body_size 250M;
${ssl_block}

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
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF
  }

  build_streams_conf() {
    cat <<EOF
# TVLister 24/7 — streams TS/HLS. Este subdominio va SIN proxy de Cloudflare
# (nube GRIS). Nada de buffer ni compresión: mataría la latencia y el zapeo.
server {
    listen 80;
    $( [ -n "$ssl_block" ] && echo "listen 443 ssl;" )
    server_name ${stream_domain};
${ssl_block}

    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_cache off;
    gzip off;
    sendfile on;
    tcp_nopush on;
    chunked_transfer_encoding on;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    location ~* \.m3u8\$ {
        proxy_pass http://127.0.0.1:${port};
        add_header Cache-Control "no-store" always;
    }
    location ~* \.(ts|m4s|mp4|mkv|avi)\$ {
        proxy_pass http://127.0.0.1:${port};
        add_header Cache-Control "public, max-age=30" always;
    }
    location / {
        proxy_pass http://127.0.0.1:${port};
        add_header Cache-Control "no-store" always;
    }
}
EOF
  }

  # Ruta del nginx interno de XUI.one (puede variar entre instalaciones)
  local xui_root=""
  for cand in /home/xui /root/xui /opt/xui /home/xui.one; do
    if [ -d "${cand}/bin/nginx/conf/servers" ]; then xui_root="$cand"; break; fi
  done
  if [ -z "$xui_root" ] && command -v nginx >/dev/null 2>&1; then
    local ngx_prefix
    ngx_prefix=$(nginx -V 2>&1 | tr ' ' '\n' | sed -n 's/^--prefix=\(.*\)$/\1/p' | head -1)
    if [ -n "$ngx_prefix" ] && [ -d "${ngx_prefix%/}/conf/servers" ]; then
      xui_root="${ngx_prefix%/}"
      xui_root="${xui_root%/bin/nginx}"
    fi
  fi

  local placed=""
  if [ -n "$xui_root" ] && [ -d "${xui_root}/bin/nginx/conf/servers" ]; then
    # ---- nginx interno de XUI.one ----------------------------------------
    local xui_servers="${xui_root}/bin/nginx/conf/servers"
    local xui_bin="${xui_root}/bin/nginx/sbin/nginx"
    echo "  nginx detectado: XUI.one (${xui_servers})"
    mkdir -p "${xui_servers}"
    # Copia de seguridad de lo que hubiera de TVLister
    for f in tvlister-panel.conf tvlister-streams.conf; do
      [ -f "${xui_servers}/${f}" ] && cp "${xui_servers}/${f}" "${xui_servers}/${f}.bak.$(date +%s)"
    done
    build_panel_conf > "${xui_servers}/tvlister-panel.conf"
    build_streams_conf > "${xui_servers}/tvlister-streams.conf"
    placed="xui"
    if [ -x "$xui_bin" ]; then
      if "$xui_bin" -t >/tmp/tvlister-nginx-test.log 2>&1; then
        "$xui_bin" -s reload >/dev/null 2>&1 && echo "✅ nginx de XUI.one recargado con los dos server blocks." \
          || echo "⚠️  nginx -t pasó pero el reload falló; revisa 'sudo ${xui_bin} -s reload'"
      else
        echo "⚠️  nginx -t falló. NO se recargó y los server blocks nuevos quedan"
        echo "    desactivados (.disabled) para que el nginx de XUI.one siga en pie:"
        tail -5 /tmp/tvlister-nginx-test.log
        for f in tvlister-panel.conf tvlister-streams.conf; do
          [ -f "${xui_servers}/${f}" ] && mv -f "${xui_servers}/${f}" "${xui_servers}/${f}.disabled"
        done
        placed="xui-failed"
      fi
    else
      echo "ℹ️  No encontré ${xui_bin}. Recarga a mano: sudo ${xui_root}/bin/nginx/sbin/nginx -s reload"
    fi
  elif [ -d /etc/nginx/conf.d ] && [ ! -d /etc/nginx/sites-available ]; then
    # ---- nginx del sistema sin sites-available (RHEL, Alpine, etc.) ------
    echo "  nginx detectado: del sistema (/etc/nginx/conf.d)"
    {
      echo "# TVLister 24/7 — IP real del cliente detrás de Cloudflare"
      for r in $cf_v4 $cf_v6; do echo "set_real_ip_from ${r};"; done
      echo "real_ip_header CF-Connecting-IP;"
      echo "real_ip_recursive on;"
    } > /etc/nginx/conf.d/tvlister-cloudflare-realip.conf
    build_panel_conf > /etc/nginx/conf.d/tvlister247-panel.conf
    build_streams_conf > /etc/nginx/conf.d/tvlister247-streams.conf
    placed="system"
    if nginx -t >/tmp/tvlister-nginx-test.log 2>&1; then
      systemctl reload nginx >/dev/null 2>&1 || nginx -s reload >/dev/null 2>&1 || true
      echo "✅ Nginx del sistema recargado."
    else
      echo "⚠️  nginx -t falló; se desactivan los sitios nuevos para no romper el nginx actual:"
      tail -5 /tmp/tvlister-nginx-test.log
      for f in tvlister247-panel.conf tvlister247-streams.conf; do
        [ -f "/etc/nginx/conf.d/${f}" ] && mv -f "/etc/nginx/conf.d/${f}" "/etc/nginx/conf.d/${f}.disabled"
      done
      placed="system-failed"
    fi
  elif [ -d /etc/nginx/sites-available ]; then
    # ---- nginx del sistema -----------------------------------------------
    echo "  nginx detectado: del sistema (/etc/nginx)"
    {
      echo "# TVLister 24/7 — IP real del cliente detrás de Cloudflare"
      echo "# Generado por: tvlister-admin cloudflare"
      for r in $cf_v4 $cf_v6; do echo "set_real_ip_from ${r};"; done
      echo "real_ip_header CF-Connecting-IP;"
      echo "real_ip_recursive on;"
    } > /etc/nginx/conf.d/tvlister-cloudflare-realip.conf
    build_panel_conf > /etc/nginx/sites-available/tvlister247-panel.conf
    build_streams_conf > /etc/nginx/sites-available/tvlister247-streams.conf
    ln -sf /etc/nginx/sites-available/tvlister247-panel.conf /etc/nginx/sites-enabled/tvlister247-panel.conf
    ln -sf /etc/nginx/sites-available/tvlister247-streams.conf /etc/nginx/sites-enabled/tvlister247-streams.conf
    placed="system"
    if nginx -t >/tmp/tvlister-nginx-test.log 2>&1; then
      systemctl reload nginx && echo "✅ Nginx del sistema recargado." || echo "⚠️  nginx -t pasó pero falló el reload."
    else
      echo "⚠️  nginx -t falló; se desactivan los sitios nuevos para no romper el nginx actual:"
      tail -5 /tmp/tvlister-nginx-test.log
      rm -f /etc/nginx/sites-enabled/tvlister247-panel.conf /etc/nginx/sites-enabled/tvlister247-streams.conf
      placed="system-failed"
    fi
  else
    # ---- sin nginx que podamos tocar -------------------------------------
    echo "ℹ️  No hay nginx del sistema ni el de XUI.one en las rutas conocidas."
    echo "   Se generan los archivos para que los incluyas donde tengas tu proxy:"
    build_panel_conf > "/root/tvlister247_panel_${domain}.conf"
    build_streams_conf > "/root/tvlister247_streams_${stream_domain}.conf"
    echo "   - /root/tvlister247_panel_${domain}.conf"
    echo "   - /root/tvlister247_streams_${stream_domain}.conf"
    echo "   Y añade en tu nginx (dentro del bloque http): include /root/tvlister247_*.conf;"
    placed="root"
  fi

  # --- Proxies de confianza (IP real, anti-spoofing) -----------------------
  mkdir -p /etc/systemd/system/tvlister24-7.service.d
  cat > /etc/systemd/system/tvlister24-7.service.d/cloudflare.conf <<EOF
[Service]
# Cloudflare conecta desde sus propios rangos: se declaran como proxies de
# confianza para que CF-Connecting-IP sea la IP real del cliente. Cualquier
# otra conexión que mande esa cabecera se ignora.
Environment=TVLISTER_TRUSTED_PROXIES=$(echo $cf_v4 $cf_v6 | tr ' ' ',')
EOF
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl restart tvlister24-7 >/dev/null 2>&1 || true

  # --- Aviso: si el dominio de video no existe o no apunta aquí, los enlaces
  #     quedan muertos y no se ve ningún canal. Mejor saberlo ahora. --------
  if ! getent hosts "$stream_domain" >/dev/null 2>&1; then
    echo ""
    echo "⚠️  ${stream_domain} no resuelve en el DNS todavía."
    echo "    Los enlaces de video apuntarán a un dominio que no existe y NO se"
    echo "    verá ningún canal hasta que crees el registro A en Cloudflare."
    echo "    Si te arrepientes: tvlister-admin cloudflare --clear"
  else
    local sip dip
    sip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1 || true)
    dip=$(getent ahostsv4 "$stream_domain" 2>/dev/null | awk 'NR==1{print $1}' || true)
    if [ -n "$sip" ] && [ -n "$dip" ] && [ "$sip" != "$dip" ]; then
      echo ""
      echo "⚠️  ${stream_domain} resuelve a ${dip}, no a este servidor (${sip})."
      echo "    Corrige el registro A/DNS, o los clientes no llegarán al video."
    fi
  fi

  # --- Base pública de streaming (siempre, haya o no nginx del sistema) ----
  # Si el server block de video no tiene certificado, el dominio SÓLO atiende
  # por HTTP:80. Poner https ahí dejaría todos los enlaces muertos, así que el
  # esquema se elige según lo que realmente se haya generado.
  local stream_scheme="http"
  [ -n "$ssl_block" ] && stream_scheme="https"
  cd "$APP_DIR"
  STREAM_BASE="${stream_scheme}://${stream_domain}" STREAM_HOST="${stream_domain}" PANEL_DOMAIN="${domain}" "$NODE_BIN" --no-warnings --input-type=module -e '
    import { initDb, db } from "./server/db.js";
    initDb();
    const base = String(process.env.STREAM_BASE || "").replace(/\/+$/, "");
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run("public_stream_base", base);
    console.log("");
    console.log("  Base pública de streaming: " + base);
    console.log("  Las playlist, .m3u8 y .ts saldrán por ahí (sin Cloudflare).");
    console.log("  Si quieres otro puerto/dominio: tvlister-admin streams-port 80 " + (process.env.STREAM_HOST || ""));
    console.log("  El panel y su API siguen por " + (process.env.PANEL_DOMAIN || "el dominio del panel") + ".");
    console.log("  Para volver atrás: tvlister-admin cloudflare --clear");
  ' || echo "⚠️  No se pudo guardar public_stream_base"

  echo ""
  echo "------------------------------------------------------------"
  echo "  En el panel de Cloudflare"
  echo "------------------------------------------------------------"
  echo "  1. DNS"
  echo "       ${domain}  A  <IP del servidor>   NARANJA (proxied)"
  echo "       ${stream_domain}  A  <IP del servidor>   GRIS    (DNS only)"
  echo "     Los streams NO van por Cloudflare: no es un límite técnico que se"
  echo "     pueda sortear, es su política (tráfico de video = plan aparte)."
  echo "  2. SSL/TLS -> modo \"Full (strict)\" y un certificado real en el servidor."
  echo "     Opción rápida sin tocar apt: Cloudflare -> SSL/TLS -> Origin Server ->"
  echo "     Create Certificate, y luego:"
  echo "       tvlister-admin cloudflare ${domain} ${stream_domain} --cert /root/origin.pem --key /root/origin.key"
  echo "  3. Caching -> Rule: si la ruta acaba en .m3u8 o .ts, \"Bypass cache\"."
  echo "  4. Rocket Loader: OFF (rompe el reproductor)."
  echo "  5. WebSockets: ON (lo usan MNF y la vista en vivo del panel)."
  echo ""
  case "$placed" in
    xui)     echo "  Server blocks instalados en ${xui_root}/bin/nginx/conf/servers" ;;
    system)  echo "  Server blocks instalados en /etc/nginx" ;;
    root)    echo "  Server blocks pendientes: inclúyelos en tu proxy frontal" ;;
    *-failed)
      echo "  ⚠️  Los server blocks NO quedaron activos (nginx -t falló)."
      echo "     Corrige el error de arriba y vuelve a ejecutar el comando." ;;
  esac
  echo ""
  echo "  Protege además la entrada al panel con un código (estilo XUI.one):"
  echo "     tvlister-admin access-code add mipanel admin"
  echo ""
  echo "  Comprueba después:"
  echo "     tvlister-admin cloudflare --check ${domain} ${stream_domain}"
  echo "============================================================"
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
      from="${from:-1}"
      to="${to:-125}"
      CATV_APPLY="$apply" CATV_FORCE="$force" CATV_FROM="$from" CATV_TO="$to" \
        "$NODE_BIN" --no-warnings --input-type=module -e '
        import { initDb, db } from "./server/db.js";
        import { ensureCatvSlotsInitialized, unitChannelList, computeDefaultUdpAddress } from "./server/wk2500Manager.js";
        initDb();
        ensureCatvSlotsInitialized();
        const apply = process.env.CATV_APPLY === "1";
        const force = process.env.CATV_FORCE === "1";
        const from = Math.max(1, Number(process.env.CATV_FROM) || 1);
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
          padl("MEDIDO", 11) + padl("PICO", 10) + padl("PKT/S", 8) + padl("DECLARADO", 12));
        console.log("  " + pad("", 7) + pad("NOMBRE DVB (lo que ve el modulador)", 58) + "PIDs");

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
            padl(mbps(m.peakKbps) + " Mbps", 10) +
            padl(m.pps || 0, 8) +
            padl(mbps(row.declared_kbps) + " Mbps", 12)
          );
          const q = String.fromCharCode(34);
          const sdt = m.sdt;
          const sdtText = sdt
            ? q + (sdt.name || "?") + q + " · proveedor " + q + (sdt.provider || "?") + q +
              " · service_id " + sdt.service_id
            : "sin SDT";
          console.log("        DVB: " + sdtText);
          console.log("        PIDs: " + (pids || "-") +
            " · ráfagas " + m.burstRatio + "× · oscilación " + m.jitterPct + "%");
          // Perfil real del flujo: cada símbolo es una trama de 500 ms.
          // Esto es lo que explica las lecturas que saltan entre 6, 10, 2 y 0.
          const bars = " ▁▂▃▄▅▆▇█";
          const prof = Array.isArray(m.profileKbps) ? m.profileKbps : [];
          if (prof.length) {
            const maxP = Math.max(1, ...prof);
            const art = prof
              .map((v) => bars[Math.min(8, Math.max(0, Math.round((v / maxP) * 8)))])
              .join("");
            const perSec = [];
            for (let i = 0; i < prof.length; i += 2) {
              perSec.push(((prof[i] + (prof[i + 1] || 0)) / 2000).toFixed(1));
            }
            console.log("        perfil: " + art + "  (" + m.bucketMs + " ms cada símbolo)");
            console.log("        por segundo (Mbps): " + perSec.join(" "));
            if (m.pattern) console.log("        forma : " + m.pattern.label);
            if (m.pattern && (m.pattern.id === "chunky" || m.pattern.id === "gaps" || m.pattern.id === "none")) {
              console.log("        → " + m.pattern.meaning);
            }
          }
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
        console.log("   - RÁFAGAS / oscilación alta        -> el flujo sale a saltos: el modulador");
        console.log("     ve picos. Se corrige con el motor FFmpeg y -re (v2.5.11, activo por defecto).");
        console.log("   - DVB \"Service01\" / \"FFmpeg\"       -> la salida se montó sin nombre de servicio;");
        console.log("     el modulador enseñará Service01 aunque el CSV diga otra cosa.");
        console.log("============================================================");
      '
      ;;
    names | nombres)
      # Uso: tvlister-admin catv names [--apply] [archivo]
      #
      # Aplica la lista ordenada de nombres a las portadoras 1..125. Sin
      # --apply sólo muestra qué cambiaría. El archivo opcional es una lista
      # "CH<TAB>NOMBRE" (o "CH,NOMBRE") para usar la tuya en vez de la incluida.
      local apply="0" file="" a3
      for a3 in "${@:2}"; do
        case "$a3" in
          --apply|-a) apply="1" ;;
          --*) ;;
          *) file="$a3" ;;
        esac
      done
      NAMES_APPLY="$apply" NAMES_FILE="$file" "$NODE_BIN" --no-warnings --input-type=module -e '
        import fs from "node:fs";
        import { initDb, db, withSqliteBusyRetry } from "./server/db.js";
        import { analogChannelNameRows } from "./server/catvChannelNames.js";
        initDb();

        const file = String(process.env.NAMES_FILE || "").trim();
        let rows = analogChannelNameRows();
        if (file) {
          if (!fs.existsSync(file)) {
            console.error("❌ No encuentro el archivo " + file);
            process.exit(1);
          }
          const text = fs.readFileSync(file, "utf8");
          rows = [];
          for (const line of text.split(/\r?\n/)) {
            const t = line.trim();
            if (!t || t.startsWith("#")) continue;
            const m = t.match(/^(?:ch\s*)?(\d{1,3})\s*[\t,;|]\s*(.+)$/i);
            if (!m) continue;
            const ch = Number(m[1]);
            if (ch < 2 || ch > 125) continue;
            rows.push({ catv_ch: ch, name: m[2].trim() });
          }
          rows.sort((a, b) => a.catv_ch - b.catv_ch);
          if (!rows.length) {
            console.error("❌ El archivo no tiene líneas válidas. Formato:  CH<TAB>NOMBRE");
            process.exit(1);
          }
        }

        const slots = new Map(
          db.prepare("SELECT catv_ch, custom_name, stream_id, custom_source_url FROM wk2500_channels").all()
            .map((r) => [Number(r.catv_ch), r])
        );
        const changes = rows.filter((r) => String(slots.get(r.catv_ch)?.custom_name || "") !== r.name);

        console.log("============================================================");
        console.log("  Nombres de las portadoras analógicas (CH 1 al 125)");
        console.log("============================================================");
        for (const r of rows) {
          const cur = String(slots.get(r.catv_ch)?.custom_name || "");
          const mark = cur === r.name ? "  " : "->";
          const ch = ("CH " + r.catv_ch).padEnd(6);
          const before = cur && cur !== r.name ? cur.slice(0, 26).padEnd(28) : "".padEnd(28);
          console.log("  " + mark + " " + ch + r.name.padEnd(30) + (cur !== r.name ? before : ""));
        }
        console.log("------------------------------------------------------------");
        console.log("  " + rows.length + " portadoras en la lista · " + changes.length + " por cambiar");
        if (!changes.length) {
          console.log("  Ya están todos aplicados.");
        } else if (String(process.env.NAMES_APPLY) !== "1") {
          console.log("  Vista previa. Para aplicarlo:");
          console.log("     tvlister-admin catv names --apply");
        }

        if (String(process.env.NAMES_APPLY) === "1" && changes.length) {
          withSqliteBusyRetry(() => {
            const stmt = db.prepare("UPDATE wk2500_channels SET custom_name = ?, updated_at = datetime(\x27now\x27) WHERE catv_ch = ?");
            for (const r of rows) stmt.run(r.name, r.catv_ch);
          });
          console.log("");
          console.log("✅ Nombres aplicados a " + rows.length + " portadoras.");
          console.log("   En los moduladores: descarga el CSV de la página CANALES de cada");
          console.log("   equipo (CATV WK2500 → plantilla CSV) y vuelve a importarlo para");
          console.log("   que cambien los rótulos. Frecuencias y UDP no se tocan.");
          console.log("   Los canales ya asignados conservan su stream.");
        }
        console.log("============================================================");
      '
      ;;

    udp-engine | udp | motor)
      # Uso: tvlister-admin catv udp-engine              (estado)
      #      tvlister-admin catv udp-engine local [canal|rango|all]
      #      tvlister-admin catv udp-engine flussonic [canal|rango|all] [stream]
      #      tvlister-admin catv udp-engine sync          (reaplica en Flussonic)
      #
      # Quién genera el MPEG-TS hacia el modulador:
      #   local     = TVLister (socket propio / ffmpeg)   ← por defecto, lo de siempre
      #   flussonic = el stream de Flussonic 23.12, por su API
      local action="${2:-status}" target="${3:-all}" stream="${4:-}"
      case "$action" in
        status | "")
          "$NODE_BIN" --no-warnings --input-type=module -e '
            import { initDb, db } from "./server/db.js";
            import { listFlussonicServers } from "./server/flussonicUdp.js";
            initDb();
            const rows = db.prepare(
              `SELECT w.catv_ch, w.udp_host, w.udp_port, w.enabled, w.udp_engine, w.flussonic_stream,
                      s.name AS stream_name, s.flussonic_stream_name AS mapped
                 FROM wk2500_channels w LEFT JOIN streams s ON s.id = w.stream_id
                WHERE w.stream_id IS NOT NULL OR w.custom_source_url <> \x27\x27
                ORDER BY w.catv_ch ASC`
            ).all();
            const servers = listFlussonicServers();
            console.log("============================================================");
            console.log("  Motor UDP de la salida CATV");
            console.log("============================================================");
            const local = rows.filter((r) => (r.udp_engine || "local") === "local");
            const flu = rows.filter((r) => r.udp_engine === "flussonic");
            console.log("  TVLister (local) : " + local.length + " canal(es)");
            console.log("  Flussonic (API)  : " + flu.length + " canal(es)");
            console.log("  Servidores Flussonic: " + (servers.length ? servers.map((s) => `#${s.id} ${s.name} <${s.base_url}>`).join(" · ") : "ninguno"));
            if (flu.length) {
              console.log("");
              console.log("  Canales delegados a Flussonic:");
              for (const r of flu) {
                const name = r.flussonic_stream || r.mapped || "(sin stream)";
                console.log("   CH" + String(r.catv_ch).padEnd(4) + (r.udp_host + ":" + r.udp_port).padEnd(22) +
                  " stream: " + name.padEnd(22) + (r.enabled ? "ON" : "off") + "  " + (r.stream_name || ""));
              }
            }
            console.log("");
            console.log("  Cambiar uno:   tvlister-admin catv udp-engine flussonic 12 mi_stream");
            console.log("  Un rango:      tvlister-admin catv udp-engine flussonic 2-33");
            console.log("  Volver a local: tvlister-admin catv udp-engine local 12");
            console.log("  Reaplicar todo: tvlister-admin catv udp-engine sync");
            console.log("============================================================");
          '
          ;;

        sync | apply | reaplicar)
          CATV_CH="$target" "$NODE_BIN" --no-warnings --input-type=module -e '
            import { initDb } from "./server/db.js";
            import { syncFlussonicUdpOutputs } from "./server/flussonicUdp.js";
            initDb();
            const only = process.env.CATV_CH && process.env.CATV_CH !== "all" ? Number(process.env.CATV_CH) : null;
            const r = await syncFlussonicUdpOutputs({ onlyCatvCh: only });
            if (!r.total) {
              console.log("  No hay canales en modo Flussonic. Nada que reaplicar.");
              process.exit(0);
            }
            console.log("============================================================");
            console.log("  Salidas UDP empujadas a Flussonic");
            console.log("============================================================");
            for (const x of r.results) {
              console.log("  " + (x.ok ? (x.already ? "[=] " : "[OK]") : "[!!]") +
                " CH" + String(x.catv_ch).padEnd(4) +
                (x.url || "").padEnd(46) + (x.ok ? (x.already ? "ya estaba" : x.method || "") : (x.error || "")));
            }
            console.log("------------------------------------------------------------");
            console.log(`  ${r.applied} aplicadas · ${r.unchanged} sin cambios · ${r.failed} con error`);
            console.log("============================================================");
            process.exit(r.failed ? 1 : 0);
          '
          ;;

        local | flussonic)
          ENGINE="$action" TARGET="$target" FSTREAM="$stream" "$NODE_BIN" --no-warnings --input-type=module -e '
            import { initDb, db, withSqliteBusyRetry } from "./server/db.js";
            initDb();
            const engine = process.env.ENGINE;
            const target = String(process.env.TARGET || "all");
            const forcedStream = String(process.env.FSTREAM || "").trim();
            let channels = [];
            if (target === "all") {
              channels = db.prepare("SELECT catv_ch FROM wk2500_channels WHERE stream_id IS NOT NULL OR custom_source_url <> \x27\x27 ORDER BY catv_ch").all().map((r) => r.catv_ch);
            } else if (/^\d+-\d+$/.test(target)) {
              const [a, b] = target.split("-").map(Number);
              for (let ch = Math.max(2, a); ch <= Math.min(125, b); ch += 1) channels.push(ch);
            } else {
              channels.push(Number(target));
            }
            if (engine === "flussonic") {
              const servers = db.prepare("SELECT id, name FROM flussonic_servers ORDER BY id").all();
              if (!servers.length) {
                console.error("❌ No hay servidores Flussonic dados de alta (sección Flussonic 23.12).");
                console.error("   El UDP sigue saliendo por TVLister: no se cambió nada.");
                process.exit(1);
              }
            }
            let done = 0;
            const skipped = [];
            for (const ch of channels) {
              const slot = db.prepare("SELECT * FROM wk2500_channels WHERE catv_ch = ?").get(ch);
              if (!slot) { skipped.push(`CH${ch} sin slot`); continue; }
              let name = forcedStream;
              if (!name) {
                name = slot.flussonic_stream || "";
                if (!name && slot.stream_id) {
                  name = db.prepare("SELECT flussonic_stream_name FROM streams WHERE id = ?").get(slot.stream_id)?.flussonic_stream_name || "";
                }
              }
              if (engine === "flussonic" && !name) {
                skipped.push(`CH${ch} sin stream de Flussonic`);
                continue;
              }
              withSqliteBusyRetry(() => {
                db.prepare("UPDATE wk2500_channels SET udp_engine = ?, flussonic_stream = COALESCE(NULLIF(?, \x27\x27), flussonic_stream), updated_at = datetime(\x27now\x27) WHERE catv_ch = ?")
                  .run(engine, name, ch);
              });
              done += 1;
            }
            console.log(`✅ ${done} canal(es) en modo ${engine === "flussonic" ? "Flussonic 23.12 (API)" : "TVLister (local)"}.`);
            if (skipped.length) {
              console.log("   Sin cambiar: " + skipped.slice(0, 8).join(" · ") + (skipped.length > 8 ? ` (+${skipped.length - 8})` : ""));
            }
            console.log("   Reinicia la salida para aplicarlo:  tvlister-admin restart");
            if (engine === "flussonic") console.log("   Luego verifica:                     tvlister-admin catv udp-engine sync");
          '
          ;;

        *) echo "Uso: tvlister-admin catv udp-engine [status|local|flussonic|sync] [canal|rango|all] [stream_flussonic]" ;;
      esac
      ;;

    steady)
      # Comprueba (y si se pide, aplica) que la salida UDP salga CONSTANTE:
      # cada canal por FFmpeg con -re, y opcionalmente con muxrate (CBR).
      # Uso: tvlister-admin catv steady [--apply] [--cbr] [--headroom 15]
      #                                 [--clear] [id_equipo]
      local apply="0" cbr="0" clear="0" headroom="15" prev2="" a2
      local -a pos2=()
      for a2 in "${@:2}"; do
        case "$a2" in
          --apply) apply="1" ; prev2="" ;;
          --cbr) cbr="1" ; prev2="" ;;
          --clear) clear="1" ; prev2="" ;;
          --headroom=*) headroom="${a2#*=}" ; prev2="" ;;
          --headroom) prev2="--headroom" ;;
          "")
            prev2=""
            ;;
          *)
            if [ "$prev2" = "--headroom" ]; then
              headroom="$a2"
              prev2=""
            else
              pos2+=("$a2")
            fi
            ;;
        esac
      done
      if [ "${#pos2[@]}" -gt 0 ] && [ -z "$unit_id" ]; then unit_id="${pos2[0]}"; fi

      CATV_APPLY="$apply" CATV_CBR="$cbr" CATV_CLEAR="$clear" CATV_HEADROOM="$headroom" \
      CATV_UNIT_ID="$unit_id" \
        "$NODE_BIN" --no-warnings --input-type=module -e '
        import { initDb, db } from "./server/db.js";
        import { catvOutputPlan } from "./server/wk2500Manager.js";
        initDb();

        const apply = process.env.CATV_APPLY === "1";
        const wantCbr = process.env.CATV_CBR === "1";
        const wantClear = process.env.CATV_CLEAR === "1";
        const headroom = Math.max(0, Math.min(100, Number(process.env.CATV_HEADROOM) || 15));
        const unitId = process.env.CATV_UNIT_ID ? Number(process.env.CATV_UNIT_ID) : null;

        const pad = (s, n) => String(s).padEnd(n);
        const padl = (s, n) => String(s).padStart(n);
        const mbps = (k) => (Number(k || 0) / 1000).toFixed(2);

        let rows = catvOutputPlan({ unitId, onlyEnabled: true });
        if (!rows.length) {
          console.log("  No hay canales habilitados con origen. Asigna canales primero:");
          console.log("     tvlister-admin catv fill --apply");
          process.exit(0);
        }

        const upd = db.prepare("UPDATE wk2500_channels SET muxrate_kbps = ?, updated_at = CURRENT_TIMESTAMP WHERE catv_ch = ?");

        let writes = 0;
        const plan = rows.map((r) => {
          let muxrate = r.muxrate_kbps;
          let action = "";
          if (wantClear && muxrate > 0) {
            muxrate = 0;
            action = "quitar CBR";
          } else if (wantCbr && r.declared_kbps > 0) {
            const target = Math.ceil((r.declared_kbps * (1 + headroom / 100)) / 100) * 100;
            if (target !== muxrate) {
              muxrate = target;
              action = "CBR " + mbps(target) + " Mbps (+" + headroom + "%)";
            }
          }
          return { ...r, new_muxrate: muxrate, action };
        });

        const broken = plan.filter((r) => r.engine === "ffmpeg" && !r.pacing);
        const direct = plan.filter((r) => r.engine === "direct_dgram");

        console.log("");
        console.log("============================================================");
        console.log("  TVLister 24/7 - Salida UDP CONSTANTE hacia los moduladores");
        console.log("  " + plan.length + " canal(es) habilitados con origen");
        console.log("============================================================");
        console.log("");
        console.log("  " + pad("CANAL", 7) + pad("MOTOR", 14) + pad("DOSIFICADO", 12) +
          padl("DECLARADO", 11) + padl("MUXRATE", 11) + "  NOMBRE");
        for (const r of plan) {
          console.log(
            "  CH" + pad(r.catv_ch, 5) +
            pad(r.engine, 14) +
            pad(r.constant ? "si (-re)" : "NO", 12) +
            padl(mbps(r.declared_kbps) + " Mbps", 11) +
            padl(r.new_muxrate ? mbps(r.new_muxrate) + " Mbps" : "-", 11) +
            "  " + String(r.name).slice(0, 30) +
            (r.action ? "  [" + r.action + "]" : "")
          );
          // La cadena completa: de dónde entra y por dónde sale.
          const flags = r.engine === "ffmpeg"
            ? "-c copy" + (r.constant ? ", -re" : "") + (r.new_muxrate ? ", CBR" : "")
            : "sin dosificar";
          console.log("        " + r.source_kind + "  ->  " + r.engine + " (" + flags + ")  ->  udp " + r.dest);
        }

        if (apply && (wantCbr || wantClear)) {
          db.exec("BEGIN IMMEDIATE;");
          try {
            for (const r of plan) {
              if (r.new_muxrate !== r.muxrate_kbps) {
                upd.run(r.new_muxrate, r.catv_ch);
                writes += 1;
              }
            }
            db.exec("COMMIT;");
          } catch (err) {
            db.exec("ROLLBACK;");
            throw err;
          }
        }

        console.log("");
        console.log("------------------------------------------------------------");
        if (broken.length) {
          console.log("  [!!] " + broken.length + " canal(es) por FFmpeg SIN dosificar: " +
            broken.slice(0, 8).map((r) => "CH" + r.catv_ch).join(" "));
        } else {
          console.log("  [OK] Todos los canales con FFmpeg salen dosificados (-re).");
        }
        if (direct.length) {
          console.log("  [!!] " + direct.length + " canal(es) por el motor directo (sin dosificar): " +
            direct.slice(0, 8).map((r) => "CH" + r.catv_ch).join(" "));
          console.log("       Es MNF o TVLISTER_CATV_DIRECT=1. Con MNF el flujo ya llega dosificado.");
        }
        if (wantCbr || wantClear) {
          if (apply) {
            console.log("  " + (wantClear ? "Quitado el CBR" : "CBR aplicado") + " en " + writes + " canal(es).");
            console.log("  Aplica con:  tvlister-admin restart");
          } else {
            console.log("  Vista previa: " + plan.filter((r) => r.action).length + " canal(es) cambiarían.");
            console.log("  Escribe con: tvlister-admin catv steady --apply" + (wantClear ? " --clear" : " --cbr"));
          }
        } else {
          console.log("");
          console.log("  Para forzar además un flujo plano (CBR, rellena con paquetes nulos):");
          console.log("     tvlister-admin catv steady --apply --cbr [--headroom 15]");
          console.log("  Para volver a VBR dosificado:");
          console.log("     tvlister-admin catv steady --apply --clear");
        }
        console.log("");
        console.log("  Comprueba el resultado con:  sudo tvlister-admin catv watch --secs 10");
        console.log("  Debe salir  forma : constante   y   sin tramos en 0.");
        console.log("============================================================");
      '
      ;;
    *)
      echo "Uso: tvlister-admin catv [check|fill|watch|steady] [id_equipo] [--apply]"
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
  # Antes de tocar nada: copia consistente de la base (si el release sale mal,
  # el panel vuelve con los datos de hace un minuto, no de ayer).
  cmd_backup || echo "⚠️  No se pudo crear el respaldo previo; continúa la instalación."
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
  cmd_backup || echo "⚠️  No se pudo crear el respaldo previo; continúa la actualización."
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
  streams-port | puerto-streams | stream-port)
    shift
    cmd_streams_port "${1:-status}" "${2:-}"
    ;;
  access-code | access-codes | codigo | codigos)
    shift
    cmd_access_code "${1:-list}" "${2:-}" "${3:-}" "${4:-}"
    ;;
  streams-check | probar | reproduce)
    cmd_streams_check "${2:-}" "${3:-}" "${4:-}"
    ;;
  health | salud)
    cmd_health "${2:-}"
    ;;
  cloudflare | cf)
    shift
    cmd_cloudflare "$@"
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
  hls)
    # Afinado HLS con el juego de opciones de XUI.one.
    # Uso: tvlister-admin hls [status|xui off|xui safe|xui full]
    sub="${2:-status}"
    mode="${3:-}"
    cd "$APP_DIR"
    case "$sub" in
      xui | afinar | tune)
        case "$mode" in
          off | safe | full) : ;;
          *) echo "Uso: tvlister-admin hls xui [off|safe|full]"; exit 1 ;;
        esac
        HLS_MODE="$mode" "$NODE_BIN" --no-warnings --input-type=module -e '
          import { initDb, db } from "./server/db.js";
          initDb();
          const mode = process.env.HLS_MODE;
          db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .run("ffmpeg_hls_xui", mode);
          const names = {
            off: "línea original del panel (byte a byte)",
            safe: "original + extras de XUI.one (header trailer, delete threshold, discont_start, err_detect)",
            full: "juego completo de XUI.one (incluye -re en la entrada)"
          };
          console.log("");
          console.log("  Modo HLS: " + mode + "  ->  " + names[mode]);
          console.log("");
          console.log("  Aplica a los canales con:  tvlister-admin restart");
          console.log("  Ver la línea resultante:   tvlister-admin hls status");
        '
        ;;
      status | show | "")
        "$NODE_BIN" --no-warnings --input-type=module -e '
          import { initDb, db } from "./server/db.js";
          import { getFfmpegEfficiencyConfig, resolveHlsXuiTokens } from "./server/streamEngine.js";
          initDb();
          const eff = getFfmpegEfficiencyConfig();
          const mode = eff.hlsXuiMode || "off";
          const names = {
            off: "línea original del panel",
            safe: "original + extras de XUI.one",
            full: "juego completo de XUI.one"
          };
          console.log("");
          console.log("============================================================");
          console.log("  TVLister 24/7 - Motor HLS (analisis del codigo de XUI.one)");
          console.log("============================================================");
          console.log("  Modo                : " + mode + "  (" + names[mode] + ")");
          console.log("  Segmento            : " + eff.hlsTime + " s");
          console.log("  Ventana             : " + eff.hlsListSize + " segmentos (~" + (eff.hlsTime * eff.hlsListSize) + " s)");
          console.log("  Sonda HTTP          : " + eff.probeHttp + " bytes / " + eff.analyzeHttp + " us");
          const tk = resolveHlsXuiTokens(mode, true);
          console.log("  -hls_flags          : " + tk.flags);
          console.log("  Opciones extra      : " + (tk.extra.length ? tk.extra.join(" ") : "(ninguna)"));
          console.log("  -err_detect         : " + (tk.errDetect ? "ignore_err" : "(no se pone)"));
          console.log("  -re en la entrada   : " + (tk.readNative ? "sí" : "no"));
          console.log("");
          if (mode === "off") {
            console.log("  Para afinar con lo de XUI.one:");
            console.log("     tvlister-admin hls xui safe     (recomendado)");
            console.log("     tvlister-admin hls xui full     (solo si safe no basta)");
          } else {
            console.log("  Volver atras en cualquier momento:");
            console.log("     tvlister-admin hls xui off");
          }
          console.log("============================================================");
        '
        ;;
      *)
        echo "Uso: tvlister-admin hls [status | xui off|safe|full]"
        exit 1
        ;;
    esac
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
    echo " 22) Dejar la salida UDP constante, sin picos (catv steady)"
    echo " 22b) Elegir quién genera el UDP: TVLister o Flussonic 23.12 (catv udp-engine)"
    echo " 22c) Aplicar la lista ordenada de nombres CH 2-125 (catv names)"
    echo " 23) Afinar el HLS con lo de XUI.one (hls xui safe|full|off)"
    echo " 24) Salud del sistema 24/7 (health) + mantenimiento"
    echo " 25) Proxy inverso para Cloudflare: panel sí, streams directos (cloudflare)"
    echo " 26) Probar la reproducción de un canal de punta a punta (streams-check)"
    echo " 27) Códigos de acceso al panel, estilo XUI.one (access-code)"
    echo " 28) Elegir el puerto de salida de los streams: 80 / 443 / 8095 (streams-port)"
    echo "  0) Salir"
    echo "============================================================"
    read -r -p "Selecciona una opción [0-28]: " opt
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
      22) cmd_catv "steady" "" ;;
      23) "$0" hls status ;;
      24) cmd_health "" || true ;;
      25)
        read -r -p "Dominio del panel (ej. tv.midominio.com): " CF_DOM
        read -r -p "Dominio para streams [stream.${CF_DOM}]: " CF_STREAM
        if [ -z "$CF_STREAM" ]; then CF_STREAM="stream.${CF_DOM}"; fi
        cmd_cloudflare "$CF_DOM" "$CF_STREAM" || true
        ;;
      26) "$0" streams-check ;;
      27) cmd_access_code "list" "" "" "" ;;
      28) "$0" streams-port ;;
      *) exit 0 ;;
    esac
    ;;
esac
exit 0
}
