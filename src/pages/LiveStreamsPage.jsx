import React, { useEffect, useState } from 'react';
import {
  Plus,
  Play,
  Square,
  RotateCw,
  Edit3,
  Trash2,
  Terminal,
  Search,
  Radio,
  X,
  Copy,
  Check,
  Upload,
  Database
} from 'lucide-react';
import { apiFetch } from '../lib/api.js';

const EMPTY_FORM = {
  name: '',
  category_id: 1,
  source_url: '',
  backup_url: '',
  logo_url: '',
  epg_channel_id: '',
  stream_mode: 'direct',
  transcode_profile_id: 1,
  server_id: 1,
  tv_archive_days: 3,
  bitrate_kbps: 4500,
  user_agent: 'TVLister/2.3 (MPEG-TS; Linux)'
};

export default function LiveStreamsPage({ onPreview, onOpenXuiImport }) {
  const [streams, setStreams] = useState([]);
  const [categories, setCategories] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [servers, setServers] = useState([]);
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('all');

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const [ffmpegModal, setFfmpegModal] = useState(null);
  const [copied, setCopied] = useState(false);

  const [importOpen, setImportOpen] = useState(false);
  const [m3uUrl, setM3uUrl] = useState('');
  const [m3uContent, setM3uContent] = useState('');
  const [importMode, setImportMode] = useState('direct');
  const [importMsg, setImportMsg] = useState('');

  const loadAll = async () => {
    const [st, cats, sys] = await Promise.all([
      apiFetch('/api/streams'),
      apiFetch('/api/categories'),
      apiFetch('/api/system')
    ]);
    setStreams(st);
    setCategories(cats.filter((c) => c.type === 'live'));
    setProfiles(sys.profiles || []);
    setServers(sys.servers || []);
  };

  useEffect(() => {
    loadAll();
  }, []);

  const openCreate = () => {
    setEditingId(null);
    setForm({
      ...EMPTY_FORM,
      category_id: categories[0]?.id || 1
    });
    setModalOpen(true);
  };

  const openEdit = (s) => {
    setEditingId(s.id);
    setForm({
      name: s.name,
      category_id: s.category_id || 1,
      source_url: s.source_url,
      backup_url: s.backup_url || '',
      logo_url: s.logo_url || '',
      epg_channel_id: s.epg_channel_id || '',
      stream_mode: s.stream_mode || 'direct',
      transcode_profile_id: s.transcode_profile_id || 1,
      server_id: s.server_id || 1,
      tv_archive_days: s.tv_archive_days || 0,
      bitrate_kbps: s.bitrate_kbps || 4000,
      user_agent: s.user_agent || 'TVLister/2.3'
    });
    setModalOpen(true);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (editingId) {
      await apiFetch(`/api/streams/${editingId}`, { method: 'PUT', body: JSON.stringify(form) });
    } else {
      await apiFetch('/api/streams', { method: 'POST', body: JSON.stringify(form) });
    }
    setModalOpen(false);
    loadAll();
  };

  const handleAction = async (id, action) => {
    await apiFetch(`/api/streams/${id}/action`, {
      method: 'POST',
      body: JSON.stringify({ action })
    });
    loadAll();
  };

  const toggleArchive = async (s) => {
    const nextEnabled = !s.archive_enabled;
    await apiFetch(`/api/streams/${s.id}/archive`, {
      method: 'POST',
      body: JSON.stringify({ enabled: nextEnabled, days: s.tv_archive_days || 3 })
    });
    loadAll();
  };

  const handleDelete = async (id) => {
    if (!window.confirm('¿Eliminar este canal en vivo?')) return;
    await apiFetch(`/api/streams/${id}`, { method: 'DELETE' });
    loadAll();
  };

  const showFfmpeg = async (s) => {
    const res = await apiFetch(`/api/streams/${s.id}/ffmpeg`);
    setFfmpegModal({ name: s.name, command: res.command });
  };

  const handleImportM3u = async (e) => {
    e.preventDefault();
    setImportMsg('');
    try {
      const res = await apiFetch('/api/streams/import-m3u', {
        method: 'POST',
        body: JSON.stringify({
          m3u_url: m3uUrl,
          m3u_content: m3uContent,
          stream_mode: importMode
        })
      });
      setImportMsg(`✅ ${res.importedCount} canales importados correctamente.`);
      setM3uUrl('');
      setM3uContent('');
      loadAll();
      setTimeout(() => {
        setImportOpen(false);
        setImportMsg('');
      }, 1500);
    } catch (err) {
      setImportMsg(`❌ ${err.message}`);
    }
  };

  const filtered = streams.filter((s) => {
    const matchesSearch =
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.source_url.toLowerCase().includes(search.toLowerCase());
    const matchesCat = catFilter === 'all' || String(s.category_id) === String(catFilter);
    return matchesSearch && matchesCat;
  });

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-[#0e1526] p-4 rounded-2xl border border-slate-800/80">
        <div className="flex flex-1 flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[210px] max-w-sm">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar canal o fuente HLS/TS/RTMP..."
              className="w-full pl-9 pr-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700/80 text-xs text-white focus:outline-none focus:border-indigo-500"
            />
          </div>

          <select
            value={catFilter}
            onChange={(e) => setCatFilter(e.target.value)}
            className="px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700/80 text-xs text-slate-200"
          >
            <option value="all">Todas las categorías</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {onOpenXuiImport && (
            <button
              onClick={onOpenXuiImport}
              className="inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 text-xs font-semibold transition"
            >
              <Database className="w-3.5 h-3.5" />
              Importar BD XUI.one
            </button>
          )}
          <button
            onClick={() => setImportOpen(true)}
            className="inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-slate-700 text-xs font-semibold transition"
          >
            <Upload className="w-4 h-4" />
            Importar M3U / XUI.one
          </button>

          <button
            onClick={openCreate}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-lg shadow-indigo-600/20 transition"
          >
            <Plus className="w-4 h-4" />
            Nuevo Canal en Vivo
          </button>
        </div>
      </div>

      {/* Streams Table */}
      <div className="rounded-2xl bg-[#0e1526] border border-slate-800/80 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#090e1a] text-slate-400 uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3">ID</th>
                <th className="px-4 py-3">Canal</th>
                <th className="px-4 py-3">Categoría</th>
                <th className="px-4 py-3">Modo & Perfil</th>
                <th className="px-4 py-3">Catchup DVR</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3 text-right">Controles</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filtered.map((s) => (
                <tr key={s.id} className="hover:bg-slate-800/30">
                  <td className="px-4 py-3 font-mono text-slate-400">#{s.id}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center overflow-hidden shrink-0">
                        {s.logo_url ? (
                          <img src={s.logo_url} alt={s.name} className="w-full h-full object-cover" />
                        ) : (
                          <Radio className="w-4 h-4 text-indigo-400" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="font-semibold text-white truncate">{s.name}</div>
                        <div className="text-[11px] text-slate-500 font-mono truncate max-w-[260px]">
                          {s.source_url}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-300">{s.category_name || 'General'}</td>
                  <td className="px-4 py-3">
                    <span className="px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 uppercase text-[10px] font-bold">
                      {s.stream_mode}
                    </span>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      {s.profile_name || 'Direct Stream'} • {s.bitrate_kbps} kbps
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => toggleArchive(s)}
                      title="Activar/Desactivar Grabación Catchup DVR en disco"
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-bold border transition ${
                        s.archive_enabled
                          ? 'bg-rose-500/20 text-rose-300 border-rose-500/40'
                          : 'bg-slate-800/80 text-slate-400 border-slate-700 hover:text-white'
                      }`}
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          s.archive_enabled ? 'bg-rose-400 animate-ping' : 'bg-slate-500'
                        }`}
                      />
                      {s.archive_enabled ? `REC ${s.tv_archive_days || 3}d` : 'DVR OFF'}
                    </button>
                    {s.archive_enabled ? (
                      <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                        {s.archiveStats?.segmentCount || 0} segs • {s.archiveStats?.sizeMb || 0} MB
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    {s.status === 'running' ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-semibold text-[11px]">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        ONLINE
                      </span>
                    ) : s.status === 'ondemand_idle' ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 font-semibold text-[11px]">
                        ON-DEMAND
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-rose-500/15 text-rose-300 border border-rose-500/30 font-semibold text-[11px]">
                        DETENIDO
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        onClick={() =>
                          onPreview({
                            id: s.id,
                            kind: 'live',
                            title: s.name,
                            url: s.source_url
                          })
                        }
                        title="Previsualizar Stream"
                        className="p-1.5 rounded-lg bg-indigo-600/25 hover:bg-indigo-600 text-indigo-300 hover:text-white transition"
                      >
                        <Play className="w-3.5 h-3.5" />
                      </button>

                      {s.status === 'running' ? (
                        <button
                          onClick={() => handleAction(s.id, 'stop')}
                          title="Detener"
                          className="p-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/30 text-amber-300 transition"
                        >
                          <Square className="w-3.5 h-3.5" />
                        </button>
                      ) : (
                        <button
                          onClick={() => handleAction(s.id, 'start')}
                          title="Iniciar"
                          className="p-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/30 text-emerald-300 transition"
                        >
                          <RotateCw className="w-3.5 h-3.5" />
                        </button>
                      )}

                      <button
                        onClick={() => showFfmpeg(s)}
                        title="Ver Comando FFmpeg"
                        className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
                      >
                        <Terminal className="w-3.5 h-3.5" />
                      </button>

                      <button
                        onClick={() => openEdit(s)}
                        title="Editar"
                        className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>

                      <button
                        onClick={() => handleDelete(s.id)}
                        title="Eliminar"
                        className="p-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 text-rose-300 transition"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add / Edit Stream Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-2xl rounded-2xl bg-[#0e1526] border border-slate-800 shadow-2xl overflow-hidden">
            <div className="px-5 py-4 bg-[#131c31] border-b border-slate-800 flex items-center justify-between">
              <h3 className="font-semibold text-white text-sm">
                {editingId ? 'Editar Canal en Vivo' : 'Agregar Nuevo Canal en Vivo'}
              </h3>
              <button onClick={() => setModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSave} className="p-5 space-y-4 max-h-[80vh] overflow-y-auto text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-slate-300 mb-1 font-medium">Nombre del Canal *</label>
                  <input
                    type="text"
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                    placeholder="Ej. Deportes HD 1"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1 font-medium">Categoría</label>
                  <select
                    value={form.category_id}
                    onChange={(e) => setForm({ ...form, category_id: Number(e.target.value) })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-slate-300 mb-1 font-medium">
                  URL Fuente Principal (HLS .m3u8, MPEG-TS, RTMP, RTSP, UDP) *
                </label>
                <input
                  type="text"
                  required
                  value={form.source_url}
                  onChange={(e) => setForm({ ...form, source_url: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                  placeholder="https://servidor.com/live/canal/index.m3u8"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-slate-300 mb-1 font-medium">URL Fuente Respaldo (Failover)</label>
                  <input
                    type="text"
                    value={form.backup_url}
                    onChange={(e) => setForm({ ...form, backup_url: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                    placeholder="Opcional"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1 font-medium">URL Logo / Icono PNG</label>
                  <input
                    type="text"
                    value={form.logo_url}
                    onChange={(e) => setForm({ ...form, logo_url: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                    placeholder="https://..."
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-slate-300 mb-1 font-medium">Modo de Transmisión</label>
                  <select
                    value={form.stream_mode}
                    onChange={(e) => setForm({ ...form, stream_mode: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    <option value="direct">Direct Stream (Sin Prebuffer)</option>
                    <option value="ondemand">On-Demand (Ahorro Banda)</option>
                    <option value="transcode">Transcodificación Activa</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-300 mb-1 font-medium">Perfil Transcodificación</label>
                  <select
                    value={form.transcode_profile_id}
                    onChange={(e) => setForm({ ...form, transcode_profile_id: Number(e.target.value) })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-slate-300 mb-1 font-medium">Servidor / Balanceador</label>
                  <select
                    value={form.server_id}
                    onChange={(e) => setForm({ ...form, server_id: Number(e.target.value) })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    {servers.map((srv) => (
                      <option key={srv.id} value={srv.id}>
                        {srv.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-slate-300 mb-1 font-medium">ID Canal EPG (XMLTV)</label>
                  <input
                    type="text"
                    value={form.epg_channel_id}
                    onChange={(e) => setForm({ ...form, epg_channel_id: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                    placeholder="ej. cine.hd.tv"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1 font-medium">Días TV Archive / Catchup</label>
                  <input
                    type="number"
                    min="0"
                    max="30"
                    value={form.tv_archive_days}
                    onChange={(e) => setForm({ ...form, tv_archive_days: Number(e.target.value) })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1 font-medium">User-Agent Personalizado</label>
                  <input
                    type="text"
                    value={form.user_agent}
                    onChange={(e) => setForm({ ...form, user_agent: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  />
                </div>
              </div>

              <div className="pt-3 border-t border-slate-800 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold"
                >
                  Guardar Canal
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Import M3U / XUI.one Modal */}
      {importOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-xl rounded-2xl bg-[#0e1526] border border-slate-800 overflow-hidden">
            <div className="px-5 py-4 bg-[#131c31] border-b border-slate-800 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">
                Importar Lista M3U desde XUI.one u otro Panel
              </h3>
              <button onClick={() => setImportOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleImportM3u} className="p-5 space-y-4 text-xs">
              {importMsg && (
                <div className="p-3 rounded-xl bg-slate-900 border border-slate-700 text-slate-200 font-medium">
                  {importMsg}
                </div>
              )}
              <div>
                <label className="block text-slate-300 mb-1">URL M3U (ej. desde tu XUI.one local o remoto)</label>
                <input
                  type="text"
                  value={m3uUrl}
                  onChange={(e) => setM3uUrl(e.target.value)}
                  placeholder="http://127.0.0.1/playlist/... o URL M3U"
                  className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                />
              </div>
              <div>
                <label className="block text-slate-300 mb-1">O pega directamente el contenido #EXTM3U</label>
                <textarea
                  rows={5}
                  value={m3uContent}
                  onChange={(e) => setM3uContent(e.target.value)}
                  placeholder={'#EXTM3U\n#EXTINF:-1 tvg-logo="" group-title="Deportes",Canal 1\nhttp://...'}
                  className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                />
              </div>
              <div>
                <label className="block text-slate-300 mb-1">Modo de apertura para los canales importados</label>
                <select
                  value={importMode}
                  onChange={(e) => setImportMode(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                >
                  <option value="ondemand">On-Demand (Recomendado para listas grandes)</option>
                  <option value="direct">Direct Stream Siempre Activo</option>
                </select>
              </div>
              <div className="pt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setImportOpen(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-semibold"
                >
                  Importar Canales
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* FFmpeg Command Inspector Modal */}
      {ffmpegModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-2xl rounded-2xl bg-[#0e1526] border border-slate-800 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <Terminal className="w-4 h-4 text-indigo-400" />
                Pipeline FFmpeg — {ffmpegModal.name}
              </h3>
              <button onClick={() => setFfmpegModal(null)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <pre className="p-4 rounded-xl bg-[#070b13] border border-slate-800 text-xs font-mono text-emerald-300 whitespace-pre-wrap break-all">
              {ffmpegModal.command}
            </pre>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(ffmpegModal.command);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1800);
                }}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold"
              >
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copied ? 'Copiado' : 'Copiar Comando'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
