import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import mysql from 'mysql2/promise';
import { db, hashPassword, resetPanelCatalog } from './db.js';

const MYSQL_SOCKET_CANDIDATES = [
  '/run/mysqld/mysqld.sock',
  '/var/run/mysqld/mysqld.sock',
  '/tmp/mysql.sock',
  '/var/lib/mysql/mysql.sock'
];

const DB_NAME_CANDIDATES = ['xui', 'xuione', 'xtream_iptvpro'];

const UNIX_SOCKET_AUTH_PLUGINS = {
  unix_socket: () => () => Buffer.alloc(0),
  auth_socket: () => () => Buffer.alloc(0)
};

function parseIniSimple(content = '') {
  const result = {};
  let section = 'root';
  result[section] = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1).trim();
      if (!result[section]) result[section] = {};
      continue;
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[section][key] = val;
  }
  return result;
}

function readXuiCredentialsTxt() {
  const paths = ['/root/credentials.txt', '/home/xui/credentials.txt', '/home/xui/config/credentials.txt'];
  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) continue;
      const txt = fs.readFileSync(p, 'utf8');
      const uMatch = txt.match(/MySQL\s+Username\s*:\s*(\S+)/i);
      const pMatch = txt.match(/MySQL\s+Password\s*:\s*(\S+)/i);
      if (uMatch && pMatch) {
        return { source: p, user: uMatch[1].trim(), password: pMatch[1].trim() };
      }
    } catch {
      // ignore permission errors
    }
  }
  return null;
}

function readDebianMysqlCnf() {
  try {
    if (!fs.existsSync('/etc/mysql/debian.cnf')) return null;
    const ini = parseIniSimple(fs.readFileSync('/etc/mysql/debian.cnf', 'utf8'));
    const sec = ini.client || ini.mysql_upgrade || {};
    if (sec.user) {
      return {
        source: '/etc/mysql/debian.cnf',
        user: sec.user,
        password: sec.password || '',
        socketPath: sec.socket || null,
        host: sec.host || '127.0.0.1',
        port: Number(sec.port) || 3306
      };
    }
  } catch {
    // ignore
  }
  return null;
}

function findMysqlCliBinary() {
  const candidates = ['/usr/bin/mysql', '/usr/local/bin/mysql', '/bin/mysql', '/usr/bin/mariadb'];
  for (const bin of candidates) {
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

export function inspectLocalXuiEnvironment() {
  const hasXuiDir = fs.existsSync('/home/xui');
  const configIniPath = '/home/xui/config/config.ini';
  const hasConfigIni = fs.existsSync(configIniPath);
  let configXui = null;

  if (hasConfigIni) {
    try {
      const parsed = parseIniSimple(fs.readFileSync(configIniPath, 'utf8'));
      const xuiSec = parsed.XUI || parsed.xui || parsed.root || {};
      configXui = {
        hostname: xuiSec.hostname || '127.0.0.1',
        port: Number(xuiSec.port) || 3306,
        database: xuiSec.database || 'xui',
        server_id: Number(xuiSec.server_id) || 1
      };
    } catch {
      configXui = { hostname: '127.0.0.1', port: 3306, database: 'xui', server_id: 1 };
    }
  }

  const sockets = MYSQL_SOCKET_CANDIDATES.filter((s) => fs.existsSync(s));
  const credsTxt = readXuiCredentialsTxt();
  const debianCnf = readDebianMysqlCnf();
  const mysqlCli = findMysqlCliBinary();

  // Scan common backup folders for .sql / .sql.gz dumps
  const backupDirs = ['/home/xui/backups', '/home/xui', '/root'];
  const localSqlBackups = [];
  const seenPaths = new Set();

  for (const dir of backupDirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const lower = entry.name.toLowerCase();
        if (!lower.endsWith('.sql') && !lower.endsWith('.sql.gz')) continue;
        const fullPath = path.join(dir, entry.name);
        if (seenPaths.has(fullPath)) continue;
        seenPaths.add(fullPath);
        const st = fs.statSync(fullPath);
        localSqlBackups.push({
          name: entry.name,
          path: fullPath,
          sizeBytes: st.size,
          modifiedAt: st.mtime.toISOString()
        });
      }
    } catch {
      // ignore unreadable dirs
    }
  }

  localSqlBackups.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));

  return {
    hasXuiDir,
    hasConfigIni,
    configXui,
    sockets,
    hasCredentialsTxt: Boolean(credsTxt),
    hasDebianCnf: Boolean(debianCnf),
    hasMysqlCli: Boolean(mysqlCli),
    canAutoConnect: Boolean(hasXuiDir || sockets.length > 0 || credsTxt || debianCnf || mysqlCli),
    localSqlBackups: localSqlBackups.slice(0, 20)
  };
}

function unescapeMysqlBatchCell(cell) {
  if (cell === '\\N') return null;
  let out = '';
  for (let i = 0; i < cell.length; i++) {
    if (cell[i] === '\\' && i + 1 < cell.length) {
      const next = cell[i + 1];
      if (next === 'n') {
        out += '\n';
        i++;
      } else if (next === 'r') {
        out += '\r';
        i++;
      } else if (next === 't') {
        out += '\t';
        i++;
      } else if (next === '0') {
        out += '\0';
        i++;
      } else if (next === '\\') {
        out += '\\';
        i++;
      } else {
        out += next;
        i++;
      }
    } else {
      out += cell[i];
    }
  }
  return out;
}

function createMysqlCliAdapter({ mysqlBin, socketPath, database, label }) {
  const runSql = (sql, useDb = true) => {
    const args = ['--batch', '--default-character-set=utf8mb4', '-u', 'root'];
    if (socketPath) args.push(`--socket=${socketPath}`);
    if (useDb && database) args.push(database);
    args.push('-e', sql);

    const stdout = execFileSync(mysqlBin, args, {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      timeout: 60000
    });
    if (!stdout || !stdout.trim()) return [];
    const lines = stdout.replace(/\r?\n$/, '').split(/\r?\n/);
    if (lines.length < 2) return [];
    const headers = lines[0].split('\t');
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split('\t');
      const obj = {};
      for (let c = 0; c < headers.length; c++) {
        obj[headers[c]] = cols[c] !== undefined ? unescapeMysqlBatchCell(cols[c]) : null;
      }
      rows.push(obj);
    }
    return rows;
  };

  return {
    label,
    database,
    async query(sql) {
      return runSql(sql, true);
    },
    async listTables() {
      const rows = runSql('SHOW TABLES;', true);
      return rows.map((r) => Object.values(r)[0]).filter(Boolean);
    },
    async close() {}
  };
}

async function discoverXuiDatabaseOnConnection(conn, preferredDb = '') {
  const [dbRows] = await conn.query('SHOW DATABASES');
  const allDbs = dbRows
    .map((r) => Object.values(r)[0])
    .filter((d) => d && !['information_schema', 'performance_schema', 'mysql', 'sys'].includes(String(d).toLowerCase()));

  const ordered = [
    ...(preferredDb ? [preferredDb] : []),
    ...DB_NAME_CANDIDATES,
    ...allDbs
  ].filter((v, idx, arr) => v && arr.indexOf(v) === idx);

  for (const dbName of ordered) {
    if (!allDbs.includes(dbName)) continue;
    try {
      const [tblRows] = await conn.query(`SHOW TABLES FROM \`${dbName.replace(/`/g, '')}\``);
      const tbls = new Set(tblRows.map((r) => String(Object.values(r)[0]).toLowerCase()));
      if (tbls.has('streams') && (tbls.has('lines') || tbls.has('users'))) {
        return dbName;
      }
    } catch {
      // ignore inaccessible database
    }
  }
  return null;
}

