import React, { useEffect, useState } from 'react';
import { CalendarClock, Send, CheckCircle2, Trash2, ExternalLink, Bell } from 'lucide-react';
import { apiFetch } from '../lib/api.js';

export default function EpgMessagesPage() {
  const [epg, setEpg] = useState({ sources: [], programs: [] });
  const [msgData, setMsgData] = useState({ messages: [], claims: [] });
  const [lines, setLines] = useState([]);

  const [progForm, setProgForm] = useState({
    channel_epg_id: 'bbb.hd.tv',
    title: '',
    description: ''
  });

  const [osdForm, setOsdForm] = useState({
    target_line_id: '',
    message: '',
    display_seconds: 15,
    style: 'banner'
  });

  const loadAll = async () => {
    const [eData, mData, lns] = await Promise.all([
      apiFetch('/api/epg'),
      apiFetch('/api/messages'),
      apiFetch('/api/lines')
    ]);
    setEpg(eData);
    setMsgData(mData);
    setLines(lns);
  };

  useEffect(() => {
    loadAll();
  }, []);

  const handleAddProgram = async (e) => {
    e.preventDefault();
    if (!progForm.title.trim()) return;
    await apiFetch('/api/epg/programs', {
      method: 'POST',
      body: JSON.stringify(progForm)
    });
    setProgForm({ ...progForm, title: '', description: '' });
    loadAll();
  };

  const handleSendOsd = async (e) => {
    e.preventDefault();
    if (!osdForm.message.trim()) return;
    await apiFetch('/api/messages', {
      method: 'POST',
      body: JSON.stringify({
        ...osdForm,
        target_line_id: osdForm.target_line_id || null
      })
    });
    setOsdForm({ ...osdForm, message: '' });
    loadAll();
  };

  const toggleOsd = async (id) => {
    await apiFetch(`/api/messages/${id}/toggle`, { method: 'PUT' });
    loadAll();
  };

  const deleteOsd = async (id) => {
    await apiFetch(`/api/messages/${id}`, { method: 'DELETE' });
    loadAll();
  };

  const resolveClaim = async (id) => {
    await apiFetch(`/api/claims/${id}/resolve`, { method: 'PUT' });
    loadAll();
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* OSD Message / Watermark Sender */}
        <div className="lg:col-span-6 rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-4">
          <h2 className="text-sm font-bold text-white flex items-center gap-2">
            <Bell className="w-4 h-4 text-indigo-400" />
            Emisor de Mensajes OSD / Watermark a Clientes
          </h2>

          <form onSubmit={handleSendOsd} className="space-y-3 text-xs">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-400 mb-1">Destinatario</label>
                <select
                  value={osdForm.target_line_id}
                  onChange={(e) => setOsdForm({ ...osdForm, target_line_id: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                >
                  <option value="">Difusión Global (Todos los clientes)</option>
                  {lines.map((l) => (
                    <option key={l.id} value={l.id}>
                      Línea: {l.username}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Estilo Visual</label>
                <select
                  value={osdForm.style}
                  onChange={(e) => setOsdForm({ ...osdForm, style: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                >
                  <option value="banner">Banner Superior Informativo</option>
                  <option value="watermark">Marca de Agua Anti-Piratería</option>
                  <option value="alert">Alerta Urgente</option>
                </select>
              </div>
            </div>

            <input
              type="text"
              value={osdForm.message}
              onChange={(e) => setOsdForm({ ...osdForm, message: e.target.value })}
              placeholder="Escribe el mensaje que verán en pantalla en tiempo real..."
              className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
            />

            <button
              type="submit"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold"
            >
              <Send className="w-3.5 h-3.5" /> Enviar Mensaje OSD en Vivo
            </button>
          </form>

          <div className="space-y-2 pt-2 border-t border-slate-800 text-xs">
            {msgData.messages.map((m) => (
              <div
                key={m.id}
                className="p-3 rounded-xl bg-[#090e1a] border border-slate-800 flex items-center justify-between gap-2"
              >
                <div className="min-w-0">
                  <div className="font-medium text-white truncate">{m.message}</div>
                  <div className="text-[11px] text-slate-400">
                    Destino: {m.target_username || 'Todos'} • Estilo: {m.style}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => toggleOsd(m.id)}
                    className={`px-2 py-1 rounded text-[10px] font-bold ${
                      m.active ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-800 text-slate-400'
                    }`}
                  >
                    {m.active ? 'ACTIVO' : 'OFF'}
                  </button>
                  <button
                    onClick={() => deleteOsd(m.id)}
                    className="p-1 rounded bg-rose-500/15 text-rose-300"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Custom EPG Editor */}
        <div className="lg:col-span-6 rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <CalendarClock className="w-4 h-4 text-cyan-400" />
              Editor EPG Personalizado & XMLTV
            </h2>
            <a
              href="/xmltv.php"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300"
            >
              Ver XMLTV Generado <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>

          <form onSubmit={handleAddProgram} className="space-y-2.5 text-xs">
            <div className="grid grid-cols-2 gap-2.5">
              <input
                type="text"
                value={progForm.channel_epg_id}
                onChange={(e) => setProgForm({ ...progForm, channel_epg_id: e.target.value })}
                placeholder="ID Canal EPG (ej. bbb.hd.tv)"
                className="px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
              />
              <input
                type="text"
                value={progForm.title}
                onChange={(e) => setProgForm({ ...progForm, title: e.target.value })}
                placeholder="Título del programa..."
                className="px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              />
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={progForm.description}
                onChange={(e) => setProgForm({ ...progForm, description: e.target.value })}
                placeholder="Descripción opcional para la guía..."
                className="flex-1 px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              />
              <button
                type="submit"
                className="px-4 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-semibold"
              >
                Publicar EPG
              </button>
            </div>
          </form>

          <div className="space-y-2 max-h-60 overflow-y-auto text-xs">
            {epg.programs.map((p) => (
              <div
                key={p.id}
                className="px-3 py-2.5 rounded-xl bg-[#090e1a] border border-slate-800 flex items-center justify-between"
              >
                <div>
                  <span className="font-mono text-indigo-300 mr-2">[{p.channel_epg_id}]</span>
                  <span className="font-semibold text-white">{p.title}</span>
                  <div className="text-[11px] text-slate-400">{p.description}</div>
                </div>
                <button
                  onClick={async () => {
                    await apiFetch(`/api/epg/programs/${p.id}`, { method: 'DELETE' });
                    loadAll();
                  }}
                  className="p-1 rounded bg-rose-500/15 text-rose-300"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Client Claims / Reports */}
      <div className="rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-3">
        <h3 className="text-sm font-bold text-white">Reportes / Reclamos Enviados desde Apps & WebTV</h3>
        <div className="space-y-2 text-xs">
          {msgData.claims.length === 0 ? (
            <div className="text-slate-500">No hay reportes de clientes.</div>
          ) : (
            msgData.claims.map((c) => (
              <div
                key={c.id}
                className="p-3 rounded-xl bg-[#090e1a] border border-slate-800 flex items-center justify-between gap-3"
              >
                <div>
                  <div className="font-semibold text-white">
                    {c.stream_name}{' '}
                    <span className="text-indigo-300 font-normal">• reportado por {c.line_username}</span>
                  </div>
                  <div className="text-slate-400 mt-0.5">
                    [{c.issue_type}] {c.message}
                  </div>
                </div>
                {c.status === 'open' ? (
                  <button
                    onClick={() => resolveClaim(c.id)}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600/25 hover:bg-emerald-600 text-emerald-300 hover:text-white font-semibold"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" /> Marcar Resuelto
                  </button>
                ) : (
                  <span className="px-2.5 py-1 rounded bg-slate-800 text-slate-400 font-medium">Resuelto</span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
