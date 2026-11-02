import React, { useEffect, useMemo, useState } from 'react';
import {
  ShieldCheck,
  ShieldOff,
  KeyRound,
  Copy,
  Check,
  RefreshCw,
  Loader2,
  Lock,
  Radio,
  Server,
  AlertTriangle,
  Trash2,
  Zap
} from 'lucide-react';
import { apiFetch } from '../lib/api.js';

const MODES = [
  { value: 'off', label: 'Desactivado', hint: 'Sin cifrado' },
  { value: 'aes128', label: 'AES-128 (HLS)', hint: 'Flussonic cifra y pide la clave a este panel' },
  { value: 'sample_aes', label: 'SAMPLE-AES (HLS)', hint: 'Igual que AES-128, cifra sólo audio/vídeo' },
  { value: 'widevine', label: 'Widevine (DRM)', hint: 'Necesita tu servidor de licencias Widevine' },
  { value: 'playready', label: 'PlayReady (DRM)', hint: 'Necesita tu servidor de licencias PlayReady' }
];

const modeLabel = (m) => MODES.find((x) => x.value === m)?.label || m;

function Badge({ children, tone = 'slate' }) {
  const tones = {
    slate: 'bg-slate-800 text-slate-300 border-slate-700',
    green: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
    red: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
    amber: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
    indigo: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/30'
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-bold ${tones[tone]}`}>
      {children}
    </span>
  );
}

function CopyButton({ text, label = 'Copiar' }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text || '');
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] font-semibold"
    >
      {done ? <Check size={11} /> : <Copy size={11} />} {done ? 'Copiado' : label}
    </button>
  );
}

export default function DrmPage() {
  const [data, setData] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [form, setForm] = useState(null);
  const [snippet, setSnippet] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [err, setErr] = useState('');
  const [testResult, setTestResult] = useState(null);
  const [flussonicPreview, setFlussonicPreview] = useState(null);
  const [bulk, setBulk] = useState(null);
  const [bulkBusy, setBulkBusy] = useState('');
  const [bulkResult, setBulkResult] = useState(null);
  const [playerSec, setPlayerSec] = useState(null);

  const flash = (msg) => {
    setNotice(msg);
    setErr('');
    setTimeout(() => setNotice(''), 5000);
  };
  const fail = (msg) => {
    setErr(msg);
    setNotice('');
  };

  const load = async () => {
    try {
      const [ov, cand, sec] = await Promise.all([
        apiFetch('/api/drm/overview'),
        apiFetch('/api/drm/candidates'),
        apiFetch('/api/drm/player-security')
      ]);
      setData(ov);
      setCandidates(cand.streams || []);
      setPlayerSec(sec);
    } catch (e) {
      fail(e.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openStream = async (id) => {
    setSelectedId(String(id));
    setTestResult(null);
    setFlussonicPreview(null);
    try {
      const res = await apiFetch(`/api/drm/streams/${id}`);
      const d = res.drm;
      setForm({
        enabled: d.enabled,
        mode: d.mode || 'off',
        licenseUrl: d.license_url || '',
        licenseHeaders: d.license_headers && d.license_headers !== '{}' ? d.license_headers : '',
        flussonicStream: d.flussonic_stream || '',
        staticKey: '',
        regenerateMasterKey: false,
        cencAesKey: '',
        cencIv: '',
        cencContentId: d.cenc_content_id || '',
        hasCenc: d.has_cenc_keys
      });
      setSnippet(res.snippet || '');
    } catch (e) {
      fail(e.message);
    }
  };

  const save = async () => {
    if (!selectedId || !form) return;
    setBusy('save');
    try {
      const res = await apiFetch(`/api/drm/streams/${selectedId}`, {
        method: 'PUT',
        body: JSON.stringify(form)
      });
      setSnippet(res.snippet || '');
      setForm({ ...form, staticKey: '', cencAesKey: '', cencIv: '', regenerateMasterKey: false });
      flash('DRM guardado. Copia el bloque de Flussonic para que empiece a cifrar.');
      await load();
    } catch (e) {
      fail(e.message);
    } finally {
      setBusy('');
    }
  };

  const rotate = async () => {
    if (!selectedId) return;
    setBusy('rotate');
    try {
      const res = await apiFetch(`/api/drm/streams/${selectedId}/rotate`, { method: 'POST' });
      setSnippet(res.snippet || '');
      flash('Tokens rotados: las URLs anteriores dejan de entregar claves.');
      await load();
    } catch (e) {
      fail(e.message);
    } finally {
      setBusy('');
    }
  };

  const runTest = async () => {
    if (!selectedId) return;
    setBusy('test');
    try {
      const res = await apiFetch(`/api/drm/streams/${selectedId}/test`, { method: 'POST', body: '{}' });
      setTestResult(res);
    } catch (e) {
      fail(e.message);
    } finally {
      setBusy('');
    }
  };

  const previewFlussonic = async (action) => {
    if (!selectedId || !form) return;
    setBusy(action);
    try {
      const res = await apiFetch(`/api/drm/streams/${selectedId}/flussonic`, {
        method: 'POST',
        body: JSON.stringify({
          action,
          flussonicStream: form.flussonicStream,
          serverId: undefined
        })
      });
      if (action === 'preview') {
        setFlussonicPreview(res);
        flash('Vista previa de lo que se enviaría a Flussonic (no se ha cambiado nada).');
      } else {
        setFlussonicPreview(null);
        flash(action === 'remove' ? 'DRM quitado del stream en Flussonic.' : 'DRM aplicado en Flussonic.');
      }
      await load();
    } catch (e) {
      fail(e.message);
    } finally {
      setBusy('');
    }
  };

  const remove = async () => {
    if (!selectedId) return;
    setBusy('remove');
    try {
      await apiFetch(`/api/drm/streams/${selectedId}`, { method: 'DELETE' });
      setForm(null);
      setSnippet('');
      setSelectedId('');
      flash('Configuración DRM borrada de ese canal.');
      await load();
    } catch (e) {
      fail(e.message);
    } finally {
      setBusy('');
    }
  };

  const loadBulkPlan = async (includeCatv = false) => {
    setBulkBusy('plan');
    try {
      const res = await apiFetch(`/api/drm/bulk/plan${includeCatv ? '?includeCatv=1' : ''}`);
      setBulk(res);
    } catch (e) {
      fail(e.message);
    } finally {
      setBulkBusy('');
    }
  };

  const applyBulk = async (includeCatv = false) => {
    setBulkBusy('apply');
    try {
      const res = await apiFetch('/api/drm/bulk/apply', {
        method: 'POST',
        body: JSON.stringify({ includeCatv })
      });
      setBulkResult(res);
      flash(`AES-128 activado en ${res.applied?.length || 0} canales del panel.`);
      await loadBulkPlan(includeCatv);
      await load();
    } catch (e) {
      fail(e.message);
    } finally {
      setBulkBusy('');
    }
  };

  const pushAll = async (action = 'apply') => {
    setBulkBusy('push');
    try {
      const res = await apiFetch('/api/drm/bulk/push', {
        method: 'POST',
        body: JSON.stringify({ action })
      });
      setBulkResult(res);
      flash(
        action === 'remove'
          ? `DRM quitado de ${res.sent} streams en Flussonic.`
          : `Bloque drm enviado a Flussonic: ${res.sent}/${res.total}.`
      );
      await load();
    } catch (e) {
      fail(e.message);
    } finally {
      setBulkBusy('');
    }
  };

  const saveSettings = async (patch) => {
    setBusy('settings');
    try {
      const res = await apiFetch('/api/drm/settings', { method: 'PUT', body: JSON.stringify(patch) });
      setData({ ...data, settings: res.settings });
      flash('Ajustes DRM guardados.');
    } catch (e) {
      fail(e.message);
    } finally {
      setBusy('');
    }
  };

  const statFor = (kind) => (data?.stats || []).find((s) => s.kind === kind) || { total: 0, ok: 0 };

  const activeCount = useMemo(
    () => (data?.streams || []).filter((s) => s.enabled).length,
    [data]
  );

  return (
    <div className="space-y-5">
      <div className="rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold text-white flex items-center gap-2">
              <Lock className="w-5 h-5 text-indigo-400" />
              DRM & Claves (CAS propio)
            </h1>
            <p className="text-[11px] text-slate-400 mt-1 max-w-3xl leading-relaxed">
              TVLister hace de <b className="text-slate-200">servidor de claves</b> de tu Flussonic: el stream se cifra
              en AES-128 (o SAMPLE-AES) y cada clave se pide a este panel, que la entrega sólo a líneas válidas y la rota
              cada 10 minutos. En Widevine/PlayReady el panel hace de <b className="text-slate-200">proxy de licencias</b>:
              el cliente nunca ve tu servidor de licencias.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={data?.settings?.enabled ? 'green' : 'red'}>
              {data?.settings?.enabled ? 'DRM ACTIVO' : 'DRM APAGADO'}
            </Badge>
            <Badge tone="indigo">{activeCount} canales protegidos</Badge>
          </div>
        </div>

        <div className="grid gap-2 mt-4 md:grid-cols-3">
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
            <div className="text-[10px] font-bold text-emerald-300 uppercase tracking-wide">AES-128 / SAMPLE-AES</div>
            <div className="text-[11px] text-slate-300 mt-1">
              <b className="text-white">Las emite este panel.</b> Clave maestra por canal + rotación cada 10 min.
              Gratis, sin terceros, funciona en casi todos los reproductores.
            </div>
          </div>
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
            <div className="text-[10px] font-bold text-amber-300 uppercase tracking-wide">ClearKey</div>
            <div className="text-[11px] text-slate-300 mt-1">
              <b className="text-white">También las emite el panel</b>, pero la clave viaja al reproductor en un JSON
              legible: sirve para EME/pruebas, no para proteger contenido de verdad.
            </div>
          </div>
          <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-3">
            <div className="text-[10px] font-bold text-indigo-300 uppercase tracking-wide">Widevine / PlayReady</div>
            <div className="text-[11px] text-slate-300 mt-1">
              <b className="text-white">No las puede emitir ningún panel.</b> La licencia la firma Google o un partner
              autorizado; TVLister custodia tu <code>aes_key/iv</code> y hace de proxy autorizado.
            </div>
          </div>
        </div>

        <div className="grid gap-3 mt-3 md:grid-cols-3">
          <div className="rounded-xl bg-[#090e1a] border border-slate-800 p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Claves CAS (24 h)</div>
            <div className="text-xl font-bold text-white mt-1">
              {statFor('cas').ok}
              <span className="text-[11px] text-slate-500 font-normal"> / {statFor('cas').total}</span>
            </div>
            <div className="text-[10px] text-slate-500">peticiones de Flussonic</div>
          </div>
          <div className="rounded-xl bg-[#090e1a] border border-slate-800 p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Claves a clientes (24 h)</div>
            <div className="text-xl font-bold text-white mt-1">
              {statFor('key').ok}
              <span className="text-[11px] text-slate-500 font-normal"> / {statFor('key').total}</span>
            </div>
            <div className="text-[10px] text-slate-500">entregas en /drm/key</div>
          </div>
          <div className="rounded-xl bg-[#090e1a] border border-slate-800 p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Licencias (24 h)</div>
            <div className="text-xl font-bold text-white mt-1">
              {statFor('license').ok}
              <span className="text-[11px] text-slate-500 font-normal"> / {statFor('license').total}</span>
            </div>
            <div className="text-[10px] text-slate-500">proxy Widevine/PlayReady</div>
          </div>
        </div>

        <div className="grid gap-3 mt-3 md:grid-cols-3">
          <label className="flex items-center justify-between gap-2 rounded-xl bg-[#090e1a] border border-slate-800 p-3">
            <span className="text-[11px] text-slate-300 font-semibold">DRM global</span>
            <input
              type="checkbox"
              checked={Boolean(data?.settings?.enabled)}
              onChange={(e) => saveSettings({ enabled: e.target.checked })}
              className="w-4 h-4 accent-indigo-500"
            />
          </label>
          <label className="rounded-xl bg-[#090e1a] border border-slate-800 p-3">
            <span className="block text-[10px] text-slate-400 mb-1">
              IPs que pueden llamar al CAS (vacío = todas)
            </span>
            <input
              type="text"
              defaultValue={data?.settings?.casAllowIps || ''}
              onBlur={(e) => saveSettings({ casAllowIps: e.target.value })}
              placeholder="127.0.0.1, 203.0.113.20"
              className="w-full px-2 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white text-[11px] font-mono"
            />
          </label>
          <label className="rounded-xl bg-[#090e1a] border border-slate-800 p-3">
            <span className="block text-[10px] text-slate-400 mb-1">Servidor de licencias por defecto</span>
            <input
              type="text"
              defaultValue={data?.settings?.defaultLicenseUrl || ''}
              onBlur={(e) => saveSettings({ defaultLicenseUrl: e.target.value })}
              placeholder="https://license.tudominio.com/wv"
              className="w-full px-2 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white text-[11px] font-mono"
            />
          </label>
        </div>

        {notice && <div className="mt-3 text-[11px] text-emerald-300 flex items-center gap-1.5"><Check size={12} /> {notice}</div>}
        {err && <div className="mt-3 text-[11px] text-rose-300 flex items-center gap-1.5"><AlertTriangle size={12} /> {err}</div>}
      </div>

      {/* Seguridad del reproductor */}
      {playerSec && (
        <div className="rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-cyan-400" /> Seguridad del reproductor del panel
              </h2>
              <p className="text-[11px] text-slate-400 mt-1 max-w-3xl">
                Lo que protege al reproductor del portal y al de la vista previa: enlaces firmados que caducan, sin URL
                del proveedor, sin incrustar en webs ajenas y sin caché de claves.
              </p>
            </div>
            <div className="flex gap-2">
              <Badge tone="indigo">{playerSec.totals.protected} protegidos</Badge>
              <Badge tone={playerSec.totals.unprotected > 0 ? 'amber' : 'green'}>
                {playerSec.totals.unprotected} sin DRM
              </Badge>
              <Badge tone="slate">enlaces {playerSec.playLinkTtlHours} h</Badge>
            </div>
          </div>

          <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {playerSec.checks.map((c) => (
              <div
                key={c.id}
                className={`rounded-xl border p-2.5 ${
                  c.ok ? 'border-emerald-500/25 bg-emerald-500/5' : 'border-amber-500/30 bg-amber-500/5'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  {c.ok ? (
                    <ShieldCheck size={12} className="text-emerald-400" />
                  ) : (
                    <AlertTriangle size={12} className="text-amber-400" />
                  )}
                  <span className="text-[11px] font-semibold text-slate-200">{c.label}</span>
                </div>
                <p className="text-[10px] text-slate-500 mt-1 leading-relaxed">{c.detail}</p>
              </div>
            ))}
          </div>

          {playerSec.totals.unprotected > 0 && (
            <p className="text-[10px] text-amber-300 mt-3">
              Hay {playerSec.totals.unprotected} canales sin DRM. Usa «Proteger todos» abajo para
              cifrarlos con las claves de este panel.
            </p>
          )}
        </div>
      )}

      {/* Fase 1: proteger todos los canales HLS */}
      <div className="rounded-2xl bg-[#0e1526] border border-emerald-500/25 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Zap className="w-4 h-4 text-emerald-400" /> Fase 1 · AES-128 del panel en todos los canales HLS
            </h2>
            <p className="text-[11px] text-slate-400 mt-1 max-w-3xl leading-relaxed">
              Un clic para proteger todo lo que empaqueta Flussonic: claves del propio panel, rotación cada 10 minutos y
              revocación por línea. Los canales que empaqueta el FFmpeg de TVLister quedan fuera (su línea de argumentos
              no se toca) y los que alimentan el UDP de CATV también, salvo que lo pidas expresamente.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => loadBulkPlan(false)}
              disabled={bulkBusy === 'plan'}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-semibold disabled:opacity-60"
            >
              {bulkBusy === 'plan' ? <Loader2 size={12} className="animate-spin" /> : <Radio size={12} />} Ver qué se cifra
            </button>
            <button
              onClick={() => applyBulk(false)}
              disabled={bulkBusy === 'apply'}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold disabled:opacity-60"
            >
              {bulkBusy === 'apply' ? <Loader2 size={12} className="animate-spin" /> : <Lock size={12} />} Proteger todos
            </button>
            <button
              onClick={() => pushAll('apply')}
              disabled={bulkBusy === 'push'}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-semibold disabled:opacity-60"
            >
              {bulkBusy === 'push' ? <Loader2 size={12} className="animate-spin" /> : <Server size={12} />} Enviar a
              Flussonic
            </button>
          </div>
        </div>

        {bulk && (
          <div className="mt-3 grid gap-3 lg:grid-cols-3 text-[11px]">
            <div className="rounded-xl bg-[#090e1a] border border-slate-800 p-3">
              <div className="text-[10px] uppercase text-slate-500 mb-1">Se cifran ({bulk.totals.eligible})</div>
              <div className="space-y-1 max-h-40 overflow-auto">
                {bulk.eligible.map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-2">
                    <span className="text-slate-200 truncate">{s.name}</span>
                    <span className="text-[9px] font-mono text-cyan-300">{s.flussonic_stream}</span>
                  </div>
                ))}
                {bulk.eligible.length === 0 && <div className="text-slate-500">Nada pendiente</div>}
              </div>
            </div>
            <div className="rounded-xl bg-[#090e1a] border border-slate-800 p-3">
              <div className="text-[10px] uppercase text-slate-500 mb-1">Ya protegidos ({bulk.totals.already})</div>
              <div className="space-y-1 max-h-40 overflow-auto text-slate-400">
                {bulk.already.map((s) => (
                  <div key={s.id} className="truncate">
                    {s.name}
                  </div>
                ))}
                {bulk.already.length === 0 && <div className="text-slate-500">—</div>}
              </div>
            </div>
            <div className="rounded-xl bg-[#090e1a] border border-slate-800 p-3">
              <div className="text-[10px] uppercase text-slate-500 mb-1">Quedan fuera ({bulk.totals.skipped})</div>
              <div className="space-y-1 max-h-40 overflow-auto">
                {bulk.skipped.map((s) => (
                  <div key={s.id} className="text-amber-300/90">
                    <b className="text-slate-300">{s.name}:</b> {s.reason}
                  </div>
                ))}
                {bulk.skipped.length === 0 && <div className="text-slate-500">—</div>}
              </div>
            </div>
          </div>
        )}

        {bulkResult?.results && (
          <div className="mt-3 rounded-xl bg-[#090e1a] border border-slate-800 p-3 text-[10px] space-y-1 max-h-40 overflow-auto">
            <div className="text-slate-400">
              Enviados {bulkResult.sent}/{bulkResult.total} a Flussonic
            </div>
            {bulkResult.results.map((r) => (
              <div key={r.id} className={r.ok ? 'text-emerald-300' : 'text-rose-300'}>
                {r.ok ? 'OK' : 'FALLO'} · {r.name} {r.stream ? `→ ${r.stream}` : ''}{' '}
                {r.error ? `— ${r.error}` : ''}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Canales con DRM */}
        <div className="rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Radio className="w-4 h-4 text-cyan-400" /> Canales con DRM
            </h2>
            <button
              onClick={load}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] font-semibold"
            >
              <RefreshCw size={11} /> Refrescar
            </button>
          </div>

          <div className="space-y-2 max-h-72 overflow-auto pr-1">
            {(data?.streams || []).length === 0 && (
              <p className="text-[11px] text-slate-500">Todavía no hay ningún canal protegido.</p>
            )}
            {(data?.streams || []).map((s) => (
              <button
                key={s.stream_id}
                onClick={() => openStream(s.stream_id)}
                className={`w-full text-left rounded-xl border p-2.5 transition ${
                  String(s.stream_id) === String(selectedId)
                    ? 'border-indigo-500/60 bg-indigo-500/10'
                    : 'border-slate-800 bg-[#090e1a] hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] font-semibold text-white truncate">
                    {s.stream_name || `Canal #${s.stream_id}`}
                  </span>
                  {s.enabled ? (
                    <Badge tone={s.mode === 'widevine' || s.mode === 'playready' ? 'indigo' : 'green'}>
                      <ShieldCheck size={10} /> {modeLabel(s.mode)}
                    </Badge>
                  ) : (
                    <Badge tone="slate">
                      <ShieldOff size={10} /> apagado
                    </Badge>
                  )}
                </div>
                {s.catv_conflicts?.length > 0 && (
                  <div className="mt-1 text-[10px] text-amber-300 flex items-center gap-1">
                    <AlertTriangle size={10} /> CH {s.catv_conflicts.map((c) => c.catv_ch).join(', ')} CATV usa este stream
                    de Flussonic
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Configuración del canal */}
        <div className="rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-3">
          <h2 className="text-sm font-bold text-white flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-indigo-400" /> Configurar un canal
          </h2>

          <select
            value={selectedId}
            onChange={(e) => openStream(e.target.value)}
            className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white text-[12px]"
          >
            <option value="">— elegir canal —</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.drm_on ? ' (DRM activo)' : ''}
              </option>
            ))}
          </select>

          {form && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <label className="rounded-xl bg-[#090e1a] border border-slate-800 p-2.5">
                  <span className="block text-[10px] text-slate-400 mb-1">Modo</span>
                  <select
                    value={form.mode}
                    onChange={(e) => setForm({ ...form, mode: e.target.value })}
                    className="w-full px-2 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white text-[11px]"
                  >
                    {MODES.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="rounded-xl bg-[#090e1a] border border-slate-800 p-2.5">
                  <span className="block text-[10px] text-slate-400 mb-1">Stream en Flussonic</span>
                  <input
                    type="text"
                    value={form.flussonicStream}
                    onChange={(e) => setForm({ ...form, flussonicStream: e.target.value })}
                    placeholder="canal1"
                    className="w-full px-2 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white text-[11px] font-mono"
                  />
                </label>
              </div>

              <p className="text-[10px] text-slate-500 -mt-1">
                {MODES.find((m) => m.value === form.mode)?.hint}
              </p>

              <div className="grid grid-cols-2 gap-2">
                <label className="rounded-xl bg-[#090e1a] border border-slate-800 p-2.5">
                  <span className="block text-[10px] text-slate-400 mb-1">
                    Clave fija AES-128 (32 hex, opcional)
                  </span>
                  <input
                    type="text"
                    value={form.staticKey}
                    onChange={(e) => setForm({ ...form, staticKey: e.target.value })}
                    placeholder="vacío = clave derivada que rota"
                    className="w-full px-2 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white text-[10px] font-mono"
                  />
                </label>
                <label className="flex items-center justify-between gap-2 rounded-xl bg-[#090e1a] border border-slate-800 p-2.5">
                  <span className="text-[10px] text-slate-300 font-semibold">Activo</span>
                  <input
                    type="checkbox"
                    checked={Boolean(form.enabled)}
                    onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                    className="w-4 h-4 accent-indigo-500"
                  />
                </label>
              </div>

              {(form.mode === 'widevine' || form.mode === 'playready') && (
                <div className="space-y-2">
                  <label className="block rounded-xl bg-[#090e1a] border border-slate-800 p-2.5">
                    <span className="block text-[10px] text-slate-400 mb-1">URL del servidor de licencias</span>
                    <input
                      type="text"
                      value={form.licenseUrl}
                      onChange={(e) => setForm({ ...form, licenseUrl: e.target.value })}
                      placeholder="https://license.tudominio.com/wv"
                      className="w-full px-2 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white text-[11px] font-mono"
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block rounded-xl bg-[#090e1a] border border-slate-800 p-2.5">
                      <span className="block text-[10px] text-slate-400 mb-1">
                        aes_key de Widevine (32 hex) {form.hasCenc && <span className="text-emerald-400">· guardada</span>}
                      </span>
                      <input
                        type="password"
                        value={form.cencAesKey || ''}
                        onChange={(e) => setForm({ ...form, cencAesKey: e.target.value })}
                        placeholder="la de tu cuenta Widevine"
                        className="w-full px-2 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white text-[10px] font-mono"
                      />
                    </label>
                    <label className="block rounded-xl bg-[#090e1a] border border-slate-800 p-2.5">
                      <span className="block text-[10px] text-slate-400 mb-1">iv de Widevine (32 hex)</span>
                      <input
                        type="password"
                        value={form.cencIv || ''}
                        onChange={(e) => setForm({ ...form, cencIv: e.target.value })}
                        placeholder="la de tu cuenta Widevine"
                        className="w-full px-2 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white text-[10px] font-mono"
                      />
                    </label>
                  </div>
                  <label className="block rounded-xl bg-[#090e1a] border border-slate-800 p-2.5">
                    <span className="block text-[10px] text-slate-400 mb-1">
                      content_id (opcional; por defecto el nombre del stream)
                    </span>
                    <input
                      type="text"
                      value={form.cencContentId || ''}
                      onChange={(e) => setForm({ ...form, cencContentId: e.target.value })}
                      placeholder="canal1"
                      className="w-full px-2 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white text-[10px] font-mono"
                    />
                  </label>
                  <p className="text-[10px] text-slate-500">
                    El panel no genera estas claves: te las da tu cuenta de Widevine. Aquí sólo se guardan para pasárselas
                    a Flussonic y no dejarlas sueltas en el .conf.
                  </p>
                  <label className="block rounded-xl bg-[#090e1a] border border-slate-800 p-2.5">
                    <span className="block text-[10px] text-slate-400 mb-1">
                      Cabeceras de licencia (JSON, se inyectan en el servidor)
                    </span>
                    <textarea
                      value={form.licenseHeaders}
                      onChange={(e) => setForm({ ...form, licenseHeaders: e.target.value })}
                      rows={2}
                      placeholder={'{"X-AxDRM-Message":"..."}'}
                      className="w-full px-2 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white text-[10px] font-mono"
                    />
                  </label>
                </div>
              )}

              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  onClick={save}
                  disabled={busy === 'save'}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-semibold disabled:opacity-60"
                >
                  {busy === 'save' ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />} Guardar
                </button>
                <button
                  onClick={runTest}
                  disabled={busy === 'test'}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-semibold disabled:opacity-60"
                >
                  {busy === 'test' ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />} Probar clave
                </button>
                <button
                  onClick={rotate}
                  disabled={busy === 'rotate'}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-semibold disabled:opacity-60"
                >
                  {busy === 'rotate' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Rotar tokens
                </button>
                <button
                  onClick={remove}
                  disabled={busy === 'remove'}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 text-[11px] font-semibold disabled:opacity-60"
                >
                  <Trash2 size={12} /> Borrar
                </button>
              </div>

              {testResult && (
                <div className="rounded-xl bg-[#090e1a] border border-emerald-500/30 p-2.5 text-[10px] text-slate-300 space-y-1">
                  <div className="text-emerald-300 font-semibold">Prueba correcta</div>
                  <div>Clave de {testResult.key_length} bytes · rota: {testResult.rotates ? 'sí' : 'no'}</div>
                  <div className="font-mono break-all">{testResult.key_preview}</div>
                </div>
              )}

              {snippet && (
                <div className="rounded-xl bg-[#090e1a] border border-slate-800 p-2.5">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[10px] uppercase tracking-wide text-slate-500">
                      En tu Flussonic (/etc/flussonic/flussonic.conf)
                    </span>
                    <CopyButton text={snippet} />
                  </div>
                  <pre className="text-[10px] text-cyan-200 font-mono whitespace-pre-wrap break-all">{snippet}</pre>
                  {snippet.includes('<guardada>') && (
                    <p className="text-[10px] text-amber-300 mt-1">
                      Las claves de contenido Widevine no se muestran en el navegador. Para verlas en local:
                      <code className="ml-1 text-slate-300">tvlister-admin drm snippet {selectedId}</code> — o usa
                      «Aplicar a Flussonic» y no pasan por el navegador.
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2 mt-2">
                    <button
                      onClick={() => previewFlussonic('preview')}
                      disabled={busy === 'preview'}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] font-semibold disabled:opacity-60"
                    >
                      {busy === 'preview' ? <Loader2 size={11} className="animate-spin" /> : <Server size={11} />} Vista
                      previa por API
                    </button>
                    {flussonicPreview && (
                      <button
                        onClick={() => previewFlussonic('apply')}
                        disabled={busy === 'apply'}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-semibold disabled:opacity-60"
                      >
                        {busy === 'apply' ? <Loader2 size={11} className="animate-spin" /> : <ShieldCheck size={11} />}{' '}
                        Aplicar a Flussonic
                      </button>
                    )}
                    <button
                      onClick={() => previewFlussonic('remove')}
                      disabled={busy === 'remove'}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 text-[10px] font-semibold disabled:opacity-60"
                    >
                      <ShieldOff size={11} /> Quitar de Flussonic
                    </button>
                  </div>
                </div>
              )}

              {flussonicPreview && (
                <div className="rounded-xl bg-[#090e1a] border border-amber-500/30 p-2.5 space-y-1">
                  <div className="text-[10px] text-amber-300 font-semibold flex items-center gap-1">
                    <AlertTriangle size={11} /> Revisa antes de aplicar · {flussonicPreview.server?.base}
                  </div>
                  <pre className="text-[10px] text-slate-300 font-mono whitespace-pre-wrap break-all max-h-40 overflow-auto">
                    {JSON.stringify(flussonicPreview.will_send, null, 2)}
                  </pre>
                  <p className="text-[10px] text-slate-500">{flussonicPreview.note}</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Últimas peticiones */}
      <div className="rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5">
        <h2 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-emerald-400" /> Últimas peticiones de claves
        </h2>
        <div className="overflow-auto max-h-64">
          <table className="w-full text-[11px]">
            <thead className="text-slate-500 text-[10px] uppercase">
              <tr>
                <th className="text-left py-1">Hora</th>
                <th className="text-left">Tipo</th>
                <th className="text-left">Canal</th>
                <th className="text-left">Nº clave</th>
                <th className="text-left">IP</th>
                <th className="text-left">Línea</th>
                <th className="text-left">Estado</th>
              </tr>
            </thead>
            <tbody className="text-slate-300">
              {(data?.lastEvents || []).map((e) => (
                <tr key={e.id} className="border-t border-slate-800/60">
                  <td className="py-1 whitespace-nowrap">{String(e.created_at).replace('T', ' ').slice(0, 19)}</td>
                  <td className="uppercase text-[10px] text-slate-400">{e.kind}</td>
                  <td>#{e.stream_id}</td>
                  <td className="font-mono">{e.key_number}</td>
                  <td className="font-mono">{e.ip}</td>
                  <td>{e.line_id || '—'}</td>
                  <td className={e.ok ? 'text-emerald-300' : 'text-rose-300'}>
                    {e.ok ? 'OK' : e.reason || 'error'}
                  </td>
                </tr>
              ))}
              {(data?.lastEvents || []).length === 0 && (
                <tr>
                  <td colSpan={7} className="py-2 text-slate-500">
                    Sin peticiones todavía. Cuando Flussonic empiece a cifrar aparecerán aquí.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