export async function openXuiDataSource(options = {}) {
  const mode = options.mode || 'auto';

  if (mode === 'sql') {
    if (options.sqlContent) {
      return createSqlDumpAdapter(options.sqlContent, options.fileName || 'dump.sql');
    }
    if (options.sqlFilePath) {
      const resolved = path.resolve(String(options.sqlFilePath));
      if (!fs.existsSync(resolved)) {
        throw new Error(`No existe el archivo SQL en el servidor: ${resolved}`);
      }
      const rawBuf = fs.readFileSync(resolved);
      const isGzip = (rawBuf.length >= 2 && rawBuf[0] === 0x1f && rawBuf[1] === 0x8b) || resolved.toLowerCase().endsWith('.gz');
      const sqlText = isGzip ? zlib.gunzipSync(rawBuf).toString('utf8') : rawBuf.toString('utf8');
      return createSqlDumpAdapter(sqlText, path.basename(resolved));
    }
    throw new Error('Debes subir un archivo .sql/.sql.gz o seleccionar un respaldo local.');
  }

  if (mode === 'mysql') {
    const rawHost = String(options.host || '127.0.0.1').trim();
    const port = Number(options.port) || 3306;
    const user = String(options.user || 'root').trim();
    const password = String(options.password || '');
    const requestedDb = String(options.database || '').trim();

    const connConfig = {
      user,
      password,
      charset: 'utf8mb4',
      connectTimeout: 10000,
      authPlugins: UNIX_SOCKET_AUTH_PLUGINS
    };
    if (rawHost.startsWith('/')) {
      connConfig.socketPath = rawHost;
    } else {
      connConfig.host = rawHost;
      connConfig.port = port;
    }

    const conn = await mysql.createConnection(connConfig);
    try {
      let targetDb = requestedDb;
      if (!targetDb || targetDb.toLowerCase() === 'auto') {
        targetDb = await discoverXuiDatabaseOnConnection(conn, 'xui');
        if (!targetDb) {
          throw new Error('Conectado a MySQL/MariaDB, pero no se encontró ninguna base de datos con tablas de XUI.one (`streams` y `lines`). Especifica el nombre de la base de datos.');
        }
      }
      await conn.changeUser({ database: targetDb });
      return {
        label: `MySQL ${rawHost}${rawHost.startsWith('/') ? '' : `:${port}`} / BD '${targetDb}'`,
        database: targetDb,
        async query(sql) {
          const [rows] = await conn.query(sql);
          return rows;
        },
        async listTables() {
          const [rows] = await conn.query('SHOW TABLES');
          return rows.map((r) => Object.values(r)[0]).filter(Boolean);
        },
        async close() {
          await conn.end().catch(() => {});
        }
      };
    } catch (err) {
      await conn.end().catch(() => {});
      throw err;
    }
  }

  // mode === 'auto': Multi-strategy local XUI.one discovery
  const env = inspectLocalXuiEnvironment();
  const preferredDb = env.configXui?.database || 'xui';
  const cfgHost = env.configXui?.hostname || '127.0.0.1';
  const cfgPort = env.configXui?.port || 3306;
  const credsTxt = readXuiCredentialsTxt();
  const debianCnf = readDebianMysqlCnf();
  const attempts = [];

  // 1) Local MariaDB/MySQL Unix sockets as root (standard on Ubuntu 22.04 with XUI.one)
  for (const sock of env.sockets) {
    attempts.push({
      label: `MariaDB Socket Local (${sock}) como root`,
      config: { socketPath: sock, user: 'root', password: '', charset: 'utf8mb4', connectTimeout: 5000, authPlugins: UNIX_SOCKET_AUTH_PLUGINS }
    });
  }

  // 2) Credentials saved by XUI.one installer in /root/credentials.txt
  if (credsTxt) {
    for (const sock of env.sockets) {
      attempts.push({
        label: `Credenciales XUI (${credsTxt.source}) vía Socket`,
        config: { socketPath: sock, user: credsTxt.user, password: credsTxt.password, charset: 'utf8mb4', connectTimeout: 5000, authPlugins: UNIX_SOCKET_AUTH_PLUGINS }
      });
    }
    attempts.push({
      label: `Credenciales XUI (${credsTxt.source}) TCP ${cfgHost}:${cfgPort}`,
      config: { host: cfgHost, port: cfgPort, user: credsTxt.user, password: credsTxt.password, charset: 'utf8mb4', connectTimeout: 5000 }
    });
  }

  // 3) Debian/Ubuntu system maintenance MariaDB credentials (/etc/mysql/debian.cnf)
  if (debianCnf) {
    if (debianCnf.socketPath && fs.existsSync(debianCnf.socketPath)) {
      attempts.push({
        label: 'Credenciales del Sistema (/etc/mysql/debian.cnf Socket)',
        config: { socketPath: debianCnf.socketPath, user: debianCnf.user, password: debianCnf.password, charset: 'utf8mb4', connectTimeout: 5000 }
      });
    }
    attempts.push({
      label: 'Credenciales del Sistema (/etc/mysql/debian.cnf TCP)',
      config: { host: debianCnf.host, port: debianCnf.port, user: debianCnf.user, password: debianCnf.password, charset: 'utf8mb4', connectTimeout: 5000 }
    });
  }

  // 4) Local TCP root without password
  attempts.push({
    label: `TCP Local ${cfgHost}:${cfgPort} (root)`,
    config: { host: cfgHost, port: cfgPort, user: 'root', password: '', charset: 'utf8mb4', connectTimeout: 4000, authPlugins: UNIX_SOCKET_AUTH_PLUGINS }
  });
  if (cfgPort !== 7999) {
    attempts.push({
      label: 'TCP Local 127.0.0.1:7999 (Xtream UI)',
      config: { host: '127.0.0.1', port: 7999, user: 'root', password: '', charset: 'utf8mb4', connectTimeout: 3000 }
    });
  }

  const errors = [];
  for (const cand of attempts) {
    let conn;
    try {
      conn = await mysql.createConnection(cand.config);
      const targetDb = await discoverXuiDatabaseOnConnection(conn, preferredDb);
      if (!targetDb) {
        await conn.end().catch(() => {});
        errors.push(`${cand.label}: conectado pero sin tablas de XUI.one`);
        continue;
      }
      await conn.changeUser({ database: targetDb });
      return {
        label: `${cand.label} → BD '${targetDb}'`,
        database: targetDb,
        async query(sql) {
          const [rows] = await conn.query(sql);
          return rows;
        },
        async listTables() {
          const [rows] = await conn.query('SHOW TABLES');
          return rows.map((r) => Object.values(r)[0]).filter(Boolean);
        },
        async close() {
          await conn.end().catch(() => {});
        }
      };
    } catch (err) {
      if (conn) await conn.end().catch(() => {});
      errors.push(`${cand.label}: ${err.message}`);
    }
  }

  // 5) Fallback to mysql CLI binary as root (uses OS peer auth directly)
  const mysqlBin = findMysqlCliBinary();
  if (mysqlBin) {
    const sockCandidates = env.sockets.length > 0 ? env.sockets : [null];
    for (const sock of sockCandidates) {
      for (const dbCand of [preferredDb, ...DB_NAME_CANDIDATES].filter((v, i, a) => v && a.indexOf(v) === i)) {
        try {
          const cliAdapter = createMysqlCliAdapter({
            mysqlBin,
            socketPath: sock,
            database: dbCand,
            label: `CLI ${mysqlBin}${sock ? ` (${sock})` : ''} → BD '${dbCand}'`
          });
          const tbls = (await cliAdapter.listTables()).map((t) => t.toLowerCase());
          if (tbls.includes('streams') && (tbls.includes('lines') || tbls.includes('users'))) {
            return cliAdapter;
          }
        } catch (err) {
          errors.push(`CLI ${mysqlBin} (${dbCand}): ${err.message}`);
        }
      }
    }
  }

  throw new Error(
    `No se detectó conexión automática a XUI.one en este servidor. Usa "Conexión MySQL Manual" o sube un respaldo ".sql / .sql.gz". (${errors[0] || 'Sin instancia MariaDB local'})`
  );
}

