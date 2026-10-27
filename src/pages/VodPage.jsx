import React, { useEffect, useState } from 'react';
import { Film, Tv, Plus, Play, Edit3, Trash2, Star, Clock, X, ListVideo } from 'lucide-react';
import { apiFetch } from '../lib/api.js';

const EMPTY_VOD = {
  title: '',
  type: 'movie',
  category_id: 6,
  source_url: '',
  poster_url: '',
  plot: '',
  genre: 'Acción, Aventura',
  release_year: 2025,
  rating: 8.2,
  duration_sec: 5400,
  container_ext: 'mp4'
};

const EMPTY_SERIES = {
  title: '',
  category_id: 8,
  poster_url: '',
  backdrop_url: '',
  plot: '',
  genre: 'Ciencia Ficción, Drama',
  release_year: 2025,
  rating: 8.7
};

export default function VodPage({ onPreview }) {
  const [subTab, setSubTab] = useState('movies'); // movies | series
  const [items, setItems] = useState([]);
  const [seriesList, setSeriesList] = useState([]);
  const [categories, setCategories] = useState([]);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_VOD);

  const [seriesModalOpen, setSeriesModalOpen] = useState(false);
  const [editingSeriesId, setEditingSeriesId] = useState(null);
  const [seriesForm, setSeriesForm] = useState(EMPTY_SERIES);

  const [episodesModalSeries, setEpisodesModalSeries] = useState(null);
  const [epForm, setEpForm] = useState({
    season_num: 1,
    episode_num: 1,
    title: '',
    source_url: '',
    duration_sec: 2400,
    container_ext: 'mp4',
    plot: ''
  });

  const loadAll = async () => {
    const [vods, srs, cats] = await Promise.all([
      apiFetch('/api/vod'),
      apiFetch('/api/series'),
      apiFetch('/api/categories')
    ]);
    setItems(vods);
    setSeriesList(srs);
    setCategories(cats);
    if (episodesModalSeries) {
      const updated = srs.find((x) => x.id === episodesModalSeries.id);
      setEpisodesModalSeries(updated || null);
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  const vodCats = categories.filter((c) => c.type === 'vod');
  const seriesCats = categories.filter((c) => c.type === 'series' || c.type === 'vod');

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...EMPTY_VOD, category_id: vodCats[0]?.id || 6 });
    setModalOpen(true);
  };

  const openEdit = (v) => {
    setEditingId(v.id);
    setForm({
      title: v.title,
      type: v.type || 'movie',
      category_id: v.category_id || 6,
      source_url: v.source_url,
      poster_url: v.poster_url || '',
      plot: v.plot || '',
      genre: v.genre || '',
      release_year: v.release_year || 2024,
      rating: v.rating || 8.0,
      duration_sec: v.duration_sec || 600,
      container_ext: v.container_ext || 'mp4'
    });
    setModalOpen(true);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (editingId) {
      await apiFetch(`/api/vod/${editingId}`, { method: 'PUT', body: JSON.stringify(form) });
    } else {
      await apiFetch('/api/vod', { method: 'POST', body: JSON.stringify(form) });
    }
    setModalOpen(false);
    loadAll();
  };

  const handleDelete = async (id) => {
    if (!window.confirm('¿Eliminar este título VOD?')) return;
    await apiFetch(`/api/vod/${id}`, { method: 'DELETE' });
    loadAll();
  };

  const openCreateSeries = () => {
    setEditingSeriesId(null);
    setSeriesForm({ ...EMPTY_SERIES, category_id: seriesCats[0]?.id || 6 });
    setSeriesModalOpen(true);
  };

  const openEditSeries = (sr) => {
    setEditingSeriesId(sr.id);
    setSeriesForm({
      title: sr.title,
      category_id: sr.category_id || 6,
      poster_url: sr.poster_url || '',
      backdrop_url: sr.backdrop_url || '',
      plot: sr.plot || '',
      genre: sr.genre || '',
      release_year: sr.release_year || 2025,
      rating: sr.rating || 8.5
    });
    setSeriesModalOpen(true);
  };

  const handleSaveSeries = async (e) => {
    e.preventDefault();
    if (editingSeriesId) {
      await apiFetch(`/api/series/${editingSeriesId}`, {
        method: 'PUT',
        body: JSON.stringify(seriesForm)
      });
    } else {
      await apiFetch('/api/series', {
        method: 'POST',
        body: JSON.stringify(seriesForm)
      });
    }
    setSeriesModalOpen(false);
    loadAll();
  };

  const handleDeleteSeries = async (id) => {
    if (!window.confirm('¿Eliminar esta serie y todos sus episodios?')) return;
    await apiFetch(`/api/series/${id}`, { method: 'DELETE' });
    loadAll();
  };

  const handleAddEpisode = async (e) => {
    e.preventDefault();
    if (!episodesModalSeries) return;
    await apiFetch(`/api/series/${episodesModalSeries.id}/episodes`, {
      method: 'POST',
      body: JSON.stringify(epForm)
    });
    setEpForm((prev) => ({
      ...prev,
      episode_num: Number(prev.episode_num) + 1,
      title: '',
      source_url: '',
      plot: ''
    }));
    loadAll();
  };

  const handleDeleteEpisode = async (epId) => {
    await apiFetch(`/api/series/episodes/${epId}`, { method: 'DELETE' });
    loadAll();
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 bg-[#0e1526] p-4 rounded-2xl border border-slate-800/80">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSubTab('movies')}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition ${
              subTab === 'movies'
                ? 'bg-indigo-600 text-white shadow'
                : 'bg-[#090e1a] text-slate-400 hover:text-white border border-slate-800'
            }`}
          >
            <Film className="w-4 h-4" />
            Películas VOD ({items.length})
          </button>
          <button
            onClick={() => setSubTab('series')}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition ${
              subTab === 'series'
                ? 'bg-violet-600 text-white shadow'
                : 'bg-[#090e1a] text-slate-400 hover:text-white border border-slate-800'
            }`}
          >
            <Tv className="w-4 h-4" />
            Series & Temporadas ({seriesList.length})
          </button>
        </div>

        {subTab === 'movies' ? (
          <button
            onClick={openCreate}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition"
          >
            <Plus className="w-4 h-4" />
            Agregar Película VOD
          </button>
        ) : (
          <button
            onClick={openCreateSeries}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold transition"
          >
            <Plus className="w-4 h-4" />
            Crear Nueva Serie
          </button>
        )}
      </div>

      {/* MOVIES TAB */}
      {subTab === 'movies' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {items.map((v) => (
            <div
              key={v.id}
              className="rounded-2xl bg-[#0e1526] border border-slate-800/80 overflow-hidden flex flex-col justify-between group"
            >
              <div>
                <div className="aspect-[16/10] bg-slate-900 relative overflow-hidden">
                  {v.poster_url ? (
                    <img
                      src={v.poster_url}
                      alt={v.title}
                      className="w-full h-full object-cover group-hover:scale-105 transition duration-300"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Film className="w-10 h-10 text-slate-700" />
                    </div>
                  )}
                  <div className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded bg-black/75 text-amber-300 text-xs font-bold flex items-center gap-1">
                    <Star className="w-3 h-3 fill-amber-300" /> {v.rating}
                  </div>
                  <div className="absolute bottom-2.5 left-2.5 px-2 py-0.5 rounded bg-indigo-600/90 text-white text-[10px] font-bold uppercase">
                    {v.container_ext} • {v.release_year}
                  </div>
                </div>

                <div className="p-4">
                  <h3 className="font-bold text-white text-sm truncate">{v.title}</h3>
                  <div className="text-[11px] text-indigo-300 mt-0.5">
                    {v.category_name || 'Películas'} • {v.genre}
                  </div>
                  <p className="text-xs text-slate-400 mt-2 line-clamp-2">{v.plot}</p>
                </div>
              </div>

              <div className="px-4 py-3 bg-[#090e1a] border-t border-slate-800/80 flex items-center justify-between text-xs">
                <span className="text-slate-400 flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5" /> {Math.round(v.duration_sec / 60)} min
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() =>
                      onPreview({
                        id: v.id,
                        kind: 'vod',
                        title: `${v.title} (${v.release_year})`,
                        url: v.source_url
                      })
                    }
                    className="p-1.5 rounded-lg bg-indigo-600/25 hover:bg-indigo-600 text-indigo-300 hover:text-white transition"
                    title="Reproducir VOD"
                  >
                    <Play className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => openEdit(v)}
                    className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleDelete(v.id)}
                    className="p-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 text-rose-300"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* SERIES TAB */}
      {subTab === 'series' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {seriesList.map((sr) => {
            const epCount = sr.episodes?.length || 0;
            const seasonsCount = new Set((sr.episodes || []).map((e) => e.season_num)).size;
            return (
              <div
                key={sr.id}
                className="rounded-2xl bg-[#0e1526] border border-slate-800/80 overflow-hidden flex flex-col justify-between group"
              >
                <div>
                  <div className="aspect-[16/9] bg-slate-900 relative overflow-hidden">
                    {sr.poster_url ? (
                      <img
                        src={sr.poster_url}
                        alt={sr.title}
                        className="w-full h-full object-cover group-hover:scale-105 transition duration-300"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Tv className="w-10 h-10 text-slate-700" />
                      </div>
                    )}
                    <div className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded bg-black/75 text-amber-300 text-xs font-bold flex items-center gap-1">
                      <Star className="w-3 h-3 fill-amber-300" /> {sr.rating}
                    </div>
                    <div className="absolute bottom-2.5 left-2.5 px-2.5 py-0.5 rounded bg-violet-600/90 text-white text-[10px] font-bold uppercase">
                      {seasonsCount} Temp • {epCount} Episodios
                    </div>
                  </div>

                  <div className="p-4">
                    <h3 className="font-bold text-white text-sm truncate">{sr.title}</h3>
                    <div className="text-[11px] text-violet-300 mt-0.5">
                      {sr.category_name || 'Series'} • {sr.genre} ({sr.release_year})
                    </div>
                    <p className="text-xs text-slate-400 mt-2 line-clamp-2">{sr.plot}</p>
                  </div>
                </div>

                <div className="px-4 py-3 bg-[#090e1a] border-t border-slate-800/80 flex items-center justify-between text-xs">
                  <button
                    onClick={() => {
                      setEpisodesModalSeries(sr);
                      setEpForm({
                        season_num: 1,
                        episode_num: (sr.episodes?.length || 0) + 1,
                        title: '',
                        source_url: '',
                        duration_sec: 2400,
                        container_ext: 'mp4',
                        plot: ''
                      });
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600/25 hover:bg-violet-600 text-violet-200 hover:text-white font-semibold transition"
                  >
                    <ListVideo className="w-3.5 h-3.5" />
                    Temporadas & Episodios ({epCount})
                  </button>

                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => openEditSeries(sr)}
                      className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleDeleteSeries(sr.id)}
                      className="p-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 text-rose-300"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create/Edit VOD Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-xl rounded-2xl bg-[#0e1526] border border-slate-800 overflow-hidden">
            <div className="px-5 py-4 bg-[#131c31] border-b border-slate-800 flex items-center justify-between">
              <h3 className="font-semibold text-white text-sm">
                {editingId ? 'Editar VOD' : 'Nuevo Contenido VOD'}
              </h3>
              <button onClick={() => setModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSave} className="p-5 space-y-3.5 text-xs max-h-[80vh] overflow-y-auto">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 mb-1">Título *</label>
                  <input
                    type="text"
                    required
                    value={form.title}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">Categoría</label>
                  <select
                    value={form.category_id}
                    onChange={(e) => setForm({ ...form, category_id: Number(e.target.value) })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    {vodCats.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-slate-300 mb-1">URL Directa MP4 / MKV / M3U8 *</label>
                <input
                  type="text"
                  required
                  value={form.source_url}
                  onChange={(e) => setForm({ ...form, source_url: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                />
              </div>

              <div>
                <label className="block text-slate-300 mb-1">URL Póster / Carátula</label>
                <input
                  type="text"
                  value={form.poster_url}
                  onChange={(e) => setForm({ ...form, poster_url: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                />
              </div>

              <div>
                <label className="block text-slate-300 mb-1">Sinopsis</label>
                <textarea
                  rows={2}
                  value={form.plot}
                  onChange={(e) => setForm({ ...form, plot: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                />
              </div>

              <div className="grid grid-cols-4 gap-3">
                <div>
                  <label className="block text-slate-300 mb-1">Año</label>
                  <input
                    type="number"
                    value={form.release_year}
                    onChange={(e) => setForm({ ...form, release_year: Number(e.target.value) })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">Rating</label>
                  <input
                    type="number"
                    step="0.1"
                    value={form.rating}
                    onChange={(e) => setForm({ ...form, rating: Number(e.target.value) })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">Duración (seg)</label>
                  <input
                    type="number"
                    value={form.duration_sec}
                    onChange={(e) => setForm({ ...form, duration_sec: Number(e.target.value) })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">Contenedor</label>
                  <select
                    value={form.container_ext}
                    onChange={(e) => setForm({ ...form, container_ext: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    <option value="mp4">mp4</option>
                    <option value="m3u8">m3u8</option>
                    <option value="mkv">mkv</option>
                  </select>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-800 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold"
                >
                  Guardar VOD
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create/Edit Series Modal */}
      {seriesModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-xl rounded-2xl bg-[#0e1526] border border-slate-800 overflow-hidden">
            <div className="px-5 py-4 bg-[#131c31] border-b border-slate-800 flex items-center justify-between">
              <h3 className="font-semibold text-white text-sm">
                {editingSeriesId ? 'Editar Serie' : 'Crear Nueva Serie (Xtream / TiviMate / Smarters)'}
              </h3>
              <button onClick={() => setSeriesModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSaveSeries} className="p-5 space-y-3.5 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 mb-1">Título de la Serie *</label>
                  <input
                    type="text"
                    required
                    value={seriesForm.title}
                    onChange={(e) => setSeriesForm({ ...seriesForm, title: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">Categoría</label>
                  <select
                    value={seriesForm.category_id}
                    onChange={(e) => setSeriesForm({ ...seriesForm, category_id: Number(e.target.value) })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    {seriesCats.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 mb-1">URL Póster</label>
                  <input
                    type="text"
                    value={seriesForm.poster_url}
                    onChange={(e) => setSeriesForm({ ...seriesForm, poster_url: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">Género</label>
                  <input
                    type="text"
                    value={seriesForm.genre}
                    onChange={(e) => setSeriesForm({ ...seriesForm, genre: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  />
                </div>
              </div>
              <div>
                <label className="block text-slate-300 mb-1">Sinopsis</label>
                <textarea
                  rows={2}
                  value={seriesForm.plot}
                  onChange={(e) => setSeriesForm({ ...seriesForm, plot: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 mb-1">Año</label>
                  <input
                    type="number"
                    value={seriesForm.release_year}
                    onChange={(e) => setSeriesForm({ ...seriesForm, release_year: Number(e.target.value) })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">Rating</label>
                  <input
                    type="number"
                    step="0.1"
                    value={seriesForm.rating}
                    onChange={(e) => setSeriesForm({ ...seriesForm, rating: Number(e.target.value) })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  />
                </div>
              </div>
              <div className="pt-3 border-t border-slate-800 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setSeriesModalOpen(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-semibold"
                >
                  Guardar Serie
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Manage Seasons & Episodes Modal */}
      {episodesModalSeries && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-2xl rounded-2xl bg-[#0e1526] border border-slate-800 overflow-hidden">
            <div className="px-5 py-4 bg-[#131c31] border-b border-slate-800 flex items-center justify-between">
              <h3 className="font-semibold text-white text-sm">
                Temporadas & Episodios — {episodesModalSeries.title}
              </h3>
              <button onClick={() => setEpisodesModalSeries(null)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-4 max-h-[82vh] overflow-y-auto text-xs">
              <form onSubmit={handleAddEpisode} className="p-4 rounded-xl bg-[#090e1a] border border-slate-800 space-y-3">
                <div className="font-semibold text-violet-300">+ Agregar Episodio a Temporada</div>
                <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
                  <div>
                    <label className="block text-slate-400 mb-1">Temp #</label>
                    <input
                      type="number"
                      min="1"
                      required
                      value={epForm.season_num}
                      onChange={(e) => setEpForm({ ...epForm, season_num: Number(e.target.value) })}
                      className="w-full px-2.5 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-400 mb-1">Episodio #</label>
                    <input
                      type="number"
                      min="1"
                      required
                      value={epForm.episode_num}
                      onChange={(e) => setEpForm({ ...epForm, episode_num: Number(e.target.value) })}
                      className="w-full px-2.5 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white"
                    />
                  </div>
                  <div className="sm:col-span-4">
                    <label className="block text-slate-400 mb-1">Título del Episodio *</label>
                    <input
                      type="text"
                      required
                      value={epForm.title}
                      onChange={(e) => setEpForm({ ...epForm, title: e.target.value })}
                      placeholder="Ej. El Comienzo"
                      className="w-full px-2.5 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
                  <input
                    type="text"
                    required
                    value={epForm.source_url}
                    onChange={(e) => setEpForm({ ...epForm, source_url: e.target.value })}
                    placeholder="URL MP4 / MKV / M3U8 del episodio *"
                    className="sm:col-span-9 px-2.5 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white font-mono"
                  />
                  <button
                    type="submit"
                    className="sm:col-span-3 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white font-semibold"
                  >
                    + Añadir Ep
                  </button>
                </div>
              </form>

              <div className="space-y-2">
                {(episodesModalSeries.episodes || []).length === 0 ? (
                  <div className="text-slate-500 text-center py-4">Sin episodios aún.</div>
                ) : (
                  episodesModalSeries.episodes.map((ep) => (
                    <div
                      key={ep.id}
                      className="p-3 rounded-xl bg-[#090e1a] border border-slate-800 flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0">
                        <span className="px-2 py-0.5 rounded bg-violet-500/20 text-violet-300 font-mono font-bold mr-2">
                          T{String(ep.season_num).padStart(2, '0')}E{String(ep.episode_num).padStart(2, '0')}
                        </span>
                        <span className="font-semibold text-white">{ep.title}</span>
                        <div className="text-[11px] font-mono text-slate-500 truncate mt-0.5">{ep.source_url}</div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          onClick={() =>
                            onPreview({
                              id: ep.id,
                              kind: 'series',
                              title: `${episodesModalSeries.title} T${ep.season_num}E${ep.episode_num} — ${ep.title}`,
                              url: ep.source_url
                            })
                          }
                          className="p-1.5 rounded-lg bg-indigo-600/25 hover:bg-indigo-600 text-indigo-300 hover:text-white"
                          title="Reproducir Episodio"
                        >
                          <Play className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDeleteEpisode(ep.id)}
                          className="p-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 text-rose-300"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
