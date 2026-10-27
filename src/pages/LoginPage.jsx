import React, { useState } from 'react';
import { Moon, Lock, User, MonitorPlay } from 'lucide-react';
import { apiFetch, setToken } from '../lib/api.js';

export default function LoginPage({ onLoginSuccess, onOpenWebTv }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });
      setToken(data.token);
      onLoginSuccess(data.user);
    } catch (err) {
      setError(err.message || 'Error al iniciar sesión');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#070b13] relative overflow-hidden p-4">
      <div className="absolute -top-40 -left-40 w-96 h-96 rounded-full bg-indigo-600/15 blur-3xl pointer-events-none" />
      <div className="absolute -bottom-40 -right-40 w-96 h-96 rounded-full bg-cyan-500/15 blur-3xl pointer-events-none" />

      <div className="w-full max-w-md relative z-10">
        <div className="text-center mb-7">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500 via-violet-600 to-cyan-500 shadow-xl shadow-indigo-500/25 mb-4">
            <Moon className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">
            TVLister <span className="text-indigo-400">24/7</span> — Midnight Panel
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Plataforma Profesional OTT / VOD, Canales 24/7 & Gestión de Suscriptores
          </p>
        </div>

        <div className="rounded-2xl bg-[#0e1526]/95 border border-slate-800 shadow-2xl p-6 sm:p-7">
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-xs text-rose-300">
                {error}
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Usuario del Panel</label>
              <div className="relative">
                <User className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full pl-10 pr-3.5 py-2.5 rounded-xl bg-[#090e1a] border border-slate-700/80 text-sm text-white focus:outline-none focus:border-indigo-500"
                  placeholder="admin"
                  autoComplete="username"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Contraseña</label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-10 pr-3.5 py-2.5 rounded-xl bg-[#090e1a] border border-slate-700/80 text-sm text-white focus:outline-none focus:border-indigo-500"
                  placeholder="••••••••"
                  autoComplete="current-password"
                  required
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white font-semibold text-sm shadow-lg shadow-indigo-600/25 transition disabled:opacity-50"
            >
              {loading ? 'Autenticando...' : 'Acceder al Panel de Administración'}
            </button>
          </form>

          <div className="mt-5 pt-5 border-t border-slate-800/80">
            <button
              type="button"
              onClick={onOpenWebTv}
              className="w-full py-2.5 px-4 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 text-xs font-semibold flex items-center justify-center gap-2 transition"
            >
              <MonitorPlay className="w-4 h-4" />
              Abrir Portal Reproductor WebTV para Clientes
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