// ============================================================================
// SQL Dump (.sql / .sql.gz) Parser for XUI.one & Xtream UI mysqldump files
// ============================================================================

const RELEVANT_DUMP_TABLES = new Set([
  'streams',
  'streams_servers',
  'streams_categories',
  'stream_categories',
  'categories',
  'streams_series',
  'series',
  'streams_episodes',
  'series_episodes',
  'bouquets',
  'lines',
  'users',
  'reg_users',
  'mag_devices'
]);

function extractCreateTableColumns(createBody) {
  const cols = [];
  const lines = createBody.split(/\r?\n/);
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('PRIMARY ') || trimmed.startsWith('UNIQUE ') || trimmed.startsWith('KEY ') || trimmed.startsWith('INDEX ') || trimmed.startsWith('CONSTRAINT ') || trimmed.startsWith('FULLTEXT ') || trimmed.startsWith(')')) {
      continue;
    }
    const m = trimmed.match(/^`([^`]+)`\s+/);
    if (m) cols.push(m[1]);
  }
  return cols;
}

function parseSqlValueToken(tok) {
  if (tok === null || tok === undefined) return null;
  if (tok.isString) return tok.value;
  const upper = tok.value.toUpperCase();
  if (upper === 'NULL') return null;
  if (upper === 'TRUE') return 1;
  if (upper === 'FALSE') return 0;
  if (/^-?\d+(\.\d+)?$/.test(tok.value)) {
    const num = Number(tok.value);
    return Number.isSafeInteger(num) ? num : tok.value;
  }
  return tok.value;
}

function parseSqlValuesTuples(valuesStr) {
  const rows = [];
  let i = 0;
  const len = valuesStr.length;

  while (i < len) {
    // Advance to next '('
    while (i < len && valuesStr[i] !== '(') {
      if (valuesStr[i] === ';') return rows;
      i++;
    }
    if (i >= len) break;
    i++; // skip '('

    const row = [];
    while (i < len) {
      while (i < len && /\s/.test(valuesStr[i])) i++;
      if (i >= len) break;
      if (valuesStr[i] === ')') {
        i++;
        break;
      }

      if (valuesStr[i] === "'" || valuesStr[i] === '"') {
        const quote = valuesStr[i];
        i++;
        let str = '';
        while (i < len) {
          const ch = valuesStr[i];
          if (ch === '\\' && i + 1 < len) {
            const next = valuesStr[i + 1];
            if (next === 'n') str += '\n';
            else if (next === 'r') str += '\r';
            else if (next === 't') str += '\t';
            else if (next === '0') str += '\0';
            else str += next;
            i += 2;
            continue;
          }
          if (ch === quote) {
            if (valuesStr[i + 1] === quote) {
              str += quote;
              i += 2;
              continue;
            }
            i++;
            break;
          }
          str += ch;
          i++;
        }
        row.push(parseSqlValueToken({ isString: true, value: str }));
      } else {
        let rawVal = '';
        while (i < len && valuesStr[i] !== ',' && valuesStr[i] !== ')') {
          rawVal += valuesStr[i];
          i++;
        }
        row.push(parseSqlValueToken({ isString: false, value: rawVal.trim() }));
      }

      while (i < len && /\s/.test(valuesStr[i])) i++;
      if (valuesStr[i] === ',') i++;
    }
    rows.push(row);
  }
  return rows;
}

function createSqlDumpAdapter(sqlText, fileName = 'dump.sql') {
  const tableColumns = new Map();
  const tableRows = new Map();

  // 1) Parse CREATE TABLE column orders
  const createRegex = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+`?([a-zA-Z0-9_]+)`?\s*\(([\s\S]*?)\)\s*ENGINE=/gi;
  let cm;
  while ((cm = createRegex.exec(sqlText)) !== null) {
    const tbl = cm[1].toLowerCase();
    if (!RELEVANT_DUMP_TABLES.has(tbl)) continue;
    const cols = extractCreateTableColumns(cm[2]);
    if (cols.length > 0) tableColumns.set(tbl, cols);
  }

  // 2) Parse INSERT INTO statements cleanly scanning statement boundaries outside quotes
  const insertHeadRegex = /INSERT\s+(?:IGNORE\s+)?INTO\s+`?([a-zA-Z0-9_]+)`?\s*(\([^)]+\))?\s*VALUES\s*/gi;
  let im;
  while ((im = insertHeadRegex.exec(sqlText)) !== null) {
    const tbl = im[1].toLowerCase();
    const explicitColsRaw = im[2];
    const startIdx = insertHeadRegex.lastIndex;

    // Find terminating ';' outside single/double quotes
    let endIdx = startIdx;
    let inQuote = null;
    while (endIdx < sqlText.length) {
      const ch = sqlText[endIdx];
      if (inQuote) {
        if (ch === '\\') {
          endIdx += 2;
          continue;
        }
        if (ch === inQuote) {
          if (sqlText[endIdx + 1] === inQuote) {
            endIdx += 2;
            continue;
          }
          inQuote = null;
        }
      } else if (ch === "'" || ch === '"') {
        inQuote = ch;
      } else if (ch === ';') {
        break;
      }
      endIdx++;
    }

    insertHeadRegex.lastIndex = endIdx + 1;
    if (!RELEVANT_DUMP_TABLES.has(tbl)) continue;

    let cols = null;
    if (explicitColsRaw) {
      cols = explicitColsRaw
        .slice(1, -1)
        .split(',')
        .map((c) => c.trim().replace(/^`|`$/g, ''));
    } else {
      cols = tableColumns.get(tbl) || null;
    }

    const tuples = parseSqlValuesTuples(sqlText.slice(startIdx, endIdx + 1));
    if (!tableRows.has(tbl)) tableRows.set(tbl, []);
    const dest = tableRows.get(tbl);

    for (const tuple of tuples) {
      if (cols && cols.length > 0) {
        const obj = {};
        for (let c = 0; c < cols.length; c++) {
          obj[cols[c]] = tuple[c] !== undefined ? tuple[c] : null;
        }
        dest.push(obj);
      } else {
        // Fallback positional defaults if CREATE TABLE was omitted from dump
        dest.push(mapFallbackPositionalRow(tbl, tuple));
      }
    }
  }

  return {
    label: `Respaldo SQL (${fileName})`,
    database: fileName,
    isSqlDump: true,
    async listTables() {
      return Array.from(new Set([...tableColumns.keys(), ...tableRows.keys()]));
    },
    async getTableRows(tblName) {
      return tableRows.get(tblName.toLowerCase()) || [];
    },
    async close() {}
  };
}

function mapFallbackPositionalRow(tbl, t) {
  if (tbl === 'streams_categories' || tbl === 'stream_categories') {
    return { id: t[0], category_type: t[1], category_name: t[2], parent_id: t[3], cat_order: t[4] };
  }
  if (tbl === 'bouquets') {
    return { id: t[0], bouquet_name: t[1], bouquet_channels: t[2], bouquet_movies: t[3], bouquet_radios: t[4], bouquet_series: t[5], bouquet_order: t[6] };
  }
  if (tbl === 'mag_devices') {
    return { mag_id: t[0], user_id: t[1], bright: t[2], contrast: t[3], saturation: t[4], aspect: t[5], video_out: t[6], volume: t[7], playback_buffer_bytes: t[8], playback_buffer_size: t[9], audio_out: t[10], mac: t[11] ?? t[2] };
  }
  if (tbl === 'lines') {
    return { id: t[0], member_id: t[1], username: t[2], password: t[3], last_ip: t[4], exp_date: t[5], admin_enabled: t[6], enabled: t[7], admin_notes: t[8], reseller_notes: t[9], bouquet: t[10], max_connections: t[11] ?? 1, is_restreamer: t[12], allowed_ips: t[13], allowed_ua: t[14], is_trial: t[15] ?? 0, created_at: t[16], is_mag: t[19] ?? 0, is_e2: t[20] ?? 0 };
  }
  if (tbl === 'streams') {
    return { id: t[0], type: t[1], category_id: t[2], stream_display_name: t[3], stream_source: t[4], stream_icon: t[5], notes: t[6], created_channel_location: t[7], enable_transcode: t[8], transcode_attributes: t[9], custom_ffmpeg: t[10], movie_properties: t[11], movie_subtitles: t[12], read_native: t[13], target_container: t[14], stream_all: t[15], remove_subtitles: t[16], custom_sid: t[17], epg_id: t[18], channel_id: t[19], gen_timestamps: t[20], added: t[21], series_no: t[22], direct_source: t[23], tv_archive_duration: t[24] };
  }
  return {};
}

// ============================================================================
// Data Extraction & Normalization (Supports XUI.one 1.5.x & Xtream UI)
// ============================================================================

function parseJsonArraySafe(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw === null || raw === undefined || raw === '') return [];
  const str = String(raw).trim();
  if (!str) return [];
  try {
    const parsed = JSON.parse(str);
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === 'number' || typeof parsed === 'string') return [parsed];
    return [];
  } catch {
    if (/^\d+$/.test(str)) return [Number(str)];
    return [];
  }
}

function parseJsonObjectSafe(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parsePrimaryCategoryId(raw) {
  if (typeof raw === 'number' && raw > 0) return raw;
  const arr = parseJsonArraySafe(raw);
  for (const item of arr) {
    const n = Number(item);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeXuiSourceUrl(rawUrl) {
  if (!rawUrl) return '';
  let u = String(rawUrl).trim();
  // XUI.one prefixes direct/local paths with "s:<serverId>:" or "s:http..."
  if (/^s:\d+:/i.test(u)) {
    u = u.replace(/^s:\d+:/i, '');
  } else if (/^s:https?:\/\//i.test(u)) {
    u = u.slice(2);
  }
  return u.trim();
}

function parseStreamSources(rawSource) {
  const arr = parseJsonArraySafe(rawSource);
  if (arr.length > 0) {
    const cleaned = arr.map(normalizeXuiSourceUrl).filter(Boolean);
    return {
      primaryUrl: cleaned[0] || '',
      backupUrl: cleaned[1] || ''
    };
  }
  const single = normalizeXuiSourceUrl(rawSource);
  return { primaryUrl: single, backupUrl: '' };
}

function normalizeContainerExt(rawTarget, fallbackUrl = '') {
  const arr = parseJsonArraySafe(rawTarget);
  const candidate = String(arr[0] || rawTarget || '').replace(/^\./, '').trim().toLowerCase();
  if (['mp4', 'mkv', 'avi', 'ts', 'm3u8', 'mov', 'webm', 'flv'].includes(candidate)) {
    return candidate;
  }
  const m = String(fallbackUrl).match(/\.([a-zA-Z0-9]{2,4})(?:\?|$)/);
  if (m) return m[1].toLowerCase();
  return 'mp4';
}

function decodeMagMacAddress(rawMac) {
  if (!rawMac) return '';
  const str = String(rawMac).trim();
  const macRegex = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;
  if (macRegex.test(str)) {
    return str.replace(/-/g, ':').toUpperCase();
  }
  try {
    const decoded = Buffer.from(str, 'base64').toString('utf8').trim();
    if (macRegex.test(decoded)) {
      return decoded.replace(/-/g, ':').toUpperCase();
    }
  } catch {
    // ignore invalid base64
  }
  return '';
}

function unixToIsoOrNull(rawExp) {
  if (rawExp === null || rawExp === undefined || rawExp === '' || rawExp === '0' || rawExp === 0) {
    return null;
  }
  const num = Number(rawExp);
  if (!Number.isFinite(num) || num <= 0) {
    const parsedDate = Date.parse(String(rawExp));
    return Number.isNaN(parsedDate) ? null : new Date(parsedDate).toISOString();
  }
  // Handle seconds vs milliseconds
  const ms = num > 99999999999 ? num : num * 1000;
  return new Date(ms).toISOString();
}

async function fetchTableFromSource(source, tableName) {
  if (source.isSqlDump) {
    return source.getTableRows(tableName);
  }
  return source.query(`SELECT * FROM \`${tableName.replace(/`/g, '')}\``);
}

