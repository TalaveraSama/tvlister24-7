import React, { useEffect, useState } from 'react';
import {
  Server,
  ShieldAlert,
  Sliders,
  Download,
  Upload,
  Plus,
  Trash2,
  Key
} from 'lucide-react';
import { apiFetch, getToken } from '../lib/api.js';

export default function ServersSecurityPage() {
  const [sys, setSys] = useState({ servers: [], profiles: [], firewall: [], settings: {} });
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

  const loadAll = async () => {
    const data = await apiFetch('/api/system');
    setSys(data);
  };

  useEffect(() => {
    loadAll();
  }, []);

  const flash = (msg) => {
    setNotice(msg);
    setTimeout(() => setNotice(''), 3000);
  };

  const addServer = async (e) => {
    e.preventDefault();
    if (!srvForm.name || !srvForm.host) return;
    await apiFetch('/api/servers', { method: 'POST', body: JSON.stringify(srvForm) });
    setSrvForm({ name: '', host: '', port: 8080, lb_mode: 'load' });
    flash('Balanceador agregado.');
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

  return (
    <div className="space-y-6">
      {notice && (
        <div className="p-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-xs text-emerald-300 font-medium">
          {notice}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Load Balancing Nodes */}
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

        {/* IPv4 / IPv6 & UA Firewall */}
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

          <div className="space-y-2 text-xs max-h-52 overflow-y-auto">
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
      </div>

      {/* Transcoding Profiles + Backup/Restore */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-4">
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

        <div className="lg:col-span-5 rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-4">
          <h2 className="text-sm font-bold text-white flex items-center gap-2">
            <Key className="w-4 h-4 text-amber-400" />
            Stalker Middleware Key & Respaldos Instantáneos
          </h2>

          <div className="p-3 rounded-xl bg-[#090e1a] border border-slate-800 text-xs space-y-1">
            <div className="text-slate-400">Dedicated Stalker / Ministra Key:</div>
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
    </div>
  );
}
