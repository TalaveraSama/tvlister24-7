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
  Terminal
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
    dbSizeKb: 0,
    listenPort: 8080,
    telemetry: {}
  });

  const [settingsForm, setSettingsForm] = useState({
    panel_name: '',
    server_timezone: 'UTC',
    default_output_format: 'hls',
    anti_restreaming: 'true',
    flood_limit_per_min: '120'
  });

  const [newAdmin, setNewAdmin] = useState({ username: '', password: '', email: '', notes: '' });
  const [pwdTargetId, setPwdTargetId] = useState(1);
  const [newPwd, setNewPwd] = useState('');

  const [srvForm, setSrvForm] = useState({ name: '', host: '', port: 8080, lb_mode: 'load' });
  const [fwForm, setFwForm] = useState({ rule_type: 'ip', value: '', description: '' });
  const [profForm, setProfForm] = useState({
    name: '',
    video_codec: 'libx264',
    audio_codec: 'aac',
    video_bitrate: '4000k',
    resolution: '1920x1080',
    hwaccel: 'none'
  });
  const [notice, setNotice] = useState('');
  const [errMsg, setErrMsg] = useState('');

  const loadAll = async () => {
    const data = await apiFetch('/api/system');
    setSys(data);
    setSettingsForm({
      panel_name: data.settings?.panel_name || 'TVLister 24/7 — Midnight Streamer Panel',
      server_timezone: data.settings?.server_timezone || 'UTC',
      default_output_format: data.settings?.default_output_format || 'hls',
      anti_restreaming: data.settings?.anti_restreaming || 'true',
      flood_limit_per_min: data.settings?.flood_limit_per_min || '120'
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
    setTimeout(() => setNotice(''), 3500);
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
    } catch (err) {
      setErrMsg(err.message);
    }
  };

  const runMaintenance = async (action) => {
    const res = await apiFetch('/api/system/maintenance', {
      method: 'POST',
      body: JSON.stringify({ action })
    });
    flash(res.message || 'Operación ejecutada.');
    loadAll();
  };

  const addServer = async (e) => {
    e.preventDefault();
    if (!srvForm.name || !srvForm.host) return;
    await apiFetch('/api/servers', { method: 'POST', body: JSON.stringify(srvForm) });
    setSrvForm({ name: '', host: '', port: 8080, lb_mode: 'load' });
    flash('Nodo Balanceador agregado.');
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

  const addProfile = async (e) => {
    e.preventDefault();
    if (!profForm.name) return;
    await apiFetch('/api/profiles', { method: 'POST', body: JSON.stringify(profForm) });
    setProfForm({ ...profForm, name: '' });
    flash('Perfil de transcodificación guardado.');
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

  const t = sys.telemetry || {};

  return (
    <div className="space-y-5">
      {/* Sub-navigation */}
      <div className="flex flex-wrap items-center gap-2 bg-[#0e1526] p-3 rounded-2xl border border-slate-800/80">
        {[
          { id: 'sysadmin', label: 'Admin del Sistema & Mantenimiento', icon: ShieldCheck },
          { id: 'cluster', label: 'Nodos Load Balancer & FFmpeg', icon: Server },
          { id: 'security', label: 'Firewall IPv4/IPv6 & Backups', icon: ShieldAlert }
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

      {/* TAB 1: SYSTEM ADMIN & MAINTENANCE */}
      {subTab === 'sysadmin' && (
        <div className="space-y-6">
          {/* Diagnostics & Quick Maintenance */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-7 rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-4">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <Terminal className="w-4 h-4 text-indigo-400" />
                Diagnóstico del Servidor & Entorno Linux
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
                  Herramientas de Mantenimiento Rápido (Root / SysAdmin)
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
                </div>
              </div>
            </div>

            {/* General Panel Settings */}
            <div className="lg:col-span-5 rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-4">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <Sliders className="w-4 h-4 text-cyan-400" />
                Ajustes Globales del Panel
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
                    <label className="block text-slate-400 mb-1">Anti-Restreaming</label>
                    <select
                      value={settingsForm.anti_restreaming}
                      onChange={(e) => setSettingsForm({ ...settingsForm, anti_restreaming: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                    >
                      <option value="true">Activado</option>
                      <option value="false">Desactivado</option>
                    </select>
                  </div>
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

      {/* TAB 2: CLUSTER & FFMPEG PROFILES */}
      {subTab === 'cluster' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-6 rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-4">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Server className="w-4 h-4 text-indigo-400" />
              Nodos & Load Balancers (Carga, GeoIP, ISP)
            </h2>

            <form onSubmit={addServer} className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <input
                type="text"
                placeholder="Nombre Nodo"
                value={srvForm.name}
                onChange={(e) => setSrvForm({ ...srvForm, name: e.target.value })}
                className="px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              />
              <input
                type="text"
                placeholder="IP / Dominio"
                value={srvForm.host}
                onChange={(e) => setSrvForm({ ...srvForm, host: e.target.value })}
                className="px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
              />
              <select
                value={srvForm.lb_mode}
                onChange={(e) => setSrvForm({ ...srvForm, lb_mode: e.target.value })}
                className="px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              >
                <option value="load">Server Load</option>
                <option value="geoip">GeoIP</option>
                <option value="isp">ISP Routing</option>
              </select>
              <button
                type="submit"
                className="px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold inline-flex items-center justify-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" /> Añadir LB
              </button>
            </form>

            <div className="space-y-2 text-xs">
              {sys.servers.map((s) => (
                <div
                  key={s.id}
                  className="p-3 rounded-xl bg-[#090e1a] border border-slate-800 flex items-center justify-between"
                >
                  <div>
                    <div className="font-semibold text-white">
                      {s.name}{' '}
                      <span className="text-[10px] uppercase text-indigo-300 ml-1">
                        [{s.is_main ? 'MASTER' : `LB-${s.lb_mode}`}]
                      </span>
                    </div>
                    <div className="text-[11px] font-mono text-slate-400">
                      {s.host}:{s.port} • Max Clientes: {s.max_clients}
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
              ))}
            </div>
          </div>

          <div className="lg:col-span-6 rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-4">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Sliders className="w-4 h-4 text-cyan-400" />
              Perfiles de Transcodificación Hardware (NVENC / Intel QSV / CPU)
            </h2>

            <form onSubmit={addProfile} className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
              <input
                type="text"
                placeholder="Nombre perfil"
                value={profForm.name}
                onChange={(e) => setProfForm({ ...profForm, name: e.target.value })}
                className="col-span-2 px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              />
              <select
                value={profForm.video_codec}
                onChange={(e) => setProfForm({ ...profForm, video_codec: e.target.value })}
                className="px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              >
                <option value="libx264">CPU libx264</option>
                <option value="h264_nvenc">NVIDIA NVENC</option>
                <option value="h264_qsv">Intel QSV</option>
                <option value="copy">Direct Copy</option>
              </select>
              <input
                type="text"
                value={profForm.video_bitrate}
                onChange={(e) => setProfForm({ ...profForm, video_bitrate: e.target.value })}
                placeholder="4000k"
                className="px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
              />
              <button
                type="submit"
                className="px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold"
              >
                Crear
              </button>
            </form>

            <div className="space-y-2 text-xs">
              {sys.profiles.map((p) => (
                <div
                  key={p.id}
                  className="px-3 py-2.5 rounded-xl bg-[#090e1a] border border-slate-800 flex items-center justify-between"
                >
                  <div>
                    <div className="font-semibold text-white">{p.name}</div>
                    <div className="font-mono text-[11px] text-slate-400">
                      Video: {p.video_codec} ({p.video_bitrate}) • Audio: {p.audio_codec} • Res: {p.resolution}
                    </div>
                  </div>
                  {p.id > 1 && (
                    <button
                      onClick={async () => {
                        await apiFetch(`/api/profiles/${p.id}`, { method: 'DELETE' });
                        loadAll();
                      }}
                      className="p-1.5 rounded bg-rose-500/15 text-rose-300"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: FIREWALL & BACKUPS */}
      {subTab === 'security' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7 rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-4">
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

            <div className="space-y-2 text-xs max-h-60 overflow-y-auto">
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

          <div className="lg:col-span-5 rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-4">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Key className="w-4 h-4 text-amber-400" />
              Stalker Middleware Key & Respaldos
            </h2>

            <div className="p-3 rounded-xl bg-[#090e1a] border border-slate-800 text-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Dedicated Stalker / Ministra Key:</span>
                <button
                  onClick={() => runMaintenance('regen_stalker_key')}
                  className="text-[11px] text-indigo-400 hover:text-indigo-300"
                >
                  Regenerar
                </button>
              </div>
              <div className="font-mono text-amber-300 break-all">{sys.settings?.stalker_key}</div>
            </div>

            <div className="space-y-2.5 pt-1 text-xs">
              <a
                href={`/api/backup/export?token=${encodeURIComponent(getToken())}`}
                className="w-full py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold flex items-center justify-center gap-2 transition"
              >
                <Download className="w-4 h-4" />
                Descargar Backup Completo (JSON)
              </a>

              <label className="w-full py-2.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 font-semibold flex items-center justify-center gap-2 cursor-pointer transition">
                <Upload className="w-4 h-4 text-indigo-400" />
                Restaurar Base de Datos desde Archivo
                <input type="file" accept=".json" onChange={handleRestoreFile} className="hidden" />
              </label>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
