import React, { useEffect, useState } from 'react';
import { apiFetch, getToken, setToken } from './lib/api.js';
import Layout from './components/Layout.jsx';
import VideoModal from './components/VideoModal.jsx';

import LoginPage from './pages/LoginPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import LiveStreamsPage from './pages/LiveStreamsPage.jsx';
import HeadendNodesPage from './pages/HeadendNodesPage.jsx';
import Flussonic2312Page from './pages/Flussonic2312Page.jsx';
import Wk2500CatvPage from './pages/Wk2500CatvPage.jsx';
import Channels247Page from './pages/Channels247Page.jsx';
import VodPage from './pages/VodPage.jsx';
import UsersDevicesPage from './pages/UsersDevicesPage.jsx';
import BouquetsPage from './pages/BouquetsPage.jsx';
import ResellersPage from './pages/ResellersPage.jsx';
import EpgMessagesPage from './pages/EpgMessagesPage.jsx';
import ServersSecurityPage from './pages/ServersSecurityPage.jsx';
import XuiImportPage from './pages/XuiImportPage.jsx';
import IngestProtocolsPage from './pages/IngestProtocolsPage.jsx';
import WebTvPortal from './pages/WebTvPortal.jsx';

export default function App() {
  const [user, setUser] = useState(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [previewItem, setPreviewItem] = useState(null);
  const [webTvMode, setWebTvMode] = useState(false);

  const refreshUser = async () => {
    if (!getToken()) {
      setCheckingAuth(false);
      return;
    }
    try {
      const res = await apiFetch('/api/auth/me');
      setUser(res.user);
    } catch {
      setToken('');
      setUser(null);
    } finally {
      setCheckingAuth(false);
    }
  };

  useEffect(() => {
    refreshUser();
  }, []);

  const handleLogout = () => {
    setToken('');
    setUser(null);
    setActiveTab('dashboard');
  };

  if (webTvMode) {
    return <WebTvPortal onBackToAdmin={() => setWebTvMode(false)} />;
  }

  if (checkingAuth) {
    return (
      <div className="min-h-screen bg-[#090d16] flex items-center justify-center text-slate-400 text-sm">
        Iniciando motor TVLister 24/7...
      </div>
    );
  }

  if (!user) {
    return (
      <LoginPage
        onLoginSuccess={(u) => {
          setUser(u);
          setActiveTab('dashboard');
        }}
        onOpenWebTv={() => setWebTvMode(true)}
      />
    );
  }

  return (
    <>
      <Layout
        user={user}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onLogout={handleLogout}
        onOpenWebTv={() => setWebTvMode(true)}
      >
        {activeTab === 'dashboard' && (
          <DashboardPage user={user} onPreview={setPreviewItem} setActiveTab={setActiveTab} />
        )}
        {activeTab === 'streams' && user.role === 'admin' && (
          <LiveStreamsPage onPreview={setPreviewItem} onOpenXuiImport={() => setActiveTab('xui-import')} />
        )}
        {activeTab === 'headend' && user.role === 'admin' && (
          <HeadendNodesPage onPreview={setPreviewItem} />
        )}
        {activeTab === 'flussonic-2312' && user.role === 'admin' && (
          <Flussonic2312Page onPreview={setPreviewItem} />
        )}
        {activeTab === 'wk2500-catv' && user.role === 'admin' && (
          <Wk2500CatvPage setActiveTab={setActiveTab} />
        )}
        {activeTab === 'channels247' && user.role === 'admin' && (
          <Channels247Page onPreview={setPreviewItem} />
        )}
        {activeTab === 'vod' && user.role === 'admin' && <VodPage onPreview={setPreviewItem} />}
        {activeTab === 'lines' && (
          <UsersDevicesPage
            user={user}
            onRefreshUser={refreshUser}
            onOpenXuiImport={user.role === 'admin' ? () => setActiveTab('xui-import') : null}
          />
        )}
        {activeTab === 'bouquets' && user.role === 'admin' && <BouquetsPage />}
        {activeTab === 'resellers' && user.role === 'admin' && <ResellersPage />}
        {activeTab === 'epg' && user.role === 'admin' && <EpgMessagesPage />}
        {activeTab === 'ingest-protocols' && user.role === 'admin' && <IngestProtocolsPage />}
        {activeTab === 'xui-import' && user.role === 'admin' && (
          <XuiImportPage setActiveTab={setActiveTab} />
        )}
        {activeTab === 'system' && user.role === 'admin' && <ServersSecurityPage />}
      </Layout>

      <VideoModal item={previewItem} onClose={() => setPreviewItem(null)} />
    </>
  );
}
