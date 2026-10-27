import React, { useEffect, useState } from 'react';
import { UserCheck, Plus, Coins, Package, Trash2, X } from 'lucide-react';
import { apiFetch } from '../lib/api.js';

export default function ResellersPage() {
  const [resellers, setResellers] = useState([]);
  const [logs, setLogs] = useState([]);
  const [packages, setPackages] = useState([]);

  const [createOpen, setCreateOpen] = useState(false);
  const [creditModal, setCreditModal] = useState(null);
  const [delta, setDelta] = useState(10);
  const [reason, setReason] = useState('Recarga de créditos');

  const [form, setForm] = useState({
    username: '',
    password: '',
    credits: 25,
    email: '',
    notes: '',
    role: 'reseller'
  });

  const [pkgForm, setPkgForm] = useState({
    name: '',
    duration_days: 30,
    cost_credits: 1,
    max_connections: 2,
    is_trial: false
  });

  const loadAll = async () => {
    const [resData, pk] = await Promise.all([apiFetch('/api/resellers'), apiFetch('/api/packages')]);
    setResellers(resData.resellers || []);
    setLogs(resData.logs || []);
    setPackages(pk || []);
  };

  useEffect(() => {
    loadAll();
  }, []);

  const handleCreateReseller = async (e) => {
    e.preventDefault();
    await apiFetch('/api/resellers', {
      method: 'POST',
      body: JSON.stringify(form)
    });
    setCreateOpen(false);
    setForm({ username: '', password: '', credits: 25, email: '', notes: '', role: 'reseller' });
    loadAll();
  };

  const handleAdjustCredits = async (e) => {
    e.preventDefault();
    if (!creditModal) return;
    await apiFetch(`/api/resellers/${creditModal.id}/credits`, {
      method: 'POST',
      body: JSON.stringify({ delta: Number(delta), reason })
    });
    setCreditModal(null);
    loadAll();
  };

  const handleCreatePackage = async (e) => {
    e.preventDefault();
    if (!pkgForm.name.trim()) return;
    await apiFetch('/api/packages', {
      method: 'POST',
      body: JSON.stringify(pkgForm)
    });
    setPkgForm({ name: '', duration_days: 30, cost_credits: 1, max_connections: 2, is_trial: false });
    loadAll();
  };

  const deletePkg = async (id) => {
    await apiFetch(`/api/packages/${id}`, { method: 'DELETE' });
    loadAll();
  };

  const deleteReseller = async (id) => {
    if (!window.confirm('¿Eliminar esta cuenta reseller?')) return;
    await apiFetch(`/api/resellers/${id}`, { method: 'DELETE' });
    loadAll();
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Resellers List */}
        <div className="lg:col-span-7 rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <UserCheck className="w-4 h-4 text-amber-400" />
              Cuentas de Resellers & Administradores
            </h2>
            <button
              onClick={() => setCreateOpen(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold"
            >
              <Plus className="w-4 h-4" /> Nuevo Reseller
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#090e1a] text-slate-400 uppercase">
                <tr>
                  <th className="px-3 py-2.5">Usuario</th>
                  <th className="px-3 py-2.5">Rol</th>
                  <th className="px-3 py-2.5">Créditos</th>
                  <th className="px-3 py-2.5">Líneas</th>
                  <th className="px-3 py-2.5 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {resellers.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-3">
                      <div className="font-semibold text-white">{r.username}</div>
                      <div className="text-[11px] text-slate-500">{r.email || r.notes}</div>
                    </td>
                    <td className="px-3 py-3 uppercase text-[11px] font-bold text-indigo-300">{r.role}</td>
                    <td className="px-3 py-3">
                      {r.role === 'admin' ? (
                        <span className="text-emerald-400 font-semibold">∞ Ilimitado</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 font-bold">
                          <Coins className="w-3 h-3" /> {r.credits}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 font-mono text-slate-300">{r.line_count}</td>
                    <td className="px-3 py-3 text-right space-x-1.5">
                      {r.role === 'reseller' && (
                        <button
                          onClick={() => {
                            setCreditModal(r);
                            setDelta(10);
                          }}
                          className="px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/35 text-amber-300 font-semibold"
                        >
                          + Créditos
                        </button>
                      )}
                      {r.role !== 'admin' && (
                        <button
                          onClick={() => deleteReseller(r.id)}
                          className="p-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 text-rose-300"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Packages Builder */}
        <div className="lg:col-span-5 rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-4">
          <h2 className="text-sm font-bold text-white flex items-center gap-2">
            <Package className="w-4 h-4 text-cyan-400" />
            Planes & Paquetes de Créditos
          </h2>

          <form onSubmit={handleCreatePackage} className="grid grid-cols-2 gap-2.5 text-xs">
            <input
              type="text"
              placeholder="Nombre del plan..."
              value={pkgForm.name}
              onChange={(e) => setPkgForm({ ...pkgForm, name: e.target.value })}
              className="col-span-2 px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
            />
            <div>
              <label className="text-slate-400 block mb-1">Duración (días)</label>
              <input
                type="number"
                value={pkgForm.duration_days}
                onChange={(e) => setPkgForm({ ...pkgForm, duration_days: Number(e.target.value) })}
                className="w-full px-3 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              />
            </div>
            <div>
              <label className="text-slate-400 block mb-1">Costo Créditos</label>
              <input
                type="number"
                value={pkgForm.cost_credits}
                onChange={(e) => setPkgForm({ ...pkgForm, cost_credits: Number(e.target.value) })}
                className="w-full px-3 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              />
            </div>
            <div>
              <label className="text-slate-400 block mb-1">Conexiones</label>
              <input
                type="number"
                value={pkgForm.max_connections}
                onChange={(e) => setPkgForm({ ...pkgForm, max_connections: Number(e.target.value) })}
                className="w-full px-3 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              />
            </div>
            <div className="flex items-end">
              <button
                type="submit"
                className="w-full py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold"
              >
                Crear Paquete
              </button>
            </div>
          </form>

          <div className="space-y-2 text-xs">
            {packages.map((p) => (
              <div
                key={p.id}
                className="px-3 py-2.5 rounded-xl bg-[#090e1a] border border-slate-800 flex items-center justify-between"
              >
                <div>
                  <div className="font-semibold text-white">{p.name}</div>
                  <div className="text-[11px] text-slate-400">
                    {p.duration_days} días • {p.max_connections} conex •{' '}
                    <span className="text-amber-300 font-semibold">{p.cost_credits} crédito(s)</span>
                  </div>
                </div>
                <button
                  onClick={() => deletePkg(p.id)}
                  className="p-1.5 rounded bg-rose-500/15 hover:bg-rose-500/30 text-rose-300"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Credit Audit Logs */}
      <div className="rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5">
        <h3 className="text-sm font-bold text-white mb-3">Historial de Movimientos de Créditos</h3>
        <div className="space-y-1.5 text-xs max-h-56 overflow-y-auto">
          {logs.length === 0 ? (
            <div className="text-slate-500">Sin movimientos registrados aún.</div>
          ) : (
            logs.map((lg) => (
              <div
                key={lg.id}
                className="px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-800 flex items-center justify-between"
              >
                <div>
                  <span className="font-semibold text-white">{lg.reseller_username}</span> —{' '}
                  <span className="text-slate-400">{lg.reason}</span>
                </div>
                <div className="font-mono">
                  <span className={lg.delta >= 0 ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                    {lg.delta >= 0 ? `+${lg.delta}` : lg.delta}
                  </span>{' '}
                  <span className="text-slate-500">(Saldo: {lg.balance_after})</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* New Reseller Modal */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-md rounded-2xl bg-[#0e1526] border border-slate-800 p-5 space-y-3.5 text-xs">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white">Crear Cuenta Reseller</h3>
              <button onClick={() => setCreateOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreateReseller} className="space-y-3">
              <input
                type="text"
                required
                placeholder="Usuario reseller"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              />
              <input
                type="text"
                required
                placeholder="Contraseña"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              />
              <input
                type="number"
                placeholder="Créditos iniciales"
                value={form.credits}
                onChange={(e) => setForm({ ...form, credits: Number(e.target.value) })}
                className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              />
              <input
                type="text"
                placeholder="Notas / Zona"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              />
              <button
                type="submit"
                className="w-full py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold"
              >
                Registrar Reseller
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Adjust Credits Modal */}
      {creditModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-[#0e1526] border border-slate-800 p-5 space-y-3.5 text-xs">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white">Recargar / Ajustar Créditos: {creditModal.username}</h3>
              <button onClick={() => setCreditModal(null)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleAdjustCredits} className="space-y-3">
              <div>
                <label className="block text-slate-400 mb-1">Cantidad (+ para sumar, - para descontar)</label>
                <input
                  type="number"
                  value={delta}
                  onChange={(e) => setDelta(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                />
              </div>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Motivo..."
                className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              />
              <button
                type="submit"
                className="w-full py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold"
              >
                Aplicar Ajuste
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
