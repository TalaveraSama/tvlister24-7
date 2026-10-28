import React, { useEffect, useState } from 'react';
import {
  Server,
  ShieldAlert,
  Sliders,
  Download,
  Upload,
  Plus,
  Trash2,
  Key,
  ShieldCheck,
  Wrench,
  RefreshCw,
  Database,
  Save,
  Terminal,
  CheckCircle2,
  AlertTriangle,
  Copy,
  Check,
  Lock,
  ExternalLink,
  Edit3,
  X
} from 'lucide-react';
import { apiFetch, getToken } from '../lib/api.js';

export default function ServersSecurityPage() {
  const [subTab, setSubTab] = useState('sysadmin'); // sysadmin | cluster | security
  const [sys, setSys] = useState({
    servers: [],
    profiles: [],
    firewall: [],
    settings: {},
    admins: [],
    snapshots: [],
    dbSizeKb: 0,
    listenPort: 8080,
    telemetry: {}
  });

  const [settingsForm, setSettingsForm] = useState({
    panel_name: '',
    server_timezone: 'UTC',
    default_output_format: 'hls',
    anti_restreaming: 'true',
    proxy_direct_ts: 'false',
    flood_limit_per_min: '240',
    lb_routing_mode: 'load'
  });

  const [newAdmin, setNewAdmin] = useState({ username: '', password: '', email: '', notes: '' });
  const [pwdTargetId, setPwdTargetId] = useState(1);
  const [newPwd, setNewPwd] = useState('');

  const [srvForm, setSrvForm] = useState({
    name: '',
    host: '',
    port: 8096,
    lb_mode: 'load',
    region_countries: '',
    isp_match: ''
  });
  const [fwForm, setFwForm] = useState({ rule_type: 'ip', value: '', description: '' });
  const [editingProfId, setEditingProfId] = useState(null);
  const [profForm, setProfForm] = useState({
    name: '',
    video_codec: 'libx264',
    audio_codec: 'aac',
    video_bitrate: '2500k',
    audio_bitrate: '128k',
    resolution: '1280x720',
    preset: 'ultrafast',
    hwaccel: 'none',
    extra_flags: '-tune zerolatency -maxrate 2500k -bufsize 5000k'
  });

  const [sslDomain, setSslDomain] = useState('tv.midominio.com');
  const [sslData, setSslData] = useState(null);
  const [copiedKey, setCopiedKey] = useState('');

  const [notice, setNotice] = useState('');
  const [errMsg, setErrMsg] = useState('');
  const [readiness, setReadiness] = useState(null);

  const loadAll = async () => {
    const [data, rdy] = await Promise.all([
      apiFetch('/api/system'),
      apiFetch('/api/system/readiness')
    ]);
    setSys(data);
    setReadiness(rdy);
    setSettingsForm({
      panel_name: data.settings?.panel_name || 'TVLister 24/7 Panel',
      server_timezone: data.settings?.server_timezone || 'UTC',
      default_output_format: data.settings?.default_output_format || 'hls',
      anti_restreaming: data.settings?.anti_restreaming || 'true',
      proxy_direct_ts: data.settings?.proxy_direct_ts || 'false',
      flood_limit_per_min: data.settings?.flood_limit_per_min || '240',
      lb_routing_mode: data.settings?.lb_routing_mode || 'load'
    });
    if (data.admins?.length > 0 && !pwdTargetId) {
      setPwdTargetId(data.admins[0].id);
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  const flash = (msg) => {
    setErrMsg('');
    setNotice(msg);
    setTimeout(() => setNotice(''), 4000);
  };

  const copyText = (key, text) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(''), 1800);
  };

  const handleSaveSettings = async (e) => {
    e.preventDefault();
    await apiFetch('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(settingsForm)
    });
    flash('Configuración general del sistema guardada.');
    loadAll();
  };

  const handleCreateAdmin = async (e) => {
    e.preventDefault();
    try {
      await apiFetch('/api/system/admins', {
        method: 'POST',
        body: JSON.stringify(newAdmin)
      });
      setNewAdmin({ username: '', password: '', email: '', notes: '' });
      flash('Nuevo Administrador del Sistema creado.');
      loadAll();
    } catch (err) {
      setErrMsg(err.message);
    }
  };

  const handleChangeAdminPwd = async (e) => {
    e.preventDefault();
    try {
      await apiFetch(`/api/system/admins/${pwdTargetId}/password`, {
        method: 'PUT',
        body: JSON.stringify({ newPassword: newPwd })
      });
      setNewPwd('');
      flash('Contraseña de Administrador actualizada correctamente.');
      loadAll();
    } catch (err) {
      setErrMsg(err.message);
    }
  };

  const runMaintenance = async (action) => {
    if (
      action === 'purge_demo_data' &&
      !window.confirm(
        '¿Purgar todos los canales/VOD/series/líneas de demostración y dejar el panel limpio para producción? (Se conservará tu cuenta Super Admin, categorías y perfiles FFmpeg).'
      )
    ) {
      return;
    }
    const res = await apiFetch('/api/system/maintenance', {
      method: 'POST',
      body: JSON.stringify({ action })
    });
    flash(res.message || 'Operación ejecutada.');
    loadAll();
  };

  const generateSslConfig = async (e) => {
    e.preventDefault();
    const res = await apiFetch(`/api/system/ssl-config?domain=${encodeURIComponent(sslDomain)}`);
    setSslData(res);
  };

  const addServer = async (e) => {
    e.preventDefault();
    if (!srvForm.name || !srvForm.host) return;
    await apiFetch('/api/servers', { method: 'POST', body: JSON.stringify(srvForm) });
    setSrvForm({ name: '', host: '', port: 8096, lb_mode: 'load', region_countries: '', isp_match: '' });
    flash('Nodo Edge Balanceador registrado. Copia su comando instalador abajo.');
    loadAll();
  };

  const addFirewall = async (e) => {
    e.preventDefault();
    if (!fwForm.value) return;
    await apiFetch('/api/firewall', { method: 'POST', body: JSON.stringify(fwForm) });
    setFwForm({ rule_type: 'ip', value: '', description: '' });
    flash('Regla de Firewall aplicada a nivel aplicación.');
    loadAll();
  };

  const startEditProfile = (p) => {
    setEditingProfId(p.id);
    setProfForm({
      name: p.name || '',
      video_codec: p.video_codec || 'libx264',
      audio_codec: p.audio_codec || 'aac',
      video_bitrate: p.video_bitrate || '2500k',
      audio_bitrate: p.audio_bitrate || '128k',
      resolution: p.resolution || '1280x720',
      preset: p.preset || 'ultrafast',
      hwaccel: p.hwaccel || 'none',
      extra_flags: p.extra_flags || ''
    });
  };

  const cancelEditProfile = () => {
    setEditingProfId(null);
    setProfForm({
      name: '',
      video_codec: 'libx264',
      audio_codec: 'aac',
      video_bitrate: '2500k',
      audio_bitrate: '128k',
      resolution: '1280x720',
      preset: 'ultrafast',
      hwaccel: 'none',
      extra_flags: '-tune zerolatency -maxrate 2500k -bufsize 5000k'
    });
  };

  const addProfile = async (e) => {
    e.preventDefault();
    if (!profForm.name) return;
    if (editingProfId) {
      const res = await apiFetch(`/api/profiles/${editingProfId}`, {
        method: 'PUT',
        body: JSON.stringify(profForm)
      });
      cancelEditProfile();
      flash(
        `Perfil FFmpeg actualizado (${res.restartedStreams || 0} canales activos recargados en caliente).`
      );
    } else {
      await apiFetch('/api/profiles', { method: 'POST', body: JSON.stringify(profForm) });
      cancelEditProfile();
      flash('Nuevo perfil FFmpeg creado.');
    }
    loadAll();
  };

  const handleRestoreFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const json = JSON.parse(text);
    const res = await apiFetch('/api/backup/restore', {
      method: 'POST',
      body: JSON.stringify(json)
    });
    flash(`Respaldo restaurado (${res.restoredCount} registros).`);
    loadAll();
  };

  const handleCreateSnapshot = async () => {
    await apiFetch('/api/backups/snapshots', { method: 'POST' });
    flash('Snapshot guardado en data/backups/ del servidor.');
    loadAll();
  };

  const handleRestoreSnapshot = async (filename) => {
    if (!window.confirm(`¿Restaurar base de datos desde ${filename}?`)) return;
    const res = await apiFetch(`/api/backups/snapshots/${encodeURIComponent(filename)}/restore`, {
      method: 'POST'
    });
    flash(`Snapshot restaurado (${res.restoredCount} registros).`);
    loadAll();
  };

  const handleDeleteSnapshot = async (filename) => {
    await apiFetch(`/api/backups/snapshots/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    loadAll();
  };

  const t = sys.telemetry || {};
  const originBase = typeof window !== 'undefined' ? window.location.origin : `http://127.0.0.1:${sys.listenPort}`;

  return (
    <div className="space-y-5">
      {/* Sub-navigation */}
      <div className="flex flex-wrap items-center gap-2 bg-[#0e1526] p-3 rounded-2xl border border-slate-800/80">
        {[
          { id: 'sysadmin', label: 'Admin del Sistema, SSL & Producción', icon: ShieldCheck },
          { id: 'cluster', label: 'Nodos Edge Load Balancer & FFmpeg', icon: Server },
          { id: 'security', label: 'Firewall, Stalker MAG & Snapshots', icon: ShieldAlert }
        ].map((tab) => {
          const Icon = tab.icon;
          const active = subTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setSubTab(tab.id)}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition ${
                active
                  ? 'bg-indigo-600 text-white shadow'
                  : 'bg-[#090e1a] text-slate-400 hover:text-white border border-slate-800'
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {notice && (
        <div className="p-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-xs text-emerald-300 font-medium">
          {notice}
        </div>
      )}
      {errMsg && (
        <div className="p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-xs text-rose-300 font-medium">
          {errMsg}
        </div>
      )}

      {/* TAB 1: SYSTEM ADMIN, SSL & PRODUCTION */}
      {subTab === 'sysadmin' && (
        <div className="space-y-6">
          {/* Production Readiness Live Audit */}
          {readiness && (
            <div className="rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-bold text-white flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  Auditoría de Preparación para Producción (Tiempo Real)
                </h2>
                <div className="flex flex-wrap items-center gap-2">
                  {!readiness.streamShieldActive && (
                    <button
                      type="button"
                      onClick={async () => {
                        const r = await apiFetch('/api/system/maintenance', {
                          method: 'POST',
                          body: JSON.stringify({ action: 'enable_production_shield' })
                        });
                        flash(r.message);
                        loadAll();
                      }}
                      className="px-3.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow transition"
                    >
                      Activar Blindaje Producción Total (1 Clic)
                    </button>
                  )}
                  <span
                    className={`px-3 py-1 rounded-full text-xs font-bold border ${
                      readiness.actionNeeded
                        ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                        : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                    }`}
                  >
                    {readiness.actionNeeded
                      ? `${readiness.pendingWarnings || 1} ajuste(s) pendiente(s)`
                      : '100% Listo para Producción Total'}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5 text-xs">
                {readiness.checks.map((chk) => (
                  <div
                    key={chk.id}
                    className={`p-3 rounded-xl border flex items-start gap-2.5 ${
                      chk.severity === 'warn'
                        ? 'bg-amber-500/10 border-amber-500/30'
                        : 'bg-[#090e1a] border-slate-800'
                    }`}
                  >
                    {chk.severity === 'warn' ? (
                      <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                    ) : (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    )}
                    <div className="min-w-0">
                      <div className="font-semibold text-white">{chk.label}</div>
                      <div className="text-[11px] text-slate-400 mt-0.5">{chk.hint}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Diagnostics & Quick Maintenance */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-7 rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-4">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <Terminal className="w-4 h-4 text-indigo-400" />
                Diagnóstico del Servidor & Operaciones de Producción
              </h2>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="p-3 rounded-xl bg-[#090e1a] border border-slate-800">
                  <div className="text-slate-400">Hostname & Kernel</div>
                  <div className="font-mono text-white font-semibold mt-0.5">
                    {t.hostname} ({t.platform})
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-[#090e1a] border border-slate-800">
                  <div className="text-slate-400">Motor Node.js & Puerto</div>
                  <div className="font-mono text-emerald-300 font-semibold mt-0.5">
                    {t.nodeVersion || 'v22.x'} • Puerto TCP {sys.listenPort}
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-[#090e1a] border border-slate-800">
                  <div className="text-slate-400">Binario FFmpeg Activo</div>
                  <div className="font-mono text-cyan-300 text-[11px] truncate mt-0.5" title={t.ffmpegBin}>
                    {t.ffmpegBin}
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-[#090e1a] border border-slate-800">
                  <div className="text-slate-400">Base de Datos SQLite (WAL)</div>
                  <div className="font-mono text-white font-semibold mt-0.5">
                    {sys.dbSizeKb} KB • {t.xuiCoexistence ? 'Coexistencia XUI.one Activa' : 'Modo Dedicado'}
                  </div>
                </div>
              </div>

              <div className="pt-2 border-t border-slate-800">
                <div className="text-xs font-semibold text-slate-300 mb-2.5 flex items-center gap-1.5">
                  <Wrench className="w-3.5 h-3.5 text-amber-400" />
                  Acciones de Mantenimiento & Limpieza para Producción
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  <button
                    onClick={() => runMaintenance('restart_streams')}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600/25 hover:bg-indigo-600 text-indigo-200 hover:text-white border border-indigo-500/35 font-semibold transition"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Sincronizar Motor Live & 24/7
                  </button>
                  <button
                    onClick={() => runMaintenance('clear_connections')}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-amber-500/15 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 font-semibold transition"
                  >
                    Purgar Conexiones Fantasma
                  </button>
                  <button
                    onClick={() => runMaintenance('vacuum_db')}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/30 font-semibold transition"
                  >
                    <Database className="w-3.5 h-3.5" />
                    Optimizar SQLite (VACUUM)
                  </button>
                  <button
                    onClick={() => runMaintenance('purge_demo_data')}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-rose-500/20 hover:bg-rose-600 text-rose-200 hover:text-white border border-rose-500/40 font-semibold transition"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Purgar Datos Demo (Modo Limpio)
                  </button>
                </div>
              </div>
            </div>

            {/* General Panel Settings */}
            <div className="lg:col-span-5 rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-4">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <Sliders className="w-4 h-4 text-cyan-400" />
                Ajustes Globales & Algoritmo Load Balancer
              </h2>

              <form onSubmit={handleSaveSettings} className="space-y-3 text-xs">
                <div>
                  <label className="block text-slate-400 mb-1">Nombre del Panel / Marca</label>
                  <input
                    type="text"
                    value={settingsForm.panel_name}
                    onChange={(e) => setSettingsForm({ ...settingsForm, panel_name: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-400 mb-1">Formato M3U por defecto</label>
                    <select
                      value={settingsForm.default_output_format}
                      onChange={(e) => setSettingsForm({ ...settingsForm, default_output_format: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                    >
                      <option value="hls">HLS (.m3u8)</option>
                      <option value="ts">MPEG-TS (.ts)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-400 mb-1">Enrutamiento Edge LB</label>
                    <select
                      value={settingsForm.lb_routing_mode}
                      onChange={(e) => setSettingsForm({ ...settingsForm, lb_routing_mode: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                    >
                      <option value="load">Menor Carga CPU/Conns</option>
                      <option value="geoip">GeoIP por País</option>
                      <option value="isp">Afinidad por ISP</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-slate-400 mb-1">Modo Entrega Canales en Vivo (Stream Shield)</label>
                  <select
                    value={settingsForm.proxy_direct_ts}
                    onChange={(e) => setSettingsForm({ ...settingsForm, proxy_direct_ts: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    <option value="true">Stream Shield Proxy Activo (Oculta URLs de Proveedor & Resuelve IP-Lock)</option>
                    <option value="false">Redirección Directa 302 (Ahorro de Ancho de Banda del VPS)</option>
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-400 mb-1">Zona Horaria EPG</label>
                    <input
                      type="text"
                      value={settingsForm.server_timezone}
                      onChange={(e) => setSettingsForm({ ...settingsForm, server_timezone: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-400 mb-1">Límite Peticiones/min</label>
                    <input
                      type="number"
                      value={settingsForm.flood_limit_per_min}
                      onChange={(e) => setSettingsForm({ ...settingsForm, flood_limit_per_min: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  className="w-full py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold inline-flex items-center justify-center gap-1.5"
                >
                  <Save className="w-3.5 h-3.5" /> Guardar Ajustes Globales
                </button>
              </form>
            </div>
          </div>

          {/* Nginx + SSL Let's Encrypt Configurator */}
          <div className="rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-4">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Lock className="w-4 h-4 text-emerald-400" />
              Configurador Automático Dominio HTTPS / SSL Let's Encrypt (Compatible XUI.one)
            </h3>
            <form onSubmit={generateSslConfig} className="flex flex-wrap gap-2 text-xs">
              <input
                type="text"
                value={sslDomain}
                onChange={(e) => setSslDomain(e.target.value)}
                placeholder="Ej. tv.midominio.com"
                className="flex-1 min-w-[240px] px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
              />
              <button
                type="submit"
                className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold"
              >
                Generar Configuración HTTPS & Comando CLI
              </button>
            </form>

            {sslData && (
              <div className="space-y-3 text-xs">
                <div className="p-3 rounded-xl bg-[#090e1a] border border-emerald-500/30 flex items-center justify-between gap-2">
                  <code className="text-emerald-300 font-mono break-all">{sslData.cliCommand}</code>
                  <button
                    onClick={() => copyText('ssl-cli', sslData.cliCommand)}
                    className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-semibold shrink-0"
                  >
                    {copiedKey === 'ssl-cli' ? 'Copiado' : 'Copiar CLI'}
                  </button>
                </div>
                <pre className="p-3.5 rounded-xl bg-[#070b13] border border-slate-800 text-[11px] font-mono text-slate-300 overflow-x-auto">
                  {sslData.nginxConf}
                </pre>
              </div>
            )}
          </div>

          {/* System Administrators Management & Password Change */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-6 rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-4">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <Key className="w-4 h-4 text-amber-400" />
                Cambiar Contraseña de Administrador
              </h3>

              <form onSubmit={handleChangeAdminPwd} className="space-y-3 text-xs">
                <div>
                  <label className="block text-slate-400 mb-1">Cuenta Super Admin</label>
                  <select
                    value={pwdTargetId}
                    onChange={(e) => setPwdTargetId(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    {(sys.admins || []).map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.username} ({a.email || a.notes})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Nueva Contraseña Segura *</label>
                  <input
                    type="password"
                    required
                    minLength={5}
                    value={newPwd}
                    onChange={(e) => setNewPwd(e.target.value)}
                    placeholder="Mínimo 5 caracteres..."
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  />
                </div>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold"
                >
                  Actualizar Contraseña Admin
                </button>
              </form>
            </div>

            <div className="lg:col-span-6 rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-4">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                Agregar Nuevo Administrador del Sistema
              </h3>

              <form onSubmit={handleCreateAdmin} className="grid grid-cols-2 gap-3 text-xs">
                <input
                  type="text"
                  required
                  placeholder="Usuario nuevo admin"
                  value={newAdmin.username}
                  onChange={(e) => setNewAdmin({ ...newAdmin, username: e.target.value })}
                  className="px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                />
                <input
                  type="password"
                  required
                  placeholder="Contraseña"
                  value={newAdmin.password}
                  onChange={(e) => setNewAdmin({ ...newAdmin, password: e.target.value })}
                  className="px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                />
                <input
                  type="email"
                  placeholder="Correo (opcional)"
                  value={newAdmin.email}
                  onChange={(e) => setNewAdmin({ ...newAdmin, email: e.target.value })}
                  className="px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                />
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold"
                >
                  + Crear Admin
                </button>
              </form>

              <div className="space-y-1.5 text-xs pt-1">
                {(sys.admins || []).map((a) => (
                  <div
                    key={a.id}
                    className="px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-800 flex items-center justify-between"
                  >
                    <div>
                      <span className="font-semibold text-white">{a.username}</span>{' '}
                      <span className="text-slate-400">• {a.notes || 'Super Admin'}</span>
                    </div>
                    <span className="px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 text-[10px] font-bold">
                      ROOT PANEL
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: CLUSTER EDGE LB & FFMPEG PROFILES */}
      {subTab === 'cluster' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7 rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-4">
            <div>
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <Server className="w-4 h-4 text-indigo-400" />
                Nodos Edge Load Balancer Reales (Relay + Heartbeat cada 10s)
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Registra un VPS secundario y ejecuta su comando de 1 línea para activar balanceo automático con failover al Master.
              </p>
            </div>

            <form onSubmit={addServer} className="grid grid-cols-2 sm:grid-cols-6 gap-2 text-xs">
              <input
                type="text"
                placeholder="Nombre Nodo"
                value={srvForm.name}
                onChange={(e) => setSrvForm({ ...srvForm, name: e.target.value })}
                className="sm:col-span-2 px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              />
              <input
                type="text"
                placeholder="IP Pública Edge"
                value={srvForm.host}
                onChange={(e) => setSrvForm({ ...srvForm, host: e.target.value })}
                className="sm:col-span-2 px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
              />
              <input
                type="number"
                placeholder="Puerto"
                value={srvForm.port}
                onChange={(e) => setSrvForm({ ...srvForm, port: Number(e.target.value) })}
                className="px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
              />
              <button
                type="submit"
                className="px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold inline-flex items-center justify-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" /> Crear Edge
              </button>
              <input
                type="text"
                placeholder="Países GeoIP (ej. MX,CO,AR)"
                value={srvForm.region_countries}
                onChange={(e) => setSrvForm({ ...srvForm, region_countries: e.target.value })}
                className="sm:col-span-3 px-3 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
              />
              <input
                type="text"
                placeholder="Filtro ISP opcional (ej. claro, telmex)"
                value={srvForm.isp_match}
                onChange={(e) => setSrvForm({ ...srvForm, isp_match: e.target.value })}
                className="sm:col-span-3 px-3 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              />
            </form>

            <div className="space-y-3 text-xs">
              {sys.servers.map((s) => {
                const installCmd = `curl -fsSL ${originBase}/api/lb/install.sh | sudo bash -s -- --master ${originBase} --token ${s.api_token} --port ${s.http_port || s.port || 8096}`;
                return (
                  <div
                    key={s.id}
                    className="p-3.5 rounded-xl bg-[#090e1a] border border-slate-800 space-y-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="font-semibold text-white flex items-center gap-2">
                          {s.name}
                          <span className="px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 text-[10px] font-bold uppercase">
                            {s.is_main ? 'MASTER NODE' : `EDGE • ${s.status}`}
                          </span>
                        </div>
                        <div className="text-[11px] font-mono text-slate-400 mt-0.5">
                          {s.host}:{s.http_port || s.port} • CPU {s.cpu_usage || 0}% • RAM {s.ram_usage || 0}% • Conns:{' '}
                          {s.active_conns || 0}/{s.max_clients}
                          {s.last_heartbeat_at ? ` • Heartbeat: ${s.last_heartbeat_at}` : ''}
                        </div>
                      </div>
                      {!s.is_main && (
                        <button
                          onClick={async () => {
                            await apiFetch(`/api/servers/${s.id}`, { method: 'DELETE' });
                            loadAll();
                          }}
                          className="p-1.5 rounded bg-rose-500/15 text-rose-300"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>

                    {!s.is_main && s.api_token && (
                      <div className="p-2.5 rounded-lg bg-[#070b13] border border-slate-800 flex items-center justify-between gap-2">
                        <code className="text-[11px] text-cyan-300 font-mono truncate">{installCmd}</code>
                        <button
                          onClick={() => copyText(`edge-${s.id}`, installCmd)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 hover:bg-indigo-600 text-slate-200 hover:text-white shrink-0 font-semibold"
                        >
                          {copiedKey === `edge-${s.id}` ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                          {copiedKey === `edge-${s.id}` ? 'Copiado' : '1-Click Install'}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="lg:col-span-5 rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <Sliders className="w-4 h-4 text-cyan-400" />
                Perfiles Hardware FFmpeg (Zero Latency / NVENC / CPU)
              </h2>
              {editingProfId && (
                <button
                  type="button"
                  onClick={cancelEditProfile}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 text-slate-300 hover:text-white text-[11px]"
                >
                  <X className="w-3.5 h-3.5" /> Cancelar edición
                </button>
              )}
            </div>

            <form
              onSubmit={addProfile}
              className={`p-3.5 rounded-xl border space-y-2.5 text-xs ${
                editingProfId
                  ? 'bg-indigo-950/25 border-indigo-500/40'
                  : 'bg-[#090e1a]/60 border-slate-800'
              }`}
            >
              <div className="flex items-center justify-between text-[11px] font-semibold">
                <span className={editingProfId ? 'text-indigo-300' : 'text-slate-300'}>
                  {editingProfId ? `Editando Perfil #${editingProfId}` : '+ Crear Perfil FFmpeg'}
                </span>
                <div className="flex items-center gap-1">
                  <span className="text-slate-500 mr-1">Bitrate rápido:</span>
                  {[
                    { label: '1.5M', br: '1500k', flags: '-tune zerolatency -maxrate 1500k -bufsize 3000k' },
                    { label: '2.5M', br: '2500k', flags: '-tune zerolatency -maxrate 2500k -bufsize 5000k' },
                    { label: '4.0M', br: '4000k', flags: '-tune zerolatency -maxrate 4000k -bufsize 8000k' }
                  ].map((q) => (
                    <button
                      key={q.label}
                      type="button"
                      onClick={() =>
                        setProfForm({
                          ...profForm,
                          video_bitrate: q.br,
                          extra_flags:
                            profForm.video_codec === 'h264_nvenc'
                              ? `-rc cbr -zerolatency 1 -maxrate ${q.br} -bufsize ${parseInt(q.br, 10) * 2}k`
                              : q.flags
                        })
                      }
                      className={`px-2 py-0.5 rounded font-mono text-[10px] border transition ${
                        profForm.video_bitrate === q.br
                          ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40'
                          : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-white'
                      }`}
                    >
                      {q.label}
                    </button>
                  ))}
                </div>
              </div>

              <input
                type="text"
                required
                placeholder="Nombre perfil (ej. Zero Latency 2.5 Mbps)"
                value={profForm.name}
                onChange={(e) => setProfForm({ ...profForm, name: e.target.value })}
                className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              />

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] text-slate-400 mb-1">Codec Video</label>
                  <select
                    value={profForm.video_codec}
                    onChange={(e) => {
                      const vc = e.target.value;
                      setProfForm({
                        ...profForm,
                        video_codec: vc,
                        hwaccel: vc === 'h264_nvenc' ? 'nvenc' : vc === 'h264_qsv' ? 'qsv' : 'none'
                      });
                    }}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    <option value="libx264">CPU libx264</option>
                    <option value="h264_nvenc">NVIDIA NVENC</option>
                    <option value="h264_qsv">Intel QSV</option>
                    <option value="copy">Direct Copy (Sin recodificar)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] text-slate-400 mb-1">Bitrate Video (ej. 2500k)</label>
                  <input
                    type="text"
                    value={profForm.video_bitrate}
                    onChange={(e) => setProfForm({ ...profForm, video_bitrate: e.target.value })}
                    placeholder="2500k"
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-[10px] text-slate-400 mb-1">Resolución</label>
                  <select
                    value={profForm.resolution}
                    onChange={(e) => setProfForm({ ...profForm, resolution: e.target.value })}
                    className="w-full px-2.5 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    <option value="source">Original (source)</option>
                    <option value="1280x720">HD 720p (1280x720)</option>
                    <option value="1920x1080">FHD 1080p (1920x1080)</option>
                    <option value="854x480">SD 480p (854x480)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] text-slate-400 mb-1">Preset Velocidad</label>
                  <select
                    value={profForm.preset}
                    onChange={(e) => setProfForm({ ...profForm, preset: e.target.value })}
                    className="w-full px-2.5 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    <option value="ultrafast">ultrafast (Zero Latency)</option>
                    <option value="superfast">superfast</option>
                    <option value="veryfast">veryfast</option>
                    <option value="faster">faster</option>
                    <option value="p2">NVENC p2 (Ultra Low-Lat)</option>
                    <option value="p4">NVENC p4</option>
                    <option value="none">none (Copy)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] text-slate-400 mb-1">Audio ({profForm.audio_codec})</label>
                  <select
                    value={profForm.audio_bitrate}
                    onChange={(e) => setProfForm({ ...profForm, audio_bitrate: e.target.value })}
                    className="w-full px-2.5 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                  >
                    <option value="96k">AAC 96k</option>
                    <option value="128k">AAC 128k</option>
                    <option value="160k">AAC 160k</option>
                    <option value="192k">AAC 192k</option>
                    <option value="source">Original</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[10px] text-slate-400 mb-1">
                  Flags Extra FFmpeg (ej. -tune zerolatency -maxrate 2500k -bufsize 5000k)
                </label>
                <input
                  type="text"
                  value={profForm.extra_flags}
                  onChange={(e) => setProfForm({ ...profForm, extra_flags: e.target.value })}
                  placeholder="-tune zerolatency -maxrate 2500k -bufsize 5000k"
                  className="w-full px-3 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono text-[11px]"
                />
              </div>

              <div className="flex justify-end pt-1">
                <button
                  type="submit"
                  className="w-full py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold inline-flex items-center justify-center gap-1.5"
                >
                  <Save className="w-3.5 h-3.5" />
                  {editingProfId ? 'Guardar Cambios del Perfil FFmpeg' : 'Crear Perfil FFmpeg'}
                </button>
              </div>
            </form>

            <div className="space-y-2 text-xs">
              {sys.profiles.map((p) => (
                <div
                  key={p.id}
                  className={`px-3 py-2.5 rounded-xl border flex items-center justify-between gap-2 ${
                    editingProfId === p.id
                      ? 'bg-indigo-950/30 border-indigo-500/50'
                      : 'bg-[#090e1a] border-slate-800'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="font-semibold text-white truncate">{p.name}</div>
                    <div className="font-mono text-[11px] text-slate-400 truncate">
                      Video: {p.video_codec} ({p.video_bitrate}) • {p.preset} • Res: {p.resolution}
                    </div>
                    {p.extra_flags && (
                      <div className="font-mono text-[10px] text-cyan-400/90 truncate mt-0.5">
                        {p.extra_flags}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => startEditProfile(p)}
                      title="Editar Perfil FFmpeg"
                      className="p-1.5 rounded bg-slate-800 hover:bg-indigo-600 text-slate-200 hover:text-white transition"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>
                    {p.id > 1 && (
                      <button
                        type="button"
                        onClick={async () => {
                          await apiFetch(`/api/profiles/${p.id}`, { method: 'DELETE' });
                          if (editingProfId === p.id) cancelEditProfile();
                          loadAll();
                        }}
                        title="Eliminar Perfil"
                        className="p-1.5 rounded bg-rose-500/15 hover:bg-rose-500/30 text-rose-300"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: FIREWALL, STALKER MAG & AUTOMATED SNAPSHOTS */}
      {subTab === 'security' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-6 rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-4">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-rose-400" />
              Firewall IPv4 / IPv6 & Anti-Restreaming
            </h2>

            <form onSubmit={addFirewall} className="grid grid-cols-1 sm:grid-cols-12 gap-2 text-xs">
              <select
                value={fwForm.rule_type}
                onChange={(e) => setFwForm({ ...fwForm, rule_type: e.target.value })}
                className="sm:col-span-3 px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              >
                <option value="ip">IPv4 / IPv6</option>
                <option value="user_agent">User-Agent</option>
              </select>
              <input
                type="text"
                placeholder="Ej. 203.0.113.50 o scanner"
                value={fwForm.value}
                onChange={(e) => setFwForm({ ...fwForm, value: e.target.value })}
                className="sm:col-span-4 px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
              />
              <input
                type="text"
                placeholder="Motivo"
                value={fwForm.description}
                onChange={(e) => setFwForm({ ...fwForm, description: e.target.value })}
                className="sm:col-span-3 px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              />
              <button
                type="submit"
                className="sm:col-span-2 px-3 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-semibold"
              >
                Bloquear
              </button>
            </form>

            <div className="space-y-2 text-xs max-h-72 overflow-y-auto">
              {sys.firewall.map((r) => (
                <div
                  key={r.id}
                  className="p-3 rounded-xl bg-[#090e1a] border border-slate-800 flex items-center justify-between"
                >
                  <div>
                    <span className="px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 uppercase text-[10px] font-bold mr-2">
                      {r.rule_type}
                    </span>
                    <span className="font-mono text-white">{r.value}</span>
                    <div className="text-[11px] text-slate-400 mt-0.5">{r.description}</div>
                  </div>
                  <button
                    onClick={async () => {
                      await apiFetch(`/api/firewall/${r.id}`, { method: 'DELETE' });
                      loadAll();
                    }}
                    className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="lg:col-span-6 rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-4">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Key className="w-4 h-4 text-amber-400" />
              Portal MAG Stalker (/c/) & Snapshots Diarios Automáticos
            </h2>

            <div className="p-3 rounded-xl bg-[#090e1a] border border-slate-800 text-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-slate-400 font-semibold">Portal Nativo MAG / STBemu Activo:</span>
                <a
                  href="/c/"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-emerald-400 hover:text-emerald-300 font-semibold"
                >
                  Probar /c/ <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
              <div className="font-mono text-indigo-300 break-all">{originBase}/c/</div>
              <div className="flex items-center justify-between pt-1 border-t border-slate-800/80">
                <span className="text-slate-400">Stalker Key: {sys.settings?.stalker_key}</span>
                <button
                  onClick={() => runMaintenance('regen_stalker_key')}
                  className="text-[11px] text-amber-400 hover:text-amber-300"
                >
                  Regenerar Key
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
              <a
                href={`/api/backup/export?token=${encodeURIComponent(getToken())}`}
                className="py-2.5 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold flex items-center justify-center gap-2 transition"
              >
                <Download className="w-4 h-4" />
                Exportar JSON Local
              </a>

              <label className="py-2.5 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 font-semibold flex items-center justify-center gap-2 cursor-pointer transition">
                <Upload className="w-4 h-4 text-indigo-400" />
                Subir y Restaurar JSON
                <input type="file" accept=".json" onChange={handleRestoreFile} className="hidden" />
              </label>
            </div>

            <div className="pt-2 border-t border-slate-800 space-y-2.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-white">
                  Snapshots Automáticos en Servidor (data/backups/ — Retención 10)
                </span>
                <button
                  onClick={handleCreateSnapshot}
                  className="px-3 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold"
                >
                  + Snapshot Ahora
                </button>
              </div>

              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {(sys.snapshots || []).map((sn) => (
                  <div
                    key={sn.filename}
                    className="px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-800 flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <div className="font-mono text-slate-200 truncate">{sn.filename}</div>
                      <div className="text-[10px] text-slate-500">
                        {sn.sizeKb} KB • {new Date(sn.created_at).toLocaleString()}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => handleRestoreSnapshot(sn.filename)}
                        className="px-2 py-1 rounded bg-amber-500/20 hover:bg-amber-500 text-amber-300 hover:text-slate-950 font-semibold text-[10px]"
                      >
                        Restaurar
                      </button>
                      <a
                        href={`/api/backups/snapshots/${encodeURIComponent(sn.filename)}/download?token=${encodeURIComponent(getToken())}`}
                        className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300"
                        title="Descargar"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </a>
                      <button
                        onClick={() => handleDeleteSnapshot(sn.filename)}
                        className="p-1 rounded bg-rose-500/15 text-rose-300"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
