import React from 'react';
import {
  LayoutDashboard,
  Radio,
  Tv2,
  Film,
  Users,
  Layers,
  UserCheck,
  CalendarClock,
  Server,
  MonitorPlay,
  LogOut,
  Moon,
  Coins,
  Menu,
  X,
  ArrowUp,
  Database
} from 'lucide-react';

export default function Layout({ user, activeTab, setActiveTab, onLogout, onOpenWebTv, children }) {
  const [mobileOpen, setMobileOpen] = React.useState(false);

  const isAdmin = user?.role === 'admin';

  const navItems = [
    { id: 'dashboard', label: 'Dashboard & Monitor', icon: LayoutDashboard, roles: ['admin', 'reseller'] },
    { id: 'streams', label: 'Canales en Vivo', icon: Radio, roles: ['admin'] },
    { id: 'channels247', label: 'Canales 24/7 Studio', icon: Tv2, badge: '24/7', roles: ['admin'] },
    { id: 'vod', label: 'Películas & Series VOD', icon: Film, roles: ['admin'] },
    { id: 'lines', label: 'Líneas, MAG & Enigma2', icon: Users, roles: ['admin', 'reseller'] },
    { id: 'bouquets', label: 'Bouquets & Categorías', icon: Layers, roles: ['admin'] },
    { id: 'resellers', label: 'Resellers & Paquetes', icon: UserCheck, roles: ['admin'] },
    { id: 'epg', label: 'EPG, OSD & Reportes', icon: CalendarClock, roles: ['admin'] },
    { id: 'xui-import', label: 'Importar XUI.one', icon: Database, badge: 'XUI', roles: ['admin'] },
    { id: 'system', label: 'Admin del Sistema', icon: Server, roles: ['admin'] }
  ].filter((item) => item.roles.includes(user?.role || 'admin'));

  return (
    <div className="min-h-screen flex bg-[#090d16] text-slate-100">
      {/* Mobile Sidebar Backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/70 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-50 w-68 bg-[#0d1322] border-r border-slate-800/80 flex flex-col transition-transform duration-200 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
      >
        <div className="px-5 py-4 border-b border-slate-800/80 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 via-violet-600 to-cyan-500 flex items-center justify-center shadow-lg shadow-indigo-500/25">
              <Moon className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="font-bold tracking-tight text-white leading-tight flex items-center gap-1.5">
                TVLister <span className="text-indigo-400">24/7</span>
              </div>
              <div className="text-[11px] text-slate-400 font-medium">Midnight Streamer v5.3</div>
            </div>
          </div>
          <button
            onClick={() => setMobileOpen(false)}
            className="lg:hidden p-1.5 rounded-lg text-slate-400 hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  setActiveTab(item.id);
                  setMobileOpen(false);
                }}
                className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm font-medium transition ${
                  active
                    ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/35 shadow-sm'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/50 border border-transparent'
                }`}
              >
                <span className="flex items-center gap-3">
                  <Icon className={`w-4 h-4 ${active ? 'text-indigo-400' : 'text-slate-400'}`} />
                  {item.label}
                </span>
                {item.badge && (
                  <span className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-indigo-500/25 text-indigo-300 border border-indigo-400/30">
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}

          <div className="pt-3 mt-3 border-t border-slate-800/80">
            <button
              onClick={onOpenWebTv}
              className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-semibold bg-gradient-to-r from-emerald-500/15 to-cyan-500/15 hover:from-emerald-500/25 hover:to-cyan-500/25 text-emerald-300 border border-emerald-500/30 transition"
            >
              <MonitorPlay className="w-4 h-4 text-emerald-400" />
              Abrir WebTV Player
            </button>
          </div>
        </nav>

        <div className="p-4 border-t border-slate-800/80 bg-[#0a0f1c]">
          <div className="flex items-center justify-between mb-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-white truncate">{user?.username}</div>
              <div className="text-xs text-slate-400 uppercase tracking-wider">
                {isAdmin ? 'Super Admin' : 'Reseller Oficial'}
              </div>
            </div>
            {!isAdmin && (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-500/15 text-amber-300 border border-amber-500/30 text-xs font-bold">
                <Coins className="w-3.5 h-3.5" />
                {user?.credits ?? 0}
              </span>
            )}
          </div>
          <button
            onClick={onLogout}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium bg-slate-800/80 hover:bg-rose-500/20 hover:text-rose-300 text-slate-300 border border-slate-700/70 transition"
          >
            <LogOut className="w-3.5 h-3.5" />
            Cerrar Sesión
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-30 h-15 px-4 lg:px-7 bg-[#0d1322]/90 backdrop-blur-md border-b border-slate-800/80 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setMobileOpen(true)}
              className="lg:hidden p-2 rounded-lg bg-slate-800/80 text-slate-200"
            >
              <Menu className="w-5 h-5" />
            </button>
            <h1 className="text-base sm:text-lg font-semibold text-slate-100">
              {navItems.find((i) => i.id === activeTab)?.label || 'Panel OTT/VOD'}
            </h1>
          </div>

          <div className="flex items-center gap-2.5 text-xs">
            <span className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-medium">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              Motor OTT Online
            </span>
            <button
              onClick={onOpenWebTv}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition shadow-sm"
            >
              <MonitorPlay className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Portal Cliente WebTV</span>
              <span className="sm:hidden">WebTV</span>
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 lg:p-7 max-w-[1600px] w-full mx-auto">{children}</main>

        {/* Quick Scroll Top Button */}
        <button
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          title="Ir arriba"
          className="fixed bottom-5 right-5 z-20 p-2.5 rounded-full bg-slate-800/90 hover:bg-indigo-600 text-slate-200 border border-slate-700 shadow-lg transition"
        >
          <ArrowUp className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
