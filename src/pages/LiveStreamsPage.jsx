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
  Save,
  CheckSquare,
  Layers,
  Image as ImageIcon,
  Film,
  Zap,
  AlertTriangle
} from 'lucide-react';
import { apiFetch, getToken } from '../lib/api.js';

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
  user_agent: 'TVLister/2.3 (MPEG-TS; Linux)',
  offline_slate_mode: 'global',
  offline_slate_url: ''
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

const EMPTY_BULK_EDIT = {
  scope: 'selected', // 'selected' | 'all' | 'category'
  category_filter_id: 'all',
  category_id: '',
  stream_mode: '',
  transcode_profile_id: '',
  bitrate_kbps: '',
  offline_slate_mode: '',
  offline_slate_url: '',
  keep_slate_url: true,
  server_id: '',
  tv_archive_days: '',
  user_agent: '',
  status: ''
};

export default function LiveStreamsPage({ onPreview, onOpenXuiImport }) {
  const [streams, setStreams] = useState([]);
  const [categories, setCategories] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [servers, setServers] = useState([]);
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('all');

  // Multi-selection for Bulk Edit / Bulk Delete / Bulk Actions
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkNotice, setBulkNotice] = useState('');

  // Bulk Edit & Bulk Delete Modals
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [bulkForm, setBulkForm] = useState(EMPTY_BULK_EDIT);
  const [bulkBusy, setBulkBusy] = useState(false);

  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleteScope, setBulkDeleteScope] = useState('selected'); // 'selected' | 'category' | 'all'
  const [bulkDeleteCatId, setBulkDeleteCatId] = useState('all');

  // Offline Slate (Image / Video Loop when no stream) Modal
  const [slateModalOpen, setSlateModalOpen] = useState(false);
  const [slateConfig, setSlateConfig] = useState({
    enabled: true,
    type: 'builtin',
    url: '',
    text: 'SEÑAL EN RECONEXIÓN - VOLVEMOS EN BREVE'
  });
  const [slateFiles, setSlateFiles] = useState([]);
  const [slateUploading, setSlateUploading] = useState(false);
  const [slateNotice, setSlateNotice] = useState('');

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

  // FFmpeg Profiles Create/Edit & Bulk Apply Modal
  const [profilesModalOpen, setProfilesModalOpen] = useState(false);
  const [editingProfId, setEditingProfId] = useState(null);
  const [profForm, setProfForm] = useState(EMPTY_PROF);
  const [profNotice, setProfNotice] = useState('');
  const [bulkCat, setBulkCat] = useState('all');
  const [bulkMode, setBulkMode] = useState('transcode');
  const [bulkProfId, setBulkProfId] = useState(2);

  const loadSlates = async () => {
    try {
      const sl = await apiFetch('/api/slates/config');
      if (sl?.config) setSlateConfig(sl.config);
      if (Array.isArray(sl?.files)) setSlateFiles(sl.files);
    } catch {
      // ignore
    }
  };

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
    setSelectedIds((prev) => {
      const valid = new Set(st.map((x) => x.id));
      return prev.filter((id) => valid.has(id));
    });
  };

  useEffect(() => {
    loadAll();
    loadSlates();
  }, []);

  const findCopyCopy2500Profile = () =>
    profiles.find(
      (p) =>
        p.video_codec === 'copy' &&
        (String(p.name || '').toLowerCase().includes('copy/copy') || String(p.video_bitrate || '') === '2500k')
    ) ||
    profiles.find((p) => p.video_codec === 'copy') ||
    profiles[0];

  const findZeroLatencyCpuProfile = () =>
    profiles.find((p) => p.video_codec === 'libx264' && String(p.name || '').toLowerCase().includes('zero')) ||
    profiles.find((p) => p.video_codec !== 'copy') ||
    profiles[0];

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
      user_agent: s.user_agent || 'TVLister/2.3',
      offline_slate_mode: s.offline_slate_mode || 'global',
      offline_slate_url: s.offline_slate_url || ''
    });
    setModalOpen(true);
  };

  const openBulkEditModal = (defaultScope = null) => {
    const scope = defaultScope || (selectedIds.length > 0 ? 'selected' : 'all');
    setBulkForm({
      ...EMPTY_BULK_EDIT,
      scope,
      category_filter_id: catFilter !== 'all' ? String(catFilter) : categories[0]?.id ? String(categories[0].id) : 'all'
    });
    setBulkEditOpen(true);
  };

  const applyPresetInBulkModal = (presetKey) => {
    const copyProf = findCopyCopy2500Profile();
    const zeroProf = findZeroLatencyCpuProfile();
    const directProf = profiles.find((p) => p.id === 1) || copyProf;

    if (presetKey === 'copy_copy_2500') {
      setBulkForm((prev) => ({
        ...prev,
        stream_mode: 'transcode',
        transcode_profile_id: copyProf ? String(copyProf.id) : '1',
        bitrate_kbps: '2500',
        offline_slate_mode: 'global',
        status: 'running'
      }));
    } else if (presetKey === 'ondemand_copy_2500') {
      setBulkForm((prev) => ({
        ...prev,
        stream_mode: 'ondemand',
        transcode_profile_id: copyProf ? String(copyProf.id) : '1',
        bitrate_kbps: '2500',
        offline_slate_mode: 'global'
      }));
    } else if (presetKey === 'zero_h264_2500') {
      setBulkForm((prev) => ({
        ...prev,
        stream_mode: 'transcode',
        transcode_profile_id: zeroProf ? String(zeroProf.id) : '2',
        bitrate_kbps: '2500',
        offline_slate_mode: 'global',
        status: 'running'
      }));
    } else if (presetKey === 'direct_proxy') {
      setBulkForm((prev) => ({
        ...prev,
        stream_mode: 'direct',
        transcode_profile_id: directProf ? String(directProf.id) : '1',
        bitrate_kbps: '2500',
        offline_slate_mode: 'global',
        status: 'running'
      }));
    }
  };

  const handleQuickCopyCopy2500 = async (targetScope = null) => {
    const copyProf = findCopyCopy2500Profile();
    if (!copyProf) return;
    const scope = targetScope || (selectedIds.length > 0 ? 'selected' : 'all');
    const countLabel = scope === 'all' ? `TODOS los ${streams.length} canales` : `${selectedIds.length} canales seleccionados`;
    if (
      !window.confirm(
        `¿Cambiar ${countLabel} a Copy / Copy (Video Copy + Audio Copy) a 2.5 Mbps (2500 kbps) con respaldo de bucle offline activo?`
      )
    ) {
      return;
    }
    setBulkBusy(true);
    try {
      const res = await apiFetch('/api/streams/bulk-edit', {
        method: 'POST',
        body: JSON.stringify({
          scope,
          ids: selectedIds,
          changes: {
            stream_mode: 'transcode',
            transcode_profile_id: copyProf.id,
            bitrate_kbps: 2500,
            offline_slate_mode: 'global',
            status: 'running'
          }
        })
      });
      setBulkNotice(
        `✅ ${res.updatedCount} canales configurados en Copy/Copy a 2.5 Mbps (2500k) correctamente.`
      );
      setTimeout(() => setBulkNotice(''), 6000);
      await loadAll();
    } catch (err) {
      window.alert(err.message);
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkEditSubmit = async (e) => {
    e.preventDefault();
    setBulkBusy(true);
    try {
      const changes = {};
      if (bulkForm.category_id !== '') changes.category_id = Number(bulkForm.category_id);
      if (bulkForm.stream_mode !== '') changes.stream_mode = bulkForm.stream_mode;
      if (bulkForm.transcode_profile_id !== '') changes.transcode_profile_id = Number(bulkForm.transcode_profile_id);
      if (bulkForm.bitrate_kbps !== '') changes.bitrate_kbps = Number(bulkForm.bitrate_kbps);
      if (bulkForm.offline_slate_mode !== '') changes.offline_slate_mode = bulkForm.offline_slate_mode;
      if (!bulkForm.keep_slate_url || bulkForm.offline_slate_mode === 'custom_image' || bulkForm.offline_slate_mode === 'custom_video') {
        changes.offline_slate_url = bulkForm.offline_slate_url;
      }
      if (bulkForm.server_id !== '') changes.server_id = Number(bulkForm.server_id);
      if (bulkForm.tv_archive_days !== '') changes.tv_archive_days = Number(bulkForm.tv_archive_days);
      if (bulkForm.user_agent !== '') changes.user_agent = bulkForm.user_agent;
      if (bulkForm.status !== '') changes.status = bulkForm.status;

      const res = await apiFetch('/api/streams/bulk-edit', {
        method: 'POST',
        body: JSON.stringify({
          scope: bulkForm.scope,
          ids: selectedIds,
          category_filter_id: bulkForm.category_filter_id,
          changes
        })
      });

      setBulkEditOpen(false);
      setBulkNotice(`✅ Edición masiva completada: ${res.updatedCount} canales actualizados.`);
      setTimeout(() => setBulkNotice(''), 6000);
      await loadAll();
    } catch (err) {
      window.alert(err.message);
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkDeleteConfirm = async () => {
    setBulkBusy(true);
    try {
      const res = await apiFetch('/api/streams/bulk-delete', {
        method: 'POST',
        body: JSON.stringify({
          scope: bulkDeleteScope,
          ids: selectedIds,
          category_filter_id: bulkDeleteCatId
        })
      });
      setBulkDeleteOpen(false);
      setSelectedIds([]);
      setBulkNotice(`🗑️ ${res.deletedCount} canales eliminados permanentemente.`);
      setTimeout(() => setBulkNotice(''), 6000);
      await loadAll();
    } catch (err) {
      window.alert(err.message);
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkStreamAction = async (action, scope = 'selected') => {
    setBulkBusy(true);
    try {
      const res = await apiFetch('/api/streams/bulk-action', {
        method: 'POST',
        body: JSON.stringify({
          scope,
          ids: selectedIds,
          action
        })
      });
      const label = action === 'stop' ? 'detenidos' : action === 'restart' ? 'reiniciados' : 'iniciados';
      setBulkNotice(`⚡ ${res.affectedCount} canales ${label}.`);
      setTimeout(() => setBulkNotice(''), 5000);
      await loadAll();
    } catch (err) {
      window.alert(err.message);
    } finally {
      setBulkBusy(false);
    }
  };

  const handleUploadSlateFile = async (e, targetTarget = 'global') => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSlateUploading(true);
    setSlateNotice('');
    try {
      const token = getToken();
      const resp = await fetch('/api/slates/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-File-Name': file.name,
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: file
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Error subiendo archivo');

      if (Array.isArray(data.files)) setSlateFiles(data.files);

      if (targetTarget === 'global') {
        const nextCfg = {
          ...slateConfig,
          enabled: true,
          type: data.kind,
          url: data.url
        };
        setSlateConfig(nextCfg);
        await apiFetch('/api/slates/config', {
          method: 'PUT',
          body: JSON.stringify(nextCfg)
        });
        setSlateNotice(
          `✅ ${data.kind === 'image' ? 'Imagen' : 'Video'} "${file.name}" activado en bucle para canales sin señal.`
        );
      } else if (targetTarget === 'stream_form') {
        setForm((prev) => ({
          ...prev,
          offline_slate_mode: data.kind === 'image' ? 'custom_image' : 'custom_video',
          offline_slate_url: data.url
        }));
      } else if (targetTarget === 'bulk_form') {
        setBulkForm((prev) => ({
          ...prev,
          offline_slate_mode: data.kind === 'image' ? 'custom_image' : 'custom_video',
          offline_slate_url: data.url,
          keep_slate_url: false
        }));
      }
    } catch (err) {
      setSlateNotice(`❌ ${err.message}`);
    } finally {
      setSlateUploading(false);
      e.target.value = '';
    }
  };

  const handleSaveGlobalSlate = async (e) => {
    e.preventDefault();
    setSlateNotice('');
    try {
      const res = await apiFetch('/api/slates/config', {
        method: 'PUT',
        body: JSON.stringify(slateConfig)
      });
      if (res?.config) setSlateConfig(res.config);
      setSlateNotice('✅ Señal de respaldo en bucle guardada y activa en todos los canales.');
    } catch (err) {
      setSlateNotice(`❌ ${err.message}`);
    }
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

  const filteredIds = filtered.map((s) => s.id);
  const allFilteredSelected =
    filteredIds.length > 0 && filteredIds.every((id) => selectedIds.includes(id));

  const toggleSelectStream = (id) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const toggleSelectAllFiltered = () => {
    if (allFilteredSelected) {
      const fSet = new Set(filteredIds);
      setSelectedIds((prev) => prev.filter((id) => !fSet.has(id)));
    } else {
      setSelectedIds((prev) => Array.from(new Set([...prev, ...filteredIds])));
    }
  };

  const selectAllEntireCatalog = () => {
    setSelectedIds(streams.map((s) => s.id));
  };

  const countForBulkDelete = () => {
    if (bulkDeleteScope === 'all') return streams.length;
    if (bulkDeleteScope === 'category') {
      return bulkDeleteCatId === 'all'
        ? streams.length
        : streams.filter((s) => String(s.category_id) === String(bulkDeleteCatId)).length;
    }
    return selectedIds.length;
  };

  return (
    <div className="space-y-4">
      {/* Main Toolbar */}
      <div className="flex flex-col gap-3 bg-[#0e1526] p-4 rounded-2xl border border-slate-800/80">
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
          <div className="flex flex-1 flex-wrap items-center gap-2.5">
            <div className="relative flex-1 min-w-[200px] max-w-sm">
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
              <option value="all">Todas las categorías ({streams.length})</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>

            {streams.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  selectedIds.length === streams.length ? setSelectedIds([]) : selectAllEntireCatalog()
                }
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#090e1a] hover:bg-slate-800 border border-slate-700/80 text-xs text-slate-200 font-medium transition"
              >
                <CheckSquare className="w-3.5 h-3.5 text-indigo-400" />
                {selectedIds.length === streams.length
                  ? 'Deseleccionar todos'
                  : `Seleccionar todos (${streams.length})`}
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Offline Video / Image Loop Button */}
            <button
              onClick={() => {
                setSlateNotice('');
                loadSlates();
                setSlateModalOpen(true);
              }}
              className={`inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold border transition ${
                slateConfig.enabled
                  ? 'bg-violet-500/15 hover:bg-violet-500/25 text-violet-300 border-violet-500/35'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'
              }`}
              title="Configurar imagen o video en bucle cuando un canal no tenga señal"
            >
              <Film className="w-4 h-4" />
              Bucle Sin Stream {slateConfig.enabled ? '• ON' : '• OFF'}
            </button>

            {/* Bulk Edit Button */}
            <button
              onClick={() => openBulkEditModal()}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/35 text-xs font-semibold transition"
            >
              <Layers className="w-4 h-4" />
              Edición Masiva
            </button>

            {/* Bulk Delete Button */}
            <button
              onClick={() => {
                setBulkDeleteScope(selectedIds.length > 0 ? 'selected' : catFilter !== 'all' ? 'category' : 'all');
                setBulkDeleteCatId(catFilter !== 'all' ? String(catFilter) : categories[0]?.id ? String(categories[0].id) : 'all');
                setBulkDeleteOpen(true);
              }}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/35 text-xs font-semibold transition"
            >
              <Trash2 className="w-4 h-4" />
              Borrar Masivo
            </button>

            <button
              onClick={() => {
                setProfNotice('');
                const copyProf = findCopyCopy2500Profile();
                if (copyProf) setBulkProfId(copyProf.id);
                setProfilesModalOpen(true);
              }}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 text-xs font-semibold transition"
            >
              <Sliders className="w-4 h-4" />
              Perfiles FFmpeg (2.5M)
            </button>

            {onOpenXuiImport && (
              <button
                onClick={onOpenXuiImport}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 text-xs font-semibold transition"
              >
                <Database className="w-3.5 h-3.5" />
                BD XUI.one
              </button>
            )}

            <button
              onClick={() => setImportOpen(true)}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-slate-700 text-xs font-semibold transition"
            >
              <Upload className="w-3.5 h-3.5" />
              M3U
            </button>

            <button
              onClick={openCreate}
              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-lg shadow-indigo-600/20 transition"
            >
              <Plus className="w-4 h-4" />
              Nuevo Canal
            </button>
          </div>
        </div>

        {/* Instant 1-Click Preset & Bulk Notice Banner */}
        {bulkNotice && (
          <div className="px-3.5 py-2.5 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs font-medium flex items-center justify-between">
            <span>{bulkNotice}</span>
            <button onClick={() => setBulkNotice('')} className="text-emerald-200 hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {/* Contextual Multi-Select Action Bar */}
      {selectedIds.length > 0 && (
        <div className="sticky top-2 z-30 p-3.5 rounded-2xl bg-[#131c31]/95 backdrop-blur border border-indigo-500/50 shadow-xl flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="px-2.5 py-1 rounded-lg bg-indigo-600 text-white font-bold">
              {selectedIds.length} seleccionado(s)
            </span>
            {selectedIds.length < streams.length && (
              <button
                onClick={selectAllEntireCatalog}
                className="text-indigo-300 hover:text-white underline font-medium"
              >
                Seleccionar los {streams.length} canales completos
              </button>
            )}
            <button
              onClick={() => setSelectedIds([])}
              className="text-slate-400 hover:text-white"
            >
              Limpiar selección
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              disabled={bulkBusy}
              onClick={() => handleQuickCopyCopy2500('selected')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/40 font-semibold transition"
              title="Pasar seleccionados a Copy Video + Copy Audio @ 2.5 Mbps"
            >
              <Zap className="w-3.5 h-3.5 text-amber-400" />
              Pasar a Copy/Copy 2.5M
            </button>

            <button
              disabled={bulkBusy}
              onClick={() => openBulkEditModal('selected')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-semibold transition"
            >
              <Edit3 className="w-3.5 h-3.5" />
              Editar ({selectedIds.length})
            </button>

            <button
              disabled={bulkBusy}
              onClick={() => handleBulkStreamAction('start', 'selected')}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/30 font-semibold"
            >
              <Play className="w-3.5 h-3.5" />
              Iniciar
            </button>

            <button
              disabled={bulkBusy}
              onClick={() => handleBulkStreamAction('restart', 'selected')}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/30 font-semibold"
            >
              <RotateCw className="w-3.5 h-3.5" />
              Reiniciar
            </button>

            <button
              disabled={bulkBusy}
              onClick={() => handleBulkStreamAction('stop', 'selected')}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-amber-300 border border-slate-700 font-semibold"
            >
              <Square className="w-3.5 h-3.5" />
              Detener
            </button>

            <button
              disabled={bulkBusy}
              onClick={() => {
                setBulkDeleteScope('selected');
                setBulkDeleteOpen(true);
              }}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-semibold transition"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Eliminar ({selectedIds.length})
            </button>
          </div>
        </div>
      )}

      {/* Streams Table */}
      <div className="rounded-2xl bg-[#0e1526] border border-slate-800/80 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#090e1a] text-slate-400 uppercase tracking-wider">
              <tr>
                <th className="px-3 py-3 w-10">
                  <input
                    type="checkbox"
                    checked={allFilteredSelected}
                    onChange={toggleSelectAllFiltered}
                    className="rounded accent-indigo-500 cursor-pointer"
                    title="Seleccionar todos los filtrados"
                  />
                </th>
                <th className="px-3 py-3">ID</th>
                <th className="px-4 py-3">Canal</th>
                <th className="px-4 py-3">Categoría</th>
                <th className="px-4 py-3">Modo & Perfil</th>
                <th className="px-4 py-3">Respaldo Bucle</th>
                <th className="px-4 py-3">Catchup DVR</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3 text-right">Controles</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-slate-500">
                    No hay canales en vivo en esta vista.
                  </td>
                </tr>
              ) : (
                filtered.map((s) => {
                  const isChecked = selectedIds.includes(s.id);
                  const slateMode = s.offline_slate_mode || 'global';
                  return (
                    <tr
                      key={s.id}
                      className={`transition ${
                        isChecked ? 'bg-indigo-950/25 hover:bg-indigo-950/35' : 'hover:bg-slate-800/30'
                      }`}
                    >
                      <td className="px-3 py-3">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleSelectStream(s.id)}
                          className="rounded accent-indigo-500 cursor-pointer"
                        />
                      </td>
                      <td className="px-3 py-3 font-mono text-slate-400">#{s.id}</td>
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
                            <div className="text-[11px] text-slate-500 font-mono truncate max-w-[240px]">
                              {s.source_url}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-300">{s.category_name || 'General'}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          <span className="px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 uppercase text-[10px] font-bold">
                            {s.stream_mode}
                          </span>
                          {s.profile_video_codec === 'copy' && s.stream_mode !== 'direct' && (
                            <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-mono text-[9px] font-bold">
                              COPY/COPY
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-400 mt-0.5">
                          {s.profile_name || 'Direct Stream'} •{' '}
                          {s.stream_mode === 'transcode' &&
                          s.profile_video_bitrate &&
                          s.profile_video_bitrate !== 'source'
                            ? s.profile_video_bitrate
                            : `${s.bitrate_kbps || 2500} kbps`}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {slateMode === 'disabled' ? (
                          <span className="text-[10px] text-slate-500">Desactivado</span>
                        ) : slateMode === 'custom_image' || slateMode === 'custom_video' ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-violet-500/15 border border-violet-500/30 text-violet-300 text-[10px] font-semibold">
                            {slateMode === 'custom_image' ? (
                              <ImageIcon className="w-3 h-3" />
                            ) : (
                              <Film className="w-3 h-3" />
                            )}
                            Propio
                          </span>
                        ) : (
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium ${
                              slateConfig.enabled
                                ? 'bg-violet-500/10 border border-violet-500/25 text-violet-300'
                                : 'bg-slate-800 text-slate-500'
                            }`}
                          >
                            {slateConfig.enabled ? `Bucle (${slateConfig.type})` : 'Global OFF'}
                          </span>
                        )}
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
                            title="Previsualizar Stream (o Bucle Offline si está sin señal)"
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
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ==================== MODAL: EDICIÓN MASIVA DE CANALES ==================== */}
      {bulkEditOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-2xl rounded-2xl bg-[#0e1526] border border-slate-800 shadow-2xl overflow-hidden">
            <div className="px-5 py-4 bg-[#131c31] border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Layers className="w-5 h-5 text-cyan-400" />
                <div>
                  <h3 className="text-sm font-bold text-white">Edición Masiva de Canales en Vivo</h3>
                  <p className="text-[11px] text-slate-400">
                    Solo se modificarán los campos donde elijas un valor distinto a &ldquo;Sin cambios&rdquo;.
                  </p>
                </div>
              </div>
              <button onClick={() => setBulkEditOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleBulkEditSubmit} className="p-5 space-y-4 max-h-[82vh] overflow-y-auto text-xs">
              {/* 1-Click Quick Presets */}
              <div className="p-3.5 rounded-xl bg-[#090e1a] border border-amber-500/30 space-y-2">
                <div className="text-[11px] font-bold text-amber-300 flex items-center gap-1.5">
                  <Zap className="w-3.5 h-3.5" />
                  Plantillas Rápidas de 1 Clic (pre-rellenan los campos de abajo):
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => applyPresetInBulkModal('copy_copy_2500')}
                    className="p-2.5 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-left transition"
                  >
                    <div className="font-bold text-amber-200">⚡ Copy / Copy a 2.5 Mbps (Recomendado +100 canales)</div>
                    <div className="text-[10px] text-slate-300 mt-0.5">
                      Video Copy + Audio Copy • HLS 2s • 2500 kbps • ~0% CPU + Bucle Offline ON
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => applyPresetInBulkModal('ondemand_copy_2500')}
                    className="p-2.5 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-left transition"
                  >
                    <div className="font-bold text-emerald-300">🌱 On-Demand Copy / Copy 2.5 Mbps</div>
                    <div className="text-[10px] text-slate-300 mt-0.5">
                      Ahorra ancho de banda upstream cuando nadie mira el canal • 2500 kbps
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => applyPresetInBulkModal('zero_h264_2500')}
                    className="p-2.5 rounded-xl bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/35 text-left transition"
                  >
                    <div className="font-bold text-indigo-200">🎬 Zero Latency H.264 2.5 Mbps (Transcode)</div>
                    <div className="text-[10px] text-slate-300 mt-0.5">
                      Recodifica video a H.264 2500k CBR + AAC 128k (usa CPU/GPU)
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => applyPresetInBulkModal('direct_proxy')}
                    className="p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-left transition"
                  >
                    <div className="font-bold text-slate-200">🚀 Direct Stream Shield Proxy</div>
                    <div className="text-[10px] text-slate-400 mt-0.5">
                      Proxy directo sin proceso FFmpeg local + Bucle Offline automático
                    </div>
                  </button>
                </div>
              </div>

              {/* Target Scope */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3.5 rounded-xl bg-[#090e1a] border border-slate-800">
                <div>
                  <label className="block text-slate-300 mb-1 font-semibold">¿A qué canales aplicar?</label>
                  <select
                    value={bulkForm.scope}
                    onChange={(e) => setBulkForm({ ...bulkForm, scope: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#0e1526] border border-slate-700 text-white font-semibold"
                  >
                    <option value="all">Todos los canales del panel ({streams.length})</option>
                    <option value="selected" disabled={selectedIds.length === 0}>
                      Canales marcados con check ({selectedIds.length})
                    </option>
                    <option value="category">Todos los de una Categoría</option>
                  </select>
                </div>

                {bulkForm.scope === 'category' && (
                  <div>
                    <label className="block text-slate-300 mb-1 font-semibold">Categoría Objetivo</label>
                    <select
                      value={bulkForm.category_filter_id}
                      onChange={(e) => setBulkForm({ ...bulkForm, category_filter_id: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl bg-[#0e1526] border border-slate-700 text-white"
                    >
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {/* Editable Fields */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 mb-1">Modo de Transmisión</label>
                  <select
                    value={bulkForm.stream_mode}
                    onChange={(e) => setBulkForm({ ...bulkForm, stream_mode: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    <option value="">— Mantener sin cambios —</option>
                    <option value="transcode">Transcodificación / Remux Activo (FFmpeg HLS)</option>
                    <option value="ondemand">On-Demand (Al conectar cliente)</option>
                    <option value="direct">Direct Stream Proxy</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-300 mb-1">Perfil FFmpeg</label>
                  <select
                    value={bulkForm.transcode_profile_id}
                    onChange={(e) => setBulkForm({ ...bulkForm, transcode_profile_id: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    <option value="">— Mantener sin cambios —</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.video_codec}/{p.audio_codec} • {p.video_bitrate})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-slate-300 mb-1">Bitrate Objetivo (kbps — 2.5 Megas = 2500)</label>
                  <input
                    type="number"
                    min="200"
                    max="30000"
                    step="100"
                    value={bulkForm.bitrate_kbps}
                    onChange={(e) => setBulkForm({ ...bulkForm, bitrate_kbps: e.target.value })}
                    placeholder="Sin cambios (ej. escribe 2500)"
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                  />
                </div>

                <div>
                  <label className="block text-slate-300 mb-1">Mover a Categoría</label>
                  <select
                    value={bulkForm.category_id}
                    onChange={(e) => setBulkForm({ ...bulkForm, category_id: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    <option value="">— Mantener sin cambios —</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-slate-300 mb-1">Si NO hay Stream (Bucle de Imagen / Video)</label>
                  <select
                    value={bulkForm.offline_slate_mode}
                    onChange={(e) => setBulkForm({ ...bulkForm, offline_slate_mode: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    <option value="">— Mantener sin cambios —</option>
                    <option value="global">Usar Bucle Global (Imagen o Video en bucle)</option>
                    <option value="custom_image">Imagen en Bucle Personalizada</option>
                    <option value="custom_video">Video en Bucle Personalizado</option>
                    <option value="disabled">Desactivar respaldo (dar error 503)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-300 mb-1">Estado del Canal</label>
                  <select
                    value={bulkForm.status}
                    onChange={(e) => setBulkForm({ ...bulkForm, status: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    <option value="">— Mantener sin cambios —</option>
                    <option value="running">Activo / En Línea (running)</option>
                    <option value="ondemand_idle">On-Demand en espera</option>
                    <option value="stopped">Detenido (stopped)</option>
                  </select>
                </div>

                {(bulkForm.offline_slate_mode === 'custom_image' ||
                  bulkForm.offline_slate_mode === 'custom_video') && (
                  <div className="sm:col-span-2 p-3 rounded-xl bg-[#090e1a] border border-violet-500/30 space-y-2">
                    <label className="block text-violet-300 font-medium">
                      URL o Archivo para el Bucle Personalizado (Imagen PNG/JPG o Video MP4/TS)
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="text"
                        value={bulkForm.offline_slate_url}
                        onChange={(e) =>
                          setBulkForm({
                            ...bulkForm,
                            offline_slate_url: e.target.value,
                            keep_slate_url: false
                          })
                        }
                        placeholder="/slates/mi_video.mp4 o https://..."
                        className="flex-1 px-3 py-2 rounded-xl bg-[#0e1526] border border-slate-700 text-white font-mono"
                      />
                      <label className="px-3 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-semibold cursor-pointer">
                        {slateUploading ? 'Subiendo...' : 'Subir Archivo'}
                        <input
                          type="file"
                          accept=".png,.jpg,.jpeg,.webp,.mp4,.ts,.mkv,.mov"
                          onChange={(e) => handleUploadSlateFile(e, 'bulk_form')}
                          className="hidden"
                        />
                      </label>
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-slate-300 mb-1">Servidor / Nodo</label>
                  <select
                    value={bulkForm.server_id}
                    onChange={(e) => setBulkForm({ ...bulkForm, server_id: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    <option value="">— Mantener sin cambios —</option>
                    {servers.map((srv) => (
                      <option key={srv.id} value={srv.id}>
                        {srv.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-slate-300 mb-1">User-Agent Upstream</label>
                  <input
                    type="text"
                    value={bulkForm.user_agent}
                    onChange={(e) => setBulkForm({ ...bulkForm, user_agent: e.target.value })}
                    placeholder="Sin cambios"
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                  />
                </div>
              </div>

              <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setBulkEditOpen(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={bulkBusy}
                  className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-semibold shadow-lg"
                >
                  <Save className="w-4 h-4" />
                  {bulkBusy ? 'Aplicando cambios...' : 'Aplicar Edición Masiva'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ==================== MODAL: BORRADO MASIVO ==================== */}
      {bulkDeleteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-md rounded-2xl bg-[#0e1526] border border-rose-500/40 shadow-2xl overflow-hidden">
            <div className="px-5 py-4 bg-rose-950/30 border-b border-rose-500/30 flex items-center justify-between">
              <h3 className="text-sm font-bold text-rose-200 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-400" />
                Borrado Masivo de Canales
              </h3>
              <button onClick={() => setBulkDeleteOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs">
              <div>
                <label className="block text-slate-300 mb-1.5 font-semibold">Selecciona qué deseas eliminar:</label>
                <select
                  value={bulkDeleteScope}
                  onChange={(e) => setBulkDeleteScope(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-semibold"
                >
                  <option value="selected" disabled={selectedIds.length === 0}>
                    Canales seleccionados con check ({selectedIds.length})
                  </option>
                  <option value="category">Todos los canales de una Categoría</option>
                  <option value="all">TODOS los canales en vivo ({streams.length})</option>
                </select>
              </div>

              {bulkDeleteScope === 'category' && (
                <div>
                  <label className="block text-slate-300 mb-1">Categoría a vaciar</label>
                  <select
                    value={bulkDeleteCatId}
                    onChange={(e) => setBulkDeleteCatId(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200">
                Se detendrán los procesos FFmpeg/DVR y se eliminarán permanentemente{' '}
                <strong className="text-white underline">{countForBulkDelete()} canal(es)</strong>. Esta acción no se puede deshacer.
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setBulkDeleteOpen(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={bulkBusy || countForBulkDelete() === 0}
                  onClick={handleBulkDeleteConfirm}
                  className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white font-bold"
                >
                  <Trash2 className="w-4 h-4" />
                  {bulkBusy ? 'Eliminando...' : `Eliminar ${countForBulkDelete()} Canal(es)`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ==================== MODAL: SEÑAL OFFLINE (IMAGEN O VIDEO EN BUCLE) ==================== */}
      {slateModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-2xl rounded-2xl bg-[#0e1526] border border-slate-800 shadow-2xl overflow-hidden">
            <div className="px-5 py-4 bg-[#131c31] border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Film className="w-5 h-5 text-violet-400" />
                <div>
                  <h3 className="text-sm font-bold text-white">
                    Señal de Respaldo Automática — Imagen o Video en Bucle (2.5 Mbps)
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    Cuando un canal se cae, queda sin stream o el encoder OBS está apagado, reproduce esta imagen o video en bucle automáticamente.
                  </p>
                </div>
              </div>
              <button onClick={() => setSlateModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveGlobalSlate} className="p-5 space-y-4 max-h-[82vh] overflow-y-auto text-xs">
              {slateNotice && (
                <div className="p-3 rounded-xl bg-slate-900 border border-violet-500/40 text-violet-200 font-medium">
                  {slateNotice}
                </div>
              )}

              <label className="flex items-center justify-between p-3.5 rounded-xl bg-[#090e1a] border border-slate-800 cursor-pointer">
                <div>
                  <div className="font-bold text-white">Activar Bucle Automático cuando NO hay Stream</div>
                  <div className="text-[11px] text-slate-400">
                    Evita pantalla negra o error de reproducción en TiviMate, Smarters, VLC y WebTV; al volver la señal real retoma el canal solo.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={slateConfig.enabled}
                  onChange={(e) => setSlateConfig({ ...slateConfig, enabled: e.target.checked })}
                  className="w-5 h-5 rounded accent-violet-500"
                />
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                {[
                  {
                    id: 'image',
                    title: '🖼️ Imagen en Bucle',
                    desc: 'PNG / JPG / WEBP fijo en loop + pista audio AAC'
                  },
                  {
                    id: 'video',
                    title: '🎬 Video en Bucle',
                    desc: 'Clip MP4 / TS / MKV repitiéndose sin fin'
                  },
                  {
                    id: 'builtin',
                    title: '📺 Barras HD Internas',
                    desc: 'Señal SMPTE HD generada sin subir archivos'
                  }
                ].map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setSlateConfig({ ...slateConfig, type: opt.id })}
                    className={`p-3 rounded-xl border text-left transition ${
                      slateConfig.type === opt.id
                        ? 'bg-violet-600/20 border-violet-500 text-white'
                        : 'bg-[#090e1a] border-slate-800 text-slate-400 hover:text-white'
                    }`}
                  >
                    <div className="font-bold text-xs">{opt.title}</div>
                    <div className="text-[10px] text-slate-400 mt-1">{opt.desc}</div>
                  </button>
                ))}
              </div>

              {slateConfig.type !== 'builtin' && (
                <div className="p-4 rounded-xl bg-[#090e1a] border border-slate-800 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="font-semibold text-slate-200">
                      Subir {slateConfig.type === 'image' ? 'Imagen (PNG, JPG, WEBP)' : 'Video Corto (MP4, TS, MKV)'} desde tu PC:
                    </label>
                    <label className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-semibold cursor-pointer transition">
                      <Upload className="w-3.5 h-3.5" />
                      {slateUploading ? 'Subiendo archivo...' : 'Subir Imagen o Video'}
                      <input
                        type="file"
                        accept=".png,.jpg,.jpeg,.webp,.mp4,.ts,.mkv,.mov"
                        onChange={(e) => handleUploadSlateFile(e, 'global')}
                        className="hidden"
                      />
                    </label>
                  </div>

                  <div>
                    <label className="block text-slate-400 mb-1">
                      O escribe ruta local del servidor / URL directa:
                    </label>
                    <input
                      type="text"
                      value={slateConfig.url}
                      onChange={(e) => setSlateConfig({ ...slateConfig, url: e.target.value })}
                      placeholder="/slates/logo_canal.png o /opt/videos/promo_bucle.mp4"
                      className="w-full px-3 py-2 rounded-xl bg-[#0e1526] border border-slate-700 text-white font-mono"
                    />
                  </div>

                  {/* Live Preview of Current Uploaded Image or Video */}
                  {slateConfig.url && (
                    <div className="p-3 rounded-xl bg-[#0e1526] border border-slate-800">
                      <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-2">
                        Vista previa del recurso en bucle actual:
                      </div>
                      {slateConfig.type === 'image' ? (
                        <img
                          src={slateConfig.url}
                          alt="Slate Preview"
                          className="max-h-40 rounded-lg border border-slate-700 mx-auto object-contain"
                        />
                      ) : (
                        <video
                          src={slateConfig.url}
                          controls
                          loop
                          muted
                          className="max-h-44 rounded-lg border border-slate-700 mx-auto"
                        />
                      )}
                    </div>
                  )}

                  {/* Library of Previously Uploaded Slate Files */}
                  {slateFiles.length > 0 && (
                    <div className="space-y-1.5">
                      <div className="text-[11px] font-semibold text-slate-400">
                        Archivos subidos en el servidor (clic para usar):
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-36 overflow-y-auto">
                        {slateFiles.map((f) => (
                          <div
                            key={f.fileName}
                            className={`p-2 rounded-lg border flex items-center justify-between gap-2 ${
                              slateConfig.url === f.url
                                ? 'bg-violet-500/15 border-violet-500/50 text-white'
                                : 'bg-[#0e1526] border-slate-800 text-slate-300'
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() =>
                                setSlateConfig({ ...slateConfig, type: f.kind, url: f.url, enabled: true })
                              }
                              className="flex items-center gap-1.5 truncate text-left flex-1"
                            >
                              {f.kind === 'image' ? (
                                <ImageIcon className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                              ) : (
                                <Film className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                              )}
                              <span className="truncate">{f.fileName}</span>
                              <span className="text-[10px] text-slate-500 shrink-0">({f.sizeKb} KB)</span>
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
                                const res = await apiFetch(
                                  `/api/slates/files/${encodeURIComponent(f.fileName)}`,
                                  { method: 'DELETE' }
                                );
                                if (Array.isArray(res?.files)) setSlateFiles(res.files);
                              }}
                              className="p-1 text-rose-400 hover:text-rose-300"
                              title="Borrar archivo"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="pt-3 border-t border-slate-800 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setSlateModalOpen(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300"
                >
                  Cerrar
                </button>
                <button
                  type="submit"
                  className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-semibold"
                >
                  <Save className="w-4 h-4" />
                  Guardar Configuración de Bucle
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add / Edit Single Stream Modal */}
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
                    <option value="transcode">Transcodificación / Remux Activo</option>
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

              {/* Per-Stream Offline Loop Slate */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-3 rounded-xl bg-[#090e1a] border border-slate-800">
                <div>
                  <label className="block text-violet-300 mb-1 font-medium">
                    Si NO hay Stream (Bucle Imagen / Video)
                  </label>
                  <select
                    value={form.offline_slate_mode}
                    onChange={(e) => setForm({ ...form, offline_slate_mode: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#0e1526] border border-slate-700 text-white"
                  >
                    <option value="global">Usar Bucle Global del Panel</option>
                    <option value="custom_image">Imagen Propia en Bucle</option>
                    <option value="custom_video">Video Propio en Bucle</option>
                    <option value="disabled">Desactivado</option>
                  </select>
                </div>

                {(form.offline_slate_mode === 'custom_image' ||
                  form.offline_slate_mode === 'custom_video') && (
                  <div>
                    <label className="block text-slate-300 mb-1 font-medium">
                      Archivo / URL del Bucle Propio
                    </label>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={form.offline_slate_url}
                        onChange={(e) => setForm({ ...form, offline_slate_url: e.target.value })}
                        placeholder="/slates/cartel.png o .mp4"
                        className="flex-1 px-2.5 py-2 rounded-xl bg-[#0e1526] border border-slate-700 text-white font-mono"
                      />
                      <label className="px-2.5 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-semibold cursor-pointer shrink-0">
                        Subir
                        <input
                          type="file"
                          accept=".png,.jpg,.jpeg,.webp,.mp4,.ts,.mkv,.mov"
                          onChange={(e) => handleUploadSlateFile(e, 'stream_form')}
                          className="hidden"
                        />
                      </label>
                    </div>
                  </div>
                )}
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
                    Gestor de Perfiles FFmpeg — Copy/Copy & Zero Latency 2.5 Mbps (2500k)
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
                      <button
                        type="button"
                        onClick={() =>
                          setProfForm({
                            name: 'Copy/Copy Remux 2.5 Mbps (Zero CPU)',
                            video_codec: 'copy',
                            audio_codec: 'copy',
                            video_bitrate: '2500k',
                            audio_bitrate: 'copy',
                            resolution: 'source',
                            preset: 'none',
                            hwaccel: 'none',
                            extra_flags: '-fflags +genpts+igndts+nobuffer -max_muxing_queue_size 1024'
                          })
                        }
                        className="px-2 py-0.5 rounded font-mono text-[10px] border bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                      >
                        Copy/Copy 2.5M
                      </button>
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
                                profForm.video_codec === 'copy'
                                  ? '-fflags +genpts+igndts+nobuffer -max_muxing_queue_size 1024'
                                  : profForm.video_codec === 'h264_nvenc'
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
                      placeholder="Copy/Copy Remux 2.5 Mbps (Zero CPU)"
                      className="w-full px-3 py-2 rounded-xl bg-[#0e1526] border border-slate-700 text-white"
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-2.5">
                    <div>
                      <label className="block text-slate-400 mb-1">Codec Video</label>
                      <select
                        value={profForm.video_codec}
                        onChange={(e) => {
                          const vc = e.target.value;
                          setProfForm({
                            ...profForm,
                            video_codec: vc,
                            audio_codec: vc === 'copy' ? 'copy' : profForm.audio_codec === 'copy' ? 'aac' : profForm.audio_codec,
                            hwaccel: vc === 'h264_nvenc' ? 'nvenc' : vc === 'h264_qsv' ? 'qsv' : 'none'
                          });
                        }}
                        className="w-full px-3 py-2 rounded-xl bg-[#0e1526] border border-slate-700 text-white"
                      >
                        <option value="copy">Copy (Sin recodificar)</option>
                        <option value="libx264">CPU libx264</option>
                        <option value="h264_nvenc">NVIDIA NVENC</option>
                        <option value="h264_qsv">Intel QSV</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Codec Audio</label>
                      <select
                        value={profForm.audio_codec}
                        onChange={(e) => setProfForm({ ...profForm, audio_codec: e.target.value })}
                        className="w-full px-3 py-2 rounded-xl bg-[#0e1526] border border-slate-700 text-white"
                      >
                        <option value="copy">Copy (Original)</option>
                        <option value="aac">AAC Estéreo</option>
                        <option value="mp3">MP3</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Bitrate (2.5M = 2500k)</label>
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
                        <option value="none">none (Copy)</option>
                        <option value="ultrafast">ultrafast</option>
                        <option value="superfast">superfast</option>
                        <option value="veryfast">veryfast</option>
                        <option value="faster">faster</option>
                        <option value="p2">NVENC p2</option>
                        <option value="p4">NVENC p4</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Audio Bitrate</label>
                      <select
                        value={profForm.audio_bitrate}
                        onChange={(e) => setProfForm({ ...profForm, audio_bitrate: e.target.value })}
                        className="w-full px-2.5 py-2 rounded-xl bg-[#0e1526] border border-slate-700 text-white font-mono"
                      >
                        <option value="copy">copy</option>
                        <option value="96k">96k</option>
                        <option value="128k">128k</option>
                        <option value="160k">160k</option>
                        <option value="source">source</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-slate-400 mb-1">Flags Extra FFmpeg</label>
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
                          {p.video_codec}/{p.audio_codec} • {p.video_bitrate} • {p.resolution}
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
                    <option value="transcode">Transcodificación / Remux Activo</option>
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
