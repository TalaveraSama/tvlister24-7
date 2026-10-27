import React, { useEffect, useState } from 'react';
import { Film, Plus, Play, Edit3, Trash2, Star, Clock, X } from 'lucide-react';
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

export default function VodPage({ onPreview }) {
  const [items, setItems] = useState([]);
  const [categories, setCategories] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_VOD);

  const loadAll = async () => {
    const [vods, cats] = await Promise.all([apiFetch('/api/vod'), apiFetch('/api/categories')]);
    setItems(vods);
    setCategories(cats.filter((c) => c.type === 'vod'));
  };

  useEffect(() => {
    loadAll();
  }, []);

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...EMPTY_VOD, category_id: categories[0]?.id || 6 });
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

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between bg-[#0e1526] p-4 rounded-2xl border border-slate-800/80">
        <div>
          <h2 className="text-sm font-bold text-white flex items-center gap-2">
            <Film className="w-4 h-4 text-cyan-400" />
            Biblioteca VOD — Películas & Series ({items.length})
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Los contenidos VOD están disponibles en M3U, API Xtream/Player, Portal WebTV y para armar Canales 24/7.
          </p>
        </div>

        <button
          onClick={openCreate}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition"
        >
          <Plus className="w-4 h-4" />
          Agregar VOD
        </button>
      </div>

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
                    {categories.map((c) => (
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
    </div>
  );
}
