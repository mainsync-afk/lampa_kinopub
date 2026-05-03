/**
 * Простой лог-сервер для приёма логов из плагина kp.js на Smart TV.
 *
 * Запуск:
 *   node server.js
 *
 * По умолчанию слушает :8088 и пишет в stdout + logs/<date>.log.
 * Конфигурация через переменные окружения:
 *   PORT       — порт (default 8088)
 *   LOG_DIR    — директория для файлов (default ./logs)
 *   LOG_TOKEN  — если задан, плагин должен слать заголовок X-Log-Token
 *
 * Эндпоинты:
 *   POST /log              — JSON {session, level, ts, tag, message, data}
 *   POST /logs             — массив записей (батч от плагина)
 *   GET  /tail             — последние записи (для быстрого просмотра в браузере)
 *   GET  /health           — { ok: true }
 *   GET  /manifest-proxy   — fetch kinopub HLS4 master, reduce to single
 *                            audio rendition + best video stream-inf, return
 *                            modified master with Content-Type application/
 *                            vnd.apple.mpegurl. Required to bypass Tizen
 *                            AVPlayer's multi-audio crash on 4K + 12 voices.
 *                            Query: ?master=<encoded URL>&voice=<1..12>
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8088', 10);
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
const LOG_TOKEN = process.env.LOG_TOKEN || '';
const TAIL_BUFFER = 500;

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const recent = [];
const colors = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m'
};

function todayFile() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return path.join(LOG_DIR, `${y}-${m}-${day}.log`);
}

function writeRecord(rec) {
  const line = JSON.stringify(rec);
  fs.appendFile(todayFile(), line + '\n', () => {});

  recent.push(rec);
  if (recent.length > TAIL_BUFFER) recent.shift();

  const lvl = (rec.level || 'info').toLowerCase();
  const c = colors[lvl] || '';
  const ts = new Date(rec.ts || Date.now()).toISOString().slice(11, 23);
  const sess = (rec.session || '').slice(0, 8);
  const tag = rec.tag ? `[${rec.tag}] ` : '';
  let msg = rec.message || '';
  if (rec.data !== undefined) {
    try {
      msg += ' ' + (typeof rec.data === 'string' ? rec.data : JSON.stringify(rec.data));
    } catch (e) { /* ignore */ }
  }
  process.stdout.write(`${c}${ts} ${sess} ${lvl.toUpperCase().padEnd(5)} ${tag}${msg}${colors.reset}\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : null);
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function send(res, code, body, ct) {
  res.writeHead(code, {
    'Content-Type': ct || 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Log-Token',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/* ======================================================================== *
 *                        MANIFEST PROXY (HLS4 reducer)                     *
 * ======================================================================== */

/**
 * Fetch a URL with Node's https module. Resolves to body string on 2xx,
 * rejects otherwise.
 */
function httpsGet(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                     '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*'
      },
      timeout: timeoutMs
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

/**
 * Parse a HLS attribute list like:
 *   TYPE=AUDIO,GROUP-ID="audio2160",NAME="01. Authorized",LANGUAGE="rus"
 * into an object. Quoted values may contain commas.
 */
function parseAttrs(s) {
  const out = {};
  let i = 0;
  const n = s.length;
  while (i < n) {
    const keyStart = i;
    while (i < n && s.charAt(i) !== '=') i++;
    const key = s.substring(keyStart, i).trim();
    if (i >= n) break;
    i++;
    let valStart, valEnd;
    if (s.charAt(i) === '"') {
      i++;
      valStart = i;
      while (i < n && s.charAt(i) !== '"') i++;
      valEnd = i;
      if (i < n) i++;
    } else {
      valStart = i;
      while (i < n && s.charAt(i) !== ',') i++;
      valEnd = i;
    }
    out[key] = s.substring(valStart, valEnd);
    while (i < n && (s.charAt(i) === ',' || s.charAt(i) === ' ')) i++;
  }
  return out;
}

/**
 * Parse a kinopub HLS4 master.m3u8 into structured pieces. Returns:
 *   { audioGroups: { groupId: [{name, lang, deflt, uri, attrs}, ...] },
 *     streamInfs:  [{attrs, audioGroup, videoUri, bandwidth, resolution, codecs}, ...] }
 */
function parseHls4Master(text) {
  const lines = text.split(/\r?\n/);
  const audioGroups = {};
  const streamInfs = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    if (l.indexOf('#EXT-X-MEDIA:') === 0) {
      const attrs = parseAttrs(l.substring('#EXT-X-MEDIA:'.length));
      if (attrs.TYPE === 'AUDIO') {
        const g = attrs['GROUP-ID'] || 'audio';
        (audioGroups[g] = audioGroups[g] || []).push({
          name: attrs.NAME || '',
          lang: attrs.LANGUAGE || '',
          deflt: attrs.DEFAULT === 'YES',
          uri: attrs.URI || '',
          attrs: attrs
        });
      }
    } else if (l.indexOf('#EXT-X-STREAM-INF:') === 0) {
      const sattrs = parseAttrs(l.substring('#EXT-X-STREAM-INF:'.length));
      let uri = '';
      for (let j = i + 1; j < lines.length; j++) {
        const n = (lines[j] || '').trim();
        if (n && n.charAt(0) !== '#') { uri = n; break; }
      }
      streamInfs.push({
        attrs: sattrs,
        audioGroup: sattrs.AUDIO || '',
        videoUri: uri,
        bandwidth: parseInt(sattrs.BANDWIDTH || '0', 10) || 0,
        resolution: sattrs.RESOLUTION || '',
        codecs: sattrs.CODECS || ''
      });
    }
  }
  return { audioGroups, streamInfs };
}

/**
 * Build a reduced master.m3u8: 1 audio MEDIA entry + best video stream-inf.
 * voiceIndex is 1-based and matches kinopub NAME prefix ("01.", "02.", ...).
 */
function buildReducedMaster(parsed, voiceIndex) {
  const out = ['#EXTM3U', '#EXT-X-VERSION:4', '#EXT-X-INDEPENDENT-SEGMENTS'];

  let bestStreamInf = null;
  parsed.streamInfs.forEach((s) => {
    if (!s.videoUri) return;
    if (!bestStreamInf || s.bandwidth > bestStreamInf.bandwidth) bestStreamInf = s;
  });
  if (!bestStreamInf) return out.join('\n') + '\n';

  const groupId = bestStreamInf.audioGroup;
  const entries = parsed.audioGroups[groupId] || [];
  let pickedEntry = null;
  const prefix = (voiceIndex < 10 ? '0' : '') + voiceIndex + '.';
  for (let k = 0; k < entries.length; k++) {
    if (entries[k].name && entries[k].name.indexOf(prefix) === 0) {
      pickedEntry = entries[k];
      break;
    }
  }
  if (!pickedEntry) {
    for (let k2 = 0; k2 < entries.length; k2++) {
      if (entries[k2].deflt) { pickedEntry = entries[k2]; break; }
    }
  }
  if (!pickedEntry && entries.length) pickedEntry = entries[0];
  if (!pickedEntry) return out.join('\n') + '\n';

  const simpleGroupId = 'aud';
  const simpleName = 'Voice ' + voiceIndex;
  out.push('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="' + simpleGroupId +
           '",NAME="' + simpleName +
           '",LANGUAGE="' + (pickedEntry.lang || 'und') +
           '",DEFAULT=YES,AUTOSELECT=YES,URI="' + pickedEntry.uri + '"');

  const parts = [];
  if (bestStreamInf.bandwidth)  parts.push('BANDWIDTH=' + bestStreamInf.bandwidth);
  if (bestStreamInf.resolution) parts.push('RESOLUTION=' + bestStreamInf.resolution);
  if (bestStreamInf.codecs)     parts.push('CODECS="' + bestStreamInf.codecs + '"');
  if (bestStreamInf.attrs['FRAME-RATE']) parts.push('FRAME-RATE=' + bestStreamInf.attrs['FRAME-RATE']);
  parts.push('AUDIO="' + simpleGroupId + '"');
  out.push('#EXT-X-STREAM-INF:' + parts.join(','));
  out.push(bestStreamInf.videoUri);

  return out.join('\n') + '\n';
}

/**
 * GET /manifest-proxy?master=<encoded-url>&voice=<1..12>
 * Fetches kinopub master, reduces to 1 audio + 1 video stream-inf, returns
 * modified m3u8 text. Logs result to console.
 */
async function handleManifestProxy(req, res) {
  const u = new URL(req.url, 'http://x');
  const master = u.searchParams.get('master');
  const voice = parseInt(u.searchParams.get('voice') || '1', 10) || 1;
  if (!master) {
    return send(res, 400, { ok: false, error: 'master query param required' });
  }
  process.stdout.write(`[manifest-proxy] master=${master.slice(0, 80)}... voice=${voice}\n`);
  try {
    const text = await httpsGet(master, 10000);
    const parsed = parseHls4Master(text);
    const reduced = buildReducedMaster(parsed, voice);
    const audioGroupCount = Object.keys(parsed.audioGroups).length;
    const firstGroupSize = audioGroupCount ? parsed.audioGroups[Object.keys(parsed.audioGroups)[0]].length : 0;
    process.stdout.write(`[manifest-proxy] parsed: ${audioGroupCount} groups × ${firstGroupSize} voices, ` +
                         `${parsed.streamInfs.length} stream-infs → reduced ${reduced.length} bytes\n`);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Cache-Control': 'no-store'
    });
    res.end(reduced);
  } catch (e) {
    process.stdout.write(`[manifest-proxy] error: ${e.message || e}\n`);
    return send(res, 502, { ok: false, error: String(e.message || e) });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (LOG_TOKEN) {
    const hdr = req.headers['x-log-token'];
    if (hdr !== LOG_TOKEN) return send(res, 401, { ok: false, error: 'token' });
  }

  const url = req.url.split('?')[0];

  if (url === '/health') return send(res, 200, { ok: true });

  if (url === '/tail' && req.method === 'GET') {
    return send(res, 200, recent.slice(-100));
  }

  if (url === '/manifest-proxy' && req.method === 'GET') {
    return handleManifestProxy(req, res);
  }

  if ((url === '/log' || url === '/logs') && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const items = Array.isArray(body) ? body : [body];
      items.filter(Boolean).forEach(writeRecord);
      return send(res, 200, { ok: true, received: items.length });
    } catch (e) {
      return send(res, 400, { ok: false, error: String(e.message || e) });
    }
  }

  return send(res, 404, { ok: false, error: 'not_found' });
});

server.listen(PORT, () => {
  process.stdout.write(`kp log-server listening on :${PORT}\n`);
  process.stdout.write(`  POST /log              one record\n`);
  process.stdout.write(`  POST /logs             batch\n`);
  process.stdout.write(`  GET  /tail             last 100 records\n`);
  process.stdout.write(`  GET  /manifest-proxy   ?master=<url>&voice=<N>\n`);
  process.stdout.write(`  GET  /health\n`);
  if (LOG_TOKEN) process.stdout.write(`  AUTH: X-Log-Token header required\n`);
});
