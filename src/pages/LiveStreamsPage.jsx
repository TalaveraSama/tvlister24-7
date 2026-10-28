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
  Database,
  Sliders,
  Save
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
  bitrate_kbps: 2500,
  user_agent: 'TVLister/2.3 (MPEG-TS; Linux)'
};

const EMPTY_PROF = {
  name: '',
  video_codec: 'libx264',
  audio_codec: 'aac',
  video_bitrate: '2500k',
  audio_bitrate: '128k',
  resolution: '1280x720',
  preset: 'ultrafast',
  hwaccel: 'none',
  extra_flags: '-tune zerolatency -maxrate 2500k -bufsize 5000k'
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

  // FFmpeg Profiles Create/Edit & Bulk Apply Modal right inside Canales en Vivo
  const [profilesModalOpen, setProfilesModalOpen] = useState(false);
  const [editingProfId, setEditingProfId] = useState(null);
  const [profForm, setProfForm] = useState(EMPTY_PROF);
  const [profNotice, setProfNotice] = useState('');
  const [bulkCat, setBulkCat] = useState('all');
  const [bulkMode, setBulkMode] = useState('transcode');
  const [bulkProfId, setBulkProfId] = useState(2);

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
      bitrate_kbps: s.bitrate_kbps || 2500,
      user_agent: s.user_agent || 'TVLister/2.3'
    });
    setModalOpen(true);
  };

  const handleSaveProfile = async (e) => {
    e.preventDefault();
    if (!profForm.name.trim()) return;
    if (editingProfId) {
      const res = await apiFetch(`/api/profiles/${editingProfId}`, {
        method: 'PUT',
        body: JSON.stringify(profForm)
      });
      setProfNotice(
        `Perfil "${profForm.name}" actualizado (${res.restartedStreams || 0} canales activos recargados).`
      );
      setEditingProfId(null);
      setProfForm(EMPTY_PROF);
    } else {
      await apiFetch('/api/profiles', {
        method: 'POST',
        body: JSON.stringify(profForm)
      });
      setProfNotice(`Nuevo perfil "${profForm.name}" creado.`);
      setProfForm(EMPTY_PROF);
    }
    await loadAll();
  };

  const handleBulkApplyProfile = async () => {
    const chosenProf = profiles.find((p) => p.id === Number(bulkProfId));
    const kbpsMatch = String(chosenProf?.video_bitrate || '').match(/^(\d+)/);
    const kbps = kbpsMatch ? Number(kbpsMatch[1]) : 2500;
    const res = await apiFetch('/api/streams/bulk-profile', {
      method: 'POST',
      body: JSON.stringify({
        category_id: bulkCat,
        stream_mode: bulkMode,
        transcode_profile_id: Number(bulkProfId),
        bitrate_kbps: kbps
      })
    });
    setProfNotice(`Perfil aplicado en lote a ${res.updatedCount} canales.`);
    await loadAll();
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
          <button
            onClick={() => {
              setProfNotice('');
              const zeroProf = profiles.find((p) => p.name?.toLowerCase().includes('zero latency'));
              if (zeroProf) setBulkProfId(zeroProf.id);
              setProfilesModalOpen(true);
            }}
            className="inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 text-xs font-semibold transition"
          >
            <Sliders className="w-4 h-4" />
            Perfiles FFmpeg (2.5M)
          </button>

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
                      {s.profile_name || 'Direct Stream'} •{' '}
                      {s.stream_mode === 'transcode' && s.profile_video_bitrate && s.profile_video_bitrate !== 'source'
                        ? s.profile_video_bitrate
                        : `${s.bitrate_kbps || 2500} kbps`}
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
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-slate-300 font-medium">Perfil FFmpeg</label>
                    <button
                      type="button"
                      onClick={() => {
                        const curP = profiles.find((p) => p.id === Number(form.transcode_profile_id));
                        if (curP) {
                          setEditingProfId(curP.id);
                          setProfForm({
                            name: curP.name || '',
                            video_codec: curP.video_codec || 'libx264',
                            audio_codec: curP.audio_codec || 'aac',
                            video_bitrate: curP.video_bitrate || '2500k',
                            audio_bitrate: curP.audio_bitrate || '128k',
                            resolution: curP.resolution || '1280x720',
                            preset: curP.preset || 'ultrafast',
                            hwaccel: curP.hwaccel || 'none',
                            extra_flags: curP.extra_flags || ''
                          });
                        }
                        setModalOpen(false);
                        setProfilesModalOpen(true);
                      }}
                      className="text-[11px] text-amber-300 hover:underline"
                    >
                      Editar perfiles
                    </button>
                  </div>
                  <select
                    value={form.transcode_profile_id}
                    onChange={(e) => {
                      const nextPid = Number(e.target.value);
                      const selP = profiles.find((p) => p.id === nextPid);
                      const brMatch = String(selP?.video_bitrate || '').match(/^(\d+)/);
                      setForm({
                        ...form,
                        transcode_profile_id: nextPid,
                        bitrate_kbps: brMatch ? Number(brMatch[1]) : form.bitrate_kbps
                      });
                    }}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.video_bitrate})
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

              <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
                <div>
                  <label className="block text-slate-300 mb-1 font-medium">Bitrate (kbps)</label>
                  <input
                    type="number"
                    min="300"
                    max="25000"
                    step="100"
                    value={form.bitrate_kbps}
                    onChange={(e) => setForm({ ...form, bitrate_kbps: Number(e.target.value) })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                    placeholder="2500"
                  />
                </div>
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

      {/* FFmpeg Profiles Create / Edit & Bulk Apply Modal */}
      {profilesModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-3xl rounded-2xl bg-[#0e1526] border border-slate-800 shadow-2xl overflow-hidden">
            <div className="px-5 py-4 bg-[#131c31] border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sliders className="w-5 h-5 text-amber-400" />
                <div>
                  <h3 className="text-sm font-semibold text-white">
                    Gestor de Perfiles FFmpeg — Zero Latency 2.5 Mbps (2500k)
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    Crea o edita cualquier perfil FFmpeg existente y recarga canales activos automáticamente.
                  </p>
                </div>
              </div>
              <button onClick={() => setProfilesModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-4 max-h-[82vh] overflow-y-auto text-xs">
              {profNotice && (
                <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 font-medium">
                  {profNotice}
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                {/* Editor Form */}
                <form
                  onSubmit={handleSaveProfile}
                  className={`lg:col-span-7 p-4 rounded-xl border space-y-3 ${
                    editingProfId
                      ? 'bg-indigo-950/25 border-indigo-500/40'
                      : 'bg-[#090e1a] border-slate-800'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-white">
                      {editingProfId ? `Editando Perfil #${editingProfId}` : '+ Nuevo Perfil FFmpeg'}
                    </span>
                    <div className="flex items-center gap-1">
                      {[
                        { label: '1.5M', br: '1500k' },
                        { label: '2.5M', br: '2500k' },
                        { label: '4.0M', br: '4000k' }
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
                                  : `-tune zerolatency -maxrate ${q.br} -bufsize ${parseInt(q.br, 10) * 2}k`
                            })
                          }
                          className={`px-2 py-0.5 rounded font-mono text-[10px] border ${
                            profForm.video_bitrate === q.br
                              ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                              : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-white'
                          }`}
                        >
                          {q.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="block text-slate-400 mb-1">Nombre del Perfil *</label>
                    <input
                      type="text"
                      required
                      value={profForm.name}
                      onChange={(e) => setProfForm({ ...profForm, name: e.target.value })}
                      placeholder="Zero Latency 2.5 Mbps (H.264 CPU)"
                      className="w-full px-3 py-2 rounded-xl bg-[#0e1526] border border-slate-700 text-white"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="block text-slate-400 mb-1">Codec Video</label>
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
                        className="w-full px-3 py-2 rounded-xl bg-[#0e1526] border border-slate-700 text-white"
                      >
                        <option value="libx264">CPU libx264</option>
                        <option value="h264_nvenc">NVIDIA NVENC</option>
                        <option value="h264_qsv">Intel QSV</option>
                        <option value="copy">Direct Copy</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Bitrate Video (2.5M = 2500k)</label>
                      <input
                        type="text"
                        value={profForm.video_bitrate}
                        onChange={(e) => setProfForm({ ...profForm, video_bitrate: e.target.value })}
                        placeholder="2500k"
                        className="w-full px-3 py-2 rounded-xl bg-[#0e1526] border border-slate-700 text-white font-mono"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="block text-slate-400 mb-1">Resolución</label>
                      <select
                        value={profForm.resolution}
                        onChange={(e) => setProfForm({ ...profForm, resolution: e.target.value })}
                        className="w-full px-2.5 py-2 rounded-xl bg-[#0e1526] border border-slate-700 text-white"
                      >
                        <option value="source">Original</option>
                        <option value="1280x720">1280x720 (720p)</option>
                        <option value="1920x1080">1920x1080 (1080p)</option>
                        <option value="854x480">854x480 (480p)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Preset</label>
                      <select
                        value={profForm.preset}
                        onChange={(e) => setProfForm({ ...profForm, preset: e.target.value })}
                        className="w-full px-2.5 py-2 rounded-xl bg-[#0e1526] border border-slate-700 text-white"
                      >
                        <option value="ultrafast">ultrafast</option>
                        <option value="superfast">superfast</option>
                        <option value="veryfast">veryfast</option>
                        <option value="faster">faster</option>
                        <option value="p2">NVENC p2</option>
                        <option value="p4">NVENC p4</option>
                        <option value="none">none</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Audio Bitrate</label>
                      <select
                        value={profForm.audio_bitrate}
                        onChange={(e) => setProfForm({ ...profForm, audio_bitrate: e.target.value })}
                        className="w-full px-2.5 py-2 rounded-xl bg-[#0e1526] border border-slate-700 text-white font-mono"
                      >
                        <option value="96k">96k</option>
                        <option value="128k">128k</option>
                        <option value="160k">160k</option>
                        <option value="source">source</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-slate-400 mb-1">Flags Extra FFmpeg (Zero Latency CBR)</label>
                    <input
                      type="text"
                      value={profForm.extra_flags}
                      onChange={(e) => setProfForm({ ...profForm, extra_flags: e.target.value })}
                      className="w-full px-3 py-1.5 rounded-xl bg-[#0e1526] border border-slate-700 text-white font-mono text-[11px]"
                    />
                  </div>

                  <div className="flex justify-end gap-2 pt-1">
                    {editingProfId && (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingProfId(null);
                          setProfForm(EMPTY_PROF);
                        }}
                        className="px-3.5 py-2 rounded-xl bg-slate-800 text-slate-300"
                      >
                        Cancelar
                      </button>
                    )}
                    <button
                      type="submit"
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold"
                    >
                      <Save className="w-3.5 h-3.5" />
                      {editingProfId ? 'Guardar Cambios' : 'Crear Perfil'}
                    </button>
                  </div>
                </form>

                {/* Profiles List */}
                <div className="lg:col-span-5 space-y-2">
                  <div className="font-semibold text-slate-300 mb-1">
                    Perfiles Disponibles (Clic en lápiz para editar)
                  </div>
                  {profiles.map((p) => (
                    <div
                      key={p.id}
                      className={`p-3 rounded-xl border flex items-center justify-between gap-2 ${
                        editingProfId === p.id
                          ? 'bg-indigo-950/30 border-indigo-500/50'
                          : 'bg-[#090e1a] border-slate-800'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="font-semibold text-white truncate">{p.name}</div>
                        <div className="font-mono text-[11px] text-amber-300">
                          {p.video_codec} • {p.video_bitrate} • {p.resolution}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
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
                          }}
                          className="p-1.5 rounded bg-slate-800 hover:bg-indigo-600 text-slate-200 hover:text-white"
                          title="Editar Perfil"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        {p.id > 1 && (
                          <button
                            type="button"
                            onClick={async () => {
                              await apiFetch(`/api/profiles/${p.id}`, { method: 'DELETE' });
                              if (editingProfId === p.id) {
                                setEditingProfId(null);
                                setProfForm(EMPTY_PROF);
                              }
                              loadAll();
                            }}
                            className="p-1.5 rounded bg-rose-500/15 text-rose-300"
                            title="Eliminar Perfil"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Bulk Apply Bar */}
              <div className="p-3.5 rounded-xl bg-[#090e1a] border border-slate-800 flex flex-wrap items-end gap-3">
                <div className="flex-1 min-w-[160px]">
                  <label className="block text-slate-400 mb-1">Aplicar en lote a Categoría</label>
                  <select
                    value={bulkCat}
                    onChange={(e) => setBulkCat(e.target.value)}
                    className="w-full px-3 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white"
                  >
                    <option value="all">Todos los canales ({streams.length})</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="min-w-[150px]">
                  <label className="block text-slate-400 mb-1">Modo</label>
                  <select
                    value={bulkMode}
                    onChange={(e) => setBulkMode(e.target.value)}
                    className="w-full px-3 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white"
                  >
                    <option value="direct">Direct Stream</option>
                    <option value="ondemand">On-Demand</option>
                    <option value="transcode">Transcodificación Activa</option>
                  </select>
                </div>
                <div className="flex-1 min-w-[180px]">
                  <label className="block text-slate-400 mb-1">Perfil FFmpeg</label>
                  <select
                    value={bulkProfId}
                    onChange={(e) => setBulkProfId(Number(e.target.value))}
                    className="w-full px-3 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white"
                  >
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.video_bitrate})
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  onClick={handleBulkApplyProfile}
                  className="px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-semibold"
                >
                  Aplicar en Lote
                </button>
              </div>
            </div>
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