export async function extractXuiDataset(source) {
  const rawTables = await source.listTables();
  const tableSet = new Set(rawTables.map((t) => String(t).toLowerCase()));
  const findActualTable = (...candidates) => {
    for (const c of candidates) {
      const hit = rawTables.find((t) => String(t).toLowerCase() === c.toLowerCase());
      if (hit) return hit;
    }
    return null;
  };

  const hasLinesTable = tableSet.has('lines');
  const schemaFlavor = hasLinesTable
    ? 'XUI.one 1.5.x'
    : tableSet.has('reg_users')
      ? 'Xtream UI / Xtream Codes'
      : 'Panel Compatible XUI';

  const catTable = findActualTable('streams_categories', 'stream_categories', 'categories');
  const streamsTable = findActualTable('streams');
  const streamServersTable = findActualTable('streams_servers', 'streams_sys');
  const bouquetsTable = findActualTable('bouquets');
  const linesTable = hasLinesTable ? findActualTable('lines') : findActualTable('users');
  const resellersTable = hasLinesTable ? findActualTable('users') : findActualTable('reg_users');
  const magTable = findActualTable('mag_devices');
  const seriesTable = findActualTable('streams_series', 'series');
  const episodesTable = findActualTable('streams_episodes', 'series_episodes');

  if (!streamsTable && !linesTable) {
    throw new Error('La fuente seleccionada no contiene tablas `streams` ni `lines`/`users` de XUI.one.');
  }

  const [
    rawCategories,
    rawStreams,
    rawStreamServers,
    rawBouquets,
    rawLines,
    rawResellers,
    rawMags,
    rawSeries,
    rawEpisodes
  ] = await Promise.all([
    catTable ? fetchTableFromSource(source, catTable).catch(() => []) : [],
    streamsTable ? fetchTableFromSource(source, streamsTable).catch(() => []) : [],
    streamServersTable ? fetchTableFromSource(source, streamServersTable).catch(() => []) : [],
    bouquetsTable ? fetchTableFromSource(source, bouquetsTable).catch(() => []) : [],
    linesTable ? fetchTableFromSource(source, linesTable).catch(() => []) : [],
    resellersTable ? fetchTableFromSource(source, resellersTable).catch(() => []) : [],
    magTable ? fetchTableFromSource(source, magTable).catch(() => []) : [],
    seriesTable ? fetchTableFromSource(source, seriesTable).catch(() => []) : [],
    episodesTable ? fetchTableFromSource(source, episodesTable).catch(() => []) : []
  ]);

  // Index on_demand per stream_id
  const onDemandByStreamId = new Map();
  for (const ss of rawStreamServers) {
    const sid = Number(ss.stream_id);
    if (sid && Number(ss.on_demand) === 1) {
      onDemandByStreamId.set(sid, true);
    }
  }

  // Index MAG MAC addresses per user_id
  const magByLineId = new Map();
  for (const m of rawMags) {
    const uid = Number(m.user_id);
    const mac = decodeMagMacAddress(m.mac);
    if (uid && mac) magByLineId.set(uid, mac);
  }

  // Normalize Categories
  const categories = rawCategories
    .map((c, idx) => {
      const xuiId = Number(c.id);
      const rawType = String(c.category_type || c.type || 'live').toLowerCase();
      let type = 'live';
      if (rawType === 'movie' || rawType === 'vod') type = 'vod';
      else if (rawType === 'series') type = 'series';
      else type = 'live'; // live + radio -> live
      return {
        xui_id: Number.isFinite(xuiId) ? xuiId : idx + 1,
        name: String(c.category_name || c.name || `Categoría ${idx + 1}`).trim(),
        type,
        sort_order: Number(c.cat_order ?? c.sort_order ?? idx + 1) || idx + 1
      };
    })
    .filter((c) => c.name);

  // Split Streams into Live (type 1, 3, 4), VOD Movies (type 2), and Series Episode Streams (type 5)
  const liveStreams = [];
  const vodMovies = [];
  const episodeStreamById = new Map();

  for (const s of rawStreams) {
    const xuiId = Number(s.id);
    const typeNum = Number(s.type ?? 1);
    const name = String(s.stream_display_name || s.name || '').trim();
    const { primaryUrl, backupUrl } = parseStreamSources(s.stream_source);
    const xuiCatId = parsePrimaryCategoryId(s.category_id);

    if (typeNum === 5) {
      episodeStreamById.set(xuiId, {
        xui_id: xuiId,
        title: name,
        source_url: primaryUrl,
        movie_props: parseJsonObjectSafe(s.movie_properties || s.movie_propeties),
        container_ext: normalizeContainerExt(s.target_container, primaryUrl)
      });
      continue;
    }

    if (!name || !primaryUrl) continue;

    if (typeNum === 2) {
      const props = parseJsonObjectSafe(s.movie_properties || s.movie_propeties);
      const releaseStr = String(props.releasedate || props.releaseDate || '');
      const yearMatch = releaseStr.match(/\b(19\d{2}|20\d{2})\b/);
      vodMovies.push({
        xui_id: xuiId,
        title: name,
        xui_category_id: xuiCatId,
        source_url: primaryUrl,
        poster_url: String(props.movie_image || props.cover_big || s.stream_icon || '').trim(),
        backdrop_url: String(Array.isArray(props.backdrop_path) ? props.backdrop_path[0] || '' : props.backdrop_path || '').trim(),
        plot: String(props.plot || props.description || s.notes || '').trim(),
        genre: String(props.genre || 'General').trim(),
        release_year: yearMatch ? Number(yearMatch[1]) : 2024,
        rating: Number(props.rating) || 8.0,
        duration_sec: Number(props.duration_secs) || 5400,
        container_ext: normalizeContainerExt(s.target_container, primaryUrl),
        direct_source: Number(s.direct_source ?? 1) ? 1 : 1
      });
    } else {
      // type 1 (Live), type 3 (Created Live), type 4 (Radio)
      const isOnDemand = onDemandByStreamId.get(xuiId) === true;
      const archiveHoursOrDays = Number(s.tv_archive_duration || 0);
      const archiveDays = archiveHoursOrDays > 30 ? Math.ceil(archiveHoursOrDays / 24) : archiveHoursOrDays;
      liveStreams.push({
        xui_id: xuiId,
        name,
        xui_category_id: xuiCatId,
        source_url: primaryUrl,
        backup_url: backupUrl,
        logo_url: String(s.stream_icon || '').trim(),
        epg_channel_id: String(s.channel_id || '').trim(),
        stream_mode: isOnDemand ? 'ondemand' : 'direct',
        status: isOnDemand ? 'ondemand_idle' : 'running',
        tv_archive_days: archiveDays > 0 ? archiveDays : 0
      });
    }
  }

  // Normalize Series + Episodes
  const seriesList = rawSeries
    .map((sr) => {
      const xuiId = Number(sr.id);
      const releaseStr = String(sr.releaseDate || sr.release_date || sr.year || '');
      const yearMatch = releaseStr.match(/\b(19\d{2}|20\d{2})\b/);
      let backdrop = '';
      const bp = parseJsonArraySafe(sr.backdrop_path);
      if (bp.length > 0) backdrop = String(bp[0] || '');
      else if (sr.backdrop_path) backdrop = String(sr.backdrop_path);

      return {
        xui_id: xuiId,
        title: String(sr.title || '').trim(),
        xui_category_id: parsePrimaryCategoryId(sr.category_id),
        poster_url: String(sr.cover || sr.cover_big || '').trim(),
        backdrop_url: backdrop.trim(),
        plot: String(sr.plot || '').trim(),
        genre: String(sr.genre || 'General').trim(),
        release_year: yearMatch ? Number(yearMatch[1]) : 2024,
        rating: Number(sr.rating) || 8.0
      };
    })
    .filter((sr) => sr.title);

  const episodesList = [];
  for (const ep of rawEpisodes) {
    const streamId = Number(ep.stream_id);
    const seriesXuiId = Number(ep.series_id);
    const epStream = episodeStreamById.get(streamId);
    if (!seriesXuiId || !epStream || !epStream.source_url) continue;
    const props = epStream.movie_props || {};
    episodesList.push({
      xui_id: Number(ep.id) || streamId,
      xui_series_id: seriesXuiId,
      season_num: Number(ep.season_num ?? ep.season ?? 1) || 1,
      episode_num: Number(ep.episode_num ?? ep.sort ?? 1) || 1,
      title: epStream.title || `Temporada ${ep.season_num || 1} - Episodio ${ep.episode_num || 1}`,
      source_url: epStream.source_url,
      plot: String(props.plot || '').trim(),
      duration_sec: Number(props.duration_secs) || 2400,
      container_ext: epStream.container_ext || 'mp4'
    });
  }

  // Normalize Bouquets
  const bouquets = rawBouquets
    .map((b, idx) => ({
      xui_id: Number(b.id),
      name: String(b.bouquet_name || b.name || `Bouquet ${idx + 1}`).trim(),
      xui_channels: [
        ...parseJsonArraySafe(b.bouquet_channels).map(Number),
        ...parseJsonArraySafe(b.bouquet_radios).map(Number)
      ].filter((n) => Number.isFinite(n) && n > 0),
      xui_movies: parseJsonArraySafe(b.bouquet_movies)
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0),
      xui_series: parseJsonArraySafe(b.bouquet_series)
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0),
      sort_order: Number(b.bouquet_order ?? idx + 1) || idx + 1
    }))
    .filter((b) => b.name);

  // Normalize Resellers (excluding main admin account collision)
  const resellers = rawResellers
    .filter((u) => {
      const uname = String(u.username || '').trim();
      if (!uname || uname.toLowerCase() === 'admin') return false;
      const grp = Number(u.member_group_id ?? 2);
      // In XUI.one / Xtream UI, member_group_id = 1 is Super Admin; >= 2 are resellers/subresellers
      return grp !== 1;
    })
    .map((u) => ({
      xui_id: Number(u.id),
      username: String(u.username).trim(),
      email: String(u.email || '').trim(),
      credits: Math.max(0, Math.round(Number(u.credits || 0))),
      status: Number(u.status ?? 1) === 1 ? 'active' : 'suspended',
      notes: String(u.notes || 'Importado desde XUI.one').trim()
    }));

  // Normalize Subscriber Lines / Users + MAG / Enigma2
  const lines = rawLines
    .map((l) => {
      const xuiId = Number(l.id);
      const username = String(l.username || '').trim();
      const password = String(l.password || '').trim();
      if (!username || !password) return null;

      const isMag = Number(l.is_mag || 0) === 1 || magByLineId.has(xuiId);
      const isE2 = Number(l.is_e2 || 0) === 1;
      const deviceType = isMag ? 'mag' : isE2 ? 'enigma2' : 'm3u';
      const macAddress = magByLineId.get(xuiId) || '';

      const adminEnabled = l.admin_enabled === undefined || l.admin_enabled === null ? 1 : Number(l.admin_enabled);
      const enabled = l.enabled === undefined || l.enabled === null ? 1 : Number(l.enabled);
      const status = adminEnabled === 1 && enabled === 1 ? 'active' : 'suspended';

      const allowedIpsArr = parseJsonArraySafe(l.allowed_ips);
      const allowedIps = allowedIpsArr.length > 0 ? allowedIpsArr.join(', ') : String(l.allowed_ips || '').replace(/^\[\]$/, '').trim();

      const notesParts = [l.admin_notes, l.reseller_notes].map((n) => String(n || '').trim()).filter(Boolean);

      return {
        xui_id: xuiId,
        xui_member_id: Number(l.member_id || 1),
        username,
        password,
        exp_date: unixToIsoOrNull(l.exp_date),
        max_connections: Math.max(1, Number(l.max_connections || 1)),
        is_trial: Number(l.is_trial || 0) === 1 ? 1 : 0,
        status,
        device_type: deviceType,
        mac_address: macAddress,
        xui_bouquets: parseJsonArraySafe(l.bouquet)
          .map(Number)
          .filter((n) => Number.isFinite(n) && n > 0),
        allowed_ips: allowedIps,
        notes: notesParts.join(' | ')
      };
    })
    .filter(Boolean);

  return {
    sourceLabel: source.label,
    database: source.database,
    schemaFlavor,
    categories,
    liveStreams,
    vodMovies,
    seriesList,
    episodesList,
    bouquets,
    lines,
    resellers
  };
}

