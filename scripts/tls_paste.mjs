#!/usr/bin/env node
/**
 * Instala un certificado pegado por consola (o leído de ficheros) para un
 * dominio concreto. Pensado para el Origin Certificate de Cloudflare, que se
 * copia y pega desde el panel de Cloudflare.
 *
 * Uso:
 *   node scripts/tls_paste.mjs --host tvadmin.ejemplo.com [--source "Cloudflare Origin"]
 *   node scripts/tls_paste.mjs --host tvadmin.ejemplo.com --cert /ruta/cert.pem --key /ruta/key.pem
 *
 * Sin --cert/--key lee de la entrada estándar:
 *   cat origin.pem origin.key | tvlister-admin tls add tvadmin.ejemplo.com
 *
 * Detecta los bloques por sus marcas (BEGIN/END CERTIFICATE y BEGIN/END … PRIVATE KEY),
 * así funciona igual pegando a mano (termina con Ctrl-D) que por tubería. Admite
 * cadena de certificados (varios bloques CERTIFICATE seguidos).
 */
import fs from 'node:fs';
import readline from 'node:readline';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

let host = arg('host');
const source = arg('source', 'consola');
const certFile = arg('cert');
const keyFile = arg('key');

if (!host) {
  console.error('Falta --host');
  process.exit(2);
}

async function readFromStdin() {
  const certLines = [];
  const keyLines = [];
  let phase = 'cert';
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const raw of rl) {
    const line = raw.replace(/\r$/, '');
    if (phase === 'cert') {
      if (!certLines.length && !line.trim()) continue; // saltar líneas en blanco iniciales
      if (!certLines.length && !line.includes('BEGIN CERTIFICATE')) {
        continue; // pegado con texto de más delante: se ignora hasta el PEM
      }
      certLines.push(line);
      if (line.includes('END CERTIFICATE')) phase = 'cert-chain'; // puede venir la cadena
      continue;
    }
    if (phase === 'cert-chain') {
      if (!line.trim()) continue;
      if (line.includes('BEGIN CERTIFICATE')) {
        certLines.push(line);
        phase = 'cert';
        continue;
      }
      if (/BEGIN .*PRIVATE KEY/.test(line)) {
        keyLines.push(line);
        phase = 'key';
        continue;
      }
      continue;
    }
    // phase === 'key'
    keyLines.push(line);
    if (/END .*PRIVATE KEY/.test(line)) {
      rl.close();
      break;
    }
  }
  return { cert: certLines.join('\n'), key: keyLines.join('\n') };
}

async function main() {
  let cert;
  let key;

  if (certFile && keyFile) {
    cert = fs.readFileSync(certFile, 'utf8');
    key = fs.readFileSync(keyFile, 'utf8');
  } else {
    if (process.stdin.isTTY) {
      console.log('');
      console.log(`Pega el CERTIFICADO de ${host} (incluye -----BEGIN CERTIFICATE-----).`);
      console.log('Si tu proveedor da cadena, pega los bloques seguidos. Termina con Ctrl-D:');
      console.log('');
    }
    ({ cert, key } = await readFromStdin());
  }

  if (!cert || !key) {
    console.error('❌ No llegó el certificado o la clave. Pega los dos bloques PEM completos.');
    process.exit(1);
  }

  const { initDb } = await import('../server/db.js');
  initDb();

  // Sin dominio indicado (o con "auto"): el del panel, y si no hay, el que diga
  // el propio certificado (CN o primer SAN). Así `tls origin` sin argumentos
  // funciona recién instalado, antes de configurar los dominios.
  if (!host || host === 'auto') {
    const { getDomains } = await import('../server/domains.js');
    host = getDomains().panelDomain || '';
  }
  if (!host) {
    const { X509Certificate } = await import('node:crypto');
    const x509 = new X509Certificate(cert);
    const cn = String(x509.subject || '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('CN='))
      .map((l) => l.slice(3))
      .map((v) => v.replace(/\\,/g, ',').trim())
      .filter((v) => v.includes('.'))
      .pop();
    const sans = String(x509.subjectAltName || '')
      .split(',')
      .map((v) => v.trim().replace(/^DNS:/, ''))
      .filter((v) => v && v.includes('.'));
    // Un certificado comodín (el de Cloudflare suele ser *.dominio) se guarda
    // como comodín: así cubre el panel y cualquier subdominio futuro de golpe.
    const wildcard = sans.find((v) => v.startsWith('*.'));
    host = wildcard || cn || sans[0] || '';
    if (host) console.log(`   (dominio tomado del certificado: ${host})`);
  }
  if (!host) {
    console.error('❌ No se pudo deducir el dominio. Indícalo: --host tvadmin.ejemplo.com');
    process.exit(1);
  }

  const { installCertificate } = await import('../server/tlsManager.js');

  try {
    const saved = installCertificate({ host, certPem: cert, keyPem: key, source });
    console.log('');
    console.log(`✅ Certificado instalado para ${saved.host}`);
    console.log(`   Emisor      : ${saved.issuer}`);
    console.log(`   Válido hasta: ${String(saved.validTo).slice(0, 10)} (${saved.daysLeft} días)`);
    console.log(`   Nombres     : ${[saved.domain, ...saved.altNames].filter(Boolean).join(', ')}`);
    console.log(`   Ficheros    : ${saved.certPath}`);
    console.log(`                 ${saved.keyPath} (sólo root)`);
    if (saved.selfSigned) {
      console.log('   ⚠️  Es autofirmado: los reproductores lo rechazarán.');
    }
    if (saved.isCloudflareOrigin) {
      console.log('');
      console.log('   ℹ️  Origin Certificate de Cloudflare: sólo es válido cuando quien');
      console.log('       valida es Cloudflare (panel con nube naranja). Un dominio que se');
      console.log('       conecta DIRECTO, como el de video, necesita CA pública');
      console.log('       (Let\'s Encrypt) o el reproductor rechazará la conexión.');
      const { getDomains } = await import('../server/domains.js');
      const doms = getDomains();
      if (doms.streamDomain && doms.streamDomain !== saved.host) {
        console.log(`       El video (${doms.streamDomain}) debe seguir con Let's Encrypt.`);
      }
    }
    process.exit(0);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
