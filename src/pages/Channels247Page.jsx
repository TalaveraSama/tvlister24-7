import React, { useEffect, useState } from 'react';
import {
  Tv2,
  Plus,
  Play,
  Square,
  RotateCw,
  Edit3,
  Trash2,
  ArrowUp,
  ArrowDown,
  Terminal,
  Calendar,
  X,
  Film
} from 'lucide-react';
import { apiFetch } from '../lib/api.js';

export default function Channels247Page({ onPreview }) {
  const [channels, setChannels] = useState([]);
  const [vodList, setVodList] = useState([]);
  const [categories, setCategories] = useState([]);
  const [profiles, setProfiles] = useState([]);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({
    name: '',
    category_id: 4,
    logo_url: '',
    epg_channel_id: '',
    loop_mode: 'loop',
    transcode_profile_id: 2,
    watermark_text: 'TVLISTER 24/7',
    playlist: []
  });

  const [customTitle, setCustomTitle] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [customDur, setCustomDur] = useState(600);

  const [epgModal, setEpgModal] = useState(null);
  const [ffmpegModal, setFfmpegModal] = useState(null);

  const loadAll = async () => {
    const [chs, vods, cats, sys] = await Promise.all([
      apiFetch('/api/channels247'),
      apiFetch('/api/vod'),
      apiFetch('/api/categories'),
      apiFetch('/api/system')
    ]);
    setChannels(chs);
    setVodList(vods);
    setCategories(cats.filter((c) => c.type === 'channel247' || c.type === 'live'));
    setProfiles(sys.profiles || []);
  };

  useEffect(() => {
    loadAll();
    const t = setInterval(loadAll, 10000);
    return () => clearInterval(t);
  }, []);

  const openCreate = () => {
    setEditingId(null);
    setForm({
      name: '',
      category_id: categories[0]?.id || 4,
      logo_url: '',
      epg_channel_id: `canal247.${Math.floor(Math.random() * 900 + 100)}.tv`,
      loop_mode: 'loop',
      transcode_profile_id: 2,
      watermark_text: 'TVLISTER 24/7',
      playlist: vodList.slice(0, 2).map((v, idx) => ({
        id: `clip-${Date.now()}-${idx}`,
        vod_id: v.id,
        title: v.title,
        url: v.source_url,
        duration_sec: v.duration_sec
      }))
    });
    setModalOpen(true);
  };

  const openEdit = (ch) => {
    setEditingId(ch.id);
    setForm({
      name: ch.name,
      category_id: ch.category_id || 4,
      logo_url: ch.logo_url || '',
      epg_channel_id: ch.epg_channel_id || '',
      loop_mode: ch.loop_mode || 'loop',
      transcode_profile_id: ch.transcode_profile_id || 2,
      watermark_text: ch.watermark_text || '',
      playlist: Array.isArray(ch.playlist) ? ch.playlist : []
    });
    setModalOpen(true);
  };

  const addVodToPlaylist = (vodId) => {
    const v = vodList.find((x) => String(x.id) === String(vodId));
    if (!v) return;
    setForm((prev) => ({
      ...prev,
      playlist: [
        ...prev.playlist,
        {
          id: `clip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          vod_id: v.id,
          title: v.title,
          url: v.source_url,
          duration_sec: v.duration_sec || 600
        }
      ]
    }));
  };

  const addCustomClip = () => {
    if (!customTitle.trim() || !customUrl.trim()) return;
    setForm((prev) => ({
      ...prev,
      playlist: [
        ...prev.playlist,
        {
          id: `clip-${Date.now()}`,
          vod_id: null,
          title: customTitle.trim(),
          url: customUrl.trim(),
          duration_sec: Math.max(15, Number(customDur) || 600)
        }
      ]
    }));
    setCustomTitle('');
    setCustomUrl('');
    setCustomDur(600);
  };

  const moveClip = (idx, dir) => {
    const next = [...form.playlist];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    setForm({ ...form, playlist: next });
  };

  const removeClip = (idx) => {
    setForm({
      ...form,
      playlist: form.playlist.filter((_, i) => i !== idx)
    });
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (editingId) {
      await apiFetch(`/api/channels247/${editingId}`, {
        method: 'PUT',
        body: JSON.stringify(form)
      });
    } else {
      await apiFetch('/api/channels247', {
        method: 'POST',
        body: JSON.stringify(form)
      });
    }
    setModalOpen(false);
    loadAll();
  };

  const handleAction = async (id, action) => {
    await apiFetch(`/api/channels247/${id}/action`, {
      method: 'POST',
      body: JSON.stringify({ action })
    });
    loadAll();
  };

  const handleDelete = async (id) => {
    if (!window.confirm('¿Eliminar este Canal 24/7?')) return;
    await apiFetch(`/api/channels247/${id}`, { method: 'DELETE' });
    loadAll();
  };

  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-gradient-to-r from-indigo-600/20 via-violet-600/15 to-cyan-600/15 border border-indigo-500/30 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <Tv2 className="w-5 h-5 text-indigo-400" />
            Estudio de Canales Personalizados 24/7 (Playout Dinámico)
          </h2>
          <p className="text-xs text-slate-300 mt-1 max-w-2xl">
            Crea canales lineales 24/7 combinando tu catálogo VOD y flujos externos con cambios de parrilla en caliente,
            marca de agua en pantalla (Watermark) y generación automática de guía EPG XMLTV.
          </p>
        </div>

        <button
          onClick={openCreate}
          className="shrink-0 inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-lg shadow-indigo-600/25 transition"
        >
          <Plus className="w-4 h-4" />
          Crear Canal 24/7
        </button>
      </div>

      {/* Channels Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        {channels.map((ch) => {
          const st = ch.liveState || {};
          return (
            <div
              key={ch.id}
              className="rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 flex flex-col justify-between gap-4 shadow-lg"
            >
              <div>
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-12 h-12 rounded-xl bg-slate-800 border border-slate-700 overflow-hidden flex items-center justify-center shrink-0">
                      {ch.logo_url ? (
                        <img src={ch.logo_url} alt={ch.name} className="w-full h-full object-cover" />
                      ) : (
                        <Tv2 className="w-6 h-6 text-violet-400" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-white text-sm truncate">{ch.name}</h3>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                            ch.status === 'running'
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                              : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                          }`}
                        >
                          {ch.status === 'running' ? 'AL AIRE 24/7' : 'DETENIDO'}
                        </span>
                      </div>
                      <div className="text-xs text-slate-400 mt-0.5">
                        {ch.category_name || '24/7'} • {ch.playlist?.length || 0} programas • EPG:{' '}
                        <span className="font-mono text-slate-300">{ch.epg_channel_id}</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Live Now Playing Box */}
                <div className="p-3.5 rounded-xl bg-[#090e1a] border border-slate-800/90 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-400 font-medium">Emitiendo ahora mismo:</span>
                    <span className="font-mono text-indigo-300 text-[11px]">{st.progressPct || 0}%</span>
                  </div>
                  <div className="text-xs font-semibold text-white truncate">
                    {st.currentItem ? `▶ ${st.currentItem.title}` : 'Parrilla vacía'}
                  </div>
                  <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-indigo-500 via-violet-500 to-cyan-400"
                      style={{ width: `${st.progressPct || 0}%` }}
                    />
                  </div>
                  {st.nextItem && (
                    <div className="text-[11px] text-slate-400 flex items-center justify-between">
                      <span>Posición: {Math.floor((st.seekOffsetSec || 0) / 60)}m {(st.seekOffsetSec || 0) % 60}s</span>
                      <span className="truncate max-w-[240px]">A continuación: {st.nextItem.title}</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="pt-2 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() =>
                      onPreview({
                        id: ch.id,
                        kind: 'channel247',
                        title: ch.name,
                        watermark: ch.watermark_text,
                        liveState: st,
                        url: st.currentItem?.url
                      })
                    }
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition"
                  >
                    <Play className="w-3.5 h-3.5" />
                    Sintonizar
                  </button>

                  <button
                    onClick={() => setEpgModal(ch)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs transition"
                  >
                    <Calendar className="w-3.5 h-3.5 text-cyan-400" />
                    Parrilla EPG
                  </button>

                  <button
                    onClick={() => setFfmpegModal(ch)}
                    className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
                    title="Ver motor FFmpeg 24/7"
                  >
                    <Terminal className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="flex items-center gap-1.5">
                  {ch.status === 'running' ? (
                    <button
                      onClick={() => handleAction(ch.id, 'stop')}
                      className="p-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/30 text-amber-300"
                      title="Detener"
                    >
                      <Square className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <button
                      onClick={() => handleAction(ch.id, 'start')}
                      className="p-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/30 text-emerald-300"
                      title="Iniciar"
                    >
                      <RotateCw className="w-3.5 h-3.5" />
                    </button>
                  )}

                  <button
                    onClick={() => openEdit(ch)}
                    className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200"
                    title="Editar programación"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>

                  <button
                    onClick={() => handleDelete(ch.id)}
                    className="p-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 text-rose-300"
                    title="Eliminar"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Create / Edit 24/7 Channel Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-3xl rounded-2xl bg-[#0e1526] border border-slate-800 shadow-2xl overflow-hidden">
            <div className="px-5 py-4 bg-[#131c31] border-b border-slate-800 flex items-center justify-between">
              <h3 className="font-semibold text-white text-sm">
                {editingId ? 'Editar Programación Canal 24/7' : 'Nuevo Canal Dinámico 24/7'}
              </h3>
              <button onClick={() => setModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSave} className="p-5 space-y-4 max-h-[82vh] overflow-y-auto text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-slate-300 mb-1 font-medium">Nombre del Canal 24/7 *</label>
                  <input
                    type="text"
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                    placeholder="Ej. Cine Acción 24/7"
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
                <div>
                  <label className="block text-slate-300 mb-1 font-medium">Marca de Agua (Watermark OSD)</label>
                  <input
                    type="text"
                    value={form.watermark_text}
                    onChange={(e) => setForm({ ...form, watermark_text: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                    placeholder="Ej. CINE 24/7 HD"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-slate-300 mb-1 font-medium">ID EPG Automático</label>
                  <input
                    type="text"
                    value={form.epg_channel_id}
                    onChange={(e) => setForm({ ...form, epg_channel_id: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1 font-medium">Perfil Transcodificador</label>
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
                  <label className="block text-slate-300 mb-1 font-medium">Logo URL</label>
                  <input
                    type="text"
                    value={form.logo_url}
                    onChange={(e) => setForm({ ...form, logo_url: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                    placeholder="https://..."
                  />
                </div>
              </div>

              {/* Add from VOD Library */}
              <div className="p-4 rounded-xl bg-[#090e1a] border border-slate-800 space-y-3">
                <div className="font-semibold text-indigo-300 flex items-center gap-2">
                  <Film className="w-4 h-4" />
                  1. Agregar Película desde Biblioteca VOD
                </div>
                <div className="flex flex-wrap gap-2">
                  {vodList.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => addVodToPlaylist(v.id)}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-indigo-600/30 border border-slate-700 hover:border-indigo-500/50 text-slate-200 transition"
                    >
                      + {v.title} ({Math.round(v.duration_sec / 60)}m)
                    </button>
                  ))}
                </div>

                <div className="pt-2 border-t border-slate-800/80">
                  <div className="text-slate-400 mb-2 font-medium">O agregar URL MP4 / HLS externa directa:</div>
                  <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
                    <input
                      type="text"
                      value={customTitle}
                      onChange={(e) => setCustomTitle(e.target.value)}
                      placeholder="Título del programa"
                      className="sm:col-span-4 px-3 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white"
                    />
                    <input
                      type="text"
                      value={customUrl}
                      onChange={(e) => setCustomUrl(e.target.value)}
                      placeholder="https://.../video.mp4"
                      className="sm:col-span-5 px-3 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white font-mono"
                    />
                    <input
                      type="number"
                      value={customDur}
                      onChange={(e) => setCustomDur(Number(e.target.value))}
                      placeholder="Segs"
                      className="sm:col-span-2 px-2 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white"
                    />
                    <button
                      type="button"
                      onClick={addCustomClip}
                      className="sm:col-span-1 px-2 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold"
                    >
                      +
                    </button>
                  </div>
                </div>
              </div>

              {/* Playlist Sequence */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-white">
                    Secuencia de Emisión Continua ({form.playlist.length} bloques)
                  </span>
                  <span className="text-slate-400">
                    Duración ciclo:{' '}
                    {Math.round(form.playlist.reduce((a, b) => a + (Number(b.duration_sec) || 0), 0) / 60)} min
                  </span>
                </div>

                <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1">
                  {form.playlist.map((clip, idx) => (
                    <div
                      key={clip.id || idx}
                      className="px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-800 flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0">
                        <span className="font-mono text-indigo-400 mr-2">#{idx + 1}</span>
                        <span className="font-medium text-white">{clip.title}</span>
                        <span className="text-slate-500 ml-2">({Math.round(clip.duration_sec / 60)} min)</span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => moveClip(idx, -1)}
                          className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                        >
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveClip(idx, 1)}
                          className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                        >
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeClip(idx)}
                          className="p-1 rounded bg-rose-500/15 hover:bg-rose-500/30 text-rose-300"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
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
                  Guardar Parrilla 24/7
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* EPG Schedule Modal */}
      {epgModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-xl rounded-2xl bg-[#0e1526] border border-slate-800 overflow-hidden">
            <div className="px-5 py-4 bg-[#131c31] border-b border-slate-800 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">
                Guía EPG Generada Automáticamente — {epgModal.name}
              </h3>
              <button onClick={() => setEpgModal(null)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 max-h-96 overflow-y-auto space-y-2 text-xs">
              {(epgModal.liveState?.schedule || []).map((slot) => (
                <div
                  key={slot.slot}
                  className={`p-3 rounded-xl border flex items-center justify-between ${
                    slot.is_current
                      ? 'bg-indigo-600/20 border-indigo-500/40 text-white'
                      : 'bg-[#090e1a] border-slate-800 text-slate-300'
                  }`}
                >
                  <div>
                    <div className="font-semibold">{slot.title}</div>
                    <div className="text-[11px] text-slate-400 font-mono">
                      {new Date(slot.start_iso).toLocaleTimeString()} — {new Date(slot.end_iso).toLocaleTimeString()}
                    </div>
                  </div>
                  {slot.is_current && (
                    <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[10px] font-bold">
                      EN VIVO
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* FFmpeg 24/7 Playout Command Modal */}
      {ffmpegModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-2xl rounded-2xl bg-[#0e1526] border border-slate-800 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">
                Motor Playout FFmpeg 24/7 — {ffmpegModal.name}
              </h3>
              <button onClick={() => setFfmpegModal(null)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <pre className="p-4 rounded-xl bg-[#070b13] border border-slate-800 text-xs font-mono text-emerald-300 whitespace-pre-wrap break-all">
              {ffmpegModal.ffmpegCommand}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
