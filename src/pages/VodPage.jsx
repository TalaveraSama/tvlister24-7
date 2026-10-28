import React, { useEffect, useState } from 'react';
import {
  Film,
  Plus,
  Play,
  Edit3,
  Trash2,
  Star,
  Clock,
  X,
  Tv,
  ListVideo,
  FolderSync,
  FolderOpen,
  Sparkles,
  Search,
  RefreshCw,
  CheckCircle2,
  HardDrive,
  ArrowUpLeft
} from 'lucide-react';
import { apiFetch } from '../lib/api.js';

const EMPTY_VOD = {
  title: '',
  type: 'movie',
  category_id: 6,
  source_url: '',
  poster_url: '',
  backdrop_url: '',
  tmdb_id: '',
  plot: '',
  genre: 'Acción',
  release_year: 2025,
  rating: 8.0,
  duration_sec: 5400,
  container_ext: 'mp4'
};

const EMPTY_SERIES = {
  title: '',
  category_id: 6,
  poster_url: '',
  backdrop_url: '',
  tmdb_id: '',
  plot: '',
  genre: 'Drama',
  release_year: 2025,
  rating: 8.5
};

export default function VodPage({ onPreview }) {
  const [subTab, setSubTab] = useState('movies'); // 'movies' | 'series'
  const [items, setItems] = useState([]);
  const [seriesList, setSeriesList] = useState([]);
  const [categories, setCategories] = useState([]);
  const [searchFilter, setSearchFilter] = useState('');

  // Movie modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_VOD);

  // Series modal
  const [seriesModalOpen, setSeriesModalOpen] = useState(false);
  const [editingSeriesId, setEditingSeriesId] = useState(null);
  const [seriesForm, setSeriesForm] = useState(EMPTY_SERIES);

  // Episodes modal
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

  // TMDB Search inside Movie/Series modal
  const [tmdbQuery, setTmdbQuery] = useState('');
  const [tmdbResults, setTmdbResults] = useState([]);
  const [tmdbSearching, setTmdbSearching] = useState(false);
  const [tmdbSearchErr, setTmdbSearchErr] = useState('');

  // TMDB Global Config & Bulk Enrich Modal
  const [tmdbModalOpen, setTmdbModalOpen] = useState(false);
  const [tmdbCfg, setTmdbCfg] = useState({ configured: false, apiKeyMasked: '', language: 'es-MX', xuiLocalImagesDirExists: false });
  const [tmdbKeyInput, setTmdbKeyInput] = useState('');
  const [tmdbLangInput, setTmdbLangInput] = useState('es-MX');
  const [tmdbBusy, setTmdbBusy] = useState(false);
  const [tmdbMsg, setTmdbMsg] = useState(null);

  // Folder Sync & Watch Folders Modal
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [watchFolders, setWatchFolders] = useState([]);
  const [folderForm, setFolderForm] = useState({
    folderPath: '/mnt/peliculas',
    contentMode: 'auto',
    useSubfoldersAsCategories: true,
    autoTmdb: true,
    autoSyncMinutes: 0,
    removeMissing: false
  });
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserData, setBrowserData] = useState({ currentPath: '/', parentPath: null, directories: [], mediaFilesInCurrent: 0 });
  const [previewScan, setPreviewScan] = useState(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderMsg, setFolderMsg] = useState(null);

  const loadAll = async () => {
    const [v, c, sr] = await Promise.all([
      apiFetch('/api/vod'),
      apiFetch('/api/categories'),
      apiFetch('/api/series')
    ]);
    setItems(v);
    setCategories(c);
    setSeriesList(sr);
    if (episodesModalSeries) {
      const updated = sr.find((x) => x.id === episodesModalSeries.id);
      setEpisodesModalSeries(updated || null);
    }
    try {
      const [cfg, wf] = await Promise.all([
        apiFetch('/api/tmdb/config'),
        apiFetch('/api/vod/folders')
      ]);
      setTmdbCfg(cfg);
      setTmdbLangInput(cfg.language || 'es-MX');
      setWatchFolders(wf);
    } catch {
      // reseller role may not access admin-only endpoints
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
    setTmdbQuery('');
    setTmdbResults([]);
    setTmdbSearchErr('');
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
      backdrop_url: v.backdrop_url || '',
      tmdb_id: v.tmdb_id || '',
      plot: v.plot || '',
      genre: v.genre || '',
      release_year: v.release_year || 2025,
      rating: v.rating || 8.0,
      duration_sec: v.duration_sec || 5400,
      container_ext: v.container_ext || 'mp4'
    });
    setTmdbQuery(v.title || '');
    setTmdbResults([]);
    setTmdbSearchErr('');
    setModalOpen(true);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (editingId) {
      await apiFetch(`/api/vod/${editingId}`, {
        method: 'PUT',
        body: JSON.stringify(form)
      });
    } else {
      await apiFetch('/api/vod', {
        method: 'POST',
        body: JSON.stringify(form)
      });
    }
    setModalOpen(false);
    loadAll();
  };

  const handleDelete = async (id) => {
    if (!window.confirm('¿Eliminar esta película VOD?')) return;
    await apiFetch(`/api/vod/${id}`, { method: 'DELETE' });
    loadAll();
  };

  const openCreateSeries = () => {
    setEditingSeriesId(null);
    setSeriesForm({ ...EMPTY_SERIES, category_id: seriesCats[0]?.id || 6 });
    setTmdbQuery('');
    setTmdbResults([]);
    setTmdbSearchErr('');
    setSeriesModalOpen(true);
  };

  const openEditSeries = (sr) => {
    setEditingSeriesId(sr.id);
    setSeriesForm({
      title: sr.title,
      category_id: sr.category_id || 6,
      poster_url: sr.poster_url || '',
      backdrop_url: sr.backdrop_url || '',
      tmdb_id: sr.tmdb_id || '',
      plot: sr.plot || '',
      genre: sr.genre || '',
      release_year: sr.release_year || 2025,
      rating: sr.rating || 8.5
    });
    setTmdbQuery(sr.title || '');
    setTmdbResults([]);
    setTmdbSearchErr('');
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

  // ==================== TMDB LIVE SEARCH & ACTIONS ====================
  const runTmdbLookup = async (type = 'movie', fallbackTitle = '') => {
    const q = (tmdbQuery || fallbackTitle).trim();
    if (!q) return;
    setTmdbSearching(true);
    setTmdbSearchErr('');
    try {
      const data = await apiFetch(`/api/tmdb/search?q=${encodeURIComponent(q)}&type=${type}`);
      setTmdbResults(data.results || []);
      if ((data.results || []).length === 0) {
        setTmdbSearchErr('Sin coincidencias en TMDB para ese título.');
      }
    } catch (err) {
      setTmdbSearchErr(err.message || 'Error consultando TMDB');
    } finally {
      setTmdbSearching(false);
    }
  };

  const applyTmdbToMovie = (hit) => {
    setForm((prev) => ({
      ...prev,
      title: hit.title || prev.title,
      poster_url: hit.poster_url || prev.poster_url,
      backdrop_url: hit.backdrop_url || prev.backdrop_url,
      tmdb_id: hit.tmdb_id || prev.tmdb_id,
      plot: hit.plot || prev.plot,
      genre: hit.genre || prev.genre,
      release_year: hit.release_year || prev.release_year,
      rating: hit.rating || prev.rating
    }));
    setTmdbResults([]);
  };

  const applyTmdbToSeries = (hit) => {
    setSeriesForm((prev) => ({
      ...prev,
      title: hit.title || prev.title,
      poster_url: hit.poster_url || prev.poster_url,
      backdrop_url: hit.backdrop_url || prev.backdrop_url,
      tmdb_id: hit.tmdb_id || prev.tmdb_id,
      plot: hit.plot || prev.plot,
      genre: hit.genre || prev.genre,
      release_year: hit.release_year || prev.release_year,
      rating: hit.rating || prev.rating
    }));
    setTmdbResults([]);
  };

  const handleSaveTmdbSettings = async (e) => {
    e.preventDefault();
    setTmdbBusy(true);
    setTmdbMsg(null);
    try {
      const payload = { language: tmdbLangInput, testConnection: true };
      if (tmdbKeyInput.trim()) payload.apiKey = tmdbKeyInput.trim();
      const res = await apiFetch('/api/tmdb/config', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      setTmdbCfg((prev) => ({ ...prev, ...res }));
      setTmdbKeyInput('');
      setTmdbMsg({ ok: true, text: 'Conexión con TMDB (themoviedb.org) verificada y guardada.' });
    } catch (err) {
      setTmdbMsg({ ok: false, text: err.message });
    } finally {
      setTmdbBusy(false);
    }
  };

  const handleImportTmdbFromXui = async () => {
    setTmdbBusy(true);
    setTmdbMsg(null);
    try {
      const res = await apiFetch('/api/tmdb/import-from-xui', { method: 'POST' });
      setTmdbCfg((prev) => ({ ...prev, ...res }));
      setTmdbLangInput(res.language || 'es-MX');
      setTmdbMsg({ ok: true, text: `API Key importada desde XUI.one (${res.apiKeyMasked}).` });
    } catch (err) {
      setTmdbMsg({ ok: false, text: err.message });
    } finally {
      setTmdbBusy(false);
    }
  };

  const handleBulkEnrichTmdb = async (overwriteAll = false) => {
    setTmdbBusy(true);
    setTmdbMsg(null);
    try {
      const res = await apiFetch('/api/tmdb/enrich-missing', {
        method: 'POST',
        body: JSON.stringify({ overwriteAll })
      });
      setTmdbMsg({
        ok: true,
        text: `TMDB completado: ${res.moviesUpdated}/${res.moviesChecked} películas y ${res.seriesUpdated}/${res.seriesChecked} series actualizadas con carátulas HD y sinopsis.`
      });
      loadAll();
    } catch (err) {
      setTmdbMsg({ ok: false, text: err.message });
    } finally {
      setTmdbBusy(false);
    }
  };

  // ==================== FOLDER EXPLORER & SYNC ====================
  const loadServerDir = async (dirPath = '/') => {
    try {
      const res = await apiFetch(`/api/vod/folders/browse?path=${encodeURIComponent(dirPath)}`);
      setBrowserData(res);
      setBrowserOpen(true);
    } catch (err) {
      setFolderMsg({ ok: false, text: err.message });
    }
  };

  const handlePreviewFolder = async () => {
    setFolderBusy(true);
    setFolderMsg(null);
    setPreviewScan(null);
    try {
      const res = await apiFetch('/api/vod/folders/preview', {
        method: 'POST',
        body: JSON.stringify({
          folderPath: folderForm.folderPath,
          contentMode: folderForm.contentMode
        })
      });
      setPreviewScan(res);
    } catch (err) {
      setFolderMsg({ ok: false, text: err.message });
    } finally {
      setFolderBusy(false);
    }
  };

  const handleSyncFolderNow = async (customFolder = null) => {
    setFolderBusy(true);
    setFolderMsg(null);
    try {
      const payload = customFolder || folderForm;
      const res = await apiFetch('/api/vod/folders/sync', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      const st = res.stats;
      setFolderMsg({
        ok: true,
        text: `Sincronización exitosa en ${st.rootFolder}: ${st.moviesAdded} películas nuevas, ${st.seriesAdded} series (+${st.episodesAdded} episodios), ${st.tmdbEnriched} carátulas TMDB descargadas (${st.moviesExisting + st.episodesExisting} ya existían).`
      });
      setPreviewScan(null);
      await loadAll();
    } catch (err) {
      setFolderMsg({ ok: false, text: err.message });
    } finally {
      setFolderBusy(false);
    }
  };

  const handleDeleteWatchFolder = async (id) => {
    await apiFetch(`/api/vod/folders/${id}`, { method: 'DELETE' });
    loadAll();
  };

  const filteredMovies = items.filter((v) =>
    !searchFilter ||
    v.title?.toLowerCase().includes(searchFilter.toLowerCase()) ||
    v.genre?.toLowerCase().includes(searchFilter.toLowerCase()) ||
    v.category_name?.toLowerCase().includes(searchFilter.toLowerCase())
  );

  const filteredSeries = seriesList.filter((s) =>
    !searchFilter ||
    s.title?.toLowerCase().includes(searchFilter.toLowerCase()) ||
    s.genre?.toLowerCase().includes(searchFilter.toLowerCase())
  );

  return (
    <div className="space-y-5">
      {/* Header Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-[#0e1526] p-4 rounded-2xl border border-slate-800/80">
        <div className="flex flex-wrap items-center gap-2">
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

          <div className="relative ml-1">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              placeholder="Buscar título o género..."
              className="pl-8 pr-3 py-1.5 rounded-xl bg-[#090e1a] border border-slate-800 text-xs text-white placeholder-slate-500 w-48 focus:outline-none focus:border-indigo-500"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => {
              setFolderMsg(null);
              setPreviewScan(null);
              setFolderModalOpen(true);
            }}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/30 text-xs font-semibold transition"
          >
            <FolderSync className="w-4 h-4" />
            Sincronizar Carpeta ({watchFolders.length})
          </button>

          <button
            onClick={() => {
              setTmdbMsg(null);
              setTmdbModalOpen(true);
            }}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-amber-500/15 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 text-xs font-semibold transition"
          >
            <Sparkles className="w-4 h-4" />
            TMDB Carátulas
            <span
              className={`w-2 h-2 rounded-full ${tmdbCfg.configured ? 'bg-emerald-400' : 'bg-slate-500'}`}
              title={tmdbCfg.configured ? 'TMDB Conectado' : 'TMDB Sin Configurar'}
            />
          </button>

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
      </div>

      {/* MOVIES TAB */}
      {subTab === 'movies' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-5">
          {filteredMovies.map((v) => (
            <div
              key={v.id}
              className="rounded-2xl bg-[#0e1526] border border-slate-800/80 overflow-hidden flex flex-col justify-between group"
            >
              <div>
                <div className="aspect-[2/3] bg-slate-900 relative overflow-hidden">
                  {v.poster_url ? (
                    <img
                      src={v.poster_url}
                      alt={v.title}
                      loading="lazy"
                      className="w-full h-full object-cover group-hover:scale-105 transition duration-300"
                    />
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-slate-600">
                      <Film className="w-10 h-10" />
                      <span className="text-[11px]">Sin carátula</span>
                    </div>
                  )}
                  <div className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded bg-black/80 text-amber-300 text-xs font-bold flex items-center gap-1">
                    <Star className="w-3 h-3 fill-amber-300" /> {v.rating}
                  </div>
                  <div className="absolute bottom-2.5 left-2.5 px-2 py-0.5 rounded bg-indigo-600/90 text-white text-[10px] font-bold uppercase">
                    {v.container_ext} • {v.release_year}
                  </div>
                  {v.source_url?.startsWith('/') && (
                    <div className="absolute top-2.5 left-2.5 px-2 py-0.5 rounded bg-emerald-600/90 text-white text-[10px] font-bold flex items-center gap-1">
                      <HardDrive className="w-3 h-3" /> Disco
                    </div>
                  )}
                </div>

                <div className="p-3.5">
                  <h3 className="font-bold text-white text-sm truncate" title={v.title}>{v.title}</h3>
                  <div className="text-[11px] text-indigo-300 mt-0.5 truncate">
                    {v.category_name || 'Películas'} • {v.genre}
                  </div>
                  <p className="text-xs text-slate-400 mt-1.5 line-clamp-2">{v.plot}</p>
                </div>
              </div>

              <div className="px-3.5 py-2.5 bg-[#090e1a] border-t border-slate-800/80 flex items-center justify-between text-xs">
                <span className="text-slate-400 flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5" /> {Math.round((v.duration_sec || 5400) / 60)} min
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
                    title="Editar / Buscar TMDB"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleDelete(v.id)}
                    className="p-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 text-rose-300"
                    title="Eliminar"
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
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {filteredSeries.map((sr) => {
            const epCount = sr.episodes?.length || 0;
            const seasonsCount = new Set((sr.episodes || []).map((e) => e.season_num)).size;
            return (
              <div
                key={sr.id}
                className="rounded-2xl bg-[#0e1526] border border-slate-800/80 overflow-hidden flex flex-col justify-between group"
              >
                <div>
                  <div className="aspect-[2/3] bg-slate-900 relative overflow-hidden">
                    {sr.poster_url ? (
                      <img
                        src={sr.poster_url}
                        alt={sr.title}
                        loading="lazy"
                        className="w-full h-full object-cover group-hover:scale-105 transition duration-300"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Tv className="w-10 h-10 text-slate-700" />
                      </div>
                    )}
                    <div className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded bg-black/80 text-amber-300 text-xs font-bold flex items-center gap-1">
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
                    Episodios ({epCount})
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

      {/* ==================== MODAL: SINCRONIZAR CARPETA LOCAL (WATCH FOLDER) ==================== */}
      {folderModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-3xl rounded-2xl bg-[#0e1526] border border-slate-800 overflow-hidden">
            <div className="px-5 py-4 bg-[#131c31] border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <FolderSync className="w-5 h-5 text-emerald-400" />
                <div>
                  <h3 className="font-semibold text-white text-sm">
                    Sincronizador de Carpetas de Películas y Series en Disco
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    Escanea recursivamente archivos .mp4, .mkv, .avi, .m4v, .ts — detecta títulos, años, S01E01 y descarga carátulas de TMDB.
                  </p>
                </div>
              </div>
              <button onClick={() => setFolderModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-4 max-h-[82vh] overflow-y-auto text-xs">
              {folderMsg && (
                <div
                  className={`p-3 rounded-xl border ${
                    folderMsg.ok
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                      : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                  }`}
                >
                  {folderMsg.text}
                </div>
              )}

              <div className="p-4 rounded-xl bg-[#090e1a] border border-slate-800 space-y-3.5">
                <div>
                  <label className="block text-slate-300 font-semibold mb-1">
                    Ruta de la Carpeta en el Servidor Ubuntu *
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={folderForm.folderPath}
                      onChange={(e) => setFolderForm({ ...folderForm, folderPath: e.target.value })}
                      placeholder="/mnt/peliculas o /home/xui/content/movies"
                      className="flex-1 px-3 py-2 rounded-xl bg-[#0e1526] border border-slate-700 text-white font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => loadServerDir(folderForm.folderPath || '/')}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold"
                    >
                      <FolderOpen className="w-4 h-4 text-amber-400" />
                      Explorar Disco
                    </button>
                  </div>
                </div>

                {/* Inline Server Directory Browser */}
                {browserOpen && (
                  <div className="p-3 rounded-xl bg-[#0e1526] border border-indigo-500/30 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="font-mono text-indigo-300 truncate">
                        Carpeta actual: <span className="text-white font-bold">{browserData.currentPath}</span>
                        {browserData.mediaFilesInCurrent > 0 && (
                          <span className="ml-2 px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[10px]">
                            {browserData.mediaFilesInCurrent} videos aquí
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setFolderForm({ ...folderForm, folderPath: browserData.currentPath });
                            setBrowserOpen(false);
                          }}
                          className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold"
                        >
                          Usar esta carpeta
                        </button>
                        <button
                          type="button"
                          onClick={() => setBrowserOpen(false)}
                          className="text-slate-400 hover:text-white"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    <div className="max-h-40 overflow-y-auto grid grid-cols-2 sm:grid-cols-3 gap-1.5 pt-1">
                      {browserData.parentPath && (
                        <button
                          type="button"
                          onClick={() => loadServerDir(browserData.parentPath)}
                          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 text-left"
                        >
                          <ArrowUpLeft className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                          <span>.. (Subir nivel)</span>
                        </button>
                      )}
                      {browserData.directories.map((d) => (
                        <button
                          key={d.path}
                          type="button"
                          onClick={() => loadServerDir(d.path)}
                          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#090e1a] hover:bg-indigo-600/20 border border-slate-800 text-slate-200 truncate text-left"
                        >
                          <FolderOpen className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                          <span className="truncate">{d.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-400 mb-1">Modo de Detección</label>
                    <select
                      value={folderForm.contentMode}
                      onChange={(e) => setFolderForm({ ...folderForm, contentMode: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl bg-[#0e1526] border border-slate-700 text-white"
                    >
                      <option value="auto">Automático (Películas + Series S01E01)</option>
                      <option value="movies">Tratar todo como Películas VOD</option>
                      <option value="series">Tratar todo como Episodios de Series</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-slate-400 mb-1">Auto-Sincronización en Segundo Plano</label>
                    <select
                      value={folderForm.autoSyncMinutes}
                      onChange={(e) => setFolderForm({ ...folderForm, autoSyncMinutes: Number(e.target.value) })}
                      className="w-full px-3 py-2 rounded-xl bg-[#0e1526] border border-slate-700 text-white"
                    >
                      <option value={0}>Solo Manual (Bajo demanda)</option>
                      <option value={15}>Cada 15 minutos (Watch Folder)</option>
                      <option value={60}>Cada 1 hora</option>
                      <option value={360}>Cada 6 horas</option>
                      <option value={1440}>Cada 24 horas</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-1">
                  <label className="flex items-center gap-2 p-2.5 rounded-xl bg-[#0e1526] border border-slate-800 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={folderForm.useSubfoldersAsCategories}
                      onChange={(e) => setFolderForm({ ...folderForm, useSubfoldersAsCategories: e.target.checked })}
                    />
                    <span className="text-slate-300">Subcarpetas = Categorías</span>
                  </label>

                  <label className="flex items-center gap-2 p-2.5 rounded-xl bg-[#0e1526] border border-slate-800 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={folderForm.autoTmdb}
                      onChange={(e) => setFolderForm({ ...folderForm, autoTmdb: e.target.checked })}
                    />
                    <span className="text-slate-300">Carátulas automáticas TMDB</span>
                  </label>

                  <label className="flex items-center gap-2 p-2.5 rounded-xl bg-[#0e1526] border border-slate-800 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={folderForm.removeMissing}
                      onChange={(e) => setFolderForm({ ...folderForm, removeMissing: e.target.checked })}
                    />
                    <span className="text-slate-300">Quitar si se borra del disco</span>
                  </label>
                </div>

                <div className="flex flex-wrap justify-end gap-2 pt-2">
                  <button
                    type="button"
                    disabled={folderBusy}
                    onClick={handlePreviewFolder}
                    className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold"
                  >
                    Analizar Vista Previa
                  </button>
                  <button
                    type="button"
                    disabled={folderBusy}
                    onClick={() => handleSyncFolderNow()}
                    className="inline-flex items-center gap-2 px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold"
                  >
                    <RefreshCw className={`w-4 h-4 ${folderBusy ? 'animate-spin' : ''}`} />
                    {folderBusy ? 'Sincronizando...' : 'Sincronizar Carpeta Ahora'}
                  </button>
                </div>
              </div>

              {/* Preview Scan Results */}
              {previewScan && (
                <div className="p-4 rounded-xl bg-[#090e1a] border border-indigo-500/30 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-indigo-300">
                      Archivos detectados en {previewScan.rootFolder}: {previewScan.totalFiles} ({previewScan.moviesCount} películas, {previewScan.episodesCount} episodios)
                    </span>
                  </div>
                  <div className="max-h-44 overflow-y-auto space-y-1">
                    {previewScan.sample.map((f, idx) => (
                      <div key={idx} className="px-2.5 py-1.5 rounded bg-[#0e1526] flex items-center justify-between gap-2">
                        <div className="truncate">
                          <span className="px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 font-mono text-[10px] mr-2 uppercase">
                            {f.kind === 'movie' ? `PELÍCULA • ${f.year}` : `SERIE T${f.seasonNum}E${f.episodeNum}`}
                          </span>
                          <span className="text-white font-semibold">
                            {f.kind === 'movie' ? f.title : `${f.seriesTitle} — ${f.episodeTitle}`}
                          </span>
                          {f.subfolderCategory && (
                            <span className="ml-2 text-emerald-400 text-[11px]">[{f.subfolderCategory}]</span>
                          )}
                        </div>
                        <span className="text-slate-500 font-mono text-[10px] shrink-0">{f.containerExt.toUpperCase()}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Saved Watch Folders */}
              <div className="space-y-2">
                <div className="font-semibold text-slate-300">Carpetas Monitoreadas Guardadas ({watchFolders.length})</div>
                {watchFolders.length === 0 ? (
                  <div className="p-4 rounded-xl bg-[#090e1a] border border-slate-800 text-slate-500 text-center">
                    Aún no has vinculado ninguna carpeta local de películas.
                  </div>
                ) : (
                  watchFolders.map((wf) => (
                    <div
                      key={wf.id}
                      className="p-3 rounded-xl bg-[#090e1a] border border-slate-800 flex flex-wrap items-center justify-between gap-2"
                    >
                      <div>
                        <div className="font-mono text-white font-semibold">{wf.folder_path}</div>
                        <div className="text-[11px] text-slate-400">
                          Modo: {wf.content_mode} • Auto-Sync: {wf.auto_sync_minutes > 0 ? `cada ${wf.auto_sync_minutes} min` : 'Manual'}
                          {wf.last_scan_summary ? ` • Último: ${wf.last_scan_summary}` : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() =>
                            handleSyncFolderNow({
                              folderPath: wf.folder_path,
                              contentMode: wf.content_mode,
                              useSubfoldersAsCategories: Boolean(wf.use_subfolders_as_categories),
                              autoTmdb: Boolean(wf.auto_tmdb),
                              autoSyncMinutes: wf.auto_sync_minutes,
                              removeMissing: Boolean(wf.remove_missing)
                            })
                          }
                          disabled={folderBusy}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white font-semibold"
                        >
                          <RefreshCw className="w-3.5 h-3.5" /> Re-Escanear
                        </button>
                        <button
                          onClick={() => handleDeleteWatchFolder(wf.id)}
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

      {/* ==================== MODAL: CONFIGURACIÓN TMDB & PUENTE IMÁGENES XUI.ONE ==================== */}
      {tmdbModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-xl rounded-2xl bg-[#0e1526] border border-slate-800 overflow-hidden">
            <div className="px-5 py-4 bg-[#131c31] border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-amber-400" />
                <h3 className="font-semibold text-white text-sm">
                  Carátulas TMDB (themoviedb.org) + Puente de Imágenes XUI.one
                </h3>
              </div>
              <button onClick={() => setTmdbModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs">
              {tmdbMsg && (
                <div
                  className={`p-3 rounded-xl border ${
                    tmdbMsg.ok
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                      : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                  }`}
                >
                  {tmdbMsg.text}
                </div>
              )}

              <div className="p-3.5 rounded-xl bg-[#090e1a] border border-slate-800 space-y-1.5 text-slate-300">
                <div className="font-semibold text-white flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  Compatibilidad nativa con XUI.one + TMDB CDN
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  TVLister resuelve automáticamente tanto URLs de <b>image.tmdb.org</b> como carátulas locales de XUI.one guardadas en{' '}
                  <code className="text-indigo-300">/home/xui/wwwdir/images/</code>{' '}
                  ({tmdbCfg.xuiLocalImagesDirExists ? 'Detectado activo en este servidor' : 'Modo lectura automática'}).
                </p>
              </div>

              <form onSubmit={handleSaveTmdbSettings} className="space-y-3">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-slate-300 font-semibold">
                      API Key v3 o Read Access Token v4 de themoviedb.org
                    </label>
                    {tmdbCfg.configured && (
                      <span className="text-emerald-400 font-mono text-[11px]">
                        Activa: {tmdbCfg.apiKeyMasked}
                      </span>
                    )}
                  </div>
                  <input
                    type="password"
                    value={tmdbKeyInput}
                    onChange={(e) => setTmdbKeyInput(e.target.value)}
                    placeholder={tmdbCfg.configured ? 'Dejar vacío para mantener clave actual o pegar nueva...' : 'Ej: a1b2c3d4e5f6... (desde themoviedb.org/settings/api)'}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-300 mb-1">Idioma de Carátulas y Sinopsis</label>
                    <select
                      value={tmdbLangInput}
                      onChange={(e) => setTmdbLangInput(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                    >
                      <option value="es-MX">Español Latino (es-MX)</option>
                      <option value="es-ES">Español España (es-ES)</option>
                      <option value="en-US">Inglés (en-US)</option>
                      <option value="pt-BR">Portugués Brasil (pt-BR)</option>
                    </select>
                  </div>
                  <div className="flex items-end">
                    <button
                      type="button"
                      disabled={tmdbBusy}
                      onClick={handleImportTmdbFromXui}
                      className="w-full px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-indigo-300 font-semibold border border-slate-700"
                    >
                      Importar Clave desde XUI.one
                    </button>
                  </div>
                </div>

                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={tmdbBusy}
                    className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold"
                  >
                    Guardar y Probar TMDB
                  </button>
                </div>
              </form>

              <div className="pt-3 border-t border-slate-800 space-y-2">
                <div className="font-semibold text-slate-200">Escaneo Masivo de Carátulas Faltantes</div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={tmdbBusy || !tmdbCfg.configured}
                    onClick={() => handleBulkEnrichTmdb(false)}
                    className="flex-1 px-4 py-2.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 disabled:opacity-40 text-amber-300 font-semibold border border-amber-500/30"
                  >
                    Completar Películas/Series sin Póster
                  </button>
                  <button
                    type="button"
                    disabled={tmdbBusy || !tmdbCfg.configured}
                    onClick={() => handleBulkEnrichTmdb(true)}
                    className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300 font-semibold"
                  >
                    Refrescar Todo el Catálogo
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ==================== MODAL: CREAR / EDITAR PELÍCULA VOD ==================== */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-2xl rounded-2xl bg-[#0e1526] border border-slate-800 overflow-hidden">
            <div className="px-5 py-4 bg-[#131c31] border-b border-slate-800 flex items-center justify-between">
              <h3 className="font-semibold text-white text-sm">
                {editingId ? 'Editar Película VOD' : 'Nueva Película VOD'}
              </h3>
              <button onClick={() => setModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSave} className="p-5 space-y-3.5 text-xs max-h-[82vh] overflow-y-auto">
              {/* Instant TMDB Autocomplete Bar */}
              <div className="p-3 rounded-xl bg-[#090e1a] border border-amber-500/30 space-y-2">
                <label className="block text-amber-300 font-semibold">
                  Autocompletar Carátula y Datos desde TMDB (themoviedb.org)
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={tmdbQuery}
                    onChange={(e) => setTmdbQuery(e.target.value)}
                    placeholder="Escribe el nombre de la película (ej. Gladiador 2, Deadpool)..."
                    className="flex-1 px-3 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white"
                  />
                  <button
                    type="button"
                    onClick={() => runTmdbLookup('movie', form.title)}
                    disabled={tmdbSearching}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 font-semibold border border-amber-500/30"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    {tmdbSearching ? 'Buscando...' : 'Buscar TMDB'}
                  </button>
                </div>
                {tmdbSearchErr && <div className="text-rose-400 text-[11px]">{tmdbSearchErr}</div>}
                {tmdbResults.length > 0 && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 max-h-48 overflow-y-auto">
                    {tmdbResults.map((r) => (
                      <button
                        key={r.tmdb_id}
                        type="button"
                        onClick={() => applyTmdbToMovie(r)}
                        className="p-1.5 rounded-lg bg-[#0e1526] hover:bg-indigo-600/25 border border-slate-800 text-left flex flex-col gap-1 transition"
                      >
                        {r.poster_url ? (
                          <img src={r.poster_url} alt={r.title} className="w-full aspect-[2/3] object-cover rounded" />
                        ) : (
                          <div className="w-full aspect-[2/3] bg-slate-900 rounded flex items-center justify-center text-slate-600">
                            <Film className="w-6 h-6" />
                          </div>
                        )}
                        <div className="font-semibold text-white truncate text-[11px]">{r.title}</div>
                        <div className="text-[10px] text-amber-300">{r.release_year} • ★ {r.rating}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

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
                <label className="block text-slate-300 mb-1">Ruta en Disco (/mnt/...) o URL Directa MP4 / MKV / M3U8 *</label>
                <input
                  type="text"
                  required
                  value={form.source_url}
                  onChange={(e) => setForm({ ...form, source_url: e.target.value })}
                  placeholder="/mnt/peliculas/Gladiador.mp4 o https://..."
                  className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 mb-1">URL Póster / Carátula (TMDB o XUI)</label>
                  <input
                    type="text"
                    value={form.poster_url}
                    onChange={(e) => setForm({ ...form, poster_url: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">Género</label>
                  <input
                    type="text"
                    value={form.genre}
                    onChange={(e) => setForm({ ...form, genre: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  />
                </div>
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
                    <option value="mkv">mkv</option>
                    <option value="m3u8">m3u8</option>
                    <option value="avi">avi</option>
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

      {/* ==================== MODAL: CREAR / EDITAR SERIE ==================== */}
      {seriesModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-2xl rounded-2xl bg-[#0e1526] border border-slate-800 overflow-hidden">
            <div className="px-5 py-4 bg-[#131c31] border-b border-slate-800 flex items-center justify-between">
              <h3 className="font-semibold text-white text-sm">
                {editingSeriesId ? 'Editar Serie' : 'Crear Nueva Serie (Xtream / TiviMate / Smarters)'}
              </h3>
              <button onClick={() => setSeriesModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSaveSeries} className="p-5 space-y-3.5 text-xs max-h-[82vh] overflow-y-auto">
              {/* Instant TMDB Autocomplete Bar for Series */}
              <div className="p-3 rounded-xl bg-[#090e1a] border border-amber-500/30 space-y-2">
                <label className="block text-amber-300 font-semibold">
                  Autocompletar Serie desde TMDB (themoviedb.org)
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={tmdbQuery}
                    onChange={(e) => setTmdbQuery(e.target.value)}
                    placeholder="Nombre de la serie (ej. Breaking Bad, El Juego del Calamar)..."
                    className="flex-1 px-3 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white"
                  />
                  <button
                    type="button"
                    onClick={() => runTmdbLookup('series', seriesForm.title)}
                    disabled={tmdbSearching}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 font-semibold border border-amber-500/30"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    {tmdbSearching ? 'Buscando...' : 'Buscar TMDB'}
                  </button>
                </div>
                {tmdbSearchErr && <div className="text-rose-400 text-[11px]">{tmdbSearchErr}</div>}
                {tmdbResults.length > 0 && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 max-h-48 overflow-y-auto">
                    {tmdbResults.map((r) => (
                      <button
                        key={r.tmdb_id}
                        type="button"
                        onClick={() => applyTmdbToSeries(r)}
                        className="p-1.5 rounded-lg bg-[#0e1526] hover:bg-violet-600/25 border border-slate-800 text-left flex flex-col gap-1 transition"
                      >
                        {r.poster_url ? (
                          <img src={r.poster_url} alt={r.title} className="w-full aspect-[2/3] object-cover rounded" />
                        ) : (
                          <div className="w-full aspect-[2/3] bg-slate-900 rounded flex items-center justify-center text-slate-600">
                            <Tv className="w-6 h-6" />
                          </div>
                        )}
                        <div className="font-semibold text-white truncate text-[11px]">{r.title}</div>
                        <div className="text-[10px] text-amber-300">{r.release_year} • ★ {r.rating}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

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

      {/* ==================== MODAL: TEMPORADAS & EPISODIOS ==================== */}
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
                    placeholder="Ruta local /mnt/... o URL MP4 / MKV / M3U8 del episodio *"
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
