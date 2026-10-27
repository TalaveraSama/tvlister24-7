import React, { useEffect, useState } from 'react';
import { Layers, Plus, Trash2, Save, FolderPlus } from 'lucide-react';
import { apiFetch } from '../lib/api.js';

export default function BouquetsPage() {
  const [bouquets, setBouquets] = useState([]);
  const [categories, setCategories] = useState([]);
  const [streams, setStreams] = useState([]);
  const [channels247, setChannels247] = useState([]);
  const [vods, setVods] = useState([]);

  const [selectedBouquet, setSelectedBouquet] = useState(null);
  const [newBouquetName, setNewBouquetName] = useState('');
  const [newCatName, setNewCatName] = useState('');
  const [newCatType, setNewCatType] = useState('live');
  const [savedNotice, setSavedNotice] = useState('');

  const loadAll = async () => {
    const [bq, cats, st, ch, vd] = await Promise.all([
      apiFetch('/api/bouquets'),
      apiFetch('/api/categories'),
      apiFetch('/api/streams'),
      apiFetch('/api/channels247'),
      apiFetch('/api/vod')
    ]);
    setBouquets(bq);
    setCategories(cats);
    setStreams(st);
    setChannels247(ch);
    setVods(vd);
    if (!selectedBouquet && bq.length > 0) {
      setSelectedBouquet(bq[0]);
    } else if (selectedBouquet) {
      const fresh = bq.find((x) => x.id === selectedBouquet.id);
      if (fresh) setSelectedBouquet(fresh);
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  const handleCreateBouquet = async (e) => {
    e.preventDefault();
    if (!newBouquetName.trim()) return;
    await apiFetch('/api/bouquets', {
      method: 'POST',
      body: JSON.stringify({
        name: newBouquetName.trim(),
        description: 'Paquete personalizado',
        stream_ids: streams.map((s) => s.id),
        channel247_ids: channels247.map((c) => c.id),
        vod_ids: vods.map((v) => v.id)
      })
    });
    setNewBouquetName('');
    loadAll();
  };

  const toggleInSelected = (field, id) => {
    if (!selectedBouquet) return;
    const arr = selectedBouquet[field] || [];
    const next = arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id];
    setSelectedBouquet({ ...selectedBouquet, [field]: next });
  };

  const saveBouquetSelection = async () => {
    if (!selectedBouquet) return;
    await apiFetch(`/api/bouquets/${selectedBouquet.id}`, {
      method: 'PUT',
      body: JSON.stringify(selectedBouquet)
    });
    setSavedNotice('Bouquet actualizado correctamente');
    setTimeout(() => setSavedNotice(''), 2200);
    loadAll();
  };

  const handleCreateCategory = async (e) => {
    e.preventDefault();
    if (!newCatName.trim()) return;
    await apiFetch('/api/categories', {
      method: 'POST',
      body: JSON.stringify({ name: newCatName.trim(), type: newCatType })
    });
    setNewCatName('');
    loadAll();
  };

  const deleteCategory = async (id) => {
    await apiFetch(`/api/categories/${id}`, { method: 'DELETE' });
    loadAll();
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      {/* Bouquets Column */}
      <div className="lg:col-span-8 space-y-5">
        <div className="rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Layers className="w-4 h-4 text-indigo-400" />
              Gestión de Bouquets (Paquetes de Canales & VOD)
            </h2>
            <form onSubmit={handleCreateBouquet} className="flex items-center gap-2">
              <input
                type="text"
                value={newBouquetName}
                onChange={(e) => setNewBouquetName(e.target.value)}
                placeholder="Nuevo Bouquet..."
                className="px-3 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-xs text-white"
              />
              <button
                type="submit"
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold"
              >
                <Plus className="w-3.5 h-3.5" /> Crear
              </button>
            </form>
          </div>

          <div className="flex flex-wrap gap-2">
            {bouquets.map((b) => (
              <button
                key={b.id}
                onClick={() => setSelectedBouquet(b)}
                className={`px-3.5 py-2 rounded-xl text-xs font-semibold border transition ${
                  selectedBouquet?.id === b.id
                    ? 'bg-indigo-600/25 border-indigo-500 text-indigo-200'
                    : 'bg-[#090e1a] border-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                {b.name}
              </button>
            ))}
          </div>

          {selectedBouquet && (
            <div className="space-y-4 pt-2 border-t border-slate-800">
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-300">
                  Editando contenido de: <strong className="text-white">{selectedBouquet.name}</strong>
                </span>
                <div className="flex items-center gap-2">
                  {savedNotice && <span className="text-xs text-emerald-400">{savedNotice}</span>}
                  <button
                    onClick={saveBouquetSelection}
                    className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold"
                  >
                    <Save className="w-3.5 h-3.5" />
                    Guardar Bouquet
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                <div className="p-3 rounded-xl bg-[#090e1a] border border-slate-800 space-y-2">
                  <div className="font-semibold text-indigo-300">Canales en Vivo</div>
                  {streams.map((s) => (
                    <label key={s.id} className="flex items-center gap-2 text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={(selectedBouquet.stream_ids || []).includes(s.id)}
                        onChange={() => toggleInSelected('stream_ids', s.id)}
                        className="accent-indigo-500"
                      />
                      <span className="truncate">{s.name}</span>
                    </label>
                  ))}
                </div>

                <div className="p-3 rounded-xl bg-[#090e1a] border border-slate-800 space-y-2">
                  <div className="font-semibold text-violet-300">Canales 24/7</div>
                  {channels247.map((c) => (
                    <label key={c.id} className="flex items-center gap-2 text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={(selectedBouquet.channel247_ids || []).includes(c.id)}
                        onChange={() => toggleInSelected('channel247_ids', c.id)}
                        className="accent-violet-500"
                      />
                      <span className="truncate">{c.name}</span>
                    </label>
                  ))}
                </div>

                <div className="p-3 rounded-xl bg-[#090e1a] border border-slate-800 space-y-2">
                  <div className="font-semibold text-cyan-300">Películas VOD</div>
                  {vods.map((v) => (
                    <label key={v.id} className="flex items-center gap-2 text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={(selectedBouquet.vod_ids || []).includes(v.id)}
                        onChange={() => toggleInSelected('vod_ids', v.id)}
                        className="accent-cyan-500"
                      />
                      <span className="truncate">{v.title}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Categories Column */}
      <div className="lg:col-span-4 rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-4">
        <h2 className="text-sm font-bold text-white flex items-center gap-2">
          <FolderPlus className="w-4 h-4 text-cyan-400" />
          Categorías Multi-Módulo
        </h2>

        <form onSubmit={handleCreateCategory} className="space-y-2 text-xs">
          <input
            type="text"
            value={newCatName}
            onChange={(e) => setNewCatName(e.target.value)}
            placeholder="Nombre de categoría..."
            className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
          />
          <div className="flex gap-2">
            <select
              value={newCatType}
              onChange={(e) => setNewCatType(e.target.value)}
              className="flex-1 px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
            >
              <option value="live">Live TV</option>
              <option value="channel247">Canales 24/7</option>
              <option value="vod">Películas VOD</option>
            </select>
            <button
              type="submit"
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold"
            >
              Añadir
            </button>
          </div>
        </form>

        <div className="space-y-2 max-h-96 overflow-y-auto text-xs">
          {categories.map((c) => (
            <div
              key={c.id}
              className="px-3 py-2.5 rounded-xl bg-[#090e1a] border border-slate-800 flex items-center justify-between"
            >
              <div>
                <div className="font-medium text-white">{c.name}</div>
                <div className="text-[10px] uppercase text-indigo-300">{c.type}</div>
              </div>
              <button
                onClick={() => deleteCategory(c.id)}
                className="p-1 rounded bg-rose-500/15 hover:bg-rose-500/30 text-rose-300"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
