import React, { useEffect, useState } from 'react';
import {
  Users,
  Plus,
  Link2,
  Edit3,
  Trash2,
  Copy,
  ExternalLink,
  X,
  Tv,
  Cpu,
  Check,
  Database
} from 'lucide-react';
import { apiFetch } from '../lib/api.js';

export default function UsersDevicesPage({ user, onRefreshUser, onOpenXuiImport }) {
  const [lines, setLines] = useState([]);
  const [bouquets, setBouquets] = useState([]);
  const [packages, setPackages] = useState([]);
  const [filterType, setFilterType] = useState('all');

  const [modalOpen, setModalOpen] = useState(false);
  const [editingLine, setEditingLine] = useState(null);
  const [linksLine, setLinksLine] = useState(null);
  const [copiedKey, setCopiedKey] = useState('');
  const [error, setError] = useState('');

  const [form, setForm] = useState({
    username: '',
    password: '',
    package_id: 2,
    exp_date: '2027-12-31',
    max_connections: 2,
    device_type: 'm3u',
    mac_address: '',
    bouquet_ids: [1],
    status: 'active',
    notes: ''
  });

  const isReseller = user?.role === 'reseller';

  const loadAll = async () => {
    const [ln, bq, pk] = await Promise.all([
      apiFetch('/api/lines'),
      apiFetch('/api/bouquets'),
      apiFetch('/api/packages')
    ]);
    setLines(ln);
    setBouquets(bq);
    setPackages(pk);
  };

  useEffect(() => {
    loadAll();
  }, []);

  const openCreate = (deviceType = 'm3u') => {
    setEditingLine(null);
    setError('');
    const randSuffix = Math.floor(Math.random() * 8999 + 1000);
    setForm({
      username: deviceType === 'mag' ? `mag_${randSuffix}` : `cliente_${randSuffix}`,
      password: Math.random().toString(36).slice(2, 10),
      package_id: packages[1]?.id || packages[0]?.id || 1,
      exp_date: '2027-12-31',
      max_connections: 2,
      device_type: deviceType,
      mac_address: deviceType === 'mag' ? '00:1A:79:5C:10:22' : '',
      bouquet_ids: [bouquets[0]?.id || 1],
      status: 'active',
      notes: ''
    });
    setModalOpen(true);
  };

  const openEdit = (l) => {
    setEditingLine(l);
    setError('');
    setForm({
      username: l.username,
      password: l.password,
      package_id: '',
      exp_date: l.exp_date ? l.exp_date.slice(0, 10) : '',
      max_connections: l.max_connections || 1,
      device_type: l.device_type || 'm3u',
      mac_address: l.mac_address || '',
      bouquet_ids: l.bouquet_ids || [1],
      status: l.status || 'active',
      notes: l.notes || ''
    });
    setModalOpen(true);
  };

  const toggleBouquet = (id) => {
    setForm((prev) => {
      const exists = prev.bouquet_ids.includes(id);
      return {
        ...prev,
        bouquet_ids: exists ? prev.bouquet_ids.filter((x) => x !== id) : [...prev.bouquet_ids, id]
      };
    });
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const payload = {
        ...form,
        exp_date: form.exp_date ? new Date(`${form.exp_date}T23:59:59Z`).toISOString() : null
      };
      if (editingLine) {
        await apiFetch(`/api/lines/${editingLine.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        });
      } else {
        await apiFetch('/api/lines', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
      }
      setModalOpen(false);
      loadAll();
      if (onRefreshUser) onRefreshUser();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('¿Eliminar esta línea/dispositivo permanentemente?')) return;
    await apiFetch(`/api/lines/${id}`, { method: 'DELETE' });
    loadAll();
  };

  const copyText = (key, text) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(''), 1800);
  };

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const visibleLines = lines.filter((l) => filterType === 'all' || l.device_type === filterType);

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-[#0e1526] p-4 rounded-2xl border border-slate-800/80">
        <div className="flex flex-wrap items-center gap-2">
          {[
            { id: 'all', label: `Todos (${lines.length})` },
            { id: 'm3u', label: 'Líneas M3U / Xtream' },
            { id: 'mag', label: 'Dispositivos MAG (Stalker)' },
            { id: 'enigma2', label: 'Enigma2' }
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setFilterType(t.id)}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium transition ${
                filterType === t.id
                  ? 'bg-indigo-600 text-white'
                  : 'bg-[#090e1a] text-slate-400 hover:text-white border border-slate-800'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {onOpenXuiImport && (
            <button
              onClick={onOpenXuiImport}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 text-xs font-semibold transition"
            >
              <Database className="w-3.5 h-3.5" />
              Importar Usuarios XUI.one
            </button>
          )}
          <button
            onClick={() => openCreate('m3u')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition"
          >
            <Plus className="w-4 h-4" />
            Nueva Línea M3U
          </button>
          <button
            onClick={() => openCreate('mag')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-slate-700 text-xs font-semibold transition"
          >
            <Tv className="w-3.5 h-3.5" />
            Agregar MAG
          </button>
        </div>
      </div>

      {/* Lines Table */}
      <div className="rounded-2xl bg-[#0e1526] border border-slate-800/80 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#090e1a] text-slate-400 uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3">Usuario / Contraseña</th>
                <th className="px-4 py-3">Dispositivo</th>
                <th className="px-4 py-3">Conexiones</th>
                <th className="px-4 py-3">Vencimiento</th>
                <th className="px-4 py-3">Propietario</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3 text-right">Playlists & Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {visibleLines.map((l) => (
                <tr key={l.id} className="hover:bg-slate-800/30">
                  <td className="px-4 py-3">
                    <div className="font-semibold text-white">{l.username}</div>
                    <div className="font-mono text-[11px] text-slate-400">Pass: {l.password}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="px-2 py-0.5 rounded bg-slate-800 text-indigo-300 uppercase font-bold text-[10px]">
                      {l.device_type}
                    </span>
                    {l.mac_address && (
                      <div className="text-[11px] font-mono text-cyan-400 mt-0.5">{l.mac_address}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono">
                    <span className={l.active_conns > 0 ? 'text-emerald-400 font-bold' : 'text-slate-400'}>
                      {l.active_conns || 0}
                    </span>{' '}
                    / {l.max_connections}
                  </td>
                  <td className="px-4 py-3 text-slate-300">
                    {l.exp_date ? new Date(l.exp_date).toLocaleDateString() : 'Ilimitado'}
                  </td>
                  <td className="px-4 py-3 text-slate-400">{l.owner_username || 'admin'}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                        l.status === 'active'
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                          : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                      }`}
                    >
                      {l.status === 'active' ? 'ACTIVA' : 'BLOQUEADA'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        onClick={() => setLinksLine(l)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-indigo-600/25 hover:bg-indigo-600 text-indigo-300 hover:text-white font-semibold transition"
                        title="Descargar M3U / XMLTV / API Xtream"
                      >
                        <Link2 className="w-3.5 h-3.5" />
                        M3U / API
                      </button>
                      <button
                        onClick={() => openEdit(l)}
                        className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDelete(l.id)}
                        className="p-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 text-rose-300"
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

      {/* Create / Edit Line Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-xl rounded-2xl bg-[#0e1526] border border-slate-800 overflow-hidden">
            <div className="px-5 py-4 bg-[#131c31] border-b border-slate-800 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">
                {editingLine ? `Editar Línea: ${editingLine.username}` : 'Crear Nueva Línea / Dispositivo'}
              </h3>
              <button onClick={() => setModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSave} className="p-5 space-y-4 text-xs max-h-[82vh] overflow-y-auto">
              {error && (
                <div className="p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300">
                  {error}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 mb-1">Usuario *</label>
                  <input
                    type="text"
                    required
                    disabled={Boolean(editingLine)}
                    value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">Contraseña *</label>
                  <input
                    type="text"
                    required
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 mb-1">Tipo de Dispositivo</label>
                  <select
                    value={form.device_type}
                    onChange={(e) => setForm({ ...form, device_type: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    <option value="m3u">Línea M3U / Xtream / Smart TV</option>
                    <option value="mag">STB MAG (Stalker / Ministra)</option>
                    <option value="enigma2">Receptor Enigma2</option>
                  </select>
                </div>

                {form.device_type !== 'm3u' ? (
                  <div>
                    <label className="block text-slate-300 mb-1">Dirección MAC (STB)</label>
                    <input
                      type="text"
                      value={form.mac_address}
                      onChange={(e) => setForm({ ...form, mac_address: e.target.value })}
                      placeholder="00:1A:79:XX:XX:XX"
                      className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-cyan-300 font-mono"
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block text-slate-300 mb-1">Estado</label>
                    <select
                      value={form.status}
                      onChange={(e) => setForm({ ...form, status: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                    >
                      <option value="active">Activa</option>
                      <option value="banned">Suspendida / Bloqueada</option>
                    </select>
                  </div>
                )}
              </div>

              {!editingLine && (isReseller || packages.length > 0) && (
                <div>
                  <label className="block text-slate-300 mb-1">
                    Paquete de Suscripción {isReseller ? '(Descuenta Créditos)' : '(Opcional)'}
                  </label>
                  <select
                    value={form.package_id}
                    onChange={(e) => setForm({ ...form, package_id: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    {!isReseller && <option value="">Fecha manual personalizada</option>}
                    {packages.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} — {p.duration_days} días • {p.max_connections} conex • {p.cost_credits} crédito(s)
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {!isReseller && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-300 mb-1">Fecha Expiración</label>
                    <input
                      type="date"
                      value={form.exp_date}
                      onChange={(e) => setForm({ ...form, exp_date: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-300 mb-1">Conexiones Simultáneas</label>
                    <input
                      type="number"
                      min="1"
                      max="50"
                      value={form.max_connections}
                      onChange={(e) => setForm({ ...form, max_connections: Number(e.target.value) })}
                      className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block text-slate-300 mb-1.5 font-medium">Bouquets Asignados</label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {bouquets.map((b) => (
                    <label
                      key={b.id}
                      className="flex items-center gap-2 p-2.5 rounded-xl bg-[#090e1a] border border-slate-800 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={form.bouquet_ids.includes(b.id)}
                        onChange={() => toggleBouquet(b.id)}
                        className="rounded accent-indigo-500"
                      />
                      <span className="text-slate-200">{b.name}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-slate-300 mb-1">Notas del Cliente</label>
                <input
                  type="text"
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  placeholder="Ej. WhatsApp o habitación de hotel"
                />
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
                  {editingLine ? 'Guardar Cambios' : 'Crear Línea'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* M3U / XMLTV / Xtream API Modal */}
      {linksLine && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-2xl rounded-2xl bg-[#0e1526] border border-slate-800 p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-sm font-bold text-white">
                  Enlaces de Integración OTT — {linksLine.username}
                </h3>
                <p className="text-xs text-slate-400">
                  Compatible con TiviMate, IPTV Smarters, VLC, Kodi, MAG Stalker & Midnight Player
                </p>
              </div>
              <button onClick={() => setLinksLine(null)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            {[
              {
                key: 'm3u_hls',
                label: 'Lista M3U Plus (HLS .m3u8 — Recomendado)',
                url: `${origin}/get.php?username=${encodeURIComponent(linksLine.username)}&password=${encodeURIComponent(linksLine.password)}&type=m3u_plus&output=hls`
              },
              {
                key: 'm3u_ts',
                label: 'Lista M3U Plus (MPEG-TS Direct Stream)',
                url: `${origin}/get.php?username=${encodeURIComponent(linksLine.username)}&password=${encodeURIComponent(linksLine.password)}&type=m3u_plus&output=ts`
              },
              {
                key: 'xmltv',
                label: 'Guía EPG XMLTV Dinámica (Incluye Canales 24/7)',
                url: `${origin}/xmltv.php?username=${encodeURIComponent(linksLine.username)}&password=${encodeURIComponent(linksLine.password)}`
              },
              {
                key: 'xtream',
                label: 'Xtream / MS Player API Endpoint',
                url: `${origin}/player_api.php?username=${encodeURIComponent(linksLine.username)}&password=${encodeURIComponent(linksLine.password)}`
              }
            ].map((item) => (
              <div key={item.key} className="space-y-1 text-xs">
                <div className="text-slate-300 font-medium">{item.label}</div>
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    value={item.url}
                    className="flex-1 px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-800 font-mono text-indigo-300 text-[11px]"
                  />
                  <button
                    onClick={() => copyText(item.key, item.url)}
                    className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 inline-flex items-center gap-1"
                  >
                    {copiedKey === item.key ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="px-3 py-2 rounded-xl bg-indigo-600/25 hover:bg-indigo-600 text-indigo-200 hover:text-white"
                    title="Abrir en nueva pestaña"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>
            ))}

            <div className="p-3 rounded-xl bg-[#090e1a] border border-slate-800 text-xs font-mono text-slate-300">
              <div className="text-slate-400 font-sans mb-1 flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5 text-cyan-400" /> Datos Xtream Codes Login:
              </div>
              Host: <span className="text-emerald-300">{origin}</span> • Usuario:{' '}
              <span className="text-white">{linksLine.username}</span> • Pass:{' '}
              <span className="text-white">{linksLine.password}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
