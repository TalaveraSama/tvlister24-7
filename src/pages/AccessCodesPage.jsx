import React, { useEffect, useMemo, useState } from 'react';
import { KeyRound, Plus, Pencil, X, ShieldCheck, ShieldAlert, Copy, Check, Loader2 } from 'lucide-react';
import { apiFetch } from '../lib/api.js';

const TYPE_OPTIONS = [
  { value: 'admin', label: 'Admin', hint: 'Acceso completo al panel' },
  { value: 'admin_api', label: 'Admin API', hint: 'Para integraciones y scripts' },
  { value: 'reseller', label: 'Reseller', hint: 'Acceso de revendedores' }
];

function TypeBadge({ type, label }) {
  const color =
    type === 'admin'
      ? 'text-sky-300'
      : type === 'admin_api'
        ? 'text-emerald-300'
        : 'text-amber-300';
  return <span className={`text-sm ${color}`}>{label || type}</span>;
}

function Modal({ title, children, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl border border-slate-700/80 bg-[#0d1322] p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-100">{title}</h3>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function AccessCodesPage() {
  const [codes, setCodes] = useState([]);
  const [gate, setGate] = useState({ forced: false, gated: false, total: 0, active: 0, uiCreate: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const [copied, setCopied] = useState('');

  const [modal, setModal] = useState(null); // { mode: 'create' | 'edit', code }
  const [form, setForm] = useState({ code: '', type: 'admin', notes: '', enabled: true });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const load = async () => {
    try {
      const res = await apiFetch('/api/access-codes');
      setCodes(res.codes || []);
      if (res.state) setGate(res.state);
      setError('');
    } catch (err) {
      setError(err.message || 'No se pudieron cargar los códigos.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const flash = (msg) => {
    setNotice(msg);
    setTimeout(() => setNotice(''), 2500);
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return codes;
    return codes.filter(
      (c) =>
        c.code.toLowerCase().includes(q) ||
        (c.typeLabel || c.type).toLowerCase().includes(q) ||
        (c.notes || '').toLowerCase().includes(q)
    );
  }, [codes, search]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = filtered.slice((page - 1) * pageSize, page * pageSize);
  const activeCount = codes.filter((c) => c.enabled).length;

  React.useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [pageCount, page]);

  const openCreate = () => {
    setForm({ code: '', type: 'admin', notes: '', enabled: true });
    setFormError('');
    setModal({ mode: 'create' });
  };

  const openEdit = (row) => {
    setForm({ code: row.code, type: row.type, notes: row.notes || '', enabled: !!row.enabled });
    setFormError('');
    setModal({ mode: 'edit', row });
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setFormError('');
    try {
      if (modal.mode === 'create') {
        await apiFetch('/api/access-codes', {
          method: 'POST',
          body: JSON.stringify({ code: form.code, type: form.type, notes: form.notes, enabled: form.enabled })
        });
        flash('Código creado. Ya está activo en el panel.');
      } else {
        await apiFetch(`/api/access-codes/${modal.row.id}`, {
          method: 'PUT',
          body: JSON.stringify({ code: form.code, type: form.type, notes: form.notes, enabled: form.enabled })
        });
        flash('Código actualizado.');
      }
      setModal(null);
      load();
    } catch (err) {
      setFormError(err.message || 'No se pudo guardar.');
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (row) => {
    try {
      await apiFetch(`/api/access-codes/${row.id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: !row.enabled })
      });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = async (row) => {
    if (!window.confirm(`¿Eliminar el código "${row.code}"?`)) return;
    try {
      await apiFetch(`/api/access-codes/${row.id}`, { method: 'DELETE' });
      flash('Código eliminado.');
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const copyLink = async (row) => {
    const url = `${window.location.origin}/?access=${encodeURIComponent(row.code)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(row.code);
      setTimeout(() => setCopied(''), 1800);
    } catch {
      setError('El navegador no dejó copiar. El enlace es: ' + url);
    }
  };

  return (
    <div className="space-y-5">
      {/* Cabecera */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-slate-100">
            <KeyRound size={22} className="text-sky-400" />
            Access Codes
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Llave previa al login del panel, como en XUI.one.
          </p>
        </div>
        {gate.uiCreate ? (
          <button
            onClick={openCreate}
            className="flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
          >
            <Plus size={16} /> Add Code
          </button>
        ) : (
          <div className="flex items-center gap-2 rounded-md border border-slate-600 bg-slate-800/60 px-3 py-2 font-mono text-xs text-slate-300">
            <KeyRound size={14} className="text-sky-400" />
            tvlister-admin access-code add micodigo admin
          </div>
        )}
      </div>

      {/* Aviso */}
      <div className="rounded-md border border-slate-600/70 bg-slate-700/40 px-5 py-4 text-sm text-slate-200">
        {gate.gated ? (
          <>
            El panel está <strong>cerrado</strong>: quien no tenga un código no llega ni a la pantalla de
            entrada. Los códigos se crean <strong>sólo desde la terminal del servidor</strong>
            (<code className="rounded bg-slate-800 px-1 py-0.5 text-[11px] text-sky-300">tvlister-admin
            access-code add micodigo admin</code>). Los clientes IPTV (get.php, player_api.php, HLS,
            MAG) siguen funcionando igual: nunca piden código.
          </>
        ) : (
          <>
            Ahora mismo el panel está <strong>abierto</strong>: cualquiera que conozca la dirección ve el
            login. Ciérralo desde la terminal con{' '}
            <code className="rounded bg-slate-800 px-1 py-0.5 text-[11px] text-sky-300">
              tvlister-admin access-code close
            </code>{' '}
            y crea después tu código.
          </>
        )}
      </div>

      {notice && (
        <div className="flex items-center gap-2 rounded-md border border-emerald-600/40 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-300">
          <Check size={16} /> {notice}
        </div>
      )}
      {error && (
        <div className="rounded-md border border-rose-600/40 bg-rose-500/10 px-4 py-2.5 text-sm text-rose-300">
          {error}
        </div>
      )}

      {/* Tabla */}
      <div className="rounded-lg border border-slate-700/70 bg-[#0f1626]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-700/60 px-5 py-3 text-sm text-slate-300">
          <div className="flex items-center gap-2">
            <span>Show</span>
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(1);
              }}
              className="rounded border border-slate-600 bg-[#0b1120] px-2 py-1 text-slate-200"
            >
              {[10, 25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span>entries</span>
          </div>
          <div className="flex items-center gap-2">
            <span>Search:</span>
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="w-52 rounded border border-slate-600 bg-[#0b1120] px-3 py-1 text-slate-200 focus:border-sky-500 focus:outline-none"
            />
          </div>
        </div>

        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-700/60 text-[11px] uppercase tracking-wider text-slate-400">
              <th className="px-5 py-3 font-semibold">Access Code</th>
              <th className="px-5 py-3 font-semibold">Type</th>
              <th className="px-5 py-3 font-semibold">Enabled</th>
              <th className="px-5 py-3 text-right font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={4} className="px-5 py-8 text-center text-slate-400">
                  <Loader2 size={18} className="mr-2 inline animate-spin" /> Cargando códigos...
                </td>
              </tr>
            )}
            {!loading && current.length === 0 && (
              <tr>
                <td colSpan={4} className="px-5 py-10 text-center text-slate-400">
                  {codes.length === 0
                    ? 'Sin códigos todavía. Pulsa «Add Code» para crear el primero.'
                    : 'Ningún código coincide con la búsqueda.'}
                </td>
              </tr>
            )}
            {current.map((row) => (
              <tr key={row.id} className="border-b border-slate-800/70 last:border-0 hover:bg-slate-800/30">
                <td className="px-5 py-4">
                  <div className="flex items-center gap-2">
                    <span className={`font-mono text-[13.5px] ${row.enabled ? 'text-slate-200' : 'text-slate-500 line-through'}`}>
                      {row.code}
                    </span>
                    <button
                      onClick={() => copyLink(row)}
                      title="Copiar enlace con el código"
                      className="rounded p-1 text-slate-500 hover:bg-slate-700/60 hover:text-slate-300"
                    >
                      {copied === row.code ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                    </button>
                  </div>
                  {row.notes ? <div className="mt-0.5 text-xs text-slate-500">{row.notes}</div> : null}
                </td>
                <td className="px-5 py-4">
                  <TypeBadge type={row.type} label={row.typeLabel} />
                </td>
                <td className="px-5 py-4">
                  <button
                    onClick={() => toggle(row)}
                    title={row.enabled ? 'Desactivar' : 'Activar'}
                    className={`flex h-5 w-5 items-center justify-center rounded-sm border ${
                      row.enabled
                        ? 'border-emerald-400 bg-emerald-400/90 text-[#0d1322]'
                        : 'border-slate-600 bg-transparent text-transparent'
                    }`}
                  >
                    <Check size={13} strokeWidth={3} />
                  </button>
                </td>
                <td className="px-5 py-4">
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => openEdit(row)}
                      className="rounded border border-slate-600 bg-slate-700/60 p-2 text-slate-200 hover:bg-slate-600/70"
                      title="Editar"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => remove(row)}
                      className="rounded border border-slate-600 bg-slate-700/60 p-2 text-slate-200 hover:bg-rose-600/70"
                      title="Eliminar"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-700/60 px-5 py-3 text-xs text-slate-400">
          <span>
            Mostrando {filtered.length === 0 ? 0 : (page - 1) * pageSize + 1}–
            {Math.min(page * pageSize, filtered.length)} de {filtered.length} códigos
            {activeCount > 0 ? ` · ${activeCount} activo(s)` : ''}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="rounded border border-slate-600 px-2.5 py-1 disabled:opacity-40"
            >
              Anterior
            </button>
            <span>
              {page} / {pageCount}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              disabled={page >= pageCount}
              className="rounded border border-slate-600 px-2.5 py-1 disabled:opacity-40"
            >
              Siguiente
            </button>
          </div>
        </div>
      </div>

      {/* Cómo funciona */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-slate-700/70 bg-[#0f1626] p-5">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-200">
            <ShieldCheck size={16} className="text-emerald-400" /> Qué protege
          </div>
          <ul className="space-y-1.5 text-sm text-slate-400">
            <li>· El panel completo (HTML, assets y API administrativa).</li>
            <li>· Lo que no protege: las líneas IPTV de tus clientes (usan su usuario y clave).</li>
            <li>· El código caduca solo de la sesión a los 7 días; se puede revocar al instante.</li>
          </ul>
        </div>
        <div className="rounded-lg border border-slate-700/70 bg-[#0f1626] p-5">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-200">
            <ShieldAlert size={16} className="text-amber-400" /> Si te quedas fuera
          </div>
          <p className="text-sm text-slate-400">
            Desde el servidor, sin entrar al panel:
          </p>
          <pre className="mt-2 overflow-x-auto rounded bg-[#0b1120] p-3 text-xs text-slate-300">
{`tvlister-admin access-code list
tvlister-admin access-code add miclave admin
tvlister-admin access-code close      # exige código siempre
tvlister-admin access-code open       # quita el cierre
tvlister-admin access-code off        # apaga todos`}
          </pre>
        </div>
      </div>

      {/* Modal crear / editar */}
      {modal && (
        <Modal title={modal.mode === 'create' ? 'Add Code' : 'Editar código'} onClose={() => setModal(null)}>
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wide text-slate-400">Código</label>
              <input
                autoFocus
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                placeholder="adminpanel"
                className="w-full rounded-md border border-slate-600 bg-[#0b1120] px-3 py-2 font-mono text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
              />
              <p className="mt-1 text-xs text-slate-500">
                4–64 caracteres: letras, números, punto, guion y guion bajo.
              </p>
            </div>
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wide text-slate-400">Tipo</label>
              <select
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value })}
                className="w-full rounded-md border border-slate-600 bg-[#0b1120] px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
              >
                {TYPE_OPTIONS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label} — {t.hint}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wide text-slate-400">Nota (opcional)</label>
              <input
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="Para quién es"
                className="w-full rounded-md border border-slate-600 bg-[#0b1120] px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                className="h-4 w-4 rounded border-slate-600 bg-[#0b1120]"
              />
              Activo
            </label>

            {formError && (
              <div className="rounded border border-rose-600/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                {formError}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setModal(null)}
                className="rounded-md border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={saving}
                className="flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-60"
              >
                {saving && <Loader2 size={14} className="animate-spin" />}
                {modal.mode === 'create' ? 'Crear código' : 'Guardar'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
