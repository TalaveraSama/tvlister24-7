import React, { useEffect, useState } from 'react';
import {
  Zap,
  Play,
  Square,
  Download,
  Network,
  Tv,
  Sliders,
  CheckCircle2,
  AlertTriangle,
  ArrowLeftRight,
  Power,
  HardDrive,
  Cpu,
  Plus,
  Pencil,
  Trash2,
  Layers,
  Wand2,
  Save,
  Upload,
  FileSpreadsheet,
  ShieldCheck,
  Copy,
  RefreshCw,
  X
} from 'lucide-react';
import { apiFetch, getToken } from '../lib/api.js';

const CATV_NUMBERS = Array.from({ length: 124 }, (_, idx) => idx + 2);

export default function Wk2500CatvPage({ setActiveTab }) {
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [warningNotice, setWarningNotice] = useState('');
  const [errorNotice, setErrorNotice] = useState('');
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState('rf_grid'); // 'rf_grid' | 'by_stream'
  const [filterMode, setFilterMode] = useState('all'); // 'all' | 'assigned' | 'enabled' | 'streaming'

  // Dedicated Network Interface (NIC) Form
  const [nicForm, setNicForm] = useState({
    if_name: '',
    ip_address: '',
    multicast_subnet: '239.25.0.0/24',
    apply_to_all_channels: true
  });
  const [savingNic, setSavingNic] = useState(false);
  const [linuxRouteCmd, setLinuxRouteCmd] = useState('');

  // MNF Peer-to-Peer Trunk Form
  const [trunkForm, setTrunkForm] = useState({
    name: 'Panel TVLister Origen (Nube)',
    origin_url: '',
    username: '',
    password: '',
    auto_assign_catv: true,
    start_catv_ch: 2
  });
  const [syncingTrunk, setSyncingTrunk] = useState(false);

  // Bulk WK2500 UDP Configurator Form
  const [bulkForm, setBulkForm] = useState({
    ch_start: 2,
    ch_end: 125,
    ip_mode: 'multicast',
    dest_ip: '239.25.0.0',
    base_port: 5000,
    local_interface_ip: '',
    ttl: 16,
    output_mode: 'direct_spts',
    muxrate_kbps: 0
  });
  const [applyingBulk, setApplyingBulk] = useState(false);

  // Equipos WK2500 (modelos de 32 / 64 / 125 canales)
  const [unitFilter, setUnitFilter] = useState('all');
  const [unitModal, setUnitModal] = useState(null); // { id?, form }
  // Plantilla CSV del modulador: { unit, text, result, busy, error }
  const [tplModal, setTplModal] = useState(null);
  // Comprobación de salida: { busy, data, error, unitId }
  const [verifyModal, setVerifyModal] = useState(null);
  const [savingUnit, setSavingUnit] = useState(false);
  const [quickForm, setQuickForm] = useState({
    model_channels: 32,
    count: 4,
    start_ch: 2,
    ip_mode: 'unicast',
    dest_ip: '192.168.25.10',
    base_port: 5000,
    ttl: 16,
    output_mode: 'direct_spts',
    replace_existing: true,
    brand_model: 'csp_2500c',
    tv_standard: 'ntsc_m',
    pkt_size: 1316,
    rtp: false,
    steal_from_others: false
  });
  const [quickBusy, setQuickBusy] = useState(false);

  const showToast = (msg) => {
    setErrorNotice('');
    setNotice(msg);
    setTimeout(() => setNotice(''), 9000);
  };

  const loadPlan = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await apiFetch('/api/wk2500/plan');
      setPlan(res);
      if (!silent && res.dedicated_nic) {
        setNicForm((prev) => ({
          ...prev,
          if_name: res.dedicated_nic.if_name || prev.if_name,
          ip_address: res.dedicated_nic.ip_address || prev.ip_address,
          multicast_subnet: res.dedicated_nic.multicast_subnet || '239.25.0.0/24'
        }));
        if (res.dedicated_nic.ip_address) {
          setBulkForm((prev) => ({
            ...prev,
            local_interface_ip: prev.local_interface_ip || res.dedicated_nic.ip_address
          }));
        }
      }
      if (Array.isArray(res.trunks) && res.trunks.length > 0 && !trunkForm.origin_url) {
        const t = res.trunks[0];
        setTrunkForm((prev) => ({
          ...prev,
          name: t.name || prev.name,
          origin_url: t.origin_url || '',
          username: t.username || '',
          password: t.password || ''
        }));
      }
    } catch (err) {
      if (!silent) setErrorNotice(err.message);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    loadPlan(false);
    const t = setInterval(() => loadPlan(true), 4000);
    return () => clearInterval(t);
  }, []);

  const handleSaveDedicatedNic = async (e) => {
    e.preventDefault();
    setSavingNic(true);
    setErrorNotice('');
    try {
      const res = await apiFetch('/api/wk2500/dedicated-interface', {
        method: 'POST',
        body: JSON.stringify(nicForm)
      });
      setBulkForm((prev) => ({ ...prev, local_interface_ip: res.dedicated_nic?.ip_address || '' }));
      if (res.linuxRouteCmd) setLinuxRouteCmd(res.linuxRouteCmd);
      await loadPlan(true);
      showToast(
        res.dedicated_nic?.ip_address
          ? `🔒 Salida UDP fijada en interfaz dedicada ${res.dedicated_nic.if_name || ''} (${res.dedicated_nic.ip_address}). ${res.reboundCount} canales activos reconectados en caliente.`
          : 'Interfaz de salida UDP devuelta a ruta automática del sistema.'
      );
    } catch (err) {
      setErrorNotice(err.message);
    } finally {
      setSavingNic(false);
    }
  };

  const handleSyncMnfTrunk = async (e) => {
    e.preventDefault();
    setSyncingTrunk(true);
    setErrorNotice('');
    setWarningNotice('');
    try {
      const res = await apiFetch('/api/wk2500/mnf-trunks/sync', {
        method: 'POST',
        body: JSON.stringify(trunkForm)
      });
      if (res.maxConnWarning) setWarningNotice(res.maxConnWarning);
      await loadPlan(true);
      showToast(
        `⚡ Troncal MNF sincronizada: ${res.totalSynced} canales vía mnf:// (${res.insertedCount} nuevos, ${res.updatedCount} actualizados).`
      );
    } catch (err) {
      setErrorNotice(err.message);
    } finally {
      setSyncingTrunk(false);
    }
  };

  const handleBulkConfigure = async (autoAssignStreams = false) => {
    setApplyingBulk(true);
    setErrorNotice('');
    try {
      await apiFetch('/api/wk2500/bulk-configure', {
        method: 'POST',
        body: JSON.stringify({
          ...bulkForm,
          auto_assign_panel_streams: autoAssignStreams
        })
      });
      await loadPlan(true);
      showToast(
        autoAssignStreams
          ? `✅ Canales numerados del CH ${bulkForm.ch_start} al CH ${bulkForm.ch_end}. Puedes cambiar cualquier número (ej. pasar del 2 al 3) o activar/desactivar canal por canal abajo.`
          : `✅ Direccionamiento UDP aplicado del CH ${bulkForm.ch_start} al CH ${bulkForm.ch_end}.`
      );
    } catch (err) {
      setErrorNotice(err.message);
    } finally {
      setApplyingBulk(false);
    }
  };

  // Lista explícita de canales por equipo, en el ORDEN de sus portadoras RF.
  // Acepta "95, 2-28, 96-99" (también 95;2-28 y rangos con – o ..).
  const parseChannelsText = (text) => {
    const out = [];
    const push = (n) => {
      const v = Number(n);
      if (Number.isInteger(v) && v >= 2 && v <= 125 && !out.includes(v)) out.push(v);
    };
    for (const chunk of String(text || '').replace(/;/g, ',').split(',')) {
      const part = chunk.trim();
      if (!part) continue;
      const body = part.includes(':') ? part.split(':').pop().trim() : part;
      const range = body.match(/^(\d{1,3})\s*(?:-|–|\.\.|a)\s*(\d{1,3})$/i);
      if (range) {
        const a = Number(range[1]);
        const b = Number(range[2]);
        if (b >= a) for (let ch = a; ch <= b; ch++) push(ch);
        continue;
      }
      if (/^\d{1,3}$/.test(body)) push(Number(body));
    }
    return out;
  };

  const channelsTextValue = (form) => {
    if (form?.channels_text !== undefined) return form.channels_text;
    if (!form) return '';
    const out = [];
    for (let ch = Number(form.ch_start); ch <= Number(form.ch_end); ch++) out.push(ch);
    return out.join(', ');
  };

  const emptyUnitForm = (model = 32) => ({
    name: '',
    model_channels: model,
    ch_start: 2,
    ch_end: 2 + model - 1,
    channels_text: '',
    ip_mode: 'unicast',
    dest_ip: '192.168.25.10',
    base_port: 5000,
    local_interface_ip: '',
    ttl: 16,
    default_output_mode: 'direct_spts',
    enabled: true,
    notes: '',
    brand_model: 'csp_2500c',
    tv_standard: 'ntsc_m',
    pkt_size: 1316,
    rtp: false,
    steal_from_others: false
  });

  const openNewUnit = () => {
    const models = plan?.models || [];
    const model = models[0]?.channels || 32;
    const used = (plan?.units || []).map((u) => Number(u.ch_end) + 1);
    const next = used.length ? Math.min(125, Math.max(...used)) : 2;
    setUnitModal({ id: null, form: { ...emptyUnitForm(model), name: `WK2500 ${(plan?.units?.length || 0) + 1}`, ch_start: next, ch_end: Math.min(125, next + model - 1) } });
  };

  const openEditUnit = (unit) => {
    setUnitModal({
      id: unit.id,
      form: {
        name: unit.name,
        model_channels: unit.model_channels,
        ch_start: unit.ch_start,
        ch_end: unit.ch_end,
        channels_text: unit.channels_input || unit.channels_text || '',
        ip_mode: unit.ip_mode,
        dest_ip: unit.dest_ip,
        base_port: unit.base_port,
        local_interface_ip: unit.local_interface_ip || '',
        ttl: unit.ttl,
        default_output_mode: unit.default_output_mode,
        enabled: Boolean(unit.enabled),
        notes: unit.notes || '',
        brand_model: unit.brand_model || 'generic_2500',
        tv_standard: unit.tv_standard || 'ntsc_m',
        pkt_size: Number(unit.pkt_size || 1316),
        rtp: Boolean(unit.rtp),
        steal_from_others: false
      }
    });
  };

  const handleSaveUnit = async (e) => {
    e.preventDefault();
    if (!unitModal) return;
    setSavingUnit(true);
    setErrorNotice('');
    try {
      const res = unitModal.id
        ? await apiFetch(`/api/wk2500/units/${unitModal.id}`, { method: 'PUT', body: JSON.stringify(unitModal.form) })
        : await apiFetch('/api/wk2500/units', { method: 'POST', body: JSON.stringify(unitModal.form) });
      await loadPlan(true);
      setUnitModal(null);
      showToast(
        `✅ ${res.unit.name}: ${res.unit.carrier_count || res.unit.model_channels} portadoras (${res.unit.channels_text || `CH ${res.unit.ch_start}–${res.unit.ch_end}`}), ` +
          `${res.unit.tv_standard} · ${res.unit.pkt_size}B${Number(res.unit.rtp) ? ' + RTP' : ''}. ` +
          `${res.applied?.channels || 0} canales reapuntados a udp://${res.unit.dest_ip}:${res.unit.base_port}.`
      );
    } catch (err) {
      setErrorNotice(err.message);
    } finally {
      setSavingUnit(false);
    }
  };

  const handleDeleteUnit = async (unit) => {
    if (!window.confirm(`¿Eliminar el equipo "${unit.name}" (CH ${unit.ch_start}–${unit.ch_end})? Sus canales quedarán desactivados.`)) return;
    setErrorNotice('');
    try {
      const res = await apiFetch(`/api/wk2500/units/${unit.id}`, { method: 'DELETE' });
      await loadPlan(true);
      showToast(`🗑 Equipo "${unit.name}" eliminado. ${res.disabledChannels} canales desactivados.`);
    } catch (err) {
      setErrorNotice(err.message);
    }
  };

  const handleApplyUnit = async (unit) => {
    setErrorNotice('');
    try {
      const res = await apiFetch(`/api/wk2500/units/${unit.id}/apply`, { method: 'POST' });
      await loadPlan(true);
      showToast(
        `🔁 "${unit.name}" aplicado: ${res.applied.channels} canales con udp://${unit.dest_ip}:${unit.base_port}. ` +
          `${res.applied.restarted} reactivados en caliente.`
      );
    } catch (err) {
      setErrorNotice(err.message);
    }
  };

  const handleAutoDistribute = async () => {
    setErrorNotice('');
    try {
      const res = await apiFetch('/api/wk2500/units/auto-distribute', {
        method: 'POST',
        body: JSON.stringify({ start_ch: 2 })
      });
      await loadPlan(true);
      showToast(`📐 ${res.message}`);
    } catch (err) {
      setErrorNotice(err.message);
    }
  };

  const handleQuickSetup = async () => {
    setQuickBusy(true);
    setErrorNotice('');
    try {
      const res = await apiFetch('/api/wk2500/units/quick-setup', {
        method: 'POST',
        body: JSON.stringify({
          model_channels: Number(quickForm.model_channels),
          count: Number(quickForm.count),
          start_ch: Number(quickForm.start_ch),
          replace_existing: Boolean(quickForm.replace_existing),
          ip_mode: quickForm.ip_mode,
          dest_ip: quickForm.dest_ip,
          base_port: Number(quickForm.base_port),
          ttl: Number(quickForm.ttl),
          default_output_mode: quickForm.output_mode,
          brand_model: quickForm.brand_model,
          tv_standard: quickForm.tv_standard,
          pkt_size: Number(quickForm.pkt_size),
          rtp: Boolean(quickForm.rtp)
        })
      });
      await loadPlan(true);
      if (res.skipped?.length) setWarningNotice(res.skipped.join(' · '));
      showToast(`⚙️ ${res.message}`);
    } catch (err) {
      setErrorNotice(err.message);
    } finally {
      setQuickBusy(false);
    }
  };

  const handleSlotChange = async (catvCh, patch) => {
    setErrorNotice('');
    try {
      await apiFetch(`/api/wk2500/channels/${catvCh}`, {
        method: 'PUT',
        body: JSON.stringify(patch)
      });
      await loadPlan(true);
    } catch (err) {
      setErrorNotice(err.message);
    }
  };

  const handleSwapOrMoveSlot = async (fromCh, toCh) => {
    if (!toCh || Number(fromCh) === Number(toCh)) return;
    setErrorNotice('');
    try {
      await apiFetch('/api/wk2500/swap-or-move', {
        method: 'POST',
        body: JSON.stringify({ from_ch: Number(fromCh), to_ch: Number(toCh) })
      });
      await loadPlan(true);
      showToast(`🔀 Canal movido/intercambiado: CH ${fromCh} ↔ CH ${toCh}.`);
    } catch (err) {
      setErrorNotice(err.message);
    }
  };

  const handleAssignStreamToExactChannel = async (streamId, targetCatvCh, enabledOverride = undefined) => {
    setErrorNotice('');
    try {
      await apiFetch('/api/wk2500/assign-stream-channel', {
        method: 'POST',
        body: JSON.stringify({
          stream_id: Number(streamId),
          target_catv_ch: targetCatvCh ? Number(targetCatvCh) : null,
          enabled: enabledOverride,
          swap_if_occupied: true
        })
      });
      await loadPlan(true);
    } catch (err) {
      setErrorNotice(err.message);
    }
  };

  const handleMasterControl = async (action, catvCh = null) => {
    setErrorNotice('');
    try {
      const res = await apiFetch('/api/wk2500/control', {
        method: 'POST',
        body: JSON.stringify({
          action,
          catv_ch: catvCh,
          ch_start: bulkForm.ch_start,
          ch_end: bulkForm.ch_end
        })
      });
      await loadPlan(true);
      if (action === 'start_all') {
        showToast(`🚀 Activados ${res.startedCount} canales UDP hacia WK2500.`);
      } else if (action === 'stop_all') {
        showToast('⏹ Todos los canales UDP fueron desactivados.');
      }
    } catch (err) {
      setErrorNotice(err.message);
    }
  };

  // Descarga un CSV. Con unit → sólo las portadoras de ESE modulador, en su orden.
  const downloadCsv = async (format, unit = null) => {
    const qs = new URLSearchParams({ format });
    if (unit) qs.set('unit_id', String(unit.id));
    const resp = await fetch(`/api/wk2500/export-table?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${getToken()}` }
    });
    if (!resp.ok) throw new Error('No se pudo generar el CSV');

    // Nombre del archivo tal como lo manda el servidor (equipo + rango de canales)
    let filename = `wk2500_${format}_2_al_125.csv`;
    const cd = resp.headers.get('content-disposition') || '';
    const m = cd.match(/filename="([^"]+)"/);
    if (m) filename = m[1];

    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return filename;
  };

  const handleDownloadExport = async (format = 'csv') => {
    try {
      await downloadCsv(format);
      showToast(`⬇ Plan completo descargado (${format === 'm3u' ? 'M3U' : 'CSV'}).`);
    } catch (err) {
      setErrorNotice(err.message);
    }
  };

  // Un CSV por modulador: es lo que se sube a cada IP analógico.
  // ====== Comprobar salida UDP / CATV ======
  const runVerify = async (unit = null) => {
    setVerifyModal({ busy: true, data: null, error: '', unitId: unit?.id ?? null });
    try {
      const qs = unit ? `?unit_id=${unit.id}` : '';
      const res = await apiFetch(`/api/wk2500/verify${qs}`);
      setVerifyModal({ busy: false, data: res, error: '', unitId: unit?.id ?? null });
    } catch (err) {
      setVerifyModal({ busy: false, data: null, error: err.message, unitId: unit?.id ?? null });
    }
  };

  const copyMapping = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast('📋 Tabla copiada: pégala en la página de entrada del modulador.');
    } catch {
      showToast('No se pudo copiar automáticamente: selecciona el texto y cópialo a mano.');
    }
  };

  // ====== Plantilla CSV del propio modulador ======
  const openTemplate = (unit) => {
    setTplModal({ unit, text: '', result: null, busy: false, error: '' });
  };

  const saveTemplate = async () => {
    if (!tplModal) return;
    setTplModal((prev) => ({ ...prev, busy: true, error: '' }));
    try {
      const res = await apiFetch(`/api/wk2500/units/${tplModal.unit.id}/csv-template`, {
        method: 'POST',
        body: JSON.stringify({ text: tplModal.text })
      });
      setTplModal((prev) => ({ ...prev, busy: false, result: res }));
      await loadPlan(true);
      showToast(`✅ Plantilla de ${tplModal.unit.name}: ${res.template.cols} columnas reconocidas.`);
    } catch (err) {
      setTplModal((prev) => ({ ...prev, busy: false, error: err.message }));
    }
  };

  const removeTemplate = async () => {
    if (!tplModal) return;
    setTplModal((prev) => ({ ...prev, busy: true, error: '' }));
    try {
      await apiFetch(`/api/wk2500/units/${tplModal.unit.id}/csv-template`, { method: 'DELETE' });
      setTplModal(null);
      await loadPlan(true);
      showToast('Plantilla quitada: el botón Import vuelve al formato compacto.');
    } catch (err) {
      setTplModal((prev) => ({ ...prev, busy: false, error: err.message }));
    }
  };

  const handleDownloadUnit = async (unit, format = 'csv') => {
    try {
      const name = await downloadCsv(format, unit);
      showToast(
        `⬇ ${unit.name}: ${unit.carrier_count ?? unit.span} portadoras · ${unit.range_label || ''} → ${name}`
      );
    } catch (err) {
      setErrorNotice(err.message);
    }
  };

  const handleDownloadAllUnits = async (format = 'csv') => {
    const list = plan?.units || [];
    if (!list.length) {
      setErrorNotice('Todavía no hay equipos configurados.');
      return;
    }
    try {
      for (const unit of list) {
        // Secuencial: algunos navegadores bloquean descargas simultáneas
        // eslint-disable-next-line no-await-in-loop
        await downloadCsv(format, unit);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 350));
      }
      showToast(`⬇ ${list.length} CSV generados, uno por modulador.`);
    } catch (err) {
      setErrorNotice(err.message);
    }
  };

  const slots = plan?.slots || [];
  const streams = plan?.streams || [];
  const interfaces = plan?.interfaces || [];
  const unconfiguredNics = plan?.unconfigured_nics || [];
  const dedicatedNic = plan?.dedicated_nic || { if_name: '', ip_address: '' };
  const summary = plan?.summary || {
    total_catv_slots: 124,
    assigned_slots: 0,
    enabled_slots: 0,
    streaming_slots: 0,
    total_udp_mbps: 0
  };

  const units = plan?.units || [];
  const models = plan?.models || [
    { id: 'wk2500_32', label: 'WK2500 · 32 canales', channels: 32 },
    { id: 'wk2500_64', label: 'WK2500 · 64 canales', channels: 64 },
    { id: 'wk2500_125', label: 'WK2500 · 125 canales', channels: 125 }
  ];
  const coverage = plan?.coverage || {
    total_capacity: 0,
    covered_channels: 0,
    uncovered_channels: 124,
    uncovered_ranges: '2–125',
    uncovered_list: []
  };
  const brands = plan?.brands || [];
  const tvStandards = plan?.tv_standards || [{ id: 'ntsc_m', label: 'NTSC M', short: 'NTSC-M', audio_offset_mhz: 4.5 }];
  const pktSizes = plan?.pkt_sizes || [188, 1316];
  const unitFilterId = unitFilter === 'all' ? null : Number(unitFilter);

  const slotMapByCh = new Map(slots.map((s) => [s.catv_ch, s]));

  const filteredSlots = slots.filter((s) => {
    if (unitFilterId && Number(s.unit_id) !== unitFilterId) return false;
    if (filterMode === 'assigned' && !s.stream_id && !s.custom_source_url) return false;
    if (filterMode === 'enabled' && !s.enabled) return false;
    if (filterMode === 'streaming' && s.live_status !== 'streaming') return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      String(s.catv_ch).includes(q) ||
      String(s.freq_mhz).includes(q) ||
      String(s.effective_name || '').toLowerCase().includes(q) ||
      String(s.udp_host || '').toLowerCase().includes(q) ||
      String(s.udp_port).includes(q)
    );
  });

  const filteredStreams = streams.filter((st) => {
    if (filterMode === 'assigned' && !st.catv_assignment) return false;
    if (filterMode === 'enabled' && !st.catv_assignment?.enabled) return false;
    if (filterMode === 'streaming' && st.catv_assignment?.live_status !== 'streaming') return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      String(st.name || '').toLowerCase().includes(q) ||
      String(st.category_name || '').toLowerCase().includes(q) ||
      String(st.catv_assignment?.catv_ch || '').includes(q)
    );
  });

  const modalUnit = unitModal;
  const modalChannels = modalUnit ? parseChannelsText(channelsTextValue(modalUnit.form)) : [];
  const modalExplicit = Boolean(modalUnit && String(modalUnit.form.channels_text || '').trim());
  const modalSpan = modalUnit
    ? modalExplicit
      ? modalChannels.length
      : Number(modalUnit.form.ch_end) - Number(modalUnit.form.ch_start) + 1
    : 0;
  const modalCap = Number(modalUnit?.form.model_channels || 32);
  const modalSpanError = Boolean(modalUnit) && (modalSpan > modalCap || (modalExplicit && modalChannels.length === 0));

  return (
    <div className="space-y-5">
      {/* Header Banner */}
      <div className="rounded-2xl bg-gradient-to-r from-[#131c31] via-[#17203a] to-[#0f172a] border border-amber-500/35 p-5 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-amber-500/15 border border-amber-500/35 text-amber-300 text-[11px] font-bold">
            <Tv className="w-3.5 h-3.5" />
            SALIDA UDP POR TARJETA DEDICADA · MODELOS 32 / 64 / 125 CANALES · GRILLA CH 2 AL 125 · MNF / M4F / TS / HLS
          </div>
          <h1 className="text-xl font-bold text-white">
            Moduladores Analógicos WK2500 — Varios equipos (32 / 64 / 125 canales) y Selección Exacta de Canal (2... 125)
          </h1>
          <p className="text-xs text-slate-300 max-w-3xl leading-relaxed">
            Saca todos tus flujos UDP SPTS (`1316 bytes`) por una <strong>segunda tarjeta de red dedicada</strong> hacia tus equipos{' '}
            <strong>WK2500</strong>, elige libremente qué número exacto lleva cada televisora (si va en el <strong>2</strong>, en el{' '}
            <strong>3</strong>, etc.) y <strong>activa o desactiva</strong> cada canal de forma independiente.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {setActiveTab && (
            <button
              type="button"
              onClick={() => setActiveTab('flussonic-2312')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-indigo-600/25 hover:bg-indigo-600/40 border border-indigo-400/40 text-indigo-200 text-xs font-bold"
            >
              <Zap className="w-3.5 h-3.5" />
              Pasar TS/HLS → M4F Flussonic
            </button>
          )}
          <button
            type="button"
            onClick={() => handleMasterControl('start_all')}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-lg shadow-emerald-950/50"
          >
            <Play className="w-4 h-4" />
            Activar Asignados
          </button>
          <button
            type="button"
            onClick={() => handleMasterControl('stop_all')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-rose-600/25 hover:bg-rose-600/40 border border-rose-500/40 text-rose-200 text-xs font-bold"
          >
            <Square className="w-3.5 h-3.5" />
            Desactivar Todos
          </button>
          <button
            type="button"
            onClick={() => handleDownloadAllUnits('csv')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold shadow-lg shadow-amber-950/40"
          >
            <Download className="w-3.5 h-3.5" />
            CSV por modulador ({units.length})
          </button>
          <button
            type="button"
            onClick={() => handleDownloadExport('csv')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600 text-amber-200 text-xs font-bold"
          >
            <Download className="w-3.5 h-3.5" />
            CSV plan completo
          </button>
        </div>
      </div>

      {/* ==================== EQUIPOS WK2500: MODELOS 32 / 64 / 125 ==================== */}
      <div className="rounded-2xl bg-[#0e1526] border border-emerald-500/35 p-4 space-y-3.5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-bold text-white">
              Tus moduladores WK2500 — modelos de 32, 64 y 125 canales
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-bold">
            <span className="px-2.5 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/35 text-emerald-300">
              {units.length} equipo{units.length === 1 ? '' : 's'}
            </span>
            <span className="px-2.5 py-0.5 rounded-full bg-cyan-500/15 border border-cyan-500/35 text-cyan-300">
              Capacidad {coverage.total_capacity} canales
            </span>
            <span
              className={`px-2.5 py-0.5 rounded-full border ${
                coverage.uncovered_channels === 0
                  ? 'bg-emerald-500/15 border-emerald-500/35 text-emerald-300'
                  : 'bg-amber-500/15 border-amber-500/40 text-amber-200'
              }`}
            >
              Cobertura {coverage.covered_channels}/124
              {coverage.uncovered_channels > 0 ? ` · sin modulador: CH ${coverage.uncovered_ranges}` : ' · grilla completa'}
            </span>
          </div>
        </div>

        <p className="text-[11px] text-slate-400 leading-relaxed">
          Cada equipo genera un número limitado de canales RF según su modelo: el de{' '}
          <strong className="text-slate-200">32</strong> cubre 32 números (ej. CH 2–33), el de{' '}
          <strong className="text-slate-200">64</strong> cubre 64 y el de <strong className="text-slate-200">125</strong> toda la
          grilla 2–125. Con <strong className="text-emerald-300">4 equipos de 32 canales</strong> cubres los{' '}
          <strong className="text-emerald-300">124 canales</strong> completos: CH 2–33, 34–65, 66–97 y 98–125. Los rangos no
          pueden solaparse porque se pisarían en el combinador RF.
        </p>

        {/* Armado rápido */}
        <div className="rounded-xl border border-slate-700 bg-[#090e1a] p-3 space-y-2">
          <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-300">
            <Wand2 className="w-3.5 h-3.5 text-emerald-400" /> Armado rápido de equipos
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2 text-xs items-end">
            <div className="xl:col-span-2">
              <label className="text-[10px] text-slate-400 block mb-0.5">Marca / modelo del modulador</label>
              <select
                value={quickForm.brand_model}
                onChange={(e) => {
                  const b = brands.find((x) => x.id === e.target.value);
                  setQuickForm({
                    ...quickForm,
                    brand_model: e.target.value,
                    tv_standard: b?.default_standard || quickForm.tv_standard,
                    pkt_size: b?.default_pkt_size || quickForm.pkt_size,
                    rtp: Boolean(b?.default_rtp)
                  });
                }}
                className="w-full px-2 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white"
              >
                {(brands.length ? brands : [{ id: 'generic_2500', label: 'Genérico IP→analógico' }]).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] text-slate-400 block mb-0.5">Estándar de TV</label>
              <select
                value={quickForm.tv_standard}
                onChange={(e) => setQuickForm({ ...quickForm, tv_standard: e.target.value })}
                className="w-full px-2 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white"
              >
                {tvStandards.map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.short} (audio +{st.audio_offset_mhz} MHz)
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] text-slate-400 block mb-0.5">Modelo (canales)</label>
              <select
                value={quickForm.model_channels}
                onChange={(e) => setQuickForm({ ...quickForm, model_channels: Number(e.target.value) })}
                className="w-full px-2 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white"
              >
                {models.map((m) => (
                  <option key={m.id} value={m.channels}>
                    {m.channels} canales
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] text-slate-400 block mb-0.5">Cantidad</label>
              <input
                type="number"
                min={1}
                max={16}
                value={quickForm.count}
                onChange={(e) => setQuickForm({ ...quickForm, count: Number(e.target.value) })}
                className="w-full px-2 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-emerald-300 font-bold"
              />
            </div>
            <div>
              <label className="text-[10px] text-slate-400 block mb-0.5">Desde CH</label>
              <input
                type="number"
                min={2}
                max={125}
                value={quickForm.start_ch}
                onChange={(e) => setQuickForm({ ...quickForm, start_ch: Number(e.target.value) })}
                className="w-full px-2 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-amber-300 font-bold"
              />
            </div>
            <div>
              <label className="text-[10px] text-slate-400 block mb-0.5">Salida UDP</label>
              <select
                value={quickForm.ip_mode}
                onChange={(e) =>
                  setQuickForm({
                    ...quickForm,
                    ip_mode: e.target.value,
                    dest_ip: e.target.value === 'multicast' ? '239.25.0.0' : '192.168.25.10'
                  })
                }
                className="w-full px-2 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white"
              >
                <option value="unicast">Unicast (IP por equipo)</option>
                <option value="multicast">Multicast 239.x</option>
              </select>
            </div>
            <div className="xl:col-span-2">
              <label className="text-[10px] text-slate-400 block mb-0.5">
                IP base {quickForm.ip_mode === 'unicast' ? '(se suma 1 por equipo)' : '(3ª octeta +1 por equipo)'}
              </label>
              <input
                type="text"
                value={quickForm.dest_ip}
                onChange={(e) => setQuickForm({ ...quickForm, dest_ip: e.target.value })}
                className="w-full px-2 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-cyan-300 font-mono"
              />
            </div>
            <div>
              <label className="text-[10px] text-slate-400 block mb-0.5">Puerto base</label>
              <input
                type="number"
                min={1}
                max={65000}
                value={quickForm.base_port}
                onChange={(e) => setQuickForm({ ...quickForm, base_port: Number(e.target.value) })}
                className="w-full px-2 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-cyan-300 font-mono"
              />
            </div>
            <div>
              <label className="text-[10px] text-slate-400 block mb-0.5">Datagrama</label>
              <select
                value={quickForm.pkt_size}
                onChange={(e) => setQuickForm({ ...quickForm, pkt_size: Number(e.target.value) })}
                className="w-full px-2 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white"
              >
                {pktSizes.map((n) => (
                  <option key={n} value={n}>
                    {n} B {n === 1316 ? '(7×188)' : '(1×188)'}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-end">
              <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-300 pb-1.5">
                <input
                  type="checkbox"
                  checked={Boolean(quickForm.rtp)}
                  onChange={(e) => setQuickForm({ ...quickForm, rtp: e.target.checked })}
                  className="accent-emerald-500"
                />
                UDP + RTP
              </label>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleQuickSetup}
              disabled={quickBusy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-bold"
            >
              <Plus className="w-3.5 h-3.5" />
              {quickBusy ? 'Creando equipos…' : `Crear ${quickForm.count} × ${quickForm.model_channels} canales`}
            </button>
            <button
              type="button"
              onClick={handleAutoDistribute}
              disabled={units.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-40 border border-slate-600 text-slate-200 text-xs font-bold"
            >
              <Layers className="w-3.5 h-3.5" /> Repartir rangos 2 → 125
            </button>
            <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-300">
              <input
                type="checkbox"
                checked={quickForm.replace_existing}
                onChange={(e) => setQuickForm({ ...quickForm, replace_existing: e.target.checked })}
                className="accent-emerald-500"
              />
              Reemplazar los equipos actuales
            </label>
            <button
              type="button"
              onClick={openNewUnit}
              className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#090e1a] hover:bg-slate-800 border border-emerald-500/40 text-emerald-200 text-xs font-bold"
            >
              <Plus className="w-3.5 h-3.5" /> Añadir equipo manualmente
            </button>
          </div>
        </div>

        {/* Tarjetas de equipos */}
        {units.length === 0 ? (
          <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-3 text-[11.5px] text-amber-100">
            Aún no hay equipos declarados. Si tienes <strong>4 moduladores de 32 canales</strong>, elige «32 canales», cantidad{' '}
            <strong>4</strong> y pulsa <strong>Crear equipos</strong>: la grilla quedará repartida en CH 2–33, 34–65, 66–97 y 98–125
            con su IP UDP asignada a cada uno.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            {units.map((u, idx) => (
              <div key={u.id} className="rounded-xl border border-slate-700 bg-[#090e1a] p-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-bold text-white">{u.name}</div>
                    <div className="text-[10px] text-slate-400">
                      Equipo {idx + 1} · {u.range_label}
                    </div>
                  </div>
                  <span className="shrink-0 rounded px-1.5 py-0.5 text-[9.5px] font-bold uppercase bg-emerald-500/15 border border-emerald-500/35 text-emerald-300">
                    {u.carrier_count ?? u.span ?? u.model_channels}/{u.model_channels} CH
                  </span>
                </div>

                <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className={`h-full ${u.fill_percent >= 100 ? 'bg-emerald-500' : 'bg-amber-500'}`}
                    style={{ width: `${Math.min(100, u.fill_percent || 0)}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-[10px] text-slate-400">
                  <span>
                    {u.span}/{u.capacity} canales usados
                  </span>
                  <span className={u.streaming_channels ? 'text-emerald-300 font-bold' : ''}>
                    {u.streaming_channels} al aire
                  </span>
                </div>

                <div className="rounded-lg bg-[#0e1526] border border-slate-800 px-2 py-1.5 text-[10px] font-mono text-cyan-300 break-all">
                  udp://{u.dest_ip}:{u.base_port}
                  <span className="text-slate-500"> → puerto CH+N</span>
                </div>
                {u.explicit_list ? (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[9.5px] leading-snug text-amber-200">
                    <div className="font-bold uppercase tracking-wide text-amber-300">Lista por portadora</div>
                    <div className="mt-0.5 font-mono break-all">
                      {u.carriers?.slice(0, 3).map((c) => `P${c.carrier}=CH${c.catv_ch}`).join(' · ')}
                      {u.carrier_count > 3 ? ` … P${u.carrier_count}=CH${u.carriers[u.carrier_count - 1].catv_ch}` : ''}
                    </div>
                  </div>
                ) : null}

                {/* CSV de ESTE modulador, en el orden de sus portadoras */}
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => handleDownloadUnit(u, 'csv')}
                    title={`Descargar el CSV de ${u.name} (${u.carrier_count ?? u.span} portadoras, P1=CH${u.carriers?.[0]?.catv_ch ?? '—'})`}
                    className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg bg-amber-600/20 hover:bg-amber-600/35 border border-amber-500/40 px-2 py-1.5 text-[10px] font-bold text-amber-200"
                  >
                    <Download className="w-3 h-3" /> CSV
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDownloadUnit(u, u.csv_template?.saved ? 'dev' : 'csv-min')}
                    title={
                      u.csv_template?.saved
                        ? `Importar en el equipo: mismo formato que exporta ${u.name} (${u.csv_template.cols} columnas, separador "${u.csv_template.delimiter}")`
                        : 'CSV compacto de 6 columnas. Si el modulador no carga los canales, pulsa «Plantilla» y pega el CSV que exporta el equipo.'
                    }
                    className={`inline-flex items-center justify-center gap-1 rounded-lg border px-2 py-1.5 text-[10px] font-bold ${
                      u.csv_template?.saved
                        ? 'bg-emerald-600/20 hover:bg-emerald-600/35 border-emerald-500/40 text-emerald-200'
                        : 'bg-slate-800 hover:bg-slate-700 border-slate-600 text-slate-300'
                    }`}
                  >
                    Import
                  </button>
                  <button
                    type="button"
                    onClick={() => openTemplate(u)}
                    title={
                      u.csv_template?.saved
                        ? `Plantilla cargada: ${u.csv_template.cols} columnas, separador "${u.csv_template.delimiter}". Pulsa para verla o reemplazarla.`
                        : 'Sin plantilla: pega aquí el CSV que exporta el modulador para que el Import tenga SU formato exacto'
                    }
                    className={`inline-flex items-center justify-center gap-1 rounded-lg border px-2 py-1.5 text-[10px] font-bold ${
                      u.csv_template?.saved
                        ? 'bg-emerald-600/15 hover:bg-emerald-600/30 border-emerald-500/40 text-emerald-200'
                        : 'bg-amber-600/15 hover:bg-amber-600/30 border-amber-500/40 text-amber-200'
                    }`}
                  >
                    <Upload className="w-3 h-3" /> Plantilla
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDownloadUnit(u, 'm3u')}
                    title="M3U de las portadoras de este equipo para probar con VLC"
                    className="inline-flex items-center justify-center gap-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 px-2 py-1.5 text-[10px] font-bold text-slate-300"
                  >
                    M3U
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => runVerify(u)}
                  title="Comprobar qué está enviando el panel, qué lleva el CSV y si el modulador es alcanzable"
                  className="inline-flex w-full items-center justify-center gap-1 rounded-lg border border-sky-500/40 bg-sky-600/15 px-2 py-1.5 text-[10px] font-bold text-sky-200 hover:bg-sky-600/30"
                >
                  <ShieldCheck className="w-3 h-3" /> Comprobar
                </button>
                {!u.csv_template?.saved ? (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-[9px] leading-snug text-amber-200/90">
                    Sin plantilla: si el equipo <b>no carga ni cambia</b> los canales con el archivo, pulsa{' '}
                    <b>Plantilla</b> y pega el CSV que exporta su propia web.
                  </div>
                ) : (
                  <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-2 py-1 text-[9px] leading-snug text-emerald-200/90">
                    Plantilla del equipo cargada: {u.csv_template.cols} columnas · separador «
                    {u.csv_template.delimiter === '\t' ? 'TAB' : u.csv_template.delimiter}» ·{' '}
                    {u.csv_template.mapped?.length || 0} campos reconocidos.
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-1">
                  <span className="rounded bg-sky-500/12 border border-sky-500/30 px-1.5 py-0.5 text-[9.5px] font-bold text-sky-300">
                    {u.tv_standard_label || 'NTSC-M'}
                  </span>
                  <span className="rounded bg-violet-500/12 border border-violet-500/30 px-1.5 py-0.5 text-[9.5px] font-bold text-violet-300">
                    {u.pkt_size} B {u.rtp ? '+ RTP' : 'UDP'}
                  </span>
                  <span
                    title={`${u.brand?.label || 'Genérico'}${u.brand?.notes ? ` — ${u.brand.notes}` : ''}`}
                    className="rounded bg-slate-700/40 border border-slate-600 px-1.5 py-0.5 text-[9.5px] font-semibold text-slate-300"
                  >
                    {u.brand?.label || 'Genérico'}
                  </span>
                </div>
                <div className="text-[10px] text-slate-400">
                  RF {u.range_freq?.from_mhz || '—'}–{u.range_freq?.to_mhz || '—'} MHz · audio +
                  {u.audio_offset_mhz ?? 4.5} MHz
                </div>
                <div className="text-[10px] text-slate-400">
                  NIC: {u.local_interface_ip || dedicatedNic.ip_address || 'automática'} · TTL {u.ttl} ·{' '}
                  {u.default_output_mode === 'direct_spts' ? 'Directo' : u.default_output_mode}
                </div>

                <div className="flex items-center gap-1.5 pt-0.5">
                  <button
                    type="button"
                    onClick={() => handleApplyUnit(u)}
                    title="Reescribir en la grilla la IP/puerto/NIC de este equipo"
                    className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-[10.5px] font-bold text-slate-200"
                  >
                    <Save className="w-3 h-3" /> Aplicar
                  </button>
                  <button
                    type="button"
                    onClick={() => openEditUnit(u)}
                    title="Editar equipo"
                    className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteUnit(u)}
                    title="Eliminar equipo"
                    className="px-2 py-1 rounded-lg bg-rose-600/20 hover:bg-rose-600/35 border border-rose-500/40 text-rose-300"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {coverage.uncovered_channels > 0 && units.length > 0 && (
          <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-2.5 text-[11px] text-amber-100">
            ⚠️ Los canales <strong>CH {coverage.uncovered_ranges}</strong> no tienen modulador asignado: no saldrán por RF. Añade otro
            equipo o amplía el rango de uno existente (si el modelo lo permite).
          </div>
        )}
        {coverage.orphan_assigned_channels?.length > 0 && (
          <div className="rounded-xl border border-rose-500/35 bg-rose-500/10 p-2.5 text-[11px] text-rose-100">
            Hay {coverage.orphan_assigned_channels.length} canal(es) con stream asignado fuera de la cobertura: CH{' '}
            {coverage.orphan_assigned_channels.join(', ')}. Muévelos a un número cubierto o amplía los equipos.
          </div>
        )}
      </div>

      {/* Dedicated Network Interface (NIC) Selector Card */}
      <form
        onSubmit={handleSaveDedicatedNic}
        className="rounded-2xl bg-[#0e1526] border border-cyan-500/40 p-4 space-y-3"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Network className="w-4 h-4 text-cyan-400" />
            <h2 className="text-sm font-bold text-white">
              Interfaz de Red Dedicada para Salida UDP hacia WK2500 (Aísla el tráfico UDP del puerto de Internet)
            </h2>
          </div>
          <span
            className={`text-[11px] px-2.5 py-0.5 rounded-full font-bold ${
              dedicatedNic.ip_address
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                : 'bg-slate-800 text-slate-300'
            }`}
          >
            {dedicatedNic.ip_address
              ? `🔒 Salida Fija en ${dedicatedNic.if_name || 'NIC'} (${dedicatedNic.ip_address})`
              : 'Ruta Automática del Sistema'}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end text-xs">
          <div className="md:col-span-5">
            <label className="text-[11px] text-slate-300 block mb-1">
              1. Elegir Tarjeta de Red Física / VLAN Detectada en este Servidor
            </label>
            <select
              value={nicForm.ip_address}
              onChange={(e) => {
                const chosenIp = e.target.value;
                const found = interfaces.find((x) => x.address === chosenIp);
                setNicForm({
                  ...nicForm,
                  ip_address: chosenIp,
                  if_name: found ? found.name : ''
                });
              }}
              className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
            >
              <option value="">— Ruta automática del Kernel (sin fijar tarjeta) —</option>
              {interfaces.map((iface) => (
                <option key={`${iface.name}-${iface.address}`} value={iface.address}>
                  {iface.name} — {iface.address} ({iface.operstate?.toUpperCase() || 'UP'}
                  {iface.speedMbps ? ` · ${iface.speedMbps} Mbps` : ''})
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-3">
            <label className="text-[11px] text-slate-300 block mb-1">
              O escribir IP local de tu NIC dedicada
            </label>
            <input
              type="text"
              placeholder="Ej. 192.168.25.1"
              value={nicForm.ip_address}
              onChange={(e) => setNicForm({ ...nicForm, ip_address: e.target.value })}
              className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-cyan-300 font-mono"
            />
          </div>

          <div className="md:col-span-4 flex items-center gap-2">
            <button
              type="submit"
              disabled={savingNic}
              className="w-full py-2 px-4 rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white font-bold transition shadow-lg shadow-cyan-950/40"
            >
              {savingNic ? 'Aplicando NIC...' : '🔒 Fijar Salida UDP en esta Tarjeta'}
            </button>
          </div>
        </div>

        {unconfiguredNics.length > 0 && (
          <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-200">
            💡 Tarjetas físicas detectadas aún sin IP IPv4 asignada:{' '}
            <strong>
              {unconfiguredNics.map((n) => `${n.name} (${n.operstate})`).join(', ')}
            </strong>
            . Para dedicar por ejemplo <code>{unconfiguredNics[0].name}</code> al switch de tus WK2500 ejecuta en consola:{' '}
            <code className="text-white bg-black/40 px-1.5 py-0.5 rounded">
              sudo ip addr add 192.168.25.1/24 dev {unconfiguredNics[0].name} && sudo ip link set {unconfiguredNics[0].name} up
            </code>
          </div>
        )}

        {linuxRouteCmd && (
          <div className="p-2.5 rounded-xl bg-slate-900/90 border border-slate-700 text-[11px] text-slate-300 flex flex-wrap items-center justify-between gap-2">
            <span>
              Tip Multicast Linux (opcional si usas IPs <code className="text-emerald-300">239.25.0.x</code> en switch dedicado):{' '}
              <code className="text-cyan-300 font-mono">{linuxRouteCmd}</code>
            </span>
          </div>
        )}
      </form>

      {notice && (
        <div className="p-3.5 rounded-xl bg-emerald-500/15 border border-emerald-500/40 text-xs text-emerald-200 font-medium flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {warningNotice && (
        <div className="p-3.5 rounded-xl bg-amber-500/15 border border-amber-500/40 text-xs text-amber-100 font-medium flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <span>{warningNotice}</span>
        </div>
      )}

      {errorNotice && (
        <div className="p-3.5 rounded-xl bg-rose-500/15 border border-rose-500/45 text-xs text-rose-200 font-medium">
          ⚠️ {errorNotice}
        </div>
      )}

      {/* Collapsible / Compact MNF Trunk & Bulk UDP Addressing Cards */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <form
          onSubmit={handleSyncMnfTrunk}
          className="rounded-2xl bg-[#0e1526] border border-violet-500/35 p-4 space-y-3"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold text-white flex items-center gap-2 uppercase tracking-wide">
              <Zap className="w-4 h-4 text-violet-400" />
              Troncal Panel a Panel vía MNF (`mnf://`)
            </h2>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-300 font-bold">
              OPCIONAL (2º VPS)
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
            <input
              type="text"
              required
              placeholder="http://IP_PANEL_ORIGEN:8095"
              value={trunkForm.origin_url}
              onChange={(e) => setTrunkForm({ ...trunkForm, origin_url: e.target.value })}
              className="sm:col-span-3 px-3 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
            />
            <input
              type="text"
              required
              placeholder="Usuario línea"
              value={trunkForm.username}
              onChange={(e) => setTrunkForm({ ...trunkForm, username: e.target.value })}
              className="px-3 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
            />
            <input
              type="password"
              required
              placeholder="Contraseña"
              value={trunkForm.password}
              onChange={(e) => setTrunkForm({ ...trunkForm, password: e.target.value })}
              className="px-3 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
            />
            <button
              type="submit"
              disabled={syncingTrunk}
              className="py-1.5 px-3 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white font-bold"
            >
              {syncingTrunk ? 'Sincronizando...' : '⚡ Traer por MNF'}
            </button>
          </div>
        </form>

        <div className="rounded-2xl bg-[#0e1526] border border-amber-500/35 p-4 space-y-3">
          <h2 className="text-xs font-bold text-white flex items-center gap-2 uppercase tracking-wide">
            <Sliders className="w-4 h-4 text-amber-400" />
            Plantilla Rápida IP/Puerto UDP para Rango WK2500
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
            <input
              type="number"
              min={2}
              max={125}
              value={bulkForm.ch_start}
              onChange={(e) => setBulkForm({ ...bulkForm, ch_start: Number(e.target.value) })}
              className="px-2.5 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-amber-300 font-bold"
              title="Canal Inicial"
            />
            <input
              type="number"
              min={2}
              max={125}
              value={bulkForm.ch_end}
              onChange={(e) => setBulkForm({ ...bulkForm, ch_end: Number(e.target.value) })}
              className="px-2.5 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-amber-300 font-bold"
              title="Canal Final"
            />
            <select
              value={bulkForm.ip_mode}
              onChange={(e) =>
                setBulkForm({
                  ...bulkForm,
                  ip_mode: e.target.value,
                  dest_ip: e.target.value === 'multicast' ? '239.25.0.0' : '192.168.25.10'
                })
              }
              className="px-2 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
            >
              <option value="multicast">Multicast 239.x</option>
              <option value="unicast">Unicast IP WK2500</option>
            </select>
            <input
              type="text"
              value={bulkForm.dest_ip}
              onChange={(e) => setBulkForm({ ...bulkForm, dest_ip: e.target.value })}
              className="px-2.5 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-emerald-300 font-mono"
            />
            <select
              value={bulkForm.output_mode}
              onChange={(e) => setBulkForm({ ...bulkForm, output_mode: e.target.value })}
              className="px-2 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
            >
              <option value="direct_spts">⚡ Directo 1316B</option>
              <option value="copy_mp2_leveled">🔊 Copy + MP2</option>
              <option value="copy_aac_leveled">🔊 Copy + AAC</option>
              <option value="ntsc_sd_wk2500">📺 NTSC 480 SD</option>
            </select>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={applyingBulk}
              onClick={() => handleBulkConfigure(true)}
              className="flex-1 py-1.5 px-3 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold"
            >
              🔢 Auto-Llenar Canales ({bulkForm.ch_start}–{bulkForm.ch_end})
            </button>
            <button
              type="button"
              disabled={applyingBulk}
              onClick={() => handleBulkConfigure(false)}
              className="py-1.5 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 text-xs font-bold"
            >
              Aplicar Solo IPs/Puertos
            </button>
          </div>
        </div>
      </div>

      {/* Main Selector & Per-Channel Activation Workspace */}
      <div className="rounded-2xl bg-[#0e1526] border border-slate-800 p-4 space-y-3.5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 border-b border-slate-800 pb-3">
          {/* Switch between RF Grid (CH 2..125) and Stream-Centric Picker ("Elegir por Mis Canales -> CH 2, CH 3...") */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setViewMode('rf_grid')}
              className={`px-3.5 py-2 rounded-xl text-xs font-bold transition ${
                viewMode === 'rf_grid'
                  ? 'bg-amber-600 text-white shadow-lg shadow-amber-950/50'
                  : 'bg-[#090e1a] border border-slate-700 text-slate-300 hover:text-white'
              }`}
            >
              📺 Grilla Numerada RF (Canal 2 al 125)
            </button>
            <button
              type="button"
              onClick={() => setViewMode('by_stream')}
              className={`px-3.5 py-2 rounded-xl text-xs font-bold transition ${
                viewMode === 'by_stream'
                  ? 'bg-cyan-600 text-white shadow-lg shadow-cyan-950/50'
                  : 'bg-[#090e1a] border border-slate-700 text-slate-300 hover:text-white'
              }`}
            >
              🎯 Elegir desde Mis Canales (Asignar si es 2, 3, 4... + Activar/Desactivar)
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {units.length > 0 && (
              <select
                value={unitFilter}
                onChange={(e) => setUnitFilter(e.target.value)}
                className="px-2.5 py-1.5 rounded-xl bg-[#090e1a] border border-emerald-500/40 text-xs text-emerald-200 font-semibold"
                title="Ver sólo los canales que entrega un equipo"
              >
                <option value="all">Todos los equipos ({units.length})</option>
                {units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} · {u.range_label}
                  </option>
                ))}
              </select>
            )}
            <select
              value={filterMode}
              onChange={(e) => setFilterMode(e.target.value)}
              className="px-2.5 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-xs text-slate-200"
            >
              <option value="all">Ver Todos</option>
              <option value="assigned">Solo Asignados ({summary.assigned_slots})</option>
              <option value="enabled">Solo Activados ({summary.enabled_slots})</option>
              <option value="streaming">Transmitiendo UDP ({summary.streaming_slots})</option>
            </select>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar nombre de canal, CH (2, 3, 10...) o IP..."
              className="px-3 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-xs text-white min-w-[250px]"
            />
          </div>
        </div>

        {viewMode === 'by_stream' ? (
          /* STREAM-CENTRIC VIEW: Pick exact CATV channel number (2, 3, 4... 125) and toggle ON/OFF per stream */
          <div className="overflow-x-auto rounded-xl border border-slate-800 max-h-[620px]">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#090e1a] text-slate-400 uppercase sticky top-0 z-10">
                <tr>
                  <th className="px-3 py-2.5">Televisora / Stream en tu Panel</th>
                  <th className="px-3 py-2.5">Protocolo</th>
                  <th className="px-3 py-2.5 min-w-[250px]">Elegir Número de Canal WK2500 (2 al 125)</th>
                  <th className="px-3 py-2.5">Salida UDP & Tarjeta</th>
                  <th className="px-3 py-2.5 text-center">Activar / Desactivar Canal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {filteredStreams.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                      No hay canales que coincidan con el filtro actual.
                    </td>
                  </tr>
                ) : (
                  filteredStreams.map((st) => {
                    const assigned = st.catv_assignment;
                    const assignedSlot = assigned ? slotMapByCh.get(assigned.catv_ch) : null;
                    const isEnabled = Boolean(assigned?.enabled);
                    const isLive = assigned?.live_status === 'streaming';

                    return (
                      <tr key={st.id} className="hover:bg-slate-800/25">
                        <td className="px-3 py-2.5">
                          <div className="font-bold text-white">{st.name}</div>
                          <div className="text-[10px] text-slate-400">{st.category_name || 'Sin Categoría'}</div>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className="px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-300 text-[10px] font-bold">
                            {st.upstream_proto}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <select
                            value={assigned?.catv_ch || ''}
                            onChange={(e) =>
                              handleAssignStreamToExactChannel(
                                st.id,
                                e.target.value ? Number(e.target.value) : null
                              )
                            }
                            className="w-full px-2.5 py-1.5 rounded-lg bg-[#090e1a] border border-amber-500/40 text-xs text-amber-200 font-semibold"
                          >
                            <option value="">— No sacar por WK2500 (Sin número) —</option>
                            {CATV_NUMBERS.map((num) => {
                              const sl = slotMapByCh.get(num);
                              const occ =
                                sl?.effective_name && Number(sl.stream_id) !== Number(st.id)
                                  ? ` [Ocupado: ${sl.effective_name} — intercambiar]`
                                  : '';
                              return (
                                <option key={num} value={num}>
                                  Canal {num} ({sl?.freq_mhz || ''} MHz){occ}
                                </option>
                              );
                            })}
                          </select>
                        </td>
                        <td className="px-3 py-2.5 font-mono text-[11px]">
                          {assignedSlot ? (
                            <div>
                              <div className="text-emerald-300">
                                udp://{assignedSlot.udp_host}:{assignedSlot.udp_port}
                              </div>
                              <div className="text-[10px] text-cyan-300">
                                NIC: {assignedSlot.effective_interface_name}
                                {assignedSlot.effective_interface_ip ? ` (${assignedSlot.effective_interface_ip})` : ''}
                              </div>
                            </div>
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          {assigned ? (
                            <button
                              type="button"
                              title={
                                isLive
                                  ? `Enviando ${(assigned.bitrate_kbps / 1000).toFixed(1)} Mbps por UDP al WK2500 (CH ${assigned.catv_ch})`
                                  : assigned.last_error || 'Canal activado, esperando flujo del origen'
                              }
                              onClick={() => handleSlotChange(assigned.catv_ch, { enabled: !isEnabled })}
                              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold transition ${
                                isEnabled
                                  ? isLive
                                    ? 'bg-emerald-500/20 border border-emerald-500/50 text-emerald-300 hover:bg-emerald-500/30'
                                    : 'bg-amber-500/15 border border-amber-500/45 text-amber-300 hover:bg-amber-500/25'
                                  : 'bg-slate-800 border border-slate-700 text-slate-400 hover:text-white'
                              }`}
                            >
                              <Power className="w-3.5 h-3.5" />
                              {!isEnabled
                                ? 'DESACTIVADO'
                                : isLive
                                  ? `ACTIVO ${(assigned.bitrate_kbps / 1000).toFixed(1)}M`
                                  : assigned.live_status === 'reconnecting'
                                    ? 'RECONECTANDO'
                                    : 'CONECTANDO'}
                            </button>
                          ) : (
                            <span className="text-[11px] text-slate-500">Elige Nº primero</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        ) : (
          /* RF GRID VIEW: Channels 2 through 125 with Move/Swap number selector, Stream selector, NIC selector & ON/OFF Switch */
          <div className="overflow-x-auto rounded-xl border border-slate-800 max-h-[620px]">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#090e1a] text-slate-400 uppercase sticky top-0 z-10">
                <tr>
                  <th className="px-3 py-2.5">Nº Canal CATV / Mover</th>
                  <th className="px-3 py-2.5">Frecuencia RF</th>
                  <th className="px-3 py-2.5 min-w-[230px]">Canal Asignado</th>
                  <th className="px-3 py-2.5">Tarjeta NIC Dedicada</th>
                  <th className="px-3 py-2.5">Destino UDP (WK2500)</th>
                  <th className="px-3 py-2.5">Perfil</th>
                  <th className="px-3 py-2.5 text-center">Activar / Desactivar</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {loading ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                      Cargando grilla CATV Canal 2 al 125...
                    </td>
                  </tr>
                ) : (
                  filteredSlots.map((slot) => {
                    const isLive = slot.live_status === 'streaming';
                    const hasAssigned = Boolean(slot.stream_id || slot.custom_source_url);
                    return (
                      <tr
                        key={slot.catv_ch}
                        className={`hover:bg-slate-800/25 ${slot.covered_by_unit ? '' : 'opacity-55'}`}
                      >
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="inline-flex items-center px-2.5 py-1 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-300 font-bold font-mono">
                              CH {slot.catv_ch}
                            </span>
                            {slot.unit_name ? (
                              <span
                                title={`Este canal lo genera el equipo ${slot.unit_name} (${slot.unit_model_channels} canales)`}
                                className="inline-flex items-center px-1.5 py-0.5 rounded bg-emerald-500/12 border border-emerald-500/30 text-[9.5px] font-bold text-emerald-300"
                              >
                                {slot.unit_name}
                              </span>
                            ) : (
                              <span
                                title="Ningún equipo WK2500 cubre este número: no tendrá salida RF"
                                className="inline-flex items-center px-1.5 py-0.5 rounded bg-rose-500/12 border border-rose-500/30 text-[9.5px] font-bold text-rose-300"
                              >
                                sin modulador
                              </span>
                            )}
                            {hasAssigned && (
                              <select
                                value=""
                                title="Mover o intercambiar este canal a otro número (ej. pasar del 2 al 3)"
                                onChange={(e) => {
                                  if (e.target.value) handleSwapOrMoveSlot(slot.catv_ch, Number(e.target.value));
                                }}
                                className="px-1.5 py-1 rounded bg-[#090e1a] border border-slate-700 text-[10px] text-slate-300"
                              >
                                <option value="">⇄ Mover</option>
                                {CATV_NUMBERS.filter((n) => n !== slot.catv_ch).map((n) => (
                                  <option key={n} value={n}>
                                    Pasar a CH {n}
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              step="0.25"
                              key={`f-${slot.catv_ch}-${slot.freq_mhz}-${slot.freq_locked}`}
                              defaultValue={slot.freq_mhz}
                              title="Frecuencia de video. Edítala sólo si tu plan usa HRC/IRC u otra grilla."
                              onBlur={(e) => {
                                const v = Number(e.target.value);
                                if (Number.isFinite(v) && v > 40 && v < 1000 && v !== slot.freq_mhz) {
                                  handleSlotChange(slot.catv_ch, { freq_mhz: v, freq_locked: true });
                                }
                              }}
                              className={`w-20 rounded bg-[#090e1a] border px-1.5 py-1 text-[11px] font-mono font-bold ${
                                slot.freq_locked
                                  ? 'border-amber-500/50 text-amber-300'
                                  : 'border-slate-700 text-slate-200'
                              }`}
                            />
                            <span className="text-[10px] text-slate-500">MHz</span>
                            {slot.freq_locked ? (
                              <button
                                type="button"
                                title="Volver al plan del estándar del equipo"
                                onClick={() => handleSlotChange(slot.catv_ch, { freq_locked: false })}
                                className="rounded border border-slate-700 px-1 text-[10px] text-slate-300 hover:bg-slate-800"
                              >
                                ↺
                              </button>
                            ) : null}
                          </div>
                          <div className="text-[10px] text-slate-500">
                            {slot.unit_standard_short || 'NTSC-M'} · audio {slot.audio_mhz} MHz
                          </div>
                          <div className="text-[10px] text-slate-600">{slot.band_label}</div>
                        </td>
                        <td className="px-3 py-2">
                          <select
                            value={slot.stream_id || ''}
                            onChange={(e) =>
                              handleSlotChange(slot.catv_ch, {
                                stream_id: e.target.value ? Number(e.target.value) : null,
                                enabled: e.target.value ? slot.enabled : false
                              })
                            }
                            className="w-full px-2.5 py-1.5 rounded-lg bg-[#090e1a] border border-slate-700 text-xs text-white"
                          >
                            <option value="">— Libre (Elegir canal para CH {slot.catv_ch}) —</option>
                            {streams.map((st) => (
                              <option key={st.id} value={st.id}>
                                {st.name} [{st.upstream_proto}]
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-3 py-2">
                          <select
                            value={slot.local_interface_ip || ''}
                            onChange={(e) => handleSlotChange(slot.catv_ch, { local_interface_ip: e.target.value })}
                            className="px-2 py-1 rounded bg-[#090e1a] border border-slate-700 text-[11px] text-cyan-300"
                          >
                            <option value="">
                              {dedicatedNic.ip_address
                                ? `Global (${dedicatedNic.if_name || dedicatedNic.ip_address})`
                                : 'Automática'}
                            </option>
                            {interfaces.map((iface) => (
                              <option key={`${iface.name}-${iface.address}`} value={iface.address}>
                                {iface.name} ({iface.address})
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1 font-mono">
                            <input
                              type="text"
                              key={`h-${slot.catv_ch}-${slot.udp_host}`}
                              defaultValue={slot.udp_host}
                              onBlur={(e) => {
                                if (e.target.value.trim() && e.target.value.trim() !== slot.udp_host) {
                                  handleSlotChange(slot.catv_ch, { udp_host: e.target.value.trim() });
                                }
                              }}
                              className="w-28 px-2 py-1 rounded bg-[#090e1a] border border-slate-700 text-emerald-300 text-[11px]"
                            />
                            <span className="text-slate-500">:</span>
                            <input
                              type="number"
                              key={`p-${slot.catv_ch}-${slot.udp_port}`}
                              defaultValue={slot.udp_port}
                              onBlur={(e) => {
                                const p = Number(e.target.value);
                                if (p > 0 && p !== slot.udp_port) {
                                  handleSlotChange(slot.catv_ch, { udp_port: p });
                                }
                              }}
                              className="w-16 px-1.5 py-1 rounded bg-[#090e1a] border border-slate-700 text-cyan-300 text-[11px]"
                            />
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <select
                            value={slot.output_mode}
                            onChange={(e) => handleSlotChange(slot.catv_ch, { output_mode: e.target.value })}
                            className="px-2 py-1 rounded bg-[#090e1a] border border-slate-700 text-[11px] text-slate-200"
                          >
                            <option value="direct_spts">Directo 1316B</option>
                            <option value="copy_mp2_leveled">Copy + MP2 Niv.</option>
                            <option value="copy_aac_leveled">Copy + AAC Niv.</option>
                            <option value="ntsc_sd_wk2500">NTSC 480 SD</option>
                          </select>
                        </td>
                        <td className="px-3 py-2 text-center">
                          <button
                            type="button"
                            disabled={!hasAssigned && !slot.enabled}
                            title={
                              isLive
                                ? `Enviando ${(slot.bitrate_kbps / 1000).toFixed(1)} Mbps a udp://${slot.udp_host}:${slot.udp_port}`
                                : slot.last_error || (slot.enabled ? 'Canal activado, esperando flujo del origen' : 'Canal apagado')
                            }
                            onClick={() => handleSlotChange(slot.catv_ch, { enabled: !slot.enabled })}
                            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold transition ${
                              slot.enabled
                                ? isLive
                                  ? 'bg-emerald-500/20 border border-emerald-500/50 text-emerald-300 hover:bg-emerald-500/35'
                                  : 'bg-amber-500/15 border border-amber-500/45 text-amber-300 hover:bg-amber-500/25'
                                : 'bg-slate-800/90 border border-slate-700 text-slate-400 hover:text-white disabled:opacity-35'
                            }`}
                          >
                            <Power className="w-3.5 h-3.5" />
                            {!slot.enabled
                              ? 'DESACTIVADO'
                              : isLive
                                ? `ACTIVO ${(slot.bitrate_kbps / 1000).toFixed(1)}M`
                                : slot.live_status === 'reconnecting'
                                  ? 'RECONECTANDO'
                                  : 'CONECTANDO'}
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ==================== MODAL: COMPROBAR SALIDA UDP / CATV ==================== */}
      {verifyModal ? (
        <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center overflow-y-auto bg-black/80 p-4">
          <div className="w-full max-w-4xl overflow-hidden rounded-2xl border border-slate-800 bg-[#0e1526] shadow-2xl">
            <div className="flex items-center justify-between gap-2 border-b border-slate-800 bg-[#131c31] px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <ShieldCheck className="h-4 w-4 shrink-0 text-sky-400" />
                <div className="min-w-0">
                  <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
                    Diagnóstico de la salida UDP
                  </div>
                  <div className="truncate text-sm font-bold text-white">
                    {verifyModal.busy
                      ? 'Comprobando…'
                      : verifyModal.data?.units?.[0]
                      ? `Comprobación · ${verifyModal.data.units[0].unit.name}`
                      : 'Comprobación'}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setVerifyModal(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="max-h-[70vh] space-y-3 overflow-y-auto p-4 text-xs">
              {verifyModal.busy ? (
                <div className="rounded-xl border border-slate-800 bg-[#090e1a] px-3 py-6 text-center text-slate-400">
                  Midiendo paquetes durante 1.2 s y consultando la red…
                </div>
              ) : null}

              {verifyModal.error ? (
                <div className="flex items-start gap-1.5 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {verifyModal.error}
                </div>
              ) : null}

              {(verifyModal.data?.units || []).map((vu) => (
                <div key={vu.unit.id} className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                    <span className="rounded-lg border border-slate-700 bg-[#090e1a] px-2 py-1 font-mono text-slate-200">
                      {vu.unit.dest_ip}
                    </span>
                    <span>{vu.carriers.length} portadoras</span>
                    <span className="text-slate-600">·</span>
                    <span>
                      {vu.checks.filter((c) => c.ok).length}/{vu.checks.length} comprobaciones OK
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    {vu.checks.map((c) => (
                      <div
                        key={c.id}
                        className={`rounded-xl border px-2.5 py-1.5 ${
                          c.ok
                            ? 'border-emerald-500/30 bg-emerald-500/8'
                            : c.level === 'error'
                            ? 'border-rose-500/40 bg-rose-500/10'
                            : 'border-amber-500/30 bg-amber-500/8'
                        }`}
                      >
                        <div className="flex items-start gap-1.5">
                          {c.ok ? (
                            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                          ) : (
                            <AlertTriangle
                              className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                                c.level === 'error' ? 'text-rose-400' : 'text-amber-400'
                              }`}
                            />
                          )}
                          <div className="min-w-0">
                            <div
                              className={`font-semibold ${
                                c.ok ? 'text-emerald-100' : c.level === 'error' ? 'text-rose-100' : 'text-amber-100'
                              }`}
                            >
                              {c.title}
                            </div>
                            {c.detail ? (
                              <div className="mt-0.5 text-[10.5px] leading-snug text-slate-400">{c.detail}</div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
                        Portadoras · lo que el panel está enviando
                      </div>
                      <button
                        type="button"
                        onClick={() => copyMapping(vu.mappingText)}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] font-semibold text-slate-200 hover:bg-slate-700"
                      >
                        <Copy className="h-3 w-3" /> Copiar tabla
                      </button>
                    </div>
                    <div className="max-h-56 overflow-auto rounded-lg border border-slate-800">
                      <table className="w-full text-left text-[10.5px]">
                        <thead className="sticky top-0 bg-[#131c31] text-slate-400">
                          <tr>
                            <th className="px-2 py-1">P</th>
                            <th className="px-2 py-1">Canal</th>
                            <th className="px-2 py-1">MHz</th>
                            <th className="px-2 py-1">UDP destino</th>
                            <th className="px-2 py-1">Nombre</th>
                            <th className="px-2 py-1">Estado</th>
                          </tr>
                        </thead>
                        <tbody>
                          {vu.carriers.map((c) => (
                            <tr key={c.catv_ch} className="border-t border-slate-800/70">
                              <td className="px-2 py-1 font-mono text-slate-500">{c.carrier}</td>
                              <td className="px-2 py-1 font-mono text-slate-200">{c.catv_ch}</td>
                              <td className="px-2 py-1 font-mono text-slate-400">{c.freq_mhz}</td>
                              <td className="px-2 py-1 font-mono text-slate-300">
                                {c.udp_host}:{c.udp_port}
                              </td>
                              <td className="px-2 py-1 text-slate-300">
                                {c.name}
                                <span className="ml-1 text-[9px] text-slate-500">({c.name_source})</span>
                              </td>
                              <td className="px-2 py-1">
                                {c.worker.packets_per_sec > 0 ? (
                                  <span className="font-semibold text-emerald-300">
                                    {c.worker.packets_per_sec} pkt/s · {c.worker.bitrate_kbps} kbps
                                  </span>
                                ) : (
                                  <span className={c.worker.last_error ? 'text-rose-300' : 'text-slate-500'}>
                                    {c.worker.status}
                                    {c.worker.last_error ? ` · ${c.worker.last_error}` : ''}
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              ))}

              {!verifyModal.busy && !verifyModal.error && !(verifyModal.data?.units || []).length ? (
                <div className="rounded-xl border border-slate-800 bg-[#090e1a] px-3 py-6 text-center text-slate-400">
                  No hay moduladores dados de alta.
                </div>
              ) : null}

              <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-[10.5px] leading-relaxed text-sky-100">
                <b>Importante:</b> el CSV cambia canal, frecuencia y nombre. La <b>IP y el puerto UDP</b> se configuran
                en la página de entrada (<span className="font-mono">Input / Mapping</span>) del propio modulador: usa
                «Copiar tabla» y pégalos ahí. Si el equipo no muestra nombres, es porque el archivo que subes no tiene
                columna de nombre (la comprobación de arriba lo dice).
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-800 bg-[#131c31] px-4 py-3">
              <button
                type="button"
                onClick={() => runVerify(verifyModal.unitId ? { id: verifyModal.unitId } : null)}
                disabled={verifyModal.busy}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-bold text-slate-200 hover:bg-slate-700 disabled:opacity-40"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Comprobar otra vez
              </button>
              <button
                type="button"
                onClick={() => setVerifyModal(null)}
                className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-500"
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ==================== MODAL: PLANTILLA CSV DEL MODULADOR ==================== */}
      {tplModal ? (
        <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center overflow-y-auto bg-black/80 p-4">
          <div className="w-full max-w-3xl overflow-hidden rounded-2xl border border-slate-800 bg-[#0e1526] shadow-2xl">
            <div className="flex items-center justify-between gap-2 border-b border-slate-800 bg-[#131c31] px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <FileSpreadsheet className="h-4 w-4 shrink-0 text-emerald-400" />
                <div className="min-w-0">
                  <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
                    Formato de importación del equipo
                  </div>
                  <div className="truncate text-sm font-bold text-white">
                    Plantilla CSV · {tplModal.unit.name}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setTplModal(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3 p-4 text-xs">
              <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 px-3 py-2 leading-relaxed text-sky-100">
                En la web del modulador (<span className="font-mono">{tplModal.unit.dest_ip}</span>) entra a la tabla de
                canales y pulsa <b>Export / Descargar</b>. Abre ese archivo con el Bloc de notas y pégalo aquí completo,
                con su primera línea. El panel rellena <b>ese mismo archivo</b> con tus canales: misma cabecera, mismo
                orden de columnas, mismo separador. Es la única forma de que el equipo lo acepte y cambie los canales.
              </div>

              {tplModal.unit.csv_template?.saved && !(tplModal.unit.csv_template.mapped || []).includes('name') ? (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[10.5px] leading-snug text-amber-100">
                  La plantilla guardada <b>no tiene columna de nombre</b>: el CSV no puede cambiar los nombres del
                  modulador. Si quieres que los cambie, exporta de nuevo el archivo del equipo con esa columna visible
                  y vuelve a pegarlo aquí.
                </div>
              ) : null}

              {tplModal.unit.csv_template?.saved && !tplModal.result ? (
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-200">
                  Plantilla guardada: {tplModal.unit.csv_template.cols} columnas · separador «
                  {tplModal.unit.csv_template.delimiter}» · {tplModal.unit.csv_template.mapped?.length || 0} campos
                  reconocidos. Pega otro archivo abajo si quieres reemplazarla.
                </div>
              ) : null}

              <div>
                <label className="mb-1 block text-[11px] font-semibold text-slate-300">
                  CSV que exporta el modulador
                </label>
                <textarea
                  value={tplModal.text}
                  onChange={(e) => setTplModal((prev) => ({ ...prev, text: e.target.value }))}
                  rows={7}
                  spellCheck={false}
                  placeholder={'Channel,Frequency(MHz),Audio Frequency(MHz),Program,IP Address,Port,Standard,Level,Bandwidth,Name,Enable\n1,91.25,95.75,1,192.168.25.10,5095,NTSC,1.0,6.000,CH95,1'}
                  className="w-full rounded-xl border border-slate-700 bg-[#090e1a] px-3 py-2 font-mono text-[11px] text-emerald-200/90 placeholder:text-slate-600"
                />
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] font-semibold text-slate-200 hover:bg-slate-700">
                    <Upload className="h-3 w-3" /> Abrir archivo…
                    <input
                      type="file"
                      accept=".csv,.txt,text/csv"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const text = await file.text();
                        setTplModal((prev) => (prev ? { ...prev, text, result: null, error: '' } : prev));
                        e.target.value = '';
                      }}
                    />
                  </label>
                  <span className="text-[10px] text-slate-500">
                    Se acepta «,» «;» tabulador y archivos sin cabecera.
                  </span>
                </div>
              </div>

              {tplModal.error ? (
                <div className="flex items-start gap-1.5 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {tplModal.error}
                </div>
              ) : null}

              {tplModal.result ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {[
                      { label: 'Columnas', value: tplModal.result.template.cols },
                      { label: 'Separador', value: tplModal.result.delimiter === '\t' ? 'TAB' : tplModal.result.delimiter },
                      { label: 'Fin de línea', value: tplModal.result.eol === 'crlf' ? 'CRLF' : 'LF' },
                      {
                        label: 'Campos',
                        value: `${tplModal.result.template.mapped?.length || 0}/5`
                      }
                    ].map((box) => (
                      <div key={box.label} className="rounded-lg border border-slate-800 bg-[#090e1a] px-2 py-1.5">
                        <div className="text-slate-500">{box.label}</div>
                        <div className="font-mono font-semibold text-white">{box.value}</div>
                      </div>
                    ))}
                  </div>
                  {(tplModal.result.template.missing || []).length ? (
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[10.5px] leading-snug text-amber-100">
                      No se encontraron estas columnas: {tplModal.result.template.missing.join(', ')}. Se conserva el
                      valor que trae el archivo del equipo en esas columnas.
                    </div>
                  ) : null}
                  <div>
                    <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                      Así saldrá el archivo (3 primeras portadoras)
                    </div>
                    <pre className="max-h-40 overflow-auto whitespace-pre rounded-lg border border-slate-800 bg-[#070b13] p-2 font-mono text-[10px] leading-relaxed text-emerald-200/90">
                      {(tplModal.result.preview || []).join('\n')}
                    </pre>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-800 bg-[#131c31] px-4 py-3">
              {tplModal.unit.csv_template?.saved ? (
                <button
                  type="button"
                  onClick={removeTemplate}
                  disabled={tplModal.busy}
                  className="mr-auto inline-flex items-center gap-1.5 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs font-bold text-rose-200 hover:bg-rose-500/20 disabled:opacity-40"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Quitar plantilla
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setTplModal(null)}
                className="rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-bold text-slate-200 hover:bg-slate-700"
              >
                Cerrar
              </button>
              <button
                type="button"
                onClick={saveTemplate}
                disabled={tplModal.busy || !tplModal.text.trim()}
                className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                <Save className="h-3.5 w-3.5" /> {tplModal.busy ? 'Analizando…' : 'Guardar plantilla'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ==================== MODAL: EQUIPO WK2500 ==================== */}
      {modalUnit ? (
        <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center overflow-y-auto bg-black/80 p-4">
          <form
            onSubmit={handleSaveUnit}
            className="w-full max-w-2xl overflow-hidden rounded-2xl border border-slate-800 bg-[#0e1526] shadow-2xl"
          >
            <div className="flex items-center justify-between gap-2 border-b border-slate-800 bg-[#131c31] px-4 py-3">
              <div className="flex items-center gap-2 min-w-0">
                <Cpu className="h-4 w-4 text-emerald-400 shrink-0" />
                <div className="min-w-0">
                  <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Modulador WK2500</div>
                  <div className="truncate text-sm font-bold text-white">
                    {modalUnit.id ? 'Editar equipo' : 'Nuevo equipo'}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setUnitModal(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4 text-xs">
              <div className="sm:col-span-2">
                <label className="mb-1 block text-[11px] text-slate-300">Nombre del equipo</label>
                <input
                  type="text"
                  required
                  value={modalUnit.form.name}
                  onChange={(e) => setUnitModal({ ...modalUnit, form: { ...modalUnit.form, name: e.target.value } })}
                  placeholder="Ej. WK2500 Rack 1"
                  className="w-full rounded-xl border border-slate-700 bg-[#090e1a] px-3 py-2 text-white"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="mb-1 block text-[11px] text-slate-300">Marca / modelo del modulador</label>
                <select
                  value={modalUnit.form.brand_model}
                  onChange={(e) => {
                    const b = brands.find((x) => x.id === e.target.value);
                    setUnitModal({
                      ...modalUnit,
                      form: {
                        ...modalUnit.form,
                        brand_model: e.target.value,
                        tv_standard: b?.default_standard || modalUnit.form.tv_standard,
                        pkt_size: b?.default_pkt_size || modalUnit.form.pkt_size,
                        rtp: Boolean(b?.default_rtp)
                      }
                    });
                  }}
                  className="w-full rounded-xl border border-slate-700 bg-[#090e1a] px-3 py-2 text-white"
                >
                  {(brands.length ? brands : [{ id: 'generic_2500', label: 'Genérico IP→analógico' }]).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.label}
                    </option>
                  ))}
                </select>
                {(() => {
                  const b = brands.find((x) => x.id === modalUnit.form.brand_model);
                  return b?.notes ? <p className="mt-1 text-[10px] leading-snug text-slate-500">{b.notes}</p> : null;
                })()}
              </div>

              <div>
                <label className="mb-1 block text-[11px] text-slate-300">Estándar de TV (define frecuencia y audio)</label>
                <select
                  value={modalUnit.form.tv_standard}
                  onChange={(e) => setUnitModal({ ...modalUnit, form: { ...modalUnit.form, tv_standard: e.target.value } })}
                  className="w-full rounded-xl border border-slate-700 bg-[#090e1a] px-3 py-2 text-white"
                >
                  {tvStandards.map((st) => (
                    <option key={st.id} value={st.id}>
                      {st.label} · audio +{st.audio_offset_mhz} MHz
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-[11px] text-slate-300">Modelo (canales de salida)</label>
                <select
                  value={modalUnit.form.model_channels}
                  onChange={(e) => {
                    const model = Number(e.target.value);
                    const start = Number(modalUnit.form.ch_start) || 2;
                    setUnitModal({
                      ...modalUnit,
                      form: {
                        ...modalUnit.form,
                        model_channels: model,
                        ch_end: Math.min(125, start + model - 1)
                      }
                    });
                  }}
                  className="w-full rounded-xl border border-slate-700 bg-[#090e1a] px-3 py-2 text-white"
                >
                  {models.map((m) => (
                    <option key={m.id} value={m.channels}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-[11px] text-slate-300">Canal inicial</label>
                  <input
                    type="number"
                    min={2}
                    max={125}
                    value={modalUnit.form.ch_start}
                    onChange={(e) => {
                      const start = Number(e.target.value);
                      setUnitModal({
                        ...modalUnit,
                        form: {
                          ...modalUnit.form,
                          ch_start: start,
                          ch_end: Math.min(125, start + Number(modalUnit.form.model_channels) - 1)
                        }
                      });
                    }}
                    className="w-full rounded-xl border border-slate-700 bg-[#090e1a] px-2.5 py-2 text-amber-300 font-bold"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-slate-300">Canal final</label>
                  <input
                    type="number"
                    min={2}
                    max={125}
                    value={modalUnit.form.ch_end}
                    onChange={(e) => setUnitModal({ ...modalUnit, form: { ...modalUnit.form, ch_end: Number(e.target.value) } })}
                    className="w-full rounded-xl border border-slate-700 bg-[#090e1a] px-2.5 py-2 text-amber-300 font-bold"
                  />
                </div>
              </div>

              <div className="sm:col-span-2">
                <label className="mb-1 flex items-center justify-between text-[11px] text-slate-300">
                  <span>
                    Canales del equipo <span className="text-slate-500">— en el orden de las portadoras RF</span>
                  </span>
                  {modalExplicit ? (
                    <button
                      type="button"
                      onClick={() => setUnitModal({ ...modalUnit, form: { ...modalUnit.form, channels_text: '' } })}
                      className="text-[10px] text-sky-300 hover:text-sky-200"
                    >
                      volver a rango contiguo
                    </button>
                  ) : null}
                </label>
                <input
                  type="text"
                  value={modalUnit.form.channels_text ?? ''}
                  onChange={(e) => setUnitModal({ ...modalUnit, form: { ...modalUnit.form, channels_text: e.target.value } })}
                  placeholder={`vacío = rango ${modalUnit.form.ch_start}-${modalUnit.form.ch_end} · o escribe 95, 2-28, 96-99`}
                  className="w-full rounded-xl border border-slate-700 bg-[#090e1a] px-3 py-2 font-mono text-amber-300"
                />
                <p className="mt-1 text-[10px] leading-snug text-slate-500">
                  La <b>primera</b> de la lista va a la portadora 1 del equipo. Ej.: «95, 2-28, 96-99» deja CH95 en la
                  portadora 1 y CH2 en la 2. Vacío = rango contiguo del canal inicial al final.
                </p>
              </div>

              {(() => {
                const ocupados = modalChannels.filter((ch) => {
                  const owner = (units || []).find(
                    (u) => Number(u.id) !== Number(modalUnit.id) && (u.channels || []).includes(ch)
                  );
                  return owner;
                });
                if (!ocupados.length) return null;
                const dueños = [
                  ...new Set(
                    ocupados.map(
                      (ch) =>
                        (units || []).find((u) => Number(u.id) !== Number(modalUnit.id) && (u.channels || []).includes(ch))
                          ?.name || ''
                    )
                  )
                ];
                return (
                  <label className="sm:col-span-2 flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100">
                    <input
                      type="checkbox"
                      checked={Boolean(modalUnit.form.steal_from_others)}
                      onChange={(e) =>
                        setUnitModal({ ...modalUnit, form: { ...modalUnit.form, steal_from_others: e.target.checked } })
                      }
                      className="mt-0.5 accent-amber-500"
                    />
                    <span>
                      <b>{ocupados.length} canal(es) ya los genera otro equipo</b> ({dueños.join(', ')}). Marca esta casilla
                      para <b>quitárselos</b> y asignarlos aquí (se recalcula la lista del otro equipo).
                    </span>
                  </label>
                );
              })()}

              <div className="sm:col-span-2 rounded-xl border border-slate-800 bg-[#090e1a] px-3 py-2 text-[11px] space-y-1.5">
                <div className={modalSpanError ? 'text-rose-300 font-bold' : 'text-slate-300'}>
                  {modalExplicit
                    ? `${modalChannels.length} portadoras · P1 = CH ${modalChannels[0] ?? '—'}`
                    : `Rango CH ${modalUnit.form.ch_start}–${modalUnit.form.ch_end} = ${modalSpan} canales`}
                  {modalSpanError
                    ? ` · excede la capacidad del modelo (${modalCap}) o la lista está vacía.`
                    : ` · capacidad usada ${Math.round((modalSpan / modalCap) * 100)}% de ${modalCap} (${Math.max(0, modalCap - modalSpan)} libres).`}
                </div>
                {modalExplicit && modalChannels.length ? (
                  <div className="flex flex-wrap gap-1">
                    {modalChannels.slice(0, 40).map((ch, idx) => (
                      <span
                        key={ch}
                        className="rounded border border-slate-700 bg-[#0e1526] px-1.5 py-0.5 font-mono text-[9.5px] text-slate-300"
                      >
                        <span className="text-slate-500">P{idx + 1}</span> CH{ch}
                      </span>
                    ))}
                    {modalChannels.length > 40 ? (
                      <span className="px-1 text-[9.5px] text-slate-500">+{modalChannels.length - 40} más…</span>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div>
                <label className="mb-1 block text-[11px] text-slate-300">Tipo de salida UDP</label>
                <select
                  value={modalUnit.form.ip_mode}
                  onChange={(e) =>
                    setUnitModal({
                      ...modalUnit,
                      form: {
                        ...modalUnit.form,
                        ip_mode: e.target.value,
                        dest_ip: e.target.value === 'multicast' ? '239.25.0.0' : '192.168.25.10'
                      }
                    })
                  }
                  className="w-full rounded-xl border border-slate-700 bg-[#090e1a] px-3 py-2 text-white"
                >
                  <option value="unicast">Unicast — IP del WK2500</option>
                  <option value="multicast">Multicast — grupo 239.x</option>
                </select>
              </div>

              <div>
                <label className="mb-1 block text-[11px] text-slate-300">IP destino del equipo</label>
                <input
                  type="text"
                  required
                  value={modalUnit.form.dest_ip}
                  onChange={(e) => setUnitModal({ ...modalUnit, form: { ...modalUnit.form, dest_ip: e.target.value } })}
                  className="w-full rounded-xl border border-slate-700 bg-[#090e1a] px-3 py-2 text-cyan-300 font-mono"
                />
              </div>

              <div>
                <label className="mb-1 block text-[11px] text-slate-300">Puerto base UDP</label>
                <input
                  type="number"
                  min={1}
                  max={65000}
                  value={modalUnit.form.base_port}
                  onChange={(e) => setUnitModal({ ...modalUnit, form: { ...modalUnit.form, base_port: Number(e.target.value) } })}
                  className="w-full rounded-xl border border-slate-700 bg-[#090e1a] px-3 py-2 text-cyan-300 font-mono"
                />
              </div>

              <div>
                <label className="mb-1 block text-[11px] text-slate-300">Tarjeta NIC de salida</label>
                <select
                  value={modalUnit.form.local_interface_ip || ''}
                  onChange={(e) =>
                    setUnitModal({ ...modalUnit, form: { ...modalUnit.form, local_interface_ip: e.target.value } })
                  }
                  className="w-full rounded-xl border border-slate-700 bg-[#090e1a] px-3 py-2 text-cyan-300"
                >
                  <option value="">
                    {dedicatedNic.ip_address ? `Global (${dedicatedNic.ip_address})` : 'Automática'}
                  </option>
                  {interfaces.map((iface) => (
                    <option key={`${iface.name}-${iface.address}`} value={iface.address}>
                      {iface.name} ({iface.address})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-[11px] text-slate-300">Tamaño de datagrama</label>
                <select
                  value={modalUnit.form.pkt_size}
                  onChange={(e) => setUnitModal({ ...modalUnit, form: { ...modalUnit.form, pkt_size: Number(e.target.value) } })}
                  className="w-full rounded-xl border border-slate-700 bg-[#090e1a] px-3 py-2 text-white"
                >
                  {pktSizes.map((n) => (
                    <option key={n} value={n}>
                      {n} bytes {n === 1316 ? '(7 × 188, el clásico)' : '(1 × 188)'}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-[11px] text-slate-300">Transporte</label>
                <label className="flex items-center gap-2 rounded-xl border border-slate-700 bg-[#090e1a] px-3 py-2 text-[11px] text-slate-300">
                  <input
                    type="checkbox"
                    checked={Boolean(modalUnit.form.rtp)}
                    onChange={(e) => setUnitModal({ ...modalUnit, form: { ...modalUnit.form, rtp: e.target.checked } })}
                    className="accent-emerald-500"
                  />
                  Envolver en RTP (UDP + RTP)
                </label>
                <p className="mt-1 text-[10px] text-slate-500">
                  Actívalo si el modulador exige UDP/RTP. Con RTP el canal se emite por FFmpeg para llevar timestamps correctos.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-[11px] text-slate-300">TTL</label>
                  <input
                    type="number"
                    min={1}
                    max={255}
                    value={modalUnit.form.ttl}
                    onChange={(e) => setUnitModal({ ...modalUnit, form: { ...modalUnit.form, ttl: Number(e.target.value) } })}
                    className="w-full rounded-xl border border-slate-700 bg-[#090e1a] px-2.5 py-2 text-white"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-slate-300">Perfil</label>
                  <select
                    value={modalUnit.form.default_output_mode}
                    onChange={(e) =>
                      setUnitModal({ ...modalUnit, form: { ...modalUnit.form, default_output_mode: e.target.value } })
                    }
                    className="w-full rounded-xl border border-slate-700 bg-[#090e1a] px-2 py-2 text-white"
                  >
                    <option value="direct_spts">Directo 1316B</option>
                    <option value="copy_mp2_leveled">Copy + MP2</option>
                    <option value="copy_aac_leveled">Copy + AAC</option>
                    <option value="ntsc_sd_wk2500">NTSC 480 SD</option>
                  </select>
                </div>
              </div>

              <div className="sm:col-span-2 flex items-center gap-2">
                <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-300">
                  <input
                    type="checkbox"
                    checked={Boolean(modalUnit.form.enabled)}
                    onChange={(e) => setUnitModal({ ...modalUnit, form: { ...modalUnit.form, enabled: e.target.checked } })}
                    className="accent-emerald-500"
                  />
                  Equipo activo (sus canales pueden salir al aire)
                </label>
              </div>

              <div className="sm:col-span-2">
                <label className="mb-1 block text-[11px] text-slate-300">Notas (opcional)</label>
                <input
                  type="text"
                  value={modalUnit.form.notes || ''}
                  onChange={(e) => setUnitModal({ ...modalUnit, form: { ...modalUnit.form, notes: e.target.value } })}
                  placeholder="Ej. Rack 2, combinador 3, canal 2 al 33"
                  className="w-full rounded-xl border border-slate-700 bg-[#090e1a] px-3 py-2 text-white"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-slate-800 bg-[#131c31] px-4 py-3">
              <button
                type="button"
                onClick={() => setUnitModal(null)}
                className="rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-bold text-slate-200 hover:bg-slate-700"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={savingUnit || modalSpanError}
                className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                <Save className="h-3.5 w-3.5" />
                {savingUnit ? 'Guardando…' : modalUnit.id ? 'Guardar cambios' : 'Crear equipo'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
