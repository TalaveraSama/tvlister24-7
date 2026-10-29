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
  AlertTriangle,
  Monitor,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronsUp,
  ChevronsDown,
  GripVertical,
  Volume2,
  Globe,
  ArrowLeftRight,
  Filter,
  Wrench
} from 'lucide-react';
import { apiFetch, getToken } from '../lib/api.js';
import {
  Chip,
  Dropdown,
  EmptyState,
  IconAction,
  Pager,
  RowMenu,
  Segmented,
  StatusPill,
  sourceHost
} from '../components/StreamsSkin.jsx';

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
  offline_slate_mode: 'disabled',
  offline_slate_url: '',
  audio_leveling_mode: 'global'
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
  audio_leveling_mode: '',
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
  const [resFilter, setResFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all'); // 'all' | 'online' | 'idle' | 'stopped' | 'source2'
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [groupByCat, setGroupByCat] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [clockNow, setClockNow] = useState(() => Date.now());

  // Auto-Resolution Classifier (SD/480p/540p -> 1M, HD 720p -> 2.5M, FHD 1080p -> 3M)
  const [autoResOpen, setAutoResOpen] = useState(false);
  const [autoResForm, setAutoResForm] = useState({
    scope: 'all', // 'all' | 'selected' | 'category'
    category_id: 'all',
    probeLive: true,
    stream_mode: 'ondemand', // 'ondemand' | 'transcode' | 'copy_ondemand' | 'copy_transcode'
    sdKbps: 1000,
    hdKbps: 2500,
    fhdKbps: 3000
  });
  const [autoResStatus, setAutoResStatus] = useState(null);
  const [probingSingleId, setProbingSingleId] = useState(null);

  // Channel & Category Lineup Ordering
  const [viewSort, setViewSort] = useState('lineup'); // 'lineup' | 'name_asc' | 'id_desc' | 'bitrate_desc'
  const [orderModalOpen, setOrderModalOpen] = useState(false);
  const [orderTab, setOrderTab] = useState('streams'); // 'streams' | 'categories'
  const [orderCatFilter, setOrderCatFilter] = useState('all');
  const [orderSearch, setOrderSearch] = useState('');
  const [orderStreamsList, setOrderStreamsList] = useState([]);
  const [orderCatsList, setOrderCatsList] = useState([]);
  const [packStreamsOnCatSave, setPackStreamsOnCatSave] = useState(true);
  const [alphaInsideCatSave, setAlphaInsideCatSave] = useState(false);
  const [dragIdx, setDragIdx] = useState(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);
  const [orderDirty, setOrderDirty] = useState(false);
  const [orderSaving, setOrderSaving] = useState(false);
  const [editingCatId, setEditingCatId] = useState(null);
  const [editingCatName, setEditingCatName] = useState('');

  // Multi-selection for Bulk Edit / Bulk Delete / Bulk Actions
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkNotice, setBulkNotice] = useState('');

  // Cambio masivo de IP/Puerto de origen
  const [repHostOpen, setRepHostOpen] = useState(false);
  // Auditoría de fuentes: detecta qué host usa cada canal como principal y como respaldo
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditData, setAuditData] = useState(null);
  const [auditBusy, setAuditBusy] = useState(false);
  const [repHostBusy, setRepHostBusy] = useState(false);
  const [repHostPreview, setRepHostPreview] = useState(null);
  const [repHostExtra, setRepHostExtra] = useState([]);
  const [repHostForm, setRepHostForm] = useState({
    oldHost: '',
    oldPort: '',
    newHost: '',
    newPort: '',
    includeBackup: true,
    includeExtra: true,
    onlyHttp: true,
    scope: 'all'
  });

  // Bulk Edit & Bulk Delete Modals
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [bulkForm, setBulkForm] = useState(EMPTY_BULK_EDIT);
  const [bulkBusy, setBulkBusy] = useState(false);

  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleteScope, setBulkDeleteScope] = useState('selected'); // 'selected' | 'category' | 'all'
  const [bulkDeleteCatId, setBulkDeleteCatId] = useState('all');

  // Respaldo por canal (imagen o video propio). El bucle global del panel ya no existe.
  const [slateUploading, setSlateUploading] = useState(false);
  const [slateNotice, setSlateNotice] = useState('');

  // Uniform Audio Leveling ("Audio Igual en Todos los Canales")
  const [audioModalOpen, setAudioModalOpen] = useState(false);
  const [audioConfig, setAudioConfig] = useState({
    enabled: false,
    preset: 'standard',
    bitrate: '128k'
  });
  const [audioDirectCount, setAudioDirectCount] = useState(0);
  const [convertDirectOnAudio, setConvertDirectOnAudio] = useState(true);
  const [audioSaving, setAudioSaving] = useState(false);
  const [audioNotice, setAudioNotice] = useState('');

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
  const [bulkKeepBitrate, setBulkKeepBitrate] = useState(true);

  const loadAudioLeveling = async () => {
    try {
      const au = await apiFetch('/api/audio-leveling/config');
      if (au?.config) setAudioConfig(au.config);
      if (typeof au?.directCount === 'number') setAudioDirectCount(au.directCount);
    } catch {
      // ignore
    }
  };

  const handleSaveAudioLeveling = async (overrideEnabled = null) => {
    setAudioSaving(true);
    setAudioNotice('');
    try {
      const nextEnabled = overrideEnabled !== null ? overrideEnabled : audioConfig.enabled;
      const res = await apiFetch('/api/audio-leveling/config', {
        method: 'PUT',
        body: JSON.stringify({
          ...audioConfig,
          enabled: nextEnabled,
          convertDirectToOnDemand: convertDirectOnAudio
        })
      });
      if (res?.config) setAudioConfig(res.config);
      if (typeof res?.directCount === 'number') setAudioDirectCount(res.directCount);
      await loadAll();
      setAudioNotice(
        res?.config?.enabled
          ? `✅ Audio nivelado activado en todos los canales${
              res.convertedFromDirect > 0
                ? ` (${res.convertedFromDirect} canales en Directo pasados a On-Demand Bajo CPU)`
                : ''
            }.`
          : 'ℹ️ Nivelación global de audio desactivada.'
      );
    } catch (err) {
      setAudioNotice(`❌ ${err.message}`);
    } finally {
      setAudioSaving(false);
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
    loadAudioLeveling();
    apiFetch('/api/streams/auto-resolution/status')
      .then((st) => {
        setAutoResStatus(st);
        if (st?.pilot) {
          setAutoResForm((f) => ({
            ...f,
            stream_mode: st.pilot.stream_mode || f.stream_mode,
            sdKbps: st.pilot.sdKbps || f.sdKbps,
            hdKbps: st.pilot.hdKbps || f.hdKbps,
            fhdKbps: st.pilot.fhdKbps || f.fhdKbps
          }));
        }
      })
      .catch(() => {});
  }, []);

  const handleToggleAutoPilot = async (nextEnabled) => {
    try {
      const res = await apiFetch('/api/streams/auto-resolution/pilot', {
        method: 'PUT',
        body: JSON.stringify({
          enabled: nextEnabled,
          stream_mode: autoResForm.stream_mode,
          sdKbps: autoResForm.sdKbps,
          hdKbps: autoResForm.hdKbps,
          fhdKbps: autoResForm.fhdKbps,
          scanNow: true
        })
      });
      setAutoResStatus({ ...(res.job || autoResStatus || {}), pilot: res.pilot });
      if (nextEnabled) {
        setBulkNotice('🤖 Auto-Piloto activado: los canales se analizan y cambian solos a 1M / 2.5M / 3M.');
        setTimeout(() => setBulkNotice(''), 5500);
      }
    } catch (err) {
      window.alert(err.message);
    }
  };

  useEffect(() => {
    if (!autoResOpen && !autoResStatus?.running) return undefined;
    let active = true;
    const poll = async () => {
      try {
        const st = await apiFetch('/api/streams/auto-resolution/status');
        if (!active) return;
        const wasRunning = autoResStatus?.running;
        setAutoResStatus(st);
        if (wasRunning && !st.running) {
          await loadAll();
        }
      } catch {
        // ignore
      }
    };
    poll();
    const timer = setInterval(poll, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [autoResOpen, autoResStatus?.running]);

  const handleRunAutoResolution = async (e) => {
    e.preventDefault();
    try {
      const res = await apiFetch('/api/streams/auto-resolution/run', {
        method: 'POST',
        body: JSON.stringify({
          ...autoResForm,
          ids: selectedIds
        })
      });
      if (res?.job) setAutoResStatus(res.job);
    } catch (err) {
      window.alert(err.message);
    }
  };

  const handleProbeSingleStream = async (s) => {
    setProbingSingleId(s.id);
    try {
      const res = await apiFetch(`/api/streams/${s.id}/probe-resolution`, { method: 'POST' });
      setBulkNotice(
        `🎯 ${s.name}: detectado ${res.resolution} (${res.tierLabel}) → recomendado ${res.bitrateKbps} kbps`
      );
      setTimeout(() => setBulkNotice(''), 5500);
      await loadAll();
    } catch (err) {
      window.alert(err.message);
    } finally {
      setProbingSingleId(null);
    }
  };

  // ==================== CHANNEL & CATEGORY LINEUP ORDERING ====================
  const openOrderModal = (initialTab = 'streams') => {
    const startCat = catFilter !== 'all' ? String(catFilter) : 'all';
    setOrderTab(initialTab);
    setOrderCatFilter(startCat);
    setOrderSearch('');
    setOrderStreamsList(
      startCat === 'all'
        ? [...streams]
        : streams.filter((s) => String(s.category_id) === startCat)
    );
    setOrderCatsList([...categories]);
    setOrderDirty(false);
    setEditingCatId(null);
    setOrderModalOpen(true);
  };

  const handleChangeOrderCatFilter = (nextCat) => {
    if (orderDirty && !window.confirm('Tienes cambios de orden sin guardar. ¿Cambiar de filtro de todos modos?')) {
      return;
    }
    setOrderCatFilter(nextCat);
    setOrderSearch('');
    setOrderStreamsList(
      nextCat === 'all'
        ? [...streams]
        : streams.filter((s) => String(s.category_id) === String(nextCat))
    );
    setOrderDirty(false);
  };

  const moveArrayItem = (arr, fromIdx, toIdx) => {
    if (fromIdx < 0 || fromIdx >= arr.length) return arr;
    const clamped = Math.max(0, Math.min(arr.length - 1, toIdx));
    if (fromIdx === clamped) return arr;
    const copy = [...arr];
    const [picked] = copy.splice(fromIdx, 1);
    copy.splice(clamped, 0, picked);
    return copy;
  };

  const moveStreamInModal = (fromIdx, toIdx) => {
    setOrderStreamsList((prev) => moveArrayItem(prev, fromIdx, toIdx));
    setOrderDirty(true);
  };

  const moveCategoryInModal = (fromIdx, toIdx) => {
    setOrderCatsList((prev) => moveArrayItem(prev, fromIdx, toIdx));
    setOrderDirty(true);
  };

  const applySmartSortPreset = (preset) => {
    const catRank = new Map(orderCatsList.map((c, i) => [c.id, i + 1]));
    const tierWeight = (t) => (t === 'fhd' ? 1 : t === 'hd' ? 2 : t === 'sd' ? 3 : 4);
    const natCmp = (a, b) =>
      String(a || '').localeCompare(String(b || ''), 'es', { numeric: true, sensitivity: 'base' });

    // If grouping by category while viewing a subset, switch to full catalog so grouping packs everything cleanly
    const base =
      (preset === 'cat_alpha' || preset === 'cat_keep') && orderCatFilter !== 'all'
        ? [...streams]
        : [...orderStreamsList];

    if ((preset === 'cat_alpha' || preset === 'cat_keep') && orderCatFilter !== 'all') {
      setOrderCatFilter('all');
    }

    const sorted = [...base].sort((a, b) => {
      if (preset === 'az') return natCmp(a.name, b.name);
      if (preset === 'za') return natCmp(b.name, a.name);
      if (preset === 'id_asc') return a.id - b.id;
      if (preset === 'quality') {
        const diff = tierWeight(a.resolution_tier) - tierWeight(b.resolution_tier);
        if (diff !== 0) return diff;
        return (b.bitrate_kbps || 0) - (a.bitrate_kbps || 0) || natCmp(a.name, b.name);
      }
      if (preset === 'cat_alpha' || preset === 'cat_keep') {
        const ra = catRank.get(a.category_id) ?? 999999;
        const rb = catRank.get(b.category_id) ?? 999999;
        if (ra !== rb) return ra - rb;
        if (preset === 'cat_alpha') return natCmp(a.name, b.name);
        return (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id;
      }
      return 0;
    });

    setOrderStreamsList(sorted);
    setOrderDirty(true);
  };

  const handleSaveStreamsOrder = async () => {
    if (orderStreamsList.length === 0) return;
    setOrderSaving(true);
    try {
      await apiFetch('/api/streams/reorder', {
        method: 'POST',
        body: JSON.stringify({
          orderedIds: orderStreamsList.map((s) => s.id),
          mode: orderCatFilter === 'all' ? 'full' : 'subset'
        })
      });
      setOrderDirty(false);
      await loadAll();
      setBulkNotice(
        `✅ Nuevo orden guardado en ${orderStreamsList.length} canales (activo en Xtream, M3U, Stalker y WebTV).`
      );
      setTimeout(() => setBulkNotice(''), 5000);
      setOrderModalOpen(false);
    } catch (err) {
      window.alert(err.message);
    } finally {
      setOrderSaving(false);
    }
  };

  const handleSaveCategoriesOrder = async () => {
    if (orderCatsList.length === 0) return;
    setOrderSaving(true);
    try {
      await apiFetch('/api/categories/reorder', {
        method: 'POST',
        body: JSON.stringify({
          orderedIds: orderCatsList.map((c) => c.id),
          packStreamsByCategory: packStreamsOnCatSave,
          alphaInsideCategory: alphaInsideCatSave
        })
      });
      setOrderDirty(false);
      await loadAll();
      setBulkNotice(
        `✅ Orden de ${orderCatsList.length} categorías guardado${
          packStreamsOnCatSave ? ' y canales reagrupados automáticamente' : ''
        }.`
      );
      setTimeout(() => setBulkNotice(''), 5000);
      setOrderModalOpen(false);
    } catch (err) {
      window.alert(err.message);
    } finally {
      setOrderSaving(false);
    }
  };

  const handleRenameCategoryInline = async (catId) => {
    if (!editingCatName.trim()) return;
    try {
      await apiFetch(`/api/categories/${catId}`, {
        method: 'PUT',
        body: JSON.stringify({ name: editingCatName.trim() })
      });
      setOrderCatsList((prev) =>
        prev.map((c) => (c.id === catId ? { ...c, name: editingCatName.trim() } : c))
      );
      setEditingCatId(null);
      await loadAll();
    } catch (err) {
      window.alert(err.message);
    }
  };

  const handleInlineNudgeStream = async (streamId, delta) => {
    // Operates on current visible lineup (either all streams or active category filter)
    const scopeList =
      catFilter === 'all'
        ? [...streams]
        : streams.filter((s) => String(s.category_id) === String(catFilter));
    const idx = scopeList.findIndex((s) => s.id === streamId);
    if (idx === -1) return;
    const targetIdx = idx + delta;
    if (targetIdx < 0 || targetIdx >= scopeList.length) return;
    const reordered = moveArrayItem(scopeList, idx, targetIdx);
    try {
      await apiFetch('/api/streams/reorder', {
        method: 'POST',
        body: JSON.stringify({
          orderedIds: reordered.map((s) => s.id),
          mode: catFilter === 'all' ? 'full' : 'subset'
        })
      });
      await loadAll();
    } catch (err) {
      window.alert(err.message);
    }
  };

  const findCopyCopy2500Profile = () =>
    profiles.find((p) => p.video_codec === 'copy' && p.audio_codec === 'copy' && p.id > 1) ||
    profiles.find((p) => p.video_codec === 'copy' && p.audio_codec === 'copy') ||
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
      offline_slate_mode: s.offline_slate_mode || 'disabled',
      offline_slate_url: s.offline_slate_url || '',
      audio_leveling_mode: s.audio_leveling_mode || 'global'
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

    if (presetKey === 'copy_copy_2500' || presetKey === 'copy_copy_source') {
      setBulkForm((prev) => ({
        ...prev,
        stream_mode: 'transcode',
        transcode_profile_id: copyProf ? String(copyProf.id) : '2',
        bitrate_kbps: '',
        offline_slate_mode: 'disabled',
        status: 'running'
      }));
    } else if (presetKey === 'ondemand_copy_2500' || presetKey === 'ondemand_copy_source') {
      setBulkForm((prev) => ({
        ...prev,
        stream_mode: 'ondemand',
        transcode_profile_id: copyProf ? String(copyProf.id) : '2',
        bitrate_kbps: '',
        offline_slate_mode: 'disabled'
      }));
    } else if (presetKey === 'zero_h264_2500') {
      setBulkForm((prev) => ({
        ...prev,
        stream_mode: 'transcode',
        transcode_profile_id: zeroProf ? String(zeroProf.id) : '2',
        bitrate_kbps: '2500',
        offline_slate_mode: 'disabled',
        status: 'running'
      }));
    } else if (presetKey === 'direct_proxy') {
      setBulkForm((prev) => ({
        ...prev,
        stream_mode: 'direct',
        transcode_profile_id: directProf ? String(directProf.id) : '1',
        bitrate_kbps: '',
        offline_slate_mode: 'disabled',
        status: 'running'
      }));
    }
  };

  const handleQuickCopyCopy2500 = async (targetScope = null) => {
    const copyProf = findCopyCopy2500Profile();
    if (!copyProf) return;
    const scope = targetScope || (selectedIds.length > 0 ? 'selected' : 'all');
    const countLabel =
      scope === 'all'
        ? `TODOS los ${streams.length} canales`
        : `${selectedIds.length} canales seleccionados`;
    if (
      !window.confirm(
        `¿Pasar ${countLabel} a Copy / Copy (Video Copy + Audio Copy) manteniendo intacto el bitrate original que trae cada stream?`
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
            offline_slate_mode: 'disabled',
            status: 'running'
          }
        })
      });
      setBulkNotice(
        `✅ ${res.updatedCount} canales configurados en Copy / Copy manteniendo intacto el bitrate original que trae cada stream.`
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
      if (bulkForm.audio_leveling_mode !== '') changes.audio_leveling_mode = bulkForm.audio_leveling_mode;
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

  const runReplaceHost = async (apply = false) => {
    setRepHostBusy(true);
    try {
      const res = await apiFetch('/api/streams/bulk-replace-host', {
        method: 'POST',
        body: JSON.stringify({
          scope: repHostForm.scope,
          ids: selectedIds,
          category_filter_id: catFilter !== 'all' ? Number(catFilter) : null,
          oldHost: repHostForm.oldHost.trim(),
          oldPort: repHostForm.oldPort.trim(),
          newHost: repHostForm.newHost.trim(),
          newPort: repHostForm.newPort.trim(),
          includeBackup: repHostForm.includeBackup,
          includeExtra: repHostForm.includeExtra,
          schemes: repHostForm.onlyHttp ? ['http', 'https'] : [],
          apply
        })
      });
      if (!apply) {
        setRepHostPreview(res.preview || []);
        setRepHostExtra(res.previewExtra || []);
        if ((res.matchedCount || 0) === 0) {
          setBulkNotice('⚠️ Ningún canal coincide con esa IP/puerto. Revisa los datos.');
          setTimeout(() => setBulkNotice(''), 6000);
        }
      } else {
        setRepHostOpen(false);
        setRepHostPreview(null);
        setRepHostExtra([]);
        setBulkNotice(
          `✅ ${res.updatedCount} canales cambiados a ${repHostForm.newHost}${
            repHostForm.newPort ? ':' + repHostForm.newPort : ''
          }${res.restartedWorkers ? ` · ${res.restartedWorkers} reiniciados escalonado` : ''}.`
        );
        setTimeout(() => setBulkNotice(''), 8000);
        await loadAll();
      }
    } catch (err) {
      window.alert(err.message);
    } finally {
      setRepHostBusy(false);
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

  const handleUploadSlateFile = async (e, targetTarget = 'stream_form') => {
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

      if (targetTarget === 'stream_form') {
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

  const handleSaveProfile = async (e) => {
    e.preventDefault();
    if (!profForm.name.trim()) return;
    try {
      const payload = {
        ...profForm,
        video_bitrate: profForm.video_codec === 'copy' ? 'source' : profForm.video_bitrate,
        resolution: profForm.video_codec === 'copy' ? 'source' : profForm.resolution,
        preset: profForm.video_codec === 'copy' ? 'none' : profForm.preset,
        audio_bitrate: profForm.audio_codec === 'copy' ? 'copy' : profForm.audio_bitrate
      };
      if (editingProfId) {
        const res = await apiFetch(`/api/profiles/${editingProfId}`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        });
        setProfNotice(
          `✅ Perfil "${profForm.name}" actualizado (${res.restartedStreams || 0} canales activos recargados).`
        );
        setEditingProfId(null);
        setProfForm(EMPTY_PROF);
      } else {
        await apiFetch('/api/profiles', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        setProfNotice(`✅ Nuevo perfil "${profForm.name}" creado.`);
        setProfForm(EMPTY_PROF);
      }
      await loadAll();
    } catch (err) {
      setProfNotice(`❌ ${err.message}`);
    }
  };

  const handleBulkApplyProfile = async () => {
    try {
      const chosenProf = profiles.find((p) => p.id === Number(bulkProfId));
      const isCopyProf =
        bulkMode === 'direct' ||
        !chosenProf ||
        chosenProf.video_codec === 'copy' ||
        String(chosenProf.video_bitrate || '').toLowerCase() === 'source';
      const keepOriginalBitrate = isCopyProf || bulkKeepBitrate;
      const kbpsMatch = String(chosenProf?.video_bitrate || '').match(/^(\d+)/);
      const kbps = !keepOriginalBitrate && kbpsMatch ? Number(kbpsMatch[1]) : undefined;

      const isSelectedScope = bulkCat === 'selected';
      const res = await apiFetch('/api/streams/bulk-profile', {
        method: 'POST',
        body: JSON.stringify({
          scope: isSelectedScope ? 'selected' : bulkCat === 'all' ? 'all' : 'category',
          ids: isSelectedScope ? selectedIds : [],
          category_id: isSelectedScope ? 'all' : bulkCat,
          stream_mode: bulkMode,
          transcode_profile_id: Number(bulkProfId),
          keep_bitrate: keepOriginalBitrate,
          ...(kbps ? { bitrate_kbps: kbps } : {})
        })
      });
      setProfNotice(
        `✅ Perfil "${chosenProf?.name || ''}" aplicado en lote a ${res.updatedCount} canales (${
          res.preservedBitrate !== false ? 'manteniendo el bitrate original de cada stream' : `a ${kbps} kbps`
        }).`
      );
      await loadAll();
    } catch (err) {
      setProfNotice(`❌ ${err.message}`);
    }
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

  // ==================== AUDITORÍA DE FUENTES / LIMPIEZA DE RESPALDOS ====================
  const loadSourceAudit = async () => {
    setAuditBusy(true);
    try {
      const res = await apiFetch('/api/streams/source-audit');
      setAuditData(res);
    } catch (err) {
      window.alert(err.message);
    } finally {
      setAuditBusy(false);
    }
  };

  const openSourceAudit = () => {
    setAuditOpen(true);
    loadSourceAudit();
  };

  const purgeSecondSources = async (host) => {
    const label = host ? `los respaldos que apuntan a ${host}` : 'TODOS los segundos orígenes';
    if (!window.confirm(`¿Borrar ${label}? El origen principal de cada canal NO se toca.`)) return;
    setAuditBusy(true);
    try {
      const res = await apiFetch('/api/streams/purge-second-sources', {
        method: 'POST',
        body: JSON.stringify(host ? { host } : {})
      });
      setBulkNotice(`✅ Se quitaron los SOURCE 2 de ${res.cleared} canales.`);
      setTimeout(() => setBulkNotice(''), 6000);
      await Promise.all([loadSourceAudit(), loadAll()]);
    } catch (err) {
      window.alert(err.message);
    } finally {
      setAuditBusy(false);
    }
  };

  // ==================== CAMBIO MANUAL DE ORIGEN (sin failover automático) ====================
  const handleSwitchSource = async (s, target) => {
    const label = target === 'backup' ? 'su SOURCE 2' : 'su source original';
    if (!window.confirm(`¿Pasar "${s.name}" a ${label}? El canal se reinicia para tomar la nueva URL.`)) return;
    try {
      await apiFetch(`/api/streams/${s.id}/switch-source`, {
        method: 'POST',
        body: JSON.stringify({ target })
      });
      setBulkNotice(`✅ "${s.name}" ahora emite desde ${label}.`);
      setTimeout(() => setBulkNotice(''), 5000);
      await loadAll();
    } catch (err) {
      window.alert(err.message);
    }
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

  const lineupIndexMap = new Map(streams.map((s, idx) => [s.id, idx + 1]));

  const filtered = streams
    .filter((s) => {
      const matchesSearch =
        s.name.toLowerCase().includes(search.toLowerCase()) ||
        s.source_url.toLowerCase().includes(search.toLowerCase()) ||
        String(s.detected_resolution || '').toLowerCase().includes(search.toLowerCase());
      const matchesCat = catFilter === 'all' || String(s.category_id) === String(catFilter);
      const matchesRes =
        resFilter === 'all' ||
        (resFilter === 'unscanned' ? !s.resolution_tier : s.resolution_tier === resFilter);
      const matchesStatus =
        statusFilter === 'all'
          ? true
          : statusFilter === 'online'
            ? s.status === 'running'
            : statusFilter === 'idle'
              ? s.status === 'ondemand_idle'
              : statusFilter === 'source2'
                ? Boolean(String(s.backup_url || '').trim())
                : s.status !== 'running' && s.status !== 'ondemand_idle';
      return matchesSearch && matchesCat && matchesRes && matchesStatus;
    })
    .sort((a, b) => {
      if (viewSort === 'name_asc') {
        return String(a.name || '').localeCompare(String(b.name || ''), 'es', {
          numeric: true,
          sensitivity: 'base'
        });
      }
      if (viewSort === 'id_desc') return b.id - a.id;
      if (viewSort === 'bitrate_desc') return (b.bitrate_kbps || 0) - (a.bitrate_kbps || 0);
      return (lineupIndexMap.get(a.id) || 0) - (lineupIndexMap.get(b.id) || 0);
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

  // Volver a la página 1 cuando cambia cualquier filtro/orden (comportamiento de lista XUI)
  useEffect(() => {
    setPage(1);
  }, [search, catFilter, resFilter, statusFilter, viewSort, groupByCat, pageSize]);

  // Reloj para la columna Estado (uptime "up 3d 04h")
  useEffect(() => {
    const timer = setInterval(() => setClockNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  // ---- XUI-style list header counters -------------------------------------------------
  const onlineCount = streams.filter((s) => s.status === 'running').length;
  const idleCount = streams.filter((s) => s.status === 'ondemand_idle').length;
  const downCount = Math.max(0, streams.length - onlineCount - idleCount);
  const source2Count = streams.filter((s) => Boolean(String(s.backup_url || '').trim())).length;
  const advancedFilterCount =
    (resFilter !== 'all' ? 1 : 0) + (groupByCat ? 1 : 0) + (statusFilter !== 'all' ? 1 : 0);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const pageStart = (safePage - 1) * pageSize;
  // Al agrupar, los canales se ordenan por categoría para que cada grupo quede contiguo (como XUI)
  const groupedRows = groupByCat
    ? [...filtered].sort(
        (a, b) =>
          String(a.category_name || 'General').localeCompare(String(b.category_name || 'General'), 'es', {
            numeric: true,
            sensitivity: 'base'
          }) || (lineupIndexMap.get(a.id) || 0) - (lineupIndexMap.get(b.id) || 0)
      )
    : filtered;
  const pageRows = groupByCat ? groupedRows : filtered.slice(pageStart, pageStart + pageSize);
  const rangeFrom = filtered.length === 0 ? 0 : groupByCat ? 1 : pageStart + 1;
  const rangeTo = groupByCat ? filtered.length : Math.min(pageStart + pageSize, filtered.length);

  // Badge "AUDIO IGUAL": modo por canal + ajuste global de nivelación
  const audioLevelOnFor = (st) =>
    st.audio_leveling_mode === 'on' ||
    (st.audio_leveling_mode !== 'off' &&
      (audioConfig.enabled || String(st.profile_name || '').toLowerCase().includes('audio nivelado')));

  // Menú "Herramientas" del encabezado (misma funcionalidad que antes, sin 12 botones sueltos)
  const toolItems = [
    { heading: 'Parrilla y emisión' },
    {
      icon: ArrowUpDown,
      label: 'Ordenar canales y categorías',
      onClick: () => openOrderModal('streams')
    },
    {
      icon: Monitor,
      label: 'Auto-Resolución (1M / 2.5M / 3M)',
      hint: autoResStatus?.running
        ? `${autoResStatus.completed}/${autoResStatus.total}`
        : autoResStatus?.pilot?.enabled
          ? 'AUTO ON'
          : '',
      onClick: () => {
        setAutoResForm((f) => ({
          ...f,
          scope: selectedIds.length > 0 ? 'selected' : catFilter !== 'all' ? 'category' : 'all',
          category_id: catFilter !== 'all' ? String(catFilter) : 'all'
        }));
        setAutoResOpen(true);
      }
    },
    {
      icon: Volume2,
      label: `Audio Igual en todos los canales ${audioConfig.enabled ? '· ON' : '· OFF'}`,
      onClick: () => {
        setAudioNotice('');
        loadAudioLeveling();
        setAudioModalOpen(true);
      }
    },
    { heading: 'Acciones masivas' },
    {
      icon: Zap,
      label: 'Copy/Copy masivo (bitrate original)',
      onClick: () => handleQuickCopyCopy2500()
    },
    {
      icon: Layers,
      label: 'Edición masiva',
      onClick: () => openBulkEditModal()
    },
    {
      icon: Globe,
      label: 'Cambiar IP / Puerto de origen',
      onClick: () => {
        setRepHostPreview(null);
        setRepHostExtra([]);
        setBulkNotice('');
        setRepHostForm((prev) => ({
          ...prev,
          scope: selectedIds.length > 0 ? 'selected' : catFilter !== 'all' ? 'category' : 'all'
        }));
        setRepHostOpen(true);
      }
    },
    {
      icon: ArrowLeftRight,
      label: 'Fuentes de los canales (auditoría)',
      onClick: openSourceAudit
    },
    {
      icon: Sliders,
      label: 'Perfiles FFmpeg',
      onClick: () => {
        setProfNotice('');
        const copyProf = findCopyCopy2500Profile();
        if (copyProf) setBulkProfId(copyProf.id);
        setBulkKeepBitrate(true);
        setProfilesModalOpen(true);
      }
    },
    {
      icon: Trash2,
      label: 'Borrar masivo',
      danger: true,
      onClick: () => {
        setBulkDeleteScope(
          selectedIds.length > 0 ? 'selected' : catFilter !== 'all' ? 'category' : 'all'
        );
        setBulkDeleteCatId(
          catFilter !== 'all' ? String(catFilter) : categories[0]?.id ? String(categories[0].id) : 'all'
        );
        setBulkDeleteOpen(true);
      }
    },
    { heading: 'Importar' },
    ...(onOpenXuiImport
      ? [{ icon: Database, label: 'Importar BD XUI.one', onClick: onOpenXuiImport }]
      : []),
    { icon: Upload, label: 'Importar lista M3U', onClick: () => setImportOpen(true) }
  ];

  return (
    <div className="space-y-4">
      {/* ===== Encabezado de página (page-title-box estilo XUI) ===== */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[9.5px] font-bold uppercase tracking-[0.22em] text-slate-500">
            Panel TVLister · Emisión 24/7
          </div>
          <div className="mt-1 flex items-center gap-2">
            <h2 className="text-xl font-bold tracking-tight text-white">Canales en Vivo</h2>
            <span className="rounded-md border border-slate-700/70 bg-slate-800/70 px-1.5 py-[1px] font-mono text-[10px] font-bold text-slate-300">
              {streams.length}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-slate-400">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {onlineCount} en emisión
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-rose-400" />
              {downCount} detenidos
            </span>
            {idleCount > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                {idleCount} on-demand
              </span>
            )}
            {source2Count > 0 && (
              <span className="inline-flex items-center gap-1.5 text-sky-300">
                <ArrowLeftRight className="h-3 w-3" />
                {source2Count} con SOURCE 2 manual
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Dropdown label="Herramientas" icon={Wrench} items={toolItems} width={304} title="Herramientas del catálogo de canales" />
          <button
            onClick={openCreate}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-indigo-500/60 bg-indigo-600 px-3 text-[11.5px] font-bold text-white shadow-lg shadow-indigo-600/20 transition hover:bg-indigo-500"
          >
            <Plus className="h-3.5 w-3.5" />
            Nuevo Canal
          </button>
        </div>
      </div>

      {/* ===== Barra de herramientas y filtros (card + collapse_filters estilo XUI) ===== */}
      <div className="rounded-xl border border-slate-800/80 bg-[#0e1526]">
        <div className="flex flex-wrap items-center gap-2 p-3">
          <div className="relative min-w-[210px] flex-1">
            <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar canal, fuente HLS/TS/RTMP..."
              className="h-8 w-full rounded-lg border border-slate-700/80 bg-[#090e1a] pl-8 pr-3 text-[11.5px] text-white focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <Segmented
            value={statusFilter}
            onChange={setStatusFilter}
            options={[
              { value: 'all', label: 'Todos', count: streams.length },
              { value: 'online', label: 'Online', count: onlineCount, dot: 'bg-emerald-400' },
              { value: 'stopped', label: 'Detenidos', count: downCount, dot: 'bg-rose-400' },
              { value: 'source2', label: 'SOURCE 2', count: source2Count }
            ]}
          />

          <button
            type="button"
            onClick={() => setFiltersOpen((v) => !v)}
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[11.5px] font-semibold transition ${
              filtersOpen || advancedFilterCount > 0
                ? 'border-indigo-500/45 bg-indigo-500/12 text-indigo-200'
                : 'border-slate-700/80 bg-slate-800/60 text-slate-300 hover:text-white'
            }`}
            title="Mostrar u ocultar los filtros avanzados"
          >
            <Filter className="h-3.5 w-3.5" />
            Filtros
            {advancedFilterCount > 0 && (
              <span className="rounded bg-indigo-600 px-1 font-mono text-[9px] font-bold text-white">
                {advancedFilterCount}
              </span>
            )}
          </button>

          {streams.length > 0 && (
            <button
              type="button"
              onClick={() =>
                selectedIds.length === streams.length ? setSelectedIds([]) : selectAllEntireCatalog()
              }
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-700/80 bg-slate-800/60 px-2.5 text-[11.5px] font-semibold text-slate-300 transition hover:text-white"
            >
              <CheckSquare className="h-3.5 w-3.5 text-indigo-400" />
              {selectedIds.length === streams.length ? 'Deseleccionar' : `Seleccionar ${streams.length}`}
            </button>
          )}
        </div>

        {filtersOpen && (
          <div className="grid gap-2 border-t border-slate-800/70 bg-[#0b1220]/40 p-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1">
              <span className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-slate-500">Categoría</span>
              <select
                value={catFilter}
                onChange={(e) => setCatFilter(e.target.value)}
                className="h-8 rounded-lg border border-slate-700/80 bg-[#090e1a] px-2 text-[11.5px] text-slate-200 focus:border-indigo-500 focus:outline-none"
              >
                <option value="all">Todas las categorías ({streams.length})</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-slate-500">Resolución</span>
              <select
                value={resFilter}
                onChange={(e) => setResFilter(e.target.value)}
                className="h-8 rounded-lg border border-slate-700/80 bg-[#090e1a] px-2 text-[11.5px] text-slate-200 focus:border-indigo-500 focus:outline-none"
              >
                <option value="all">Todas las resoluciones</option>
                <option value="sd">SD / 480p / 540p (1.0 Mbps)</option>
                <option value="hd">HD 720p (2.5 Mbps)</option>
                <option value="fhd">FHD 1080p (3.0 Mbps)</option>
                <option value="unscanned">Sin clasificar aún</option>
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-slate-500">
                Vista / Orden
              </span>
              <select
                value={viewSort}
                onChange={(e) => setViewSort(e.target.value)}
                className="h-8 rounded-lg border border-slate-700/80 bg-[#090e1a] px-2 text-[11.5px] text-slate-200 focus:border-indigo-500 focus:outline-none"
                title="Cambiar el orden de esta tabla"
              >
                <option value="lineup">Orden de Parrilla (Clientes)</option>
                <option value="name_asc">Nombre A → Z</option>
                <option value="bitrate_desc">Mayor Bitrate</option>
                <option value="id_desc">ID más reciente</option>
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-slate-500">Agrupar</span>
              <button
                type="button"
                onClick={() => setGroupByCat((v) => !v)}
                className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border px-2 text-[11.5px] font-semibold transition ${
                  groupByCat
                    ? 'border-indigo-500/45 bg-indigo-500/15 text-indigo-200'
                    : 'border-slate-700/80 bg-[#090e1a] text-slate-300 hover:text-white'
                }`}
              >
                <Layers className="h-3.5 w-3.5" />
                {groupByCat ? 'Agrupado por categoría' : 'Agrupar por categoría'}
              </button>
            </label>

            {advancedFilterCount > 0 && (
              <button
                type="button"
                onClick={() => {
                  setResFilter('all');
                  setStatusFilter('all');
                  setGroupByCat(false);
                  setCatFilter('all');
                }}
                className="self-end justify-self-start text-[11px] font-semibold text-slate-400 underline-offset-2 hover:text-white hover:underline"
              >
                Limpiar filtros
              </button>
            )}
          </div>
        )}

        {bulkNotice && (
          <div className="flex items-center justify-between gap-2 border-t border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-[11.5px] font-medium text-emerald-300">
            <span>{bulkNotice}</span>
            <button onClick={() => setBulkNotice('')} className="text-emerald-200 hover:text-white">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* ===== Barra de acciones sobre la selección (with-selected estilo XUI) ===== */}
      {selectedIds.length > 0 && (
        <div className="sticky top-2 z-30 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-indigo-500/40 bg-[#111a2c]/95 px-3 py-2 shadow-xl shadow-black/40 backdrop-blur">
          <div className="flex flex-wrap items-center gap-2.5 text-[11px]">
            <span className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-2 py-[3px] font-bold text-white">
              <CheckSquare className="h-3 w-3" />
              {selectedIds.length} seleccionado(s)
            </span>
            {selectedIds.length < streams.length && (
              <button
                onClick={selectAllEntireCatalog}
                className="font-medium text-indigo-300 underline-offset-2 hover:text-white hover:underline"
              >
                Seleccionar los {streams.length} canales completos
              </button>
            )}
            <button onClick={() => setSelectedIds([])} className="text-slate-400 hover:text-white">
              Limpiar selección
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <button
              disabled={bulkBusy}
              onClick={() => handleQuickCopyCopy2500('selected')}
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-amber-500/40 bg-amber-500/15 px-2 font-semibold text-amber-200 transition hover:bg-amber-500/25 disabled:opacity-50"
              title="Pasar seleccionados a Copy Video + Copy Audio manteniendo el bitrate original del stream"
            >
              <Zap className="h-3 w-3 text-amber-400" />
              Copy/Copy
            </button>

            <button
              disabled={bulkBusy}
              onClick={() => openBulkEditModal('selected')}
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-cyan-500/40 bg-cyan-500/15 px-2 font-semibold text-cyan-200 transition hover:bg-cyan-500/25 disabled:opacity-50"
            >
              <Edit3 className="h-3 w-3" />
              Editar ({selectedIds.length})
            </button>

            <button
              disabled={bulkBusy}
              onClick={() => handleBulkStreamAction('start', 'selected')}
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-2 font-semibold text-emerald-300 transition hover:bg-emerald-500/25 disabled:opacity-50"
            >
              <Play className="h-3 w-3" />
              Iniciar
            </button>

            <button
              disabled={bulkBusy}
              onClick={() => handleBulkStreamAction('restart', 'selected')}
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-indigo-500/40 bg-indigo-500/15 px-2 font-semibold text-indigo-300 transition hover:bg-indigo-500/25 disabled:opacity-50"
            >
              <RotateCw className="h-3 w-3" />
              Reiniciar
            </button>

            <button
              disabled={bulkBusy}
              onClick={() => handleBulkStreamAction('stop', 'selected')}
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-slate-700/80 bg-slate-800/70 px-2 font-semibold text-amber-300 transition hover:bg-slate-700 disabled:opacity-50"
            >
              <Square className="h-3 w-3" />
              Detener
            </button>

            <button
              disabled={bulkBusy}
              onClick={() => {
                setBulkDeleteScope('selected');
                setBulkDeleteOpen(true);
              }}
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-rose-500/50 bg-rose-600 px-2.5 font-semibold text-white transition hover:bg-rose-500 disabled:opacity-50"
            >
              <Trash2 className="h-3 w-3" />
              Eliminar ({selectedIds.length})
            </button>
          </div>
        </div>
      )}

      {/* ===== Lista de canales (skin XUI: card + tabla densa + paginación) ===== */}
      <div className="overflow-hidden rounded-xl border border-slate-800/80 bg-[#0e1526]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/70 px-4 py-2.5">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
            <Radio className="w-3.5 h-3.5 text-indigo-400" />
            Lista de canales
            <span className="rounded border border-slate-700/70 bg-slate-800/70 px-1.5 py-[1px] font-mono text-[10px] text-slate-400">
              {filtered.length}
            </span>
            {groupByCat ? <Chip tone="indigo">Agrupado por categoría</Chip> : null}
          </div>
          <div className="text-[10.5px] text-slate-500">
            {filtered.length === 0 ? 'Sin resultados' : `Mostrando ${rangeFrom}–${rangeTo} de ${filtered.length}`}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1060px] text-left text-xs">
            <thead className="bg-[#080d18] text-[9.5px] uppercase tracking-[0.12em] text-slate-500">
              <tr>
                <th className="w-9 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={allFilteredSelected}
                    onChange={toggleSelectAllFiltered}
                    className="h-3.5 w-3.5 cursor-pointer rounded accent-indigo-500"
                    title="Seleccionar todos los filtrados"
                  />
                </th>
                <th className="w-[88px] px-2 py-2 font-bold">#</th>
                <th className="px-2 py-2 font-bold">Canal</th>
                <th className="px-2 py-2 font-bold">Fuente</th>
                <th className="px-2 py-2 font-bold">Modo &amp; Perfil</th>
                <th className="w-[132px] px-2 py-2 font-bold">DVR / Respaldo</th>
                <th className="w-[112px] px-2 py-2 font-bold">Estado</th>
                <th className="px-3 py-2 text-right font-bold">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filtered.length === 0 ? (
                <EmptyState
                  colSpan={8}
                  title="No hay canales en esta vista"
                  hint="Ajusta la búsqueda, la categoría o los filtros de estado."
                />
              ) : (
                (() => {
                  let lastCategory = null;
                  return pageRows.map((s) => {
                    const isChecked = selectedIds.includes(s.id);
                    const slateMode = s.offline_slate_mode || 'disabled';
                    const hasSource2 = Boolean(String(s.backup_url || '').trim());
                    const activeUrl =
                      s.failover_active && hasSource2 ? String(s.backup_url).trim() : s.source_url;
                    const audioLevelOn = audioLevelOnFor(s);
                    const category = s.category_name || 'General';

                    const categoryRow =
                      groupByCat && category !== lastCategory ? (
                        <tr key={`cat-${category}`} className="bg-[#0b1220]">
                          <td colSpan={8} className="px-3 py-1.5">
                            <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">
                              <Layers className="h-3 w-3 text-indigo-400" />
                              {category}
                              <span className="font-mono text-[9px] font-medium normal-case tracking-normal text-slate-500">
                                {filtered.filter((x) => (x.category_name || 'General') === category).length} canales
                              </span>
                            </div>
                          </td>
                        </tr>
                      ) : null;
                    lastCategory = category;

                    return (
                      <React.Fragment key={s.id}>
                        {categoryRow}
                        <tr
                          className={`group transition-colors ${
                            isChecked ? 'bg-indigo-500/[0.07]' : 'hover:bg-white/[0.025]'
                          }`}
                        >
                          <td className="px-3 py-2 align-middle">
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => toggleSelectStream(s.id)}
                              className="h-3.5 w-3.5 cursor-pointer rounded accent-indigo-500"
                            />
                          </td>

                          <td className="px-2 py-2 align-middle">
                            <div className="flex items-center gap-1.5">
                              {viewSort === 'lineup' && !search && resFilter === 'all' && (
                                <div className="flex flex-col gap-0.5">
                                  <button
                                    type="button"
                                    onClick={() => handleInlineNudgeStream(s.id, -1)}
                                    title="Subir 1 puesto en la parrilla"
                                    className="flex h-3 w-3.5 items-center justify-center rounded-sm text-slate-500 transition hover:bg-sky-500/20 hover:text-sky-300"
                                  >
                                    <ArrowUp className="h-2.5 w-2.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleInlineNudgeStream(s.id, 1)}
                                    title="Bajar 1 puesto en la parrilla"
                                    className="flex h-3 w-3.5 items-center justify-center rounded-sm text-slate-500 transition hover:bg-sky-500/20 hover:text-sky-300"
                                  >
                                    <ArrowDown className="h-2.5 w-2.5" />
                                  </button>
                                </div>
                              )}
                              <div className="leading-tight">
                                <div className="font-mono text-[11px] font-bold text-sky-300">
                                  #{lineupIndexMap.get(s.id) || s.sort_order || s.id}
                                </div>
                                <div className="font-mono text-[9px] text-slate-600">ID {s.id}</div>
                              </div>
                            </div>
                          </td>

                          <td className="px-2 py-2 align-middle">
                            <div className="flex items-center gap-2.5">
                              <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md border border-slate-700/80 bg-slate-800">
                                {s.logo_url ? (
                                  <img
                                    src={s.logo_url}
                                    alt={s.name}
                                    loading="lazy"
                                    className="h-full w-full object-cover"
                                  />
                                ) : (
                                  <Radio className="h-3.5 w-3.5 text-indigo-400" />
                                )}
                              </div>
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="truncate text-[12.5px] font-semibold text-slate-100 group-hover:text-white">
                                    {s.name}
                                  </span>
                                  {hasSource2 && (
                                    <Chip
                                      tone="sky"
                                      title={`Tiene un segundo source guardado (manual, no entra solo)\n${String(
                                        s.backup_url
                                      ).trim()}`}
                                    >
                                      SOURCE 2
                                    </Chip>
                                  )}
                                </div>
                                <div className="mt-[1px] flex items-center gap-1.5 text-[9.5px] text-slate-500">
                                  <span className="max-w-[150px] truncate">{category}</span>
                                  <span className="text-slate-700">·</span>
                                  <span className="truncate">{s.server_name || 'Servidor 1'}</span>
                                </div>
                              </div>
                            </div>
                          </td>

                          <td className="px-2 py-2 align-middle">
                            <div className="flex flex-col gap-1">
                              <div className="flex items-center gap-1.5" title={activeUrl}>
                                <Globe className="h-3 w-3 shrink-0 text-slate-500" />
                                <span className="max-w-[150px] truncate font-mono text-[10px] text-slate-400">
                                  {sourceHost(activeUrl)}
                                </span>
                              </div>
                              {hasSource2 ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleSwitchSource(s, s.failover_active ? 'primary' : 'backup')
                                  }
                                  title={
                                    s.failover_active
                                      ? `Este canal está emitiendo su SOURCE 2\n${s.backup_url}\nClic para volver al source original`
                                      : `Emitir desde el SOURCE 2 de este canal (manual)\n${s.backup_url}\nClic para cambiar`
                                  }
                                  className={`inline-flex w-fit items-center gap-1 rounded border px-1.5 py-[1px] text-[9px] font-bold uppercase tracking-wide transition ${
                                    s.failover_active
                                      ? 'border-amber-500/40 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25'
                                      : 'border-slate-700/70 bg-slate-800/60 text-slate-400 hover:text-sky-300'
                                  }`}
                                >
                                  <ArrowLeftRight className="h-2.5 w-2.5" />
                                  {s.failover_active ? 'Volver a SOURCE 1' : 'Usar SOURCE 2'}
                                </button>
                              ) : (
                                <span className="font-mono text-[9px] text-slate-600">sin source 2</span>
                              )}
                            </div>
                          </td>

                          <td className="px-2 py-2 align-middle">
                            <div className="flex max-w-[300px] flex-wrap items-center gap-1">
                              <Chip tone="indigo">{s.stream_mode}</Chip>
                              {s.profile_video_codec === 'copy' && s.stream_mode !== 'direct' && (
                                <Chip tone="emerald">{audioLevelOn ? 'COPY VIDEO' : 'COPY/COPY'}</Chip>
                              )}
                              {s.stream_mode !== 'direct' && audioLevelOn && (
                                <Chip
                                  tone="amber"
                                  icon={Volume2}
                                  title="Audio nivelado dinámicamente a 48 kHz Estéreo (mismo volumen en todos los canales)"
                                >
                                  AUDIO IGUAL
                                </Chip>
                              )}
                              {s.headend_node_id && (
                                <Chip
                                  tone="cyan"
                                  title={`Procesado y nivelado localmente en Nodo Cabecera (${
                                    s.headend_node_name || 'ProLiant'
                                  }) — La Nube solo hace Copy/Copy (0% CPU)`}
                                >
                                  {s.headend_mode === 'vip_247' ? 'PROLIANT VIP' : 'PROLIANT ONDEMAND'}
                                </Chip>
                              )}
                              {s.resolution_tier && (
                                <Chip
                                  tone={
                                    s.resolution_tier === 'fhd'
                                      ? 'amber'
                                      : s.resolution_tier === 'sd'
                                        ? 'emerald'
                                        : 'cyan'
                                  }
                                  title={
                                    s.resolution_source === 'probed'
                                      ? `Medido en vivo con FFmpeg (${s.detected_resolution})`
                                      : s.resolution_source === 'hls_manifest'
                                        ? `Leído del manifiesto HLS (${s.detected_resolution})`
                                        : `Clasificado por nombre del canal (${s.detected_resolution})`
                                  }
                                >
                                  {s.resolution_tier === 'fhd'
                                    ? 'FHD'
                                    : s.resolution_tier === 'sd'
                                      ? 'SD/540p'
                                      : 'HD 720p'}
                                  {s.detected_resolution ? ` • ${s.detected_resolution}` : ''}
                                </Chip>
                              )}
                            </div>
                            <div className="mt-[3px] truncate text-[9.5px] text-slate-500">
                              {s.profile_name || 'Direct Stream'} •{' '}
                              {s.stream_mode === 'direct' ||
                              s.profile_video_codec === 'copy' ||
                              !s.profile_video_bitrate ||
                              s.profile_video_bitrate === 'source'
                                ? s.bitrate_kbps && s.bitrate_kbps !== 2500
                                  ? `Bitrate Original (${s.bitrate_kbps} kbps)`
                                  : 'Bitrate Original (Source)'
                                : s.profile_video_bitrate}
                            </div>
                          </td>

                          <td className="px-2 py-2 align-middle">
                            <div className="flex flex-col items-start gap-1">
                              <button
                                onClick={() => toggleArchive(s)}
                                title="Activar/Desactivar Grabación Catchup DVR en disco"
                                className={`inline-flex items-center gap-1 rounded border px-1.5 py-[1px] text-[9px] font-bold uppercase tracking-wide transition ${
                                  s.archive_enabled
                                    ? 'border-rose-500/40 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25'
                                    : 'border-slate-700/70 bg-slate-800/60 text-slate-400 hover:text-white'
                                }`}
                              >
                                <span
                                  className={`h-1.5 w-1.5 rounded-full ${
                                    s.archive_enabled ? 'animate-ping bg-rose-400' : 'bg-slate-500'
                                  }`}
                                />
                                {s.archive_enabled ? `REC ${s.tv_archive_days || 3}d` : 'DVR OFF'}
                              </button>
                              {slateMode === 'disabled' ? (
                                <span
                                  className="text-[9px] text-slate-600"
                                  title="Este canal no tiene señal de respaldo: si se cae el origen, el reproductor recibe el error del canal."
                                >
                                  respaldo: off
                                </span>
                              ) : slateMode === 'custom_image' || slateMode === 'custom_video' ? (
                                <Chip
                                  tone="violet"
                                  icon={slateMode === 'custom_image' ? ImageIcon : Film}
                                  title="Respaldo propio (imagen o video) cuando el canal se queda sin señal"
                                >
                                  propio
                                </Chip>
                              ) : (
                                <span className="text-[9px] text-slate-600">sin respaldo</span>
                              )}
                              {s.archive_enabled && s.archiveStats ? (
                                <span className="font-mono text-[9px] text-slate-500">
                                  {s.archiveStats.segmentCount || 0} segs · {s.archiveStats.sizeMb || 0} MB
                                </span>
                              ) : null}
                            </div>
                          </td>

                          <td className="px-2 py-2 align-middle">
                            <StatusPill
                              status={s.status}
                              uptimeStartedAt={s.uptime_started_at}
                              now={clockNow}
                            />
                          </td>

                          <td className="px-3 py-2 align-middle">
                            <div className="flex items-center justify-end gap-1">
                              <IconAction
                                icon={Play}
                                tone="indigo"
                                label="Previsualizar Stream (o Bucle Offline si está sin señal)"
                                onClick={() =>
                                  onPreview({
                                    id: s.id,
                                    kind: 'live',
                                    title: s.name,
                                    url: s.source_url
                                  })
                                }
                              />
                              {s.status === 'running' ? (
                                <IconAction
                                  icon={Square}
                                  tone="amber"
                                  label="Detener"
                                  onClick={() => handleAction(s.id, 'stop')}
                                />
                              ) : (
                                <IconAction
                                  icon={RotateCw}
                                  tone="emerald"
                                  label="Iniciar"
                                  onClick={() => handleAction(s.id, 'start')}
                                />
                              )}
                              <IconAction icon={Edit3} label="Editar canal" onClick={() => openEdit(s)} />
                              <RowMenu
                                items={[
                                  {
                                    icon: Monitor,
                                    label:
                                      probingSingleId === s.id ? 'Midiendo resolución...' : 'Medir resolución real',
                                    disabled: probingSingleId === s.id,
                                    onClick: () => handleProbeSingleStream(s)
                                  },
                                  {
                                    icon: Terminal,
                                    label: 'Ver comando FFmpeg',
                                    onClick: () => showFfmpeg(s)
                                  },
                                  hasSource2
                                    ? {
                                        icon: ArrowLeftRight,
                                        label: s.failover_active
                                          ? 'Volver al SOURCE 1'
                                          : 'Emitir desde SOURCE 2',
                                        onClick: () =>
                                          handleSwitchSource(s, s.failover_active ? 'primary' : 'backup')
                                      }
                                    : null,
                                  {
                                    icon: Layers,
                                    label: `Ordenar en la parrilla (#${
                                      lineupIndexMap.get(s.id) || s.sort_order || s.id
                                    })`,
                                    onClick: () => openOrderModal('streams')
                                  },
                                  { separator: true },
                                  {
                                    icon: Trash2,
                                    label: 'Eliminar canal',
                                    danger: true,
                                    onClick: () => handleDelete(s.id)
                                  }
                                ]}
                              />
                            </div>
                          </td>
                        </tr>
                      </React.Fragment>
                    );
                  });
                })()
              )}
            </tbody>
          </table>
        </div>

        {groupByCat ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/70 bg-[#0b1220]/60 px-4 py-2 text-[11px] text-slate-400">
            <span>
              Vista agrupada · {filtered.length} canales en pantalla (sin paginar)
            </span>
            <button
              type="button"
              onClick={() => setGroupByCat(false)}
              className="font-semibold text-indigo-300 hover:text-white"
            >
              Volver a lista paginada
            </button>
          </div>
        ) : (
          <Pager
            page={safePage}
            pageSize={pageSize}
            total={filtered.length}
            onPage={setPage}
            onPageSize={setPageSize}
          />
        )}
      </div>

      {/* ==================== MODAL: AUDITORÍA DE FUENTES ==================== */}
      {auditOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-4xl rounded-2xl bg-[#0e1526] border border-slate-800 shadow-2xl overflow-hidden">
            <div className="px-5 py-4 bg-[#131c31] border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Globe className="w-5 h-5 text-sky-400" />
                <div>
                  <h3 className="text-sm font-bold text-white">Fuentes de los Canales (quién jala de dónde)</h3>
                  <p className="text-[11px] text-slate-400">
                    Muestra de qué host jala cada canal. El SOURCE 2 es manual: se guarda y no se usa hasta que tú
                    cambies a él en ese canal.
                  </p>
                </div>
              </div>
              <button onClick={() => setAuditOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto text-xs">
              {auditBusy && !auditData && <div className="text-slate-400">Analizando canales...</div>}

              {auditData && (
                <>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="rounded-xl bg-[#090e1a] border border-slate-800 p-3">
                      <div className="text-slate-400 text-[11px]">Canales</div>
                      <div className="text-lg font-bold text-white">{auditData.totalChannels}</div>
                    </div>
                    <div className="rounded-xl bg-[#090e1a] border border-slate-800 p-3">
                      <div className="text-slate-400 text-[11px]">Con SOURCE 2 manual</div>
                      <div className="text-lg font-bold text-violet-300">{auditData.channelsWithBackup}</div>
                    </div>
                    <div className="rounded-xl bg-[#090e1a] border border-slate-800 p-3">
                      <div className="text-slate-400 text-[11px]">Source 1 = Source 2 (mismo host)</div>
                      <div className={`text-lg font-bold ${auditData.sameHostCount ? 'text-amber-300' : 'text-slate-300'}`}>
                        {auditData.sameHostCount}
                      </div>
                    </div>
                  </div>

                  <div className="overflow-x-auto rounded-xl border border-slate-800">
                    <table className="w-full text-left">
                      <thead className="bg-[#131c31] text-[11px] uppercase text-slate-400">
                        <tr>
                          <th className="px-3 py-2">Host</th>
                          <th className="px-3 py-2 text-center">Como principal</th>
                          <th className="px-3 py-2 text-center">Como respaldo</th>
                          <th className="px-3 py-2">Acción</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/70">
                        {auditData.hosts.map((h) => (
                          <tr key={h.host} className="hover:bg-slate-800/25">
                            <td className="px-3 py-2 font-mono text-slate-200">
                              {h.host}
                              <div className="text-[10px] text-slate-500 truncate max-w-[280px]">{h.channels.join(', ')}</div>
                            </td>
                            <td className="px-3 py-2 text-center font-bold text-emerald-300">{h.primary}</td>
                            <td className="px-3 py-2 text-center font-bold text-violet-300">{h.backup}</td>
                            <td className="px-3 py-2">
                              {h.backup > 0 ? (
                                <button
                                  onClick={() => purgeSecondSources(h.host)}
                                  disabled={auditBusy}
                                  className="px-2.5 py-1 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-200 border border-rose-500/35 font-semibold disabled:opacity-40"
                                >
                                  Quitar SOURCE 2 de este host
                                </button>
                              ) : (
                                <span className="text-slate-600">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                        {auditData.hosts.length === 0 && (
                          <tr>
                            <td colSpan={4} className="px-3 py-6 text-center text-slate-500">
                              No hay canales con URL todavía.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  {auditData.sameHostCount > 0 && (
                    <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/35 text-amber-100">
                      Hay {auditData.sameHostCount} canales cuyo SOURCE 2 apunta al <b>mismo host</b> que el principal
                      (no aporta nada y gasta una conexión extra).{' '}
                      <button
                        onClick={async () => {
                          setAuditBusy(true);
                          try {
                            const res = await apiFetch('/api/streams/purge-second-sources', {
                              method: 'POST',
                              body: JSON.stringify({ only_same_host: true })
                            });
                            setBulkNotice(`✅ SOURCE 2 redundantes quitados en ${res.cleared} canales.`);
                            setTimeout(() => setBulkNotice(''), 6000);
                            await Promise.all([loadSourceAudit(), loadAll()]);
                          } catch (err) {
                            window.alert(err.message);
                          } finally {
                            setAuditBusy(false);
                          }
                        }}
                        className="underline font-bold hover:text-white"
                      >
                        Quitarlos ahora
                      </button>
                    </div>
                  )}

                  <div className="flex justify-between items-center pt-2 border-t border-slate-800">
                    <button
                      onClick={() => purgeSecondSources('')}
                      disabled={auditBusy || auditData.channelsWithBackup === 0}
                      className="px-3 py-2 rounded-xl bg-rose-600/80 hover:bg-rose-600 text-white font-semibold disabled:opacity-40"
                    >
                      Quitar TODOS los SOURCE 2 ({auditData.channelsWithBackup})
                    </button>
                    <div className="flex gap-2">
                      <button
                        onClick={loadSourceAudit}
                        disabled={auditBusy}
                        className="px-3 py-2 rounded-xl bg-slate-800 text-slate-200 font-semibold disabled:opacity-40"
                      >
                        {auditBusy ? 'Analizando...' : 'Actualizar'}
                      </button>
                      <button onClick={() => setAuditOpen(false)} className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300">
                        Cerrar
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ==================== MODAL: CAMBIO MASIVO DE IP / PUERTO DE ORIGEN ==================== */}
      {repHostOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-3xl rounded-2xl bg-[#0e1526] border border-slate-800 shadow-2xl overflow-hidden">
            <div className="px-5 py-4 bg-[#131c31] border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Globe className="w-5 h-5 text-sky-400" />
                <div>
                  <h3 className="text-sm font-bold text-white">Cambiar IP / Puerto de Origen</h3>
                  <p className="text-[11px] text-slate-400">
                    Reemplaza el host (y opcionalmente el puerto) de la URL de cada canal. La ruta, el usuario/clave
                    y los parámetros se conservan intactos.
                  </p>
                </div>
              </div>
              <button onClick={() => setRepHostOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-4 max-h-[80vh] overflow-y-auto text-xs">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">IP actual (a buscar)</label>
                  <input
                    value={repHostForm.oldHost}
                    onChange={(e) => setRepHostForm({ ...repHostForm, oldHost: e.target.value })}
                    placeholder="38.226.161.148"
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Puerto actual (opcional)</label>
                  <input
                    value={repHostForm.oldPort}
                    onChange={(e) => setRepHostForm({ ...repHostForm, oldPort: e.target.value })}
                    placeholder="todos"
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">IP / dominio nuevo</label>
                  <input
                    value={repHostForm.newHost}
                    onChange={(e) => setRepHostForm({ ...repHostForm, newHost: e.target.value })}
                    placeholder="nueva.ip.o.dominio"
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Puerto nuevo</label>
                  <input
                    value={repHostForm.newPort}
                    onChange={(e) => setRepHostForm({ ...repHostForm, newPort: e.target.value })}
                    placeholder="conservar"
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">Alcance</label>
                  <select
                    value={repHostForm.scope}
                    onChange={(e) => setRepHostForm({ ...repHostForm, scope: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    <option value="all">Todos los canales ({streams.length})</option>
                    <option value="selected">Sólo seleccionados ({selectedIds.length})</option>
                    <option value="category">Categoría del filtro actual</option>
                  </select>
                </div>
                <button
                  type="button"
                  onClick={() => setRepHostForm({ ...repHostForm, includeBackup: !repHostForm.includeBackup })}
                  className={`flex items-center justify-between gap-2 px-3 py-2 rounded-xl border transition ${
                    repHostForm.includeBackup
                      ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200'
                      : 'bg-[#090e1a] border-slate-800 text-slate-400'
                  }`}
                >
                  <span className="text-left">Incluir URL de respaldo</span>
                  <span className={`w-9 h-5 rounded-full relative shrink-0 ${repHostForm.includeBackup ? 'bg-emerald-500' : 'bg-slate-700'}`}>
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${repHostForm.includeBackup ? 'left-4.5' : 'left-0.5'}`} />
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setRepHostForm({ ...repHostForm, includeExtra: !repHostForm.includeExtra })}
                  className={`flex items-center justify-between gap-2 px-3 py-2 rounded-xl border transition ${
                    repHostForm.includeExtra
                      ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200'
                      : 'bg-[#090e1a] border-slate-800 text-slate-400'
                  }`}
                  title="También actualiza URL original, espejo Astra, canales WK2500 y troncales MNF que usen esa IP"
                >
                  <span className="text-left">Incluir URL original / Astra / WK2500</span>
                  <span className={`w-9 h-5 rounded-full relative shrink-0 ${repHostForm.includeExtra ? 'bg-emerald-500' : 'bg-slate-700'}`}>
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${repHostForm.includeExtra ? 'left-4.5' : 'left-0.5'}`} />
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setRepHostForm({ ...repHostForm, onlyHttp: !repHostForm.onlyHttp })}
                  className={`flex items-center justify-between gap-2 px-3 py-2 rounded-xl border transition ${
                    repHostForm.onlyHttp
                      ? 'bg-sky-500/15 border-sky-500/40 text-sky-200'
                      : 'bg-[#090e1a] border-slate-800 text-slate-400'
                  }`}
                  title="Si lo desactivas también se reescriben fuentes UDP / RTMP / RTSP"
                >
                  <span className="text-left">Sólo fuentes HTTP / HLS</span>
                  <span className={`w-9 h-5 rounded-full relative shrink-0 ${repHostForm.onlyHttp ? 'bg-sky-500' : 'bg-slate-700'}`}>
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${repHostForm.onlyHttp ? 'left-4.5' : 'left-0.5'}`} />
                  </span>
                </button>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => runReplaceHost(false)}
                  disabled={repHostBusy || !repHostForm.newHost.trim()}
                  className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-sky-300 border border-slate-700 font-semibold disabled:opacity-50"
                >
                  {repHostBusy ? 'Revisando…' : '1. Previsualizar cambios'}
                </button>
                <button
                  type="button"
                  onClick={() => runReplaceHost(true)}
                  disabled={repHostBusy || (repHostPreview ? repHostPreview.length : 0) + repHostExtra.length === 0}
                  className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold disabled:opacity-50"
                >
                  2. Aplicar a {(repHostPreview ? repHostPreview.length : 0) + repHostExtra.length} registro(s)
                </button>
                <span className="text-[11px] text-slate-500 self-center">
                  Primero previsualiza: verás exactamente la URL antes y después de cada canal.
                </span>
              </div>

              {repHostExtra.length > 0 && (
                <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-3 space-y-1">
                  <div className="text-[11px] font-semibold text-sky-200">
                    {repHostExtra.length} registro(s) en otras tablas también se actualizarán
                  </div>
                  {repHostExtra.map((x) => (
                    <div key={`${x.table}-${x.id}`} className="font-mono text-[10px] text-slate-300 break-all">
                      [{x.table}] {x.name}: {x.before} → {x.after}
                    </div>
                  ))}
                </div>
              )}

              {repHostPreview && repHostPreview.length > 0 && (
                <div className="rounded-xl border border-slate-800 overflow-hidden">
                  <div className="px-3 py-2 bg-[#131c31] text-[11px] text-slate-300 font-semibold">
                    {repHostPreview.length} canal(es) coinciden
                  </div>
                  <div className="max-h-64 overflow-y-auto divide-y divide-slate-800/70">
                    {repHostPreview.map((p) => (
                      <div key={p.id} className="px-3 py-2 space-y-0.5">
                        <div className="text-slate-200 font-semibold">
                          #{p.id} · {p.name}
                          {p.running && <span className="ml-2 text-[10px] text-amber-300">se reiniciará</span>}
                        </div>
                        <div className="font-mono text-[10px] text-rose-300 break-all">- {p.before}</div>
                        <div className="font-mono text-[10px] text-emerald-300 break-all">+ {p.after}</div>
                        {p.backupBefore && (
                          <div className="font-mono text-[10px] text-slate-500 break-all">
                            respaldo: {p.backupBefore} → {p.backupAfter}
                          </div>
                        )}
                        {(p.extras || []).map((x) => (
                          <div key={x.col} className="font-mono text-[10px] text-sky-300/80 break-all">
                            {x.label}: {x.before} → {x.after}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

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
                    onClick={() => applyPresetInBulkModal('copy_copy_source')}
                    className="p-2.5 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-left transition"
                  >
                    <div className="font-bold text-amber-200">⚡ Copy / Copy — Bitrate Original del Stream</div>
                    <div className="text-[10px] text-slate-300 mt-0.5">
                      Video Copy + Audio Copy • Mantiene intacto el bitrate que trae cada canal • ~0% CPU
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => applyPresetInBulkModal('ondemand_copy_source')}
                    className="p-2.5 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-left transition"
                  >
                    <div className="font-bold text-emerald-300">🌱 On-Demand Copy / Copy — Bitrate Original</div>
                    <div className="text-[10px] text-slate-300 mt-0.5">
                      Ahorra ancho de banda cuando nadie mira el canal • Mantiene el bitrate original
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
                    onChange={(e) => {
                      const val = e.target.value;
                      const selProf = profiles.find((p) => String(p.id) === String(val));
                      const isCopy =
                        selProf &&
                        (selProf.video_codec === 'copy' ||
                          String(selProf.video_bitrate || '').toLowerCase() === 'source');
                      setBulkForm({
                        ...bulkForm,
                        transcode_profile_id: val,
                        bitrate_kbps: isCopy ? '' : bulkForm.bitrate_kbps
                      });
                    }}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    <option value="">— Mantener sin cambios —</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.video_codec}/{p.audio_codec} •{' '}
                        {p.video_codec === 'copy' || p.video_bitrate === 'source'
                          ? 'Bitrate Original'
                          : p.video_bitrate}
                        )
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-slate-300 mb-1">
                    Bitrate Objetivo (dejar vacío = mantener el bitrate que trae el stream)
                  </label>
                  {(() => {
                    const selProf = profiles.find(
                      (p) => String(p.id) === String(bulkForm.transcode_profile_id)
                    );
                    const isCopy =
                      bulkForm.stream_mode === 'direct' ||
                      (selProf &&
                        (selProf.video_codec === 'copy' ||
                          String(selProf.video_bitrate || '').toLowerCase() === 'source'));
                    return isCopy ? (
                      <div className="w-full px-3 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/35 text-emerald-300 font-semibold">
                        ✓ Mantener Bitrate Original del Stream (Sin tocar bitrate)
                      </div>
                    ) : (
                      <input
                        type="number"
                        min="200"
                        max="30000"
                        step="100"
                        value={bulkForm.bitrate_kbps}
                        onChange={(e) => setBulkForm({ ...bulkForm, bitrate_kbps: e.target.value })}
                        placeholder="Mantener el bitrate original del stream"
                        className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                      />
                    );
                  })()}
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
                    <option value="disabled">Sin respaldo (el canal da error si se cae)</option>
                    <option value="custom_image">Imagen Propia en Bucle (elegida por canal)</option>
                    <option value="custom_video">Video Propio en Bucle (elegido por canal)</option>
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

                <div>
                  <label className="block text-slate-300 mb-1">Nivelación de Audio (Volumen Igual)</label>
                  <select
                    value={bulkForm.audio_leveling_mode}
                    onChange={(e) => setBulkForm({ ...bulkForm, audio_leveling_mode: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    <option value="">— Mantener sin cambios —</option>
                    <option value="global">Seguir configuración Global</option>
                    <option value="on">Forzar Audio Nivelado siempre (ON)</option>
                    <option value="off">Desactivar nivelación en estos canales (OFF)</option>
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

                {/* Source adicional (manual): se agrega a mano en este canal, no entra solo */}
                {form.backup_url ? (
                  <div className="mt-2 rounded-xl border border-slate-700 bg-[#0b1120] p-2.5 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold uppercase tracking-wide text-sky-300">Source 2 (manual)</span>
                      <button
                        type="button"
                        onClick={() => setForm({ ...form, backup_url: '' })}
                        className="text-[10px] font-semibold text-rose-300 hover:text-rose-200"
                      >
                        Quitar
                      </button>
                    </div>
                    <input
                      type="text"
                      value={form.backup_url}
                      onChange={(e) => setForm({ ...form, backup_url: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                      placeholder="https://otro-proveedor.com/live/canal/index.m3u8"
                    />
                    <p className="text-[10px] text-slate-500">
                      Se guarda sin usarse. Para emitir desde aquí, pulsa <b className="text-slate-400">⇄</b> en la fila
                      del canal (y otra vez para regresar).
                    </p>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, backup_url: ' ' })}
                    className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-sky-500/10 hover:bg-sky-500/20 text-sky-300 border border-sky-500/30 text-[11px] font-semibold transition"
                    title="Agregar un segundo source solo a este canal (manual, no entra solo)"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Agregar Source
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                      const isCopy =
                        !selP ||
                        selP.video_codec === 'copy' ||
                        String(selP.video_bitrate || '').toLowerCase() === 'source';
                      const brMatch = !isCopy ? String(selP?.video_bitrate || '').match(/^(\d+)/) : null;
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
                        {p.name} ({p.video_codec === 'copy' || p.video_bitrate === 'source' ? 'Bitrate Original' : p.video_bitrate})
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
                    <option value="disabled">Sin respaldo (recomendado)</option>
                    <option value="custom_image">Imagen Propia en Bucle</option>
                    <option value="custom_video">Video Propio en Bucle</option>
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

                <div>
                  <label className="block text-slate-300 mb-1 font-medium">
                    🔊 Nivelación de Audio (Volumen Igual)
                  </label>
                  <select
                    value={form.audio_leveling_mode || 'global'}
                    onChange={(e) => setForm({ ...form, audio_leveling_mode: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#0e1526] border border-slate-700 text-white"
                  >
                    <option value="global">Seguir configuración Global ({audioConfig.enabled ? 'ON' : 'OFF'})</option>
                    <option value="on">Forzar Audio Nivelado siempre (ON)</option>
                    <option value="off">Sin nivelar en este canal (OFF)</option>
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
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <span className="font-bold text-white">
                      {editingProfId ? `Editando Perfil #${editingProfId}` : '+ Nuevo Perfil FFmpeg'}
                    </span>
                    <div className="flex items-center gap-1 flex-wrap">
                      <button
                        type="button"
                        onClick={() =>
                          setProfForm({
                            name: 'Copy / Copy (Bitrate Original · Zero CPU)',
                            video_codec: 'copy',
                            audio_codec: 'copy',
                            video_bitrate: 'source',
                            audio_bitrate: 'copy',
                            resolution: 'source',
                            preset: 'none',
                            hwaccel: 'none',
                            extra_flags: '-fflags +genpts+igndts+nobuffer -max_muxing_queue_size 1024'
                          })
                        }
                        className="px-2 py-0.5 rounded font-mono text-[10px] border bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                      >
                        ⚡ Copy/Copy (Bitrate Original)
                      </button>
                      {profForm.video_codec !== 'copy' &&
                        [
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
                      placeholder="Copy / Copy (Bitrate Original · Zero CPU)"
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
                          const isCopy = vc === 'copy';
                          setProfForm({
                            ...profForm,
                            video_codec: vc,
                            audio_codec: isCopy ? 'copy' : profForm.audio_codec === 'copy' ? 'aac' : profForm.audio_codec,
                            video_bitrate: isCopy ? 'source' : profForm.video_bitrate === 'source' ? '2500k' : profForm.video_bitrate,
                            audio_bitrate: isCopy ? 'copy' : profForm.audio_bitrate === 'copy' ? '128k' : profForm.audio_bitrate,
                            resolution: isCopy ? 'source' : profForm.resolution === 'source' ? '1280x720' : profForm.resolution,
                            preset: isCopy ? 'none' : profForm.preset === 'none' ? 'ultrafast' : profForm.preset,
                            hwaccel: vc === 'h264_nvenc' ? 'nvenc' : vc === 'h264_qsv' ? 'qsv' : 'none',
                            extra_flags: isCopy
                              ? '-fflags +genpts+igndts+nobuffer -max_muxing_queue_size 1024'
                              : profForm.extra_flags
                          });
                        }}
                        className="w-full px-3 py-2 rounded-xl bg-[#0e1526] border border-slate-700 text-white"
                      >
                        <option value="copy">Copy (Sin recodificar · Bitrate Original)</option>
                        <option value="libx264">CPU libx264</option>
                        <option value="h264_nvenc">NVIDIA NVENC</option>
                        <option value="h264_qsv">Intel QSV</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Codec Audio</label>
                      <select
                        value={profForm.audio_codec}
                        onChange={(e) => {
                          const ac = e.target.value;
                          setProfForm({
                            ...profForm,
                            audio_codec: ac,
                            audio_bitrate: ac === 'copy' ? 'copy' : profForm.audio_bitrate === 'copy' ? '128k' : profForm.audio_bitrate
                          });
                        }}
                        className="w-full px-3 py-2 rounded-xl bg-[#0e1526] border border-slate-700 text-white"
                      >
                        <option value="copy">Copy (Original)</option>
                        <option value="aac">AAC Estéreo</option>
                        <option value="mp2">MP2 Broadcast</option>
                        <option value="mp3">MP3</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Bitrate Video</label>
                      {profForm.video_codec === 'copy' ? (
                        <div className="w-full px-2.5 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/35 text-emerald-300 font-mono text-[11px] font-semibold">
                          source (Original)
                        </div>
                      ) : (
                        <input
                          type="text"
                          value={profForm.video_bitrate}
                          onChange={(e) => setProfForm({ ...profForm, video_bitrate: e.target.value })}
                          placeholder="2500k"
                          className="w-full px-3 py-2 rounded-xl bg-[#0e1526] border border-slate-700 text-white font-mono"
                        />
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="block text-slate-400 mb-1">Resolución</label>
                      <select
                        value={profForm.resolution}
                        disabled={profForm.video_codec === 'copy'}
                        onChange={(e) => setProfForm({ ...profForm, resolution: e.target.value })}
                        className="w-full px-2.5 py-2 rounded-xl bg-[#0e1526] border border-slate-700 text-white disabled:opacity-50"
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
                        disabled={profForm.video_codec === 'copy'}
                        onChange={(e) => setProfForm({ ...profForm, preset: e.target.value })}
                        className="w-full px-2.5 py-2 rounded-xl bg-[#0e1526] border border-slate-700 text-white disabled:opacity-50"
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
                        disabled={profForm.audio_codec === 'copy'}
                        onChange={(e) => setProfForm({ ...profForm, audio_bitrate: e.target.value })}
                        className="w-full px-2.5 py-2 rounded-xl bg-[#0e1526] border border-slate-700 text-white font-mono disabled:opacity-50"
                      >
                        <option value="copy">copy</option>
                        <option value="96k">96k</option>
                        <option value="128k">128k</option>
                        <option value="160k">160k</option>
                        <option value="192k">192k</option>
                        <option value="256k">256k</option>
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
                          {p.video_codec}/{p.audio_codec} •{' '}
                          {p.video_codec === 'copy' || p.video_bitrate === 'source'
                            ? 'Bitrate Original (source)'
                            : p.video_bitrate}{' '}
                          • {p.resolution}
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
                              video_bitrate:
                                p.video_codec === 'copy' ? 'source' : p.video_bitrate || '2500k',
                              audio_bitrate:
                                p.audio_codec === 'copy' ? 'copy' : p.audio_bitrate || '128k',
                              resolution: p.video_codec === 'copy' ? 'source' : p.resolution || '1280x720',
                              preset: p.video_codec === 'copy' ? 'none' : p.preset || 'ultrafast',
                              hwaccel: p.video_codec === 'copy' ? 'none' : p.hwaccel || 'none',
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
                              try {
                                await apiFetch(`/api/profiles/${p.id}`, { method: 'DELETE' });
                                if (editingProfId === p.id) {
                                  setEditingProfId(null);
                                  setProfForm(EMPTY_PROF);
                                }
                                setProfNotice(`🗑️ Perfil "${p.name}" eliminado.`);
                                loadAll();
                              } catch (err) {
                                setProfNotice(`❌ ${err.message}`);
                              }
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
              <div className="p-3.5 rounded-xl bg-[#090e1a] border border-slate-800 space-y-3">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex-1 min-w-[170px]">
                    <label className="block text-slate-400 mb-1">Aplicar en lote a</label>
                    <select
                      value={bulkCat}
                      onChange={(e) => setBulkCat(e.target.value)}
                      className="w-full px-3 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white"
                    >
                      <option value="all">Todos los canales ({streams.length})</option>
                      {selectedIds.length > 0 && (
                        <option value="selected">Canales seleccionados con check ({selectedIds.length})</option>
                      )}
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          Categoría: {c.name}
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
                  <div className="flex-1 min-w-[190px]">
                    <label className="block text-slate-400 mb-1">Perfil FFmpeg</label>
                    <select
                      value={bulkProfId}
                      onChange={(e) => setBulkProfId(Number(e.target.value))}
                      className="w-full px-3 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white"
                    >
                      {profiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} (
                          {p.video_codec === 'copy' || p.video_bitrate === 'source'
                            ? 'Bitrate Original'
                            : p.video_bitrate}
                          )
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

                {(() => {
                  const chosenProf = profiles.find((p) => p.id === Number(bulkProfId));
                  const isCopy =
                    bulkMode === 'direct' ||
                    !chosenProf ||
                    chosenProf.video_codec === 'copy' ||
                    String(chosenProf.video_bitrate || '').toLowerCase() === 'source';
                  return (
                    <label className="inline-flex items-center gap-2 text-xs text-emerald-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isCopy ? true : bulkKeepBitrate}
                        disabled={isCopy}
                        onChange={(e) => setBulkKeepBitrate(e.target.checked)}
                        className="rounded accent-emerald-500"
                      />
                      <span>
                        <strong>Mantener intacto el bitrate original que trae cada stream</strong> (sin tocar ni modificar bitrate)
                      </span>
                    </label>
                  );
                })()}
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

      {/* Auto-Resolution Classifier Modal (SD/480p/540p -> 1.0M, HD 720p -> 2.5M, FHD 1080p -> 3.0M) */}
      {autoResOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-2xl rounded-2xl bg-[#0e1526] border border-emerald-500/35 p-6 space-y-5 max-h-[92vh] overflow-y-auto shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <Monitor className="w-5 h-5 text-emerald-400" />
                  Auto-Clasificador Inteligente por Resolución (1M / 2.5M / 3M)
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Distingue automáticamente cada canal y aplica el bitrate exacto según su resolución real
                </p>
              </div>
              <button
                onClick={() => setAutoResOpen(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleRunAutoResolution} className="space-y-4">
              {/* 1-Click Permanent Auto-Pilot Banner */}
              <div
                className={`p-4 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                  autoResStatus?.pilot?.enabled
                    ? 'bg-emerald-500/15 border-emerald-400/50'
                    : 'bg-[#090e1a] border-slate-700'
                }`}
              >
                <div className="space-y-1">
                  <div className="text-xs font-bold text-white flex items-center gap-2">
                    <span>🤖 Auto-Piloto Permanente (Que se cambien solos)</span>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        autoResStatus?.pilot?.enabled
                          ? 'bg-emerald-500 text-slate-950'
                          : 'bg-slate-800 text-slate-400'
                      }`}
                    >
                      {autoResStatus?.pilot?.enabled ? 'ACTIVADO' : 'APAGADO'}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-300 leading-relaxed">
                    Al activarlo, el panel saca tus canales del perfil fijo <strong>Copy/Copy 2.5M</strong>, mide sus píxeles reales (<strong>≤580p = SD 1M</strong>, <strong>720p = HD 2.5M</strong>, <strong>1080p = FHD 3M</strong>) y vigila en segundo plano cualquier canal nuevo o que cambie de calidad para ajustarlo solo.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleToggleAutoPilot(!autoResStatus?.pilot?.enabled)}
                  className={`px-4 py-2.5 rounded-xl text-xs font-bold shrink-0 transition shadow-lg ${
                    autoResStatus?.pilot?.enabled
                      ? 'bg-slate-800 hover:bg-rose-600/30 text-rose-300 border border-rose-500/40'
                      : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950'
                  }`}
                >
                  {autoResStatus?.pilot?.enabled
                    ? 'Desactivar Auto-Piloto'
                    : '⚡ Activar Auto-Piloto Ahora'}
                </button>
              </div>

              {/* 3 Bitrate Tiers */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="p-3.5 rounded-xl bg-teal-500/10 border border-teal-500/30 space-y-1.5">
                  <div className="text-xs font-bold text-teal-300">SD / 480p / 540p</div>
                  <div className="text-[11px] text-slate-400">Altura ≤ 580 px</div>
                  <div className="flex items-center gap-1.5 pt-1">
                    <input
                      type="number"
                      min={300}
                      max={8000}
                      step={100}
                      value={autoResForm.sdKbps}
                      onChange={(e) =>
                        setAutoResForm({ ...autoResForm, sdKbps: Number(e.target.value) })
                      }
                      className="w-full px-2.5 py-1.5 rounded-lg bg-[#090e1a] border border-teal-500/40 text-xs font-mono font-bold text-white"
                    />
                    <span className="text-[11px] text-teal-300 font-semibold shrink-0">kbps</span>
                  </div>
                  <div className="text-[10px] text-teal-200/80 font-mono">
                    = {(Number(autoResForm.sdKbps || 1000) / 1000).toFixed(1)} Mbps
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-cyan-500/10 border border-cyan-500/30 space-y-1.5">
                  <div className="text-xs font-bold text-cyan-300">HD 720p</div>
                  <div className="text-[11px] text-slate-400">Altura 581 – 800 px</div>
                  <div className="flex items-center gap-1.5 pt-1">
                    <input
                      type="number"
                      min={500}
                      max={12000}
                      step={100}
                      value={autoResForm.hdKbps}
                      onChange={(e) =>
                        setAutoResForm({ ...autoResForm, hdKbps: Number(e.target.value) })
                      }
                      className="w-full px-2.5 py-1.5 rounded-lg bg-[#090e1a] border border-cyan-500/40 text-xs font-mono font-bold text-white"
                    />
                    <span className="text-[11px] text-cyan-300 font-semibold shrink-0">kbps</span>
                  </div>
                  <div className="text-[10px] text-cyan-200/80 font-mono">
                    = {(Number(autoResForm.hdKbps || 2500) / 1000).toFixed(1)} Mbps
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 space-y-1.5">
                  <div className="text-xs font-bold text-amber-300">FHD 1080p / 4K</div>
                  <div className="text-[11px] text-slate-400">Altura &gt; 800 px</div>
                  <div className="flex items-center gap-1.5 pt-1">
                    <input
                      type="number"
                      min={1000}
                      max={20000}
                      step={100}
                      value={autoResForm.fhdKbps}
                      onChange={(e) =>
                        setAutoResForm({ ...autoResForm, fhdKbps: Number(e.target.value) })
                      }
                      className="w-full px-2.5 py-1.5 rounded-lg bg-[#090e1a] border border-amber-500/40 text-xs font-mono font-bold text-white"
                    />
                    <span className="text-[11px] text-amber-300 font-semibold shrink-0">kbps</span>
                  </div>
                  <div className="text-[10px] text-amber-200/80 font-mono">
                    = {(Number(autoResForm.fhdKbps || 3000) / 1000).toFixed(1)} Mbps
                  </div>
                </div>
              </div>

              {/* Scope & Detection Method */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    ¿A qué canales aplicar?
                  </label>
                  <select
                    value={autoResForm.scope}
                    onChange={(e) => setAutoResForm({ ...autoResForm, scope: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-xs text-white"
                  >
                    <option value="all">Todos los canales del panel ({streams.length})</option>
                    <option value="selected" disabled={selectedIds.length === 0}>
                      Solo canales seleccionados ({selectedIds.length})
                    </option>
                    <option value="category">Por categoría específica</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Método para distinguir resolución
                  </label>
                  <select
                    value={autoResForm.probeLive ? 'live' : 'name'}
                    onChange={(e) =>
                      setAutoResForm({ ...autoResForm, probeLive: e.target.value === 'live' })
                    }
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-xs text-white"
                  >
                    <option value="live">
                      🔍 Medir video en vivo (FFmpeg + HLS Master + Respaldo Nombre)
                    </option>
                    <option value="name">
                      ⚡ Instantáneo por etiquetas del nombre (SD / 540p / HD / FHD)
                    </option>
                  </select>
                </div>
              </div>

              {autoResForm.scope === 'category' && (
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Categoría objetivo
                  </label>
                  <select
                    value={autoResForm.category_id}
                    onChange={(e) =>
                      setAutoResForm({ ...autoResForm, category_id: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-xs text-white"
                  >
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Engine Mode Selector */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Modo de aplicación del Bitrate en tu Servidor
                </label>
                <select
                  value={autoResForm.stream_mode}
                  onChange={(e) =>
                    setAutoResForm({ ...autoResForm, stream_mode: e.target.value })
                  }
                  className="w-full px-3 py-2.5 rounded-xl bg-[#090e1a] border border-emerald-500/40 text-xs text-white font-medium"
                >
                  <option value="ondemand">
                    🌱 On-Demand H.264 (Recomendado en Core i3: comprime a 1M / 2.5M / 3M solo al canal que alguien esté viendo)
                  </option>
                  <option value="copy_transcode">
                    ⚡ Copy / Copy 24/7 Clasificado (0% CPU: distingue SD/HD/FHD y mantiene video original en RAMDisk)
                  </option>
                  <option value="copy_ondemand">
                    ⚡ Copy / Copy On-Demand Clasificado (0% CPU + arranque bajo demanda)
                  </option>
                  <option value="transcode">
                    🔥 Transcodificación H.264 24/7 Fija (Usar solo en pocos canales o CPU Xeon/Ryzen multinúcleo)
                  </option>
                </select>
              </div>

              {/* Live Progress & Results Box */}
              {autoResStatus && (autoResStatus.running || autoResStatus.completed > 0) && (
                <div className="p-4 rounded-xl bg-[#070b13] border border-slate-800 space-y-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-white">
                      {autoResStatus.running
                        ? `Analizando en paralelo: ${autoResStatus.currentChannel || '...'}`
                        : '✅ Clasificación y asignación completada'}
                    </span>
                    <span className="font-mono text-emerald-300 font-bold">
                      {autoResStatus.completed} / {autoResStatus.total}
                    </span>
                  </div>

                  <div className="w-full h-2.5 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-teal-500 via-cyan-500 to-emerald-400 transition-all duration-300"
                      style={{
                        width: `${
                          autoResStatus.total > 0
                            ? Math.round((autoResStatus.completed / autoResStatus.total) * 100)
                            : 0
                        }%`
                      }}
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-center text-[11px]">
                    <div className="p-2 rounded-lg bg-teal-500/10 border border-teal-500/25 text-teal-300 font-semibold">
                      SD / 480p / 540p: <span className="font-mono font-bold">{autoResStatus.countsByTier?.sd || 0}</span>
                    </div>
                    <div className="p-2 rounded-lg bg-cyan-500/10 border border-cyan-500/25 text-cyan-300 font-semibold">
                      HD 720p: <span className="font-mono font-bold">{autoResStatus.countsByTier?.hd || 0}</span>
                    </div>
                    <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/25 text-amber-300 font-semibold">
                      FHD 1080p: <span className="font-mono font-bold">{autoResStatus.countsByTier?.fhd || 0}</span>
                    </div>
                  </div>

                  {Array.isArray(autoResStatus.recentResults) &&
                    autoResStatus.recentResults.length > 0 && (
                      <div className="max-h-36 overflow-y-auto space-y-1 pt-1 border-t border-slate-800/80">
                        {autoResStatus.recentResults.map((r) => (
                          <div
                            key={r.id}
                            className="flex items-center justify-between text-[11px] px-2 py-1 rounded bg-slate-900/70"
                          >
                            <span className="text-slate-200 truncate max-w-[240px]">{r.name}</span>
                            <span className="font-mono text-slate-400">
                              {r.resolution} ({r.tierLabel}) →{' '}
                              <strong className="text-emerald-300">{r.bitrateKbps} kbps</strong>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setAutoResOpen(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold"
                >
                  Cerrar
                </button>
                <button
                  type="submit"
                  disabled={autoResStatus?.running}
                  className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold transition shadow-lg shadow-emerald-950/50"
                >
                  <Monitor className="w-4 h-4" />
                  {autoResStatus?.running
                    ? 'Analizando canales...'
                    : 'Detectar Resolución y Aplicar 1M / 2.5M / 3M'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Channel & Category Lineup Organizer Modal */}
      {orderModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-4xl rounded-2xl bg-[#0e1526] border border-sky-500/35 p-6 flex flex-col max-h-[92vh] shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-slate-800 pb-3 shrink-0">
              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <ArrowUpDown className="w-5 h-5 text-sky-400" />
                  Organizador de Parrilla — Cómo se muestran los Canales y Categorías
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  El orden guardado aquí se aplica en vivo a IPTV Smarters, TiviMate, XCIPTV, Listas M3U (tvg-chno), Stalker MAG y WebTV
                </p>
              </div>
              <button
                onClick={() => setOrderModalOpen(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Tabs */}
            <div className="flex items-center gap-2 pt-3 shrink-0">
              <button
                type="button"
                onClick={() => setOrderTab('streams')}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition border ${
                  orderTab === 'streams'
                    ? 'bg-sky-500/20 text-sky-200 border-sky-400/50'
                    : 'bg-[#090e1a] text-slate-400 border-slate-800 hover:text-white'
                }`}
              >
                📺 Orden de Canales ({orderStreamsList.length})
              </button>
              <button
                type="button"
                onClick={() => setOrderTab('categories')}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition border ${
                  orderTab === 'categories'
                    ? 'bg-indigo-500/20 text-indigo-200 border-indigo-400/50'
                    : 'bg-[#090e1a] text-slate-400 border-slate-800 hover:text-white'
                }`}
              >
                📂 Orden de Categorías ({orderCatsList.length})
              </button>
            </div>

            {orderTab === 'streams' ? (
              <>
                {/* Filter + Search + Smart Auto-Sort Presets */}
                <div className="pt-3 space-y-2.5 shrink-0">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <select
                      value={orderCatFilter}
                      onChange={(e) => handleChangeOrderCatFilter(e.target.value)}
                      className="px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-xs text-white"
                    >
                      <option value="all">
                        Parrilla Global Completa ({streams.length} canales)
                      </option>
                      {categories.map((c) => (
                        <option key={c.id} value={String(c.id)}>
                          Solo categoría: {c.name}
                        </option>
                      ))}
                    </select>

                    <div className="relative">
                      <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-2.5" />
                      <input
                        type="text"
                        value={orderSearch}
                        onChange={(e) => setOrderSearch(e.target.value)}
                        placeholder="Filtrar rápido para encontrar un canal y cambiar su # posición..."
                        className="w-full pl-8 pr-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-xs text-white"
                      />
                    </div>
                  </div>

                  {/* Quick Auto-Sort Buttons */}
                  <div className="flex flex-wrap items-center gap-1.5 bg-[#090e1a] p-2.5 rounded-xl border border-slate-800">
                    <span className="text-[11px] text-slate-400 font-semibold mr-1">
                      Orden rápido:
                    </span>
                    <button
                      type="button"
                      onClick={() => applySmartSortPreset('cat_alpha')}
                      className="px-2.5 py-1 rounded-lg bg-sky-500/15 hover:bg-sky-500/30 text-sky-200 border border-sky-500/30 text-[11px] font-semibold transition"
                    >
                      📂 Por Categorías + A→Z
                    </button>
                    <button
                      type="button"
                      onClick={() => applySmartSortPreset('cat_keep')}
                      className="px-2.5 py-1 rounded-lg bg-indigo-500/15 hover:bg-indigo-500/30 text-indigo-200 border border-indigo-500/30 text-[11px] font-semibold transition"
                    >
                      📂 Agrupar por Categorías
                    </button>
                    <button
                      type="button"
                      onClick={() => applySmartSortPreset('az')}
                      className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-[11px] font-semibold transition"
                    >
                      A → Z
                    </button>
                    <button
                      type="button"
                      onClick={() => applySmartSortPreset('za')}
                      className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-[11px] font-semibold transition"
                    >
                      Z → A
                    </button>
                    <button
                      type="button"
                      onClick={() => applySmartSortPreset('quality')}
                      className="px-2.5 py-1 rounded-lg bg-amber-500/15 hover:bg-amber-500/30 text-amber-200 border border-amber-500/30 text-[11px] font-semibold transition"
                    >
                      💎 Calidad (FHD → HD → SD)
                    </button>
                    <button
                      type="button"
                      onClick={() => applySmartSortPreset('id_asc')}
                      className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-[11px] font-semibold transition"
                    >
                      # ID Original
                    </button>
                  </div>
                </div>

                {/* Scrollable Draggable Channel List */}
                <div className="my-3 flex-1 overflow-y-auto rounded-xl bg-[#070b13] border border-slate-800 divide-y divide-slate-800/70">
                  {orderStreamsList.length === 0 ? (
                    <div className="p-8 text-center text-xs text-slate-500">
                      No hay canales en esta selección.
                    </div>
                  ) : (
                    orderStreamsList.map((st, realIdx) => {
                      if (
                        orderSearch.trim() &&
                        !st.name.toLowerCase().includes(orderSearch.trim().toLowerCase()) &&
                        !String(st.category_name || '')
                          .toLowerCase()
                          .includes(orderSearch.trim().toLowerCase())
                      ) {
                        return null;
                      }
                      const isDragTarget = dragOverIdx === realIdx && dragIdx !== null && dragIdx !== realIdx;
                      return (
                        <div
                          key={`${st.id}-${realIdx}`}
                          draggable={!orderSearch.trim()}
                          onDragStart={() => setDragIdx(realIdx)}
                          onDragOver={(e) => {
                            e.preventDefault();
                            if (dragOverIdx !== realIdx) setDragOverIdx(realIdx);
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            if (dragIdx !== null && dragIdx !== realIdx) {
                              moveStreamInModal(dragIdx, realIdx);
                            }
                            setDragIdx(null);
                            setDragOverIdx(null);
                          }}
                          onDragEnd={() => {
                            setDragIdx(null);
                            setDragOverIdx(null);
                          }}
                          className={`flex items-center justify-between gap-2 px-3 py-2 text-xs transition ${
                            isDragTarget
                              ? 'bg-sky-500/20 border-t-2 border-sky-400'
                              : 'hover:bg-slate-800/40'
                          }`}
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            {!orderSearch.trim() && (
                              <GripVertical
                                className="w-4 h-4 text-slate-500 hover:text-sky-300 cursor-grab shrink-0"
                                title="Arrastra para mover este canal"
                              />
                            )}

                            {/* Direct # Position Input */}
                            <div className="flex items-center gap-1 shrink-0" title="Escribe el número de puesto y pulsa Enter">
                              <span className="text-[10px] text-slate-500 font-mono">#</span>
                              <input
                                type="number"
                                min={1}
                                max={orderStreamsList.length}
                                defaultValue={realIdx + 1}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault();
                                    const val = parseInt(e.currentTarget.value, 10);
                                    if (!Number.isNaN(val)) moveStreamInModal(realIdx, val - 1);
                                  }
                                }}
                                onBlur={(e) => {
                                  const val = parseInt(e.currentTarget.value, 10);
                                  if (!Number.isNaN(val) && val - 1 !== realIdx) {
                                    moveStreamInModal(realIdx, val - 1);
                                  }
                                }}
                                className="w-14 px-1.5 py-1 rounded-lg bg-[#0e1526] border border-slate-700 focus:border-sky-400 text-center font-mono font-bold text-sky-300 text-xs"
                              />
                            </div>

                            {st.logo_url ? (
                              <img
                                src={st.logo_url}
                                alt={st.name}
                                className="w-7 h-7 rounded bg-slate-800 object-cover shrink-0"
                              />
                            ) : (
                              <div className="w-7 h-7 rounded bg-slate-800 flex items-center justify-center shrink-0">
                                <Radio className="w-3.5 h-3.5 text-indigo-400" />
                              </div>
                            )}

                            <div className="min-w-0">
                              <div className="font-semibold text-white truncate">{st.name}</div>
                              <div className="text-[10px] text-slate-400 flex items-center gap-1.5">
                                <span>{st.category_name || 'General'}</span>
                                {st.resolution_tier && (
                                  <span className="px-1.5 py-0.2 rounded bg-slate-800 text-cyan-300 font-mono">
                                    {st.resolution_tier.toUpperCase()}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* 4 Quick Move Buttons */}
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              disabled={realIdx === 0}
                              onClick={() => moveStreamInModal(realIdx, 0)}
                              title="Enviar al puesto #1 (Inicio)"
                              className="p-1.5 rounded-lg bg-slate-800 hover:bg-sky-600/30 disabled:opacity-30 text-slate-300 hover:text-sky-200 transition"
                            >
                              <ChevronsUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              disabled={realIdx === 0}
                              onClick={() => moveStreamInModal(realIdx, realIdx - 1)}
                              title="Subir 1 puesto"
                              className="p-1.5 rounded-lg bg-slate-800 hover:bg-sky-600/30 disabled:opacity-30 text-slate-300 hover:text-sky-200 transition"
                            >
                              <ArrowUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              disabled={realIdx === orderStreamsList.length - 1}
                              onClick={() => moveStreamInModal(realIdx, realIdx + 1)}
                              title="Bajar 1 puesto"
                              className="p-1.5 rounded-lg bg-slate-800 hover:bg-sky-600/30 disabled:opacity-30 text-slate-300 hover:text-sky-200 transition"
                            >
                              <ArrowDown className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              disabled={realIdx === orderStreamsList.length - 1}
                              onClick={() => moveStreamInModal(realIdx, orderStreamsList.length - 1)}
                              title="Enviar al final"
                              className="p-1.5 rounded-lg bg-slate-800 hover:bg-sky-600/30 disabled:opacity-30 text-slate-300 hover:text-sky-200 transition"
                            >
                              <ChevronsDown className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Footer Save Channels */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-2 border-t border-slate-800 shrink-0">
                  <div className="text-[11px] text-slate-400">
                    💡 Arrastra filas, usa las flechas o escribe directamente el <strong># número</strong> y pulsa Enter.
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setOrderModalOpen(false)}
                      className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold"
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      disabled={orderSaving}
                      onClick={handleSaveStreamsOrder}
                      className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-xs font-bold transition shadow-lg shadow-sky-950/50"
                    >
                      <Save className="w-4 h-4" />
                      {orderSaving ? 'Guardando...' : 'Guardar Orden de Canales'}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
                {/* Tab 2: Categories Ordering & Inline Rename */}
                <div className="pt-3 space-y-2 shrink-0">
                  <div className="p-3 rounded-xl bg-[#090e1a] border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <label className="inline-flex items-center gap-2 text-xs text-slate-200 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={packStreamsOnCatSave}
                        onChange={(e) => setPackStreamsOnCatSave(e.target.checked)}
                        className="rounded accent-indigo-500"
                      />
                      <span>
                        Reagrupar también los <strong>{streams.length} canales</strong> siguiendo este orden de categorías
                      </span>
                    </label>

                    {packStreamsOnCatSave && (
                      <label className="inline-flex items-center gap-2 text-xs text-indigo-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={alphaInsideCatSave}
                          onChange={(e) => setAlphaInsideCatSave(e.target.checked)}
                          className="rounded accent-indigo-500"
                        />
                        <span>Ordenar A→Z dentro de cada categoría</span>
                      </label>
                    )}
                  </div>
                </div>

                <div className="my-3 flex-1 overflow-y-auto rounded-xl bg-[#070b13] border border-slate-800 divide-y divide-slate-800/70">
                  {orderCatsList.length === 0 ? (
                    <div className="p-8 text-center text-xs text-slate-500">
                      No hay categorías en vivo creadas.
                    </div>
                  ) : (
                    orderCatsList.map((cat, idx) => {
                      const countInCat = streams.filter((s) => s.category_id === cat.id).length;
                      return (
                        <div
                          key={`${cat.id}-${idx}`}
                          draggable
                          onDragStart={() => setDragIdx(idx)}
                          onDragOver={(e) => {
                            e.preventDefault();
                            if (dragOverIdx !== idx) setDragOverIdx(idx);
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            if (dragIdx !== null && dragIdx !== idx) {
                              moveCategoryInModal(dragIdx, idx);
                            }
                            setDragIdx(null);
                            setDragOverIdx(null);
                          }}
                          onDragEnd={() => {
                            setDragIdx(null);
                            setDragOverIdx(null);
                          }}
                          className="flex items-center justify-between gap-2 px-3 py-2.5 text-xs hover:bg-slate-800/40 transition"
                        >
                          <div className="flex items-center gap-2.5 min-w-0 flex-1">
                            <GripVertical className="w-4 h-4 text-slate-500 hover:text-indigo-300 cursor-grab shrink-0" />
                            <input
                              type="number"
                              min={1}
                              max={orderCatsList.length}
                              defaultValue={idx + 1}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  const val = parseInt(e.currentTarget.value, 10);
                                  if (!Number.isNaN(val)) moveCategoryInModal(idx, val - 1);
                                }
                              }}
                              onBlur={(e) => {
                                const val = parseInt(e.currentTarget.value, 10);
                                if (!Number.isNaN(val) && val - 1 !== idx) {
                                  moveCategoryInModal(idx, val - 1);
                                }
                              }}
                              className="w-12 px-1.5 py-1 rounded-lg bg-[#0e1526] border border-slate-700 text-center font-mono font-bold text-indigo-300 text-xs shrink-0"
                            />

                            {editingCatId === cat.id ? (
                              <div className="flex items-center gap-1.5 flex-1">
                                <input
                                  type="text"
                                  value={editingCatName}
                                  onChange={(e) => setEditingCatName(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleRenameCategoryInline(cat.id);
                                  }}
                                  className="px-2.5 py-1 rounded-lg bg-[#0e1526] border border-indigo-500 text-white text-xs flex-1 max-w-xs"
                                  autoFocus
                                />
                                <button
                                  type="button"
                                  onClick={() => handleRenameCategoryInline(cat.id)}
                                  className="px-2.5 py-1 rounded-lg bg-emerald-600 text-white font-semibold text-[11px]"
                                >
                                  OK
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingCatId(null)}
                                  className="px-2 py-1 rounded-lg bg-slate-800 text-slate-400 text-[11px]"
                                >
                                  ✕
                                </button>
                              </div>
                            ) : (
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="font-semibold text-white truncate">{cat.name}</span>
                                <span className="px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 text-[10px] font-mono">
                                  {countInCat} canales
                                </span>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingCatId(cat.id);
                                    setEditingCatName(cat.name);
                                  }}
                                  title="Renombrar categoría"
                                  className="text-slate-500 hover:text-indigo-300 p-1"
                                >
                                  <Edit3 className="w-3 h-3" />
                                </button>
                              </div>
                            )}
                          </div>

                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() => moveCategoryInModal(idx, 0)}
                              className="p-1.5 rounded-lg bg-slate-800 hover:bg-indigo-600/30 disabled:opacity-30 text-slate-300"
                              title="Enviar al #1"
                            >
                              <ChevronsUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() => moveCategoryInModal(idx, idx - 1)}
                              className="p-1.5 rounded-lg bg-slate-800 hover:bg-indigo-600/30 disabled:opacity-30 text-slate-300"
                              title="Subir"
                            >
                              <ArrowUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              disabled={idx === orderCatsList.length - 1}
                              onClick={() => moveCategoryInModal(idx, idx + 1)}
                              className="p-1.5 rounded-lg bg-slate-800 hover:bg-indigo-600/30 disabled:opacity-30 text-slate-300"
                              title="Bajar"
                            >
                              <ArrowDown className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              disabled={idx === orderCatsList.length - 1}
                              onClick={() => moveCategoryInModal(idx, orderCatsList.length - 1)}
                              className="p-1.5 rounded-lg bg-slate-800 hover:bg-indigo-600/30 disabled:opacity-30 text-slate-300"
                              title="Enviar al final"
                            >
                              <ChevronsDown className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800 shrink-0">
                  <button
                    type="button"
                    onClick={() => setOrderModalOpen(false)}
                    className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    disabled={orderSaving}
                    onClick={handleSaveCategoriesOrder}
                    className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-bold transition shadow-lg shadow-indigo-950/50"
                  >
                    <Save className="w-4 h-4" />
                    {orderSaving ? 'Guardando...' : 'Guardar Orden de Categorías'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Global Uniform Audio Leveling Modal */}
      {audioModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-2xl rounded-2xl bg-[#0e1526] border border-amber-500/40 p-6 space-y-5 max-h-[92vh] overflow-y-auto shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <Volume2 className="w-5 h-5 text-amber-400" />
                  Nivelador Global de Audio — Mismo Volumen en Todos los Canales
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Empareja canales bajos, frena comerciales fuertes y convierte Dolby 5.1 a Estéreo 48 kHz sin perder lip-sync
                </p>
              </div>
              <button
                onClick={() => setAudioModalOpen(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {audioNotice && (
              <div className="p-3 rounded-xl bg-amber-500/15 border border-amber-400/40 text-xs text-amber-100 font-medium">
                {audioNotice}
              </div>
            )}

            {/* Master Switch Card */}
            <div
              className={`p-4 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                audioConfig.enabled
                  ? 'bg-amber-500/15 border-amber-400/50'
                  : 'bg-[#090e1a] border-slate-700'
              }`}
            >
              <div className="space-y-1">
                <div className="text-xs font-bold text-white flex items-center gap-2">
                  <span>🔊 Estado Global de Audio Nivelado</span>
                  <span
                    className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                      audioConfig.enabled
                        ? 'bg-amber-400 text-slate-950'
                        : 'bg-slate-800 text-slate-400'
                    }`}
                  >
                    {audioConfig.enabled ? 'ACTIVO EN TODA LA PARRILLA' : 'APAGADO'}
                  </span>
                </div>
                <p className="text-[11px] text-slate-300 leading-relaxed">
                  Funciona tanto con <strong>Auto-Resolución (1M / 2.5M / 3M)</strong> como con <strong>Copy de Video (0% CPU de video)</strong>. Consume apenas <strong>~0.4% CPU</strong> por canal activo.
                </p>
              </div>

              <button
                type="button"
                disabled={audioSaving}
                onClick={() => handleSaveAudioLeveling(!audioConfig.enabled)}
                className={`px-4 py-2.5 rounded-xl text-xs font-bold shrink-0 transition shadow-lg ${
                  audioConfig.enabled
                    ? 'bg-slate-800 hover:bg-rose-600/30 text-rose-300 border border-rose-500/40'
                    : 'bg-amber-400 hover:bg-amber-300 text-slate-950'
                }`}
              >
                {audioConfig.enabled
                  ? 'Desactivar Nivelación'
                  : '⚡ Activar Audio Igual Ahora'}
              </button>
            </div>

            {/* Curve Preset + Bitrate */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Curva de Nivelación de Volumen
                </label>
                <select
                  value={audioConfig.preset}
                  onChange={(e) => setAudioConfig({ ...audioConfig, preset: e.target.value })}
                  className="w-full px-3 py-2.5 rounded-xl bg-[#090e1a] border border-slate-700 text-xs text-white"
                >
                  <option value="standard">
                    📺 Estándar TV Equilibrado (-13 dB RMS • Recomendado)
                  </option>
                  <option value="voice">
                    🎙️ Claridad Voz & Deportes (-11.5 dB RMS • Resalta voces)
                  </option>
                  <option value="cinema">
                    🎬 Suave Cine (-15 dB RMS • Más rango dinámico)
                  </option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Calidad de Audio Uniforme (AAC Estéreo 48 kHz)
                </label>
                <select
                  value={audioConfig.bitrate}
                  onChange={(e) => setAudioConfig({ ...audioConfig, bitrate: e.target.value })}
                  className="w-full px-3 py-2.5 rounded-xl bg-[#090e1a] border border-slate-700 text-xs text-white"
                >
                  <option value="96k">96 kbps AAC Estéreo (Ahorro)</option>
                  <option value="128k">128 kbps AAC Estéreo (Recomendado TV)</option>
                  <option value="160k">160 kbps AAC Estéreo (Alta Fidelidad)</option>
                  <option value="192k">192 kbps AAC Estéreo (Máxima Calidad)</option>
                </select>
              </div>
            </div>

            {/* Direct-mode protection */}
            <div className="p-3.5 rounded-xl bg-[#090e1a] border border-slate-800 space-y-1.5">
              <label className="inline-flex items-start gap-2.5 text-xs text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={convertDirectOnAudio}
                  onChange={(e) => setConvertDirectOnAudio(e.target.checked)}
                  className="mt-0.5 rounded accent-amber-400"
                />
                <span>
                  Convertir automáticamente canales que estén en modo <strong>Directo puro</strong> a{' '}
                  <strong>On-Demand (Copy Video + Audio Nivelado)</strong> para que ningún canal quede sin nivelar
                  {audioDirectCount > 0 ? (
                    <span className="ml-1 text-amber-300 font-semibold">
                      ({audioDirectCount} canal{audioDirectCount === 1 ? '' : 'es'} actualmente en Directo)
                    </span>
                  ) : null}
                </span>
              </label>
            </div>

            {/* Filter Preview */}
            <div className="p-3 rounded-xl bg-[#070b13] border border-slate-800 text-[11px] font-mono text-emerald-300 break-all">
              FFmpeg Audio Pipeline: -af &quot;aresample=async=1:first_pts=0,dynaudnorm=
              {audioConfig.preset === 'voice'
                ? 'f=150:g=11:p=0.93:m=14:r=0.26:n=1:b=1'
                : audioConfig.preset === 'cinema'
                ? 'f=200:g=17:p=0.88:m=7:r=0.18:n=1:b=1'
                : 'f=150:g=13:p=0.90:m=10:r=0.22:n=1:b=1'}
              &quot; -ac 2 -ar 48000 -c:a aac -b:a {audioConfig.bitrate}
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setAudioModalOpen(false)}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold"
              >
                Cerrar
              </button>
              <button
                type="button"
                disabled={audioSaving}
                onClick={() => handleSaveAudioLeveling(true)}
                className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 text-xs font-bold transition shadow-lg shadow-amber-950/40"
              >
                <Save className="w-4 h-4" />
                {audioSaving ? 'Aplicando...' : 'Guardar y Aplicar Audio Igual'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
