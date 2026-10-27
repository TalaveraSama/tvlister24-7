// Punto de entrada de Proca Automation + OBS.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from './store.js';
import { demoData } from './defaults.js';
import { createLogger } from './logger.js';
import { ObsManager } from './obs/manager.js';
import { Engine } from './engine.js';
import { createApp } from './app.js';

const log = createLogger('proca');
const DATA_FILE = process.env.PROCA_DATA || path.resolve('data', 'proca.json');
const PORT = Number(process.env.PORT) || 8420;
const HOST = process.env.HOST || '0.0.0.0';

fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

const store = new Store(DATA_FILE, () => (fs.existsSync(DATA_FILE) ? demoData() : demoData()));
const obs = new ObsManager(store, log);
const engine = new Engine({ store, obs, log });
const app = createApp({ store, obs, engine, log });

const server = http.createServer(app);

server.listen(PORT, HOST, async () => {
  log.info(`Proca Automation escuchando en http://${HOST}:${PORT}`);
  log.info(`Datos: ${DATA_FILE}`);
  log.info('Interfaz: /   ·   Gráficos para OBS: /overlay');

  const driver = process.env.PROCA_DRIVER || store.data.settings.obs.driver || 'mock';
  if (driver !== 'off') {
    const status = await obs.connect({ mock: driver !== 'real' });
    if (!status.connected) {
      log.warn('OBS no disponible. La interfaz seguirá funcionando; configure la conexión en Ajustes.');
    }
  }
  engine.start();
});

async function shutdown(signal) {
  log.info(`Cerrando (${signal})…`);
  try {
    engine.stop();
    store.saveNow();
    if (store.data.recording.active) {
      await engine.stopRecording('cierre de la aplicación').catch(() => {});
    }
    await obs.disconnect();
  } catch (err) {
    log.error(err.message);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log.error(`Promesa rechazada: ${err?.message || err}`));
process.on('uncaughtException', (err) => log.error(`Excepción no controlada: ${err?.message || err}`));