export async function previewXuiImport(connectionOptions = {}) {
  const source = await openXuiDataSource(connectionOptions);
  try {
    const ds = await extractXuiDataset(source);
    return {
      ok: true,
      sourceLabel: ds.sourceLabel,
      database: ds.database,
      schemaFlavor: ds.schemaFlavor,
      counts: {
        categories: ds.categories.length,
        liveStreams: ds.liveStreams.length,
        vodMovies: ds.vodMovies.length,
        series: ds.seriesList.length,
        episodes: ds.episodesList.length,
        bouquets: ds.bouquets.length,
        lines: ds.lines.length,
        magDevices: ds.lines.filter((l) => l.device_type === 'mag').length,
        resellers: ds.resellers.length
      },
      samples: {
        streams: ds.liveStreams.slice(0, 8).map((s) => ({
          id: s.xui_id,
          name: s.name,
          mode: s.stream_mode,
          source_url: s.source_url
        })),
        vod: ds.vodMovies.slice(0, 5).map((v) => ({
          id: v.xui_id,
          title: v.title,
          year: v.release_year
        })),
        lines: ds.lines.slice(0, 8).map((l) => ({
          id: l.xui_id,
          username: l.username,
          status: l.status,
          max_connections: l.max_connections,
          device_type: l.device_type,
          exp_date: l.exp_date
        }))
      }
    };
  } finally {
    await source.close();
  }
}

