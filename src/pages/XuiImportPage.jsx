import React, { useEffect, useState } from 'react';
import {
  Database,
  Server,
  Upload,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Radio,
  Users,
  Film,
  Layers,
  FolderTree,
  Play,
  ShieldCheck,
  HardDrive,
  Trash2,
  Tv2,
  UserCheck,
  Sparkles,
  ArrowRight
} from 'lucide-react';
import { apiFetch, getToken } from '../lib/api.js';

function formatBytes(bytes = 0) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let val = bytes;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function XuiImportPage({ setActiveTab }) {
  const [sourceTab, setSourceTab] = useState('auto'); // 'auto' | 'mysql' | 'sql'
  const [envInfo, setEnvInfo] = useState(null);
  const [loadingEnv, setLoadingEnv] = useState(true);

  const [mysqlForm, setMysqlForm] = useState({
    host: '127.0.0.1',
    port: '3306',
    user: 'root',
    password: '',
    database: 'xui'
  });

  const [selectedLocalSql, setSelectedLocalSql] = useState('');
  const [uploadedSqlPath, setUploadedSqlPath] = useState('');
  const [uploadedFileName, setUploadedFileName] = useState('');
  const [uploadingSql, setUploadingSql] = useState(false);

  const [flags, setFlags] = useState({
    importStreams: true,
    importLines: true,
    importCategories: true,
    importBouquets: true,
    importVod: true,
    importSeries: true,
    importResellers: false,
    replaceExisting: false,
    streamModeOverride: 'preserve'
  });

  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [previewData, setPreviewData] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const detectLocalEnv = async () => {
    setLoadingEnv(true);
    try {
      const res = await apiFetch('/api/xui/detect');
      setEnvInfo(res);
      if (res.configXui) {
        setMysqlForm((prev) => ({
          ...prev,
          host: res.configXui.hostname || prev.host,
          port: String(res.configXui.port || prev.port),
          database: res.configXui.database || prev.database
        }));
      }
      if (res.localSqlBackups?.length > 0 && !selectedLocalSql) {
        setSelectedLocalSql(res.localSqlBackups[0].path);
      }
      if (!res.canAutoConnect && res.localSqlBackups?.length === 0) {
        setSourceTab('mysql');
      }
    } catch (err) {
      setError(err.message || 'No se pudo inspeccionar el entorno local');
    } finally {
      setLoadingEnv(false);
    }
  };

  useEffect(() => {
    detectLocalEnv();
  }, []);

  const buildConnectionPayload = () => {
    if (sourceTab === 'auto') {
      return { mode: 'auto' };
    }
    if (sourceTab === 'mysql') {
      return {
        mode: 'mysql',
        host: mysqlForm.host.trim(),
        port: Number(mysqlForm.port) || 3306,
        user: mysqlForm.user.trim(),
        password: mysqlForm.password,
        database: mysqlForm.database.trim()
      };
    }
    // sql mode
    const targetPath = uploadedSqlPath || selectedLocalSql;
    return {
      mode: 'sql',
      sqlFilePath: targetPath,
      fileName: uploadedFileName || (targetPath ? targetPath.split('/').pop() : 'dump.sql')
    };
  };

  const handlePreview = async () => {
    setError('');
    setNotice('');
    setImportResult(null);
    setPreviewing(true);
    try {
      const payload = buildConnectionPayload();
      const res = await apiFetch('/api/xui/preview', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      setPreviewData(res);
    } catch (err) {
      setPreviewData(null);
      setError(err.message || 'Error al analizar la base de datos de XUI.one');
    } finally {
      setPreviewing(false);
    }
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    setNotice('');
    setImportResult(null);
    setUploadingSql(true);
    try {
      const token = getToken();
      const resp = await fetch('/api/xui/upload-sql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-file-name': encodeURIComponent(file.name),
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: file
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || 'Error subiendo archivo SQL');
      }
      setUploadedSqlPath(data.uploadedSqlPath);
      setUploadedFileName(file.name);
      setPreviewData(data);
      setNotice(`Respaldo "${file.name}" (${formatBytes(file.size)}) cargado y analizado correctamente.`);
    } catch (err) {
      setPreviewData(null);
      setError(err.message || 'No se pudo procesar el archivo .sql / .sql.gz');
    } finally {
      setUploadingSql(false);
      e.target.value = '';
    }
  };

  const handleExecuteImport = async () => {
    setError('');
    setNotice('');
    setImporting(true);
    try {
      const connection = buildConnectionPayload();
      const res = await apiFetch('/api/xui/import', {
        method: 'POST',
        body: JSON.stringify({ connection, flags })
      });
      setImportResult(res);
      setNotice('Importación desde XUI.one completada con éxito.');
    } catch (err) {
      setError(err.message || 'Error durante la importación de XUI.one');
    } finally {
      setImporting(false);
    }
  };

  const handleCleanPanel = async () => {
    const ok = window.confirm(
      '¿Deseas dejar el panel 100% limpio?\n\nSe eliminarán todos los canales, VOD, series, canales 24/7, categorías, bouquets extra y líneas de usuarios actuales.\nTu cuenta Super Admin y perfiles FFmpeg se conservarán intactos.'
    );
    if (!ok) return;
    setError('');
    setNotice('');
    setCleaning(true);
    try {
      const res = await apiFetch('/api/system/maintenance', {
        method: 'POST',
        body: JSON.stringify({ action: 'clean_panel', wipeCategories: true, wipeResellers: true })
      });
      setImportResult(null);
      setNotice(res.message || 'Panel limpiado al 100%.');
    } catch (err) {
      setError(err.message || 'No se pudo limpiar el panel');
    } finally {
      setCleaning(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="rounded-2xl bg-gradient-to-r from-[#11192e] via-[#131d38] to-[#0f172a] border border-indigo-500/30 p-6 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 shadow-xl">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/15 border border-indigo-400/30 text-indigo-300 text-xs font-semibold mb-2">
            <Database className="w-3.5 h-3.5" />
            Integración Nativa XUI.one 1.5.x & Xtream UI (Modo Solo-Lectura Seguro)
          </div>
          <h1 className="text-xl sm:text-2xl font-bold text-white">
            Importador de Base de Datos XUI.one — Streams & Usuarios
          </h1>
          <p className="text-sm text-slate-400 mt-1 max-w-3xl">
            Extrae canales en vivo, películas VOD, series, categorías, bouquets, líneas de clientes y dispositivos MAG directamente desde tu instalación de <span className="text-slate-200 font-mono">/home/xui</span>, un servidor MySQL/MariaDB remoto o un respaldo <span className="text-slate-200 font-mono">.sql / .sql.gz</span> sin alterar ni detener tu XUI.one.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={handleCleanPanel}
            disabled={cleaning}
            className="px-4 py-2.5 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-300 text-xs font-semibold flex items-center gap-2 transition disabled:opacity-50"
          >
            <Trash2 className="w-4 h-4" />
            {cleaning ? 'Limpiando...' : 'Dejar Panel 100% Limpio'}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-2xl bg-rose-500/15 border border-rose-500/35 text-sm text-rose-200 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
          <div>{error}</div>
        </div>
      )}

      {notice && (
        <div className="p-4 rounded-2xl bg-emerald-500/15 border border-emerald-500/35 text-sm text-emerald-200 flex items-start gap-3">
          <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
          <div>{notice}</div>
        </div>
      )}

      {/* Connection Mode Selector */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <button
          type="button"
          onClick={() => {
            setSourceTab('auto');
            setError('');
          }}
          className={`p-4 rounded-2xl border text-left transition ${
            sourceTab === 'auto'
              ? 'bg-indigo-600/20 border-indigo-500/50 shadow-lg shadow-indigo-950/40'
              : 'bg-[#0e1526] border-slate-800 hover:border-slate-700'
          }`}
        >
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-sm font-bold text-white flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-indigo-400" />
              1. XUI.one Local Automático
            </span>
            {envInfo?.hasXuiDir && (
              <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                Detectado
              </span>
            )}
          </div>
          <p className="text-xs text-slate-400">
            Conecta en 1 clic al MariaDB local de <span className="font-mono text-slate-300">/home/xui</span> vía socket root o credenciales del sistema.
          </p>
        </button>

        <button
          type="button"
          onClick={() => {
            setSourceTab('mysql');
            setError('');
          }}
          className={`p-4 rounded-2xl border text-left transition ${
            sourceTab === 'mysql'
              ? 'bg-indigo-600/20 border-indigo-500/50 shadow-lg shadow-indigo-950/40'
              : 'bg-[#0e1526] border-slate-800 hover:border-slate-700'
          }`}
        >
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-sm font-bold text-white flex items-center gap-2">
              <Server className="w-4 h-4 text-cyan-400" />
              2. Conexión MySQL / MariaDB
            </span>
          </div>
          <p className="text-xs text-slate-400">
            Conecta especificando IP/Host, puerto (3306 / 7999), usuario, contraseña y base de datos <span className="font-mono text-slate-300">xui</span>.
          </p>
        </button>

        <button
          type="button"
          onClick={() => {
            setSourceTab('sql');
            setError('');
          }}
          className={`p-4 rounded-2xl border text-left transition ${
            sourceTab === 'sql'
              ? 'bg-indigo-600/20 border-indigo-500/50 shadow-lg shadow-indigo-950/40'
              : 'bg-[#0e1526] border-slate-800 hover:border-slate-700'
          }`}
        >
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-sm font-bold text-white flex items-center gap-2">
              <Upload className="w-4 h-4 text-emerald-400" />
              3. Archivo Respaldo .SQL / .GZ
            </span>
            {envInfo?.localSqlBackups?.length > 0 && (
              <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                {envInfo.localSqlBackups.length} locales
              </span>
            )}
          </div>
          <p className="text-xs text-slate-400">
            Sube un dump <span className="font-mono text-slate-300">.sql</span> / <span className="font-mono text-slate-300">.sql.gz</span> de XUI.one o elige un backup de <span className="font-mono text-slate-300">/home/xui/backups</span>.
          </p>
        </button>
      </div>

      {/* Main Grid: Left = Source Config + Flags, Right = Preview & Execution */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        <div className="xl:col-span-5 space-y-6">
          {/* Source Details Card */}
          <div className="rounded-2xl bg-[#0e1526] border border-slate-800 p-5 space-y-4">
            {sourceTab === 'auto' && (
              <>
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-bold text-white flex items-center gap-2">
                    <HardDrive className="w-4 h-4 text-indigo-400" />
                    Diagnóstico Local del Servidor
                  </h2>
                  <button
                    type="button"
                    onClick={detectLocalEnv}
                    className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${loadingEnv ? 'animate-spin' : ''}`} />
                    Re-escanear
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2.5 text-xs">
                  <div className="p-3 rounded-xl bg-[#090e1a] border border-slate-800">
                    <div className="text-slate-400">Directorio /home/xui</div>
                    <div className={`font-semibold mt-0.5 ${envInfo?.hasXuiDir ? 'text-emerald-400' : 'text-slate-500'}`}>
                      {envInfo?.hasXuiDir ? 'Presente (/home/xui)' : 'No detectado'}
                    </div>
                  </div>
                  <div className="p-3 rounded-xl bg-[#090e1a] border border-slate-800">
                    <div className="text-slate-400">Base de Datos Config</div>
                    <div className="font-semibold text-slate-200 mt-0.5 font-mono">
                      {envInfo?.configXui?.database || 'xui'} (:{envInfo?.configXui?.port || 3306})
                    </div>
                  </div>
                  <div className="p-3 rounded-xl bg-[#090e1a] border border-slate-800">
                    <div className="text-slate-400">Socket MariaDB Local</div>
                    <div className={`font-semibold mt-0.5 truncate ${envInfo?.sockets?.length ? 'text-emerald-400' : 'text-slate-500'}`}>
                      {envInfo?.sockets?.[0] || 'Sin socket activo'}
                    </div>
                  </div>
                  <div className="p-3 rounded-xl bg-[#090e1a] border border-slate-800">
                    <div className="text-slate-400">Acceso Automático</div>
                    <div className={`font-semibold mt-0.5 ${envInfo?.canAutoConnect ? 'text-emerald-400' : 'text-amber-400'}`}>
                      {envInfo?.canAutoConnect ? 'Listo (Root / Socket)' : 'Usar MySQL o .SQL'}
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handlePreview}
                  disabled={previewing}
                  className="w-full py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20 transition disabled:opacity-50"
                >
                  <RefreshCw className={`w-4 h-4 ${previewing ? 'animate-spin' : ''}`} />
                  {previewing ? 'Analizando Base de Datos XUI.one...' : 'Conectar y Previsualizar XUI.one Local'}
                </button>
              </>
            )}

            {sourceTab === 'mysql' && (
              <>
                <h2 className="text-sm font-bold text-white flex items-center gap-2">
                  <Server className="w-4 h-4 text-cyan-400" />
                  Parámetros MySQL / MariaDB de XUI.one
                </h2>

                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2">
                    <label className="block text-xs text-slate-400 mb-1">Host IP o Ruta Socket</label>
                    <input
                      type="text"
                      value={mysqlForm.host}
                      onChange={(e) => setMysqlForm({ ...mysqlForm, host: e.target.value })}
                      placeholder="127.0.0.1 o /run/mysqld/mysqld.sock"
                      className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-sm text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Puerto</label>
                    <input
                      type="number"
                      value={mysqlForm.port}
                      onChange={(e) => setMysqlForm({ ...mysqlForm, port: e.target.value })}
                      placeholder="3306"
                      className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-sm text-white"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Usuario MySQL</label>
                    <input
                      type="text"
                      value={mysqlForm.user}
                      onChange={(e) => setMysqlForm({ ...mysqlForm, user: e.target.value })}
                      placeholder="root"
                      className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-sm text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Contraseña</label>
                    <input
                      type="password"
                      value={mysqlForm.password}
                      onChange={(e) => setMysqlForm({ ...mysqlForm, password: e.target.value })}
                      placeholder="(vacío si usa socket root)"
                      className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-sm text-white"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-slate-400 mb-1">Nombre de Base de Datos</label>
                  <input
                    type="text"
                    value={mysqlForm.database}
                    onChange={(e) => setMysqlForm({ ...mysqlForm, database: e.target.value })}
                    placeholder="xui (o deja vacío para auto-descubrir)"
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-sm text-white font-mono"
                  />
                </div>

                <button
                  type="button"
                  onClick={handlePreview}
                  disabled={previewing}
                  className="w-full py-2.5 px-4 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-semibold flex items-center justify-center gap-2 transition disabled:opacity-50"
                >
                  <RefreshCw className={`w-4 h-4 ${previewing ? 'animate-spin' : ''}`} />
                  {previewing ? 'Conectando a MySQL...' : 'Probar Conexión y Previsualizar'}
                </button>
              </>
            )}

            {sourceTab === 'sql' && (
              <>
                <h2 className="text-sm font-bold text-white flex items-center gap-2">
                  <Upload className="w-4 h-4 text-emerald-400" />
                  Cargar Respaldo SQL de XUI.one (.sql / .sql.gz)
                </h2>

                <label className="flex flex-col items-center justify-center p-5 rounded-2xl border-2 border-dashed border-slate-700 hover:border-emerald-500/60 bg-[#090e1a] cursor-pointer transition text-center">
                  <Upload className="w-7 h-7 text-emerald-400 mb-2" />
                  <span className="text-xs font-semibold text-white">
                    {uploadingSql
                      ? 'Subiendo y analizando respaldo SQL...'
                      : uploadedFileName
                        ? `Archivo listo: ${uploadedFileName}`
                        : 'Haz clic para subir tu archivo .sql o .sql.gz'}
                  </span>
                  <span className="text-[11px] text-slate-400 mt-1">
                    Compatible con mysqldump de XUI.one y respaldos comprimidos .gz (hasta 250 MB)
                  </span>
                  <input
                    type="file"
                    accept=".sql,.gz"
                    onChange={handleFileUpload}
                    disabled={uploadingSql}
                    className="hidden"
                  />
                </label>

                {envInfo?.localSqlBackups?.length > 0 && (
                  <div className="space-y-2 pt-2 border-t border-slate-800">
                    <label className="block text-xs text-slate-400">
                      O selecciona un respaldo detectado en el servidor:
                    </label>
                    <select
                      value={selectedLocalSql}
                      onChange={(e) => {
                        setSelectedLocalSql(e.target.value);
                        setUploadedSqlPath('');
                        setUploadedFileName('');
                      }}
                      className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-xs text-white font-mono"
                    >
                      {envInfo.localSqlBackups.map((b) => (
                        <option key={b.path} value={b.path}>
                          {b.path} ({formatBytes(b.sizeBytes)})
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={handlePreview}
                      disabled={previewing || !selectedLocalSql}
                      className="w-full py-2 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition"
                    >
                      Analizar Respaldo del Servidor Seleccionado
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Import Selection Checkboxes */}
          <div className="rounded-2xl bg-[#0e1526] border border-slate-800 p-5 space-y-4">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              ¿Qué datos deseas importar?
            </h2>

            <div className="space-y-2.5 text-xs">
              {[
                { key: 'importStreams', label: 'Canales en Vivo & Radio (Streams)', desc: 'URLs primarias, failover backup, logos, EPG ID y catchup' },
                { key: 'importLines', label: 'Usuarios / Líneas & Dispositivos MAG', desc: 'Usuario, clave, expiración, conexiones máx, MAC MAG y notas' },
                { key: 'importCategories', label: 'Categorías de Canales, VOD y Series', desc: ' Conserva el orden y clasificación original de XUI.one' },
                { key: 'importBouquets', label: 'Bouquets y Paquetes de Contenido', desc: 'Mapea automáticamente canales y líneas a sus bouquets' },
                { key: 'importVod', label: 'Películas VOD (Movies)', desc: ' Pósters, sinopsis, año, género y URL directa del contenedor' },
                { key: 'importSeries', label: 'Series y Episodios', desc: 'Temporadas, capítulos y metadatos completos' },
                { key: 'importResellers', label: 'Cuentas de Resellers', desc: 'Importa revendedores con sus créditos actuales' }
              ].map((item) => (
                <label
                  key={item.key}
                  className="flex items-start gap-3 p-2.5 rounded-xl bg-[#090e1a] border border-slate-800/90 hover:border-slate-700 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={Boolean(flags[item.key])}
                    onChange={(e) => setFlags({ ...flags, [item.key]: e.target.checked })}
                    className="mt-0.5 rounded border-slate-600 text-indigo-500 focus:ring-indigo-500"
                  />
                  <div>
                    <div className="font-semibold text-slate-200">{item.label}</div>
                    <div className="text-[11px] text-slate-400">{item.desc}</div>
                  </div>
                </label>
              ))}
            </div>

            <div className="pt-2 border-t border-slate-800 space-y-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Modo de Arranque para Streams Importados</label>
                <select
                  value={flags.streamModeOverride}
                  onChange={(e) => setFlags({ ...flags, streamModeOverride: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-xs text-white"
                >
                  <option value="preserve">Respetar configuración Direct / On-Demand de XUI.one</option>
                  <option value="direct">Modo Direct Stream (Sin recodificar — Zapping instantáneo)</option>
                  <option value="ondemand">Modo On-Demand (Solo activa al conectar un cliente)</option>
                </select>
              </div>

              <label className="flex items-start gap-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/25 cursor-pointer">
                <input
                  type="checkbox"
                  checked={flags.replaceExisting}
                  onChange={(e) => setFlags({ ...flags, replaceExisting: e.target.checked })}
                  className="mt-0.5 rounded border-amber-500/50 text-amber-500"
                />
                <div className="text-xs">
                  <div className="font-semibold text-amber-300">Reemplazar catálogo actual antes de importar</div>
                  <div className="text-[11px] text-amber-200/70">
                    Si no lo marcas, el importador fusiona y actualiza sin duplicar canales ni líneas existentes.
                  </div>
                </div>
              </label>
            </div>
          </div>
        </div>

        {/* Right Column: Preview & Import Action */}
        <div className="xl:col-span-7 space-y-6">
          {!previewData && !importResult && (
            <div className="rounded-2xl bg-[#0e1526] border border-slate-800 p-10 text-center space-y-3">
              <div className="w-14 h-14 rounded-2xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center mx-auto text-indigo-400">
                <Database className="w-7 h-7" />
              </div>
              <h3 className="text-base font-bold text-white">
                Conecta tu origen XUI.one para previsualizar Streams y Usuarios
              </h3>
              <p className="text-xs text-slate-400 max-w-md mx-auto">
                Haz clic en <span className="text-slate-200 font-semibold">Conectar y Previsualizar</span> en el panel izquierdo para inspeccionar cuántos canales, películas, bouquets y líneas están listos para migrarse.
              </p>
            </div>
          )}

          {previewData && (
            <div className="rounded-2xl bg-[#0e1526] border border-slate-800 p-6 space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-4 border-b border-slate-800">
                <div>
                  <div className="text-xs font-semibold text-emerald-400 flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4" />
                    Fuente verificada • {previewData.schemaFlavor}
                  </div>
                  <h3 className="text-base font-bold text-white mt-0.5">{previewData.sourceLabel}</h3>
                </div>

                <button
                  type="button"
                  onClick={handleExecuteImport}
                  disabled={importing}
                  className="px-5 py-3 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-sm font-bold flex items-center justify-center gap-2 shadow-lg shadow-emerald-600/25 transition disabled:opacity-50"
                >
                  {importing ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      Importando a TVLister 24/7...
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4" />
                      Importar Streams y Usuarios Ahora
                    </>
                  )}
                </button>
              </div>

              {/* Summary Counters */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-3.5 rounded-xl bg-[#090e1a] border border-indigo-500/25">
                  <div className="text-xs text-slate-400 flex items-center gap-1.5">
                    <Radio className="w-3.5 h-3.5 text-indigo-400" /> Canales en Vivo
                  </div>
                  <div className="text-2xl font-bold text-white mt-1">{previewData.counts?.liveStreams ?? 0}</div>
                </div>
                <div className="p-3.5 rounded-xl bg-[#090e1a] border border-cyan-500/25">
                  <div className="text-xs text-slate-400 flex items-center gap-1.5">
                    <Users className="w-3.5 h-3.5 text-cyan-400" /> Usuarios / Líneas
                  </div>
                  <div className="text-2xl font-bold text-white mt-1">{previewData.counts?.lines ?? 0}</div>
                  {previewData.counts?.magDevices > 0 && (
                    <div className="text-[11px] text-cyan-300 mt-0.5">{previewData.counts.magDevices} STB MAG</div>
                  )}
                </div>
                <div className="p-3.5 rounded-xl bg-[#090e1a] border border-violet-500/25">
                  <div className="text-xs text-slate-400 flex items-center gap-1.5">
                    <Film className="w-3.5 h-3.5 text-violet-400" /> VOD & Series
                  </div>
                  <div className="text-2xl font-bold text-white mt-1">
                    {(previewData.counts?.vodMovies ?? 0) + (previewData.counts?.series ?? 0)}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    {previewData.counts?.vodMovies ?? 0} pelis • {previewData.counts?.episodes ?? 0} caps
                  </div>
                </div>
                <div className="p-3.5 rounded-xl bg-[#090e1a] border border-emerald-500/25">
                  <div className="text-xs text-slate-400 flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5 text-emerald-400" /> Cat. & Bouquets
                  </div>
                  <div className="text-2xl font-bold text-white mt-1">
                    {previewData.counts?.categories ?? 0} / {previewData.counts?.bouquets ?? 0}
                  </div>
                  {previewData.counts?.resellers > 0 && (
                    <div className="text-[11px] text-amber-300 mt-0.5">{previewData.counts.resellers} resellers</div>
                  )}
                </div>
              </div>

              {/* Sample Preview Tables */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="rounded-xl bg-[#090e1a] border border-slate-800 p-4">
                  <div className="text-xs font-bold text-slate-300 mb-2.5 flex items-center gap-1.5">
                    <Radio className="w-3.5 h-3.5 text-indigo-400" />
                    Muestra de Streams Detectados
                  </div>
                  {previewData.samples?.streams?.length > 0 ? (
                    <div className="space-y-1.5 max-h-52 overflow-y-auto">
                      {previewData.samples.streams.map((s) => (
                        <div key={s.id} className="text-xs flex items-center justify-between gap-2 py-1 border-b border-slate-800/70 last:border-0">
                          <span className="text-slate-200 truncate font-medium">#{s.id} {s.name}</span>
                          <span className="px-1.5 py-0.5 rounded bg-slate-800 text-[10px] text-slate-400 shrink-0 uppercase">
                            {s.mode}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs text-slate-500">Sin canales en vivo en esta fuente.</div>
                  )}
                </div>

                <div className="rounded-xl bg-[#090e1a] border border-slate-800 p-4">
                  <div className="text-xs font-bold text-slate-300 mb-2.5 flex items-center gap-1.5">
                    <Users className="w-3.5 h-3.5 text-cyan-400" />
                    Muestra de Usuarios / Líneas Detectadas
                  </div>
                  {previewData.samples?.lines?.length > 0 ? (
                    <div className="space-y-1.5 max-h-52 overflow-y-auto">
                      {previewData.samples.lines.map((l) => (
                        <div key={l.id} className="text-xs flex items-center justify-between gap-2 py-1 border-b border-slate-800/70 last:border-0">
                          <span className="text-slate-200 font-mono truncate">{l.username}</span>
                          <span className="text-[11px] text-slate-400 shrink-0">
                            {l.max_connections} conex • {l.device_type.toUpperCase()}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs text-slate-500">Sin líneas de clientes en esta fuente.</div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Post-Import Result Summary */}
          {importResult && (
            <div className="rounded-2xl bg-gradient-to-br from-emerald-500/15 via-[#0e1526] to-[#0e1526] border border-emerald-500/40 p-6 space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-300">
                  <CheckCircle2 className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white">¡Migración XUI.one Finalizada!</h3>
                  <p className="text-xs text-slate-300">
                    Origen: {importResult.sourceLabel} ({importResult.schemaFlavor})
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                <div className="p-3 rounded-xl bg-[#090e1a]/90 border border-slate-800">
                  <div className="text-slate-400">Canales en Vivo</div>
                  <div className="text-base font-bold text-white mt-0.5">
                    +{importResult.stats.streamsCreated} nuevos / {importResult.stats.streamsUpdated} act.
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-[#090e1a]/90 border border-slate-800">
                  <div className="text-slate-400">Usuarios / Líneas</div>
                  <div className="text-base font-bold text-white mt-0.5">
                    +{importResult.stats.linesCreated} nuevas / {importResult.stats.linesUpdated} act.
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-[#090e1a]/90 border border-slate-800">
                  <div className="text-slate-400">Categorías & Bouquets</div>
                  <div className="text-base font-bold text-white mt-0.5">
                    {importResult.stats.categoriesCreated + importResult.stats.categoriesUpdated} cat • {importResult.stats.bouquetsSynced} bouquets
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-[#090e1a]/90 border border-slate-800">
                  <div className="text-slate-400">Películas VOD</div>
                  <div className="text-base font-bold text-white mt-0.5">
                    +{importResult.stats.vodCreated} nuevas / {importResult.stats.vodUpdated} act.
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-[#090e1a]/90 border border-slate-800">
                  <div className="text-slate-400">Series & Episodios</div>
                  <div className="text-base font-bold text-white mt-0.5">
                    {importResult.stats.seriesCreated + importResult.stats.seriesUpdated} series ({importResult.stats.episodesImported} caps)
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-[#090e1a]/90 border border-slate-800">
                  <div className="text-slate-400">Resellers</div>
                  <div className="text-base font-bold text-white mt-0.5">
                    {importResult.stats.resellersImported} sincronizados
                  </div>
                </div>
              </div>

              {setActiveTab && (
                <div className="flex flex-wrap gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setActiveTab('streams')}
                    className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center gap-1.5 transition"
                  >
                    Ir a Canales en Vivo <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('lines')}
                    className="px-4 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold flex items-center gap-1.5 transition"
                  >
                    Ir a Usuarios / Líneas <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