export async function executeXuiImport(connectionOptions = {}, importFlags = {}) {
  const {
    importCategories = true,
    importStreams = true,
    importVod = true,
    importSeries = true,
    importBouquets = true,
    importLines = true,
    importResellers = false,
    replaceExisting = false,
    streamModeOverride = 'preserve' // 'preserve' | 'direct' | 'ondemand'
  } = importFlags;

  const source = await openXuiDataSource(connectionOptions);
  let ds;
  try {
    ds = await extractXuiDataset(source);
  } finally {
    await source.close();
  }

  if (replaceExisting) {
    resetPanelCatalog({ wipeCategories: true, wipeResellers: Boolean(importResellers) });
  }

  const stats = {
    categoriesCreated: 0,
    categoriesUpdated: 0,
    streamsCreated: 0,
    streamsUpdated: 0,
    vodCreated: 0,
    vodUpdated: 0,
    seriesCreated: 0,
    seriesUpdated: 0,
    episodesImported: 0,
    bouquetsSynced: 0,
    linesCreated: 0,
    linesUpdated: 0,
    resellersImported: 0
  };

  // ID translation maps (xui_id -> tvlister sqlite id)
  const catMap = new Map();
  const streamMap = new Map();
  const vodMap = new Map();
  const seriesMap = new Map();
  const bouquetMap = new Map();
  const resellerMap = new Map();

  // Preload existing xui_id mappings so incremental sync works even when importing only Lines or only Streams
  for (const r of db.prepare('SELECT id, xui_id, name, type FROM categories').all()) {
    if (r.xui_id) catMap.set(`${r.type}:${r.xui_id}`, Number(r.id));
    if (r.xui_id) catMap.set(`any:${r.xui_id}`, Number(r.id));
  }
  for (const r of db.prepare('SELECT id, xui_id FROM streams WHERE xui_id IS NOT NULL').all()) {
    streamMap.set(Number(r.xui_id), Number(r.id));
  }
  for (const r of db.prepare('SELECT id, xui_id FROM vod_items WHERE xui_id IS NOT NULL').all()) {
    vodMap.set(Number(r.xui_id), Number(r.id));
  }
  for (const r of db.prepare('SELECT id, xui_id FROM series WHERE xui_id IS NOT NULL').all()) {
    seriesMap.set(Number(r.xui_id), Number(r.id));
  }
  for (const r of db.prepare('SELECT id, xui_id FROM bouquets WHERE xui_id IS NOT NULL').all()) {
    bouquetMap.set(Number(r.xui_id), Number(r.id));
  }
  for (const r of db.prepare('SELECT id, xui_id FROM users WHERE xui_id IS NOT NULL').all()) {
    resellerMap.set(Number(r.xui_id), Number(r.id));
  }

  const adminUser = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get();
  const defaultOwnerId = adminUser ? Number(adminUser.id) : 1;

  db.exec('BEGIN IMMEDIATE;');
  try {
    // 1. Categories
    if (importCategories || importStreams || importVod || importSeries) {
      const findCatByXui = db.prepare('SELECT id FROM categories WHERE xui_id = ? AND type = ? LIMIT 1');
      const findCatByName = db.prepare('SELECT id FROM categories WHERE LOWER(name) = LOWER(?) AND type = ? LIMIT 1');
      const insCat = db.prepare('INSERT INTO categories (name, type, sort_order, xui_id) VALUES (?, ?, ?, ?)');
      const updCat = db.prepare('UPDATE categories SET name = ?, sort_order = ?, xui_id = ? WHERE id = ?');

      for (const c of ds.categories) {
        if (!importCategories) break;
        const existing = findCatByXui.get(c.xui_id, c.type) || findCatByName.get(c.name, c.type);
        let tvId;
        if (existing) {
          tvId = Number(existing.id);
          updCat.run(c.name, c.sort_order, c.xui_id, tvId);
          stats.categoriesUpdated++;
        } else {
          const info = insCat.run(c.name, c.type, c.sort_order, c.xui_id);
          tvId = Number(info.lastInsertRowid);
          stats.categoriesCreated++;
        }
        catMap.set(`${c.type}:${c.xui_id}`, tvId);
        catMap.set(`any:${c.xui_id}`, tvId);
      }
    }

    const ensureFallbackCategory = (type, defaultName) => {
      const row = db.prepare('SELECT id FROM categories WHERE type = ? ORDER BY sort_order ASC, id ASC LIMIT 1').get(type);
      if (row) return Number(row.id);
      const info = db.prepare('INSERT INTO categories (name, type, sort_order) VALUES (?, ?, 99)').run(defaultName, type);
      return Number(info.lastInsertRowid);
    };

    // 2. Live Streams
    if (importStreams && ds.liveStreams.length > 0) {
      const fallbackLiveCatId = ensureFallbackCategory('live', 'Canales XUI.one');
      const findStreamByXui = db.prepare('SELECT id FROM streams WHERE xui_id = ? LIMIT 1');
      const findStreamByUrl = db.prepare('SELECT id FROM streams WHERE LOWER(name) = LOWER(?) AND source_url = ? LIMIT 1');
      const insStream = db.prepare(`
        INSERT INTO streams (
          name, category_id, source_url, backup_url, logo_url, epg_channel_id,
          stream_mode, transcode_profile_id, server_id, status, tv_archive_days, archive_enabled, xui_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)
      `);
      const updStream = db.prepare(`
        UPDATE streams
        SET name = ?, category_id = ?, source_url = ?, backup_url = ?, logo_url = ?,
            epg_channel_id = ?, stream_mode = ?, status = ?, tv_archive_days = ?, archive_enabled = ?, xui_id = ?
        WHERE id = ?
      `);

      for (const s of ds.liveStreams) {
        const catId =
          catMap.get(`live:${s.xui_category_id}`) ||
          catMap.get(`any:${s.xui_category_id}`) ||
          fallbackLiveCatId;

        const mode =
          streamModeOverride === 'direct'
            ? 'direct'
            : streamModeOverride === 'ondemand'
              ? 'ondemand'
              : s.stream_mode;
        const status = mode === 'ondemand' ? 'ondemand_idle' : 'running';
        const archiveEnabled = s.tv_archive_days > 0 ? 1 : 0;

        const existing = findStreamByXui.get(s.xui_id) || findStreamByUrl.get(s.name, s.source_url);
        let tvId;
        if (existing) {
          tvId = Number(existing.id);
          updStream.run(
            s.name,
            catId,
            s.source_url,
            s.backup_url,
            s.logo_url,
            s.epg_channel_id,
            mode,
            status,
            s.tv_archive_days,
            archiveEnabled,
            s.xui_id,
            tvId
          );
          stats.streamsUpdated++;
        } else {
          const info = insStream.run(
            s.name,
            catId,
            s.source_url,
            s.backup_url,
            s.logo_url,
            s.epg_channel_id,
            mode,
            status,
            s.tv_archive_days,
            archiveEnabled,
            s.xui_id
          );
          tvId = Number(info.lastInsertRowid);
          stats.streamsCreated++;
        }
        streamMap.set(s.xui_id, tvId);
      }
    }

    // 3. VOD Movies
    if (importVod && ds.vodMovies.length > 0) {
      const fallbackVodCatId = ensureFallbackCategory('vod', 'Películas XUI.one');
      const findVodByXui = db.prepare('SELECT id FROM vod_items WHERE xui_id = ? LIMIT 1');
      const findVodByUrl = db.prepare('SELECT id FROM vod_items WHERE LOWER(title) = LOWER(?) AND source_url = ? LIMIT 1');
      const insVod = db.prepare(`
        INSERT INTO vod_items (
          title, type, category_id, source_url, poster_url, backdrop_url,
          plot, genre, release_year, rating, duration_sec, container_ext, direct_source, xui_id
        ) VALUES (?, 'movie', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const updVod = db.prepare(`
        UPDATE vod_items
        SET title = ?, category_id = ?, source_url = ?, poster_url = ?, backdrop_url = ?,
            plot = ?, genre = ?, release_year = ?, rating = ?, duration_sec = ?, container_ext = ?, xui_id = ?
        WHERE id = ?
      `);

      for (const v of ds.vodMovies) {
        const catId =
          catMap.get(`vod:${v.xui_category_id}`) ||
          catMap.get(`any:${v.xui_category_id}`) ||
          fallbackVodCatId;
        const existing = findVodByXui.get(v.xui_id) || findVodByUrl.get(v.title, v.source_url);
        let tvId;
        if (existing) {
          tvId = Number(existing.id);
          updVod.run(
            v.title,
            catId,
            v.source_url,
            v.poster_url,
            v.backdrop_url,
            v.plot,
            v.genre,
            v.release_year,
            v.rating,
            v.duration_sec,
            v.container_ext,
            v.xui_id,
            tvId
          );
          stats.vodUpdated++;
        } else {
          const info = insVod.run(
            v.title,
            catId,
            v.source_url,
            v.poster_url,
            v.backdrop_url,
            v.plot,
            v.genre,
            v.release_year,
            v.rating,
            v.duration_sec,
            v.container_ext,
            v.direct_source,
            v.xui_id
          );
          tvId = Number(info.lastInsertRowid);
          stats.vodCreated++;
        }
        vodMap.set(v.xui_id, tvId);
      }
    }

    // 4. Series & Episodes
    if (importSeries && ds.seriesList.length > 0) {
      const fallbackSeriesCatId = ensureFallbackCategory('series', 'Series XUI.one');
      const findSeriesByXui = db.prepare('SELECT id FROM series WHERE xui_id = ? LIMIT 1');
      const findSeriesByTitle = db.prepare('SELECT id FROM series WHERE LOWER(title) = LOWER(?) LIMIT 1');
      const insSeries = db.prepare(`
        INSERT INTO series (title, category_id, poster_url, backdrop_url, plot, genre, release_year, rating, xui_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const updSeries = db.prepare(`
        UPDATE series
        SET title = ?, category_id = ?, poster_url = ?, backdrop_url = ?, plot = ?, genre = ?, release_year = ?, rating = ?, xui_id = ?
        WHERE id = ?
      `);

      for (const sr of ds.seriesList) {
        const catId =
          catMap.get(`series:${sr.xui_category_id}`) ||
          catMap.get(`any:${sr.xui_category_id}`) ||
          fallbackSeriesCatId;
        const existing = findSeriesByXui.get(sr.xui_id) || findSeriesByTitle.get(sr.title);
        let tvId;
        if (existing) {
          tvId = Number(existing.id);
          updSeries.run(
            sr.title,
            catId,
            sr.poster_url,
            sr.backdrop_url,
            sr.plot,
            sr.genre,
            sr.release_year,
            sr.rating,
            sr.xui_id,
            tvId
          );
          stats.seriesUpdated++;
        } else {
          const info = insSeries.run(
            sr.title,
            catId,
            sr.poster_url,
            sr.backdrop_url,
            sr.plot,
            sr.genre,
            sr.release_year,
            sr.rating,
            sr.xui_id
          );
          tvId = Number(info.lastInsertRowid);
          stats.seriesCreated++;
        }
        seriesMap.set(sr.xui_id, tvId);
      }

      const findEp = db.prepare(
        'SELECT id FROM series_episodes WHERE series_id = ? AND season_num = ? AND episode_num = ? LIMIT 1'
      );
      const insEp = db.prepare(`
        INSERT INTO series_episodes (series_id, season_num, episode_num, title, source_url, plot, duration_sec, container_ext, xui_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const updEp = db.prepare(`
        UPDATE series_episodes
        SET title = ?, source_url = ?, plot = ?, duration_sec = ?, container_ext = ?, xui_id = ?
        WHERE id = ?
      `);

      for (const ep of ds.episodesList) {
        const tvSeriesId = seriesMap.get(ep.xui_series_id);
        if (!tvSeriesId) continue;
        const existing = findEp.get(tvSeriesId, ep.season_num, ep.episode_num);
        if (existing) {
          updEp.run(ep.title, ep.source_url, ep.plot, ep.duration_sec, ep.container_ext, ep.xui_id, existing.id);
        } else {
          insEp.run(
            tvSeriesId,
            ep.season_num,
            ep.episode_num,
            ep.title,
            ep.source_url,
            ep.plot,
            ep.duration_sec,
            ep.container_ext,
            ep.xui_id
          );
        }
        stats.episodesImported++;
      }
    }

    // 5. Bouquets + Keep Main Bouquet #1 Synced
    if (importBouquets && ds.bouquets.length > 0) {
      const findBqByXui = db.prepare('SELECT id FROM bouquets WHERE xui_id = ? LIMIT 1');
      const findBqByName = db.prepare('SELECT id FROM bouquets WHERE LOWER(name) = LOWER(?) LIMIT 1');
      const insBq = db.prepare(`
        INSERT INTO bouquets (name, description, stream_ids_json, channel247_ids_json, vod_ids_json, series_ids_json, sort_order, xui_id)
        VALUES (?, ?, ?, '[]', ?, ?, ?, ?)
      `);
      const updBq = db.prepare(`
        UPDATE bouquets
        SET name = ?, stream_ids_json = ?, vod_ids_json = ?, series_ids_json = ?, sort_order = ?, xui_id = ?
        WHERE id = ?
      `);

      for (const b of ds.bouquets) {
        const mappedStreams = Array.from(
          new Set(b.xui_channels.map((id) => streamMap.get(id)).filter(Boolean))
        );
        const mappedVod = Array.from(
          new Set(b.xui_movies.map((id) => vodMap.get(id)).filter(Boolean))
        );
        const mappedSeries = Array.from(
          new Set(b.xui_series.map((id) => seriesMap.get(id)).filter(Boolean))
        );

        const existing = findBqByXui.get(b.xui_id) || findBqByName.get(b.name);
        let tvId;
        if (existing) {
          tvId = Number(existing.id);
          updBq.run(
            b.name,
            JSON.stringify(mappedStreams),
            JSON.stringify(mappedVod),
            JSON.stringify(mappedSeries),
            b.sort_order,
            b.xui_id,
            tvId
          );
        } else {
          const info = insBq.run(
            b.name,
            'Bouquet importado desde XUI.one',
            JSON.stringify(mappedStreams),
            JSON.stringify(mappedVod),
            JSON.stringify(mappedSeries),
            b.sort_order,
            b.xui_id
          );
          tvId = Number(info.lastInsertRowid);
        }
        bouquetMap.set(b.xui_id, tvId);
        stats.bouquetsSynced++;
      }
    }

    // Ensure Bouquet #1 (Bouquet General) includes all imported content if it wasn't overwritten by an XUI bouquet
    const b1 = db.prepare('SELECT * FROM bouquets WHERE id = 1').get();
    if (b1 && !b1.xui_id) {
      const mergeIds = (rawJson, allTableRows) => {
        const current = new Set(parseJsonArraySafe(rawJson).map(Number).filter(Boolean));
        for (const r of allTableRows) current.add(Number(r.id));
        return JSON.stringify(Array.from(current));
      };
      const allS = db.prepare('SELECT id FROM streams').all();
      const allV = db.prepare('SELECT id FROM vod_items').all();
      const allSr = db.prepare('SELECT id FROM series').all();
      db.prepare(
        'UPDATE bouquets SET stream_ids_json = ?, vod_ids_json = ?, series_ids_json = ? WHERE id = 1'
      ).run(
        mergeIds(b1.stream_ids_json, allS),
        mergeIds(b1.vod_ids_json, allV),
        mergeIds(b1.series_ids_json, allSr)
      );
    }

    // 6. Optional Reseller Accounts
    if (importResellers && ds.resellers.length > 0) {
      const findUser = db.prepare('SELECT id, role FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1');
      const insUser = db.prepare(`
        INSERT INTO users (username, password_hash, role, credits, email, status, notes, xui_id)
        VALUES (?, ?, 'reseller', ?, ?, ?, ?, ?)
      `);
      const updUser = db.prepare(`
        UPDATE users SET credits = ?, email = ?, status = ?, notes = ?, xui_id = ?
        WHERE id = ? AND role = 'reseller'
      `);

      for (const r of ds.resellers) {
        const existing = findUser.get(r.username);
        if (existing) {
          if (existing.role === 'reseller') {
            updUser.run(r.credits, r.email, r.status, r.notes, r.xui_id, existing.id);
            resellerMap.set(r.xui_id, Number(existing.id));
            stats.resellersImported++;
          }
        } else {
          // Temporary password = username + "2026" (XUI stores bcrypt hashes incompatible with PBKDF2; admin can reset anytime)
          const info = insUser.run(
            r.username,
            hashPassword(`${r.username}2026`),
            r.credits,
            r.email,
            r.status,
            r.notes,
            r.xui_id
          );
          resellerMap.set(r.xui_id, Number(info.lastInsertRowid));
          stats.resellersImported++;
        }
      }
    }

    // 7. Subscriber Lines / Users + MAG Devices
    if (importLines && ds.lines.length > 0) {
      const allBouquetIds = db.prepare('SELECT id FROM bouquets ORDER BY sort_order ASC, id ASC').all().map((b) => Number(b.id));
      const fallbackBouquetsJson = JSON.stringify(allBouquetIds.length > 0 ? [allBouquetIds[0]] : [1]);

      const findLineByUsername = db.prepare('SELECT id FROM lines WHERE LOWER(username) = LOWER(?) LIMIT 1');
      const insLine = db.prepare(`
        INSERT INTO lines (
          username, password, owner_id, exp_date, max_connections, is_trial,
          status, device_type, mac_address, bouquet_ids_json, allowed_ips, notes, xui_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const updLine = db.prepare(`
        UPDATE lines
        SET password = ?, owner_id = ?, exp_date = ?, max_connections = ?, is_trial = ?,
            status = ?, device_type = ?, mac_address = ?, bouquet_ids_json = ?, allowed_ips = ?, notes = ?, xui_id = ?
        WHERE id = ?
      `);

      for (const l of ds.lines) {
        const ownerId = resellerMap.get(l.xui_member_id) || defaultOwnerId;
        const mappedBq = l.xui_bouquets
          .map((bid) => bouquetMap.get(bid))
          .filter(Boolean);
        const bouquetJson = mappedBq.length > 0 ? JSON.stringify(Array.from(new Set(mappedBq))) : fallbackBouquetsJson;

        const existing = findLineByUsername.get(l.username);
        if (existing) {
          updLine.run(
            l.password,
            ownerId,
            l.exp_date,
            l.max_connections,
            l.is_trial,
            l.status,
            l.device_type,
            l.mac_address,
            bouquetJson,
            l.allowed_ips,
            l.notes,
            l.xui_id,
            existing.id
          );
          stats.linesUpdated++;
        } else {
          insLine.run(
            l.username,
            l.password,
            ownerId,
            l.exp_date,
            l.max_connections,
            l.is_trial,
            l.status,
            l.device_type,
            l.mac_address,
            bouquetJson,
            l.allowed_ips,
            l.notes,
            l.xui_id
          );
          stats.linesCreated++;
        }
      }
    }

    db.exec('COMMIT;');
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // ignore
    }
    throw err;
  }

  return {
    ok: true,
    sourceLabel: ds.sourceLabel,
    schemaFlavor: ds.schemaFlavor,
    stats
  };
}
