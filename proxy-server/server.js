/**
 * lampa-kinopub-proxy — HLS4 master.m3u8 reducer.
 *
 * Why this exists: kinopub returns a multi-audio HLS4 master with
 * 12 voice renditions × 4 quality groups + ~7 subtitles. Tizen 9.0
 * native AVPlayer hangs on master parse at 4K (state=PLAYING but no
 * frames; black screen with infinite loading). PWA / Android / Kodi
 * use software HLS parsers (hls.js / ExoPlayer) and don't hit this.
 * On Tizen we have to hand the player a SIMPLER master.
 *
 * This server fetches the kinopub master, picks one audio rendition
 * (chosen by index from the URL) + the best video stream-inf, drops
 * subtitles and I-FRAME entries, and returns a 600-800 byte master
 * that AVPlayer demuxes in 2 tracks total. URLs INSIDE the master
 * still point at kinopub CDN, so segments are fetched directly by
 * the player — VPS only proxies the master itself.
 *
 * Endpoints:
 *   GET /manifest-proxy?master=<encoded-kinopub-url>&voice=<1..12>
 *                       → application/vnd.apple.mpegurl reduced master
 *   GET /health         → { ok: true, version, uptime, cache, hits }
 *
 * Whitelist: only hosts ending in cdn2cdn.com / digital-cdn.net /
 * cdntogo.net are accepted as master targets, to prevent the proxy
 * from being abused as an open relay.
 */

'use strict';

const http  = require('http');
const https = require('https');

const PORT     = parseInt(process.env.PORT     || '3000', 10);
const HOST     = process.env.HOST     || '0.0.0.0';
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || '60000', 10);
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || '10000', 10);
const VERSION  = '1.0.0';
const STARTED  = Date.now();

const ALLOWED_HOSTS = [
  // Master.m3u8 hosts (kinopub rotates between these on each request).
  'cdn2cdn.com',
  'cdn2site.com',
  'digital-cdn.net',
  // Variant playlists + segments host (referenced from inside masters).
  // Plugin doesn't proxy these (player fetches direct), but listing here
  // for completeness in case kinopub returns a master URL on this host.
  'cdntogo.net'
];

function isAllowedHost(host) {
  if (!host) return false;
  host = host.toLowerCase();
  return ALLOWED_HOSTS.some(suffix =>
    host === suffix || host.endsWith('.' + suffix)
  );
}

/* ──────────────────────────────────────────────────────────────────── *
 *  HTTPS fetch                                                          *
 * ──────────────────────────────────────────────────────────────────── */

function httpsGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        // Mimic kinopub PWA client UA — server doesn't gate on UA but
        // some CDN edges might profile, and Chrome UA always works.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                     'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                     'Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*'
      },
      timeout: timeoutMs
    }, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error('upstream HTTP ' + res.statusCode));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
  });
}

/* ──────────────────────────────────────────────────────────────────── *
 *  HLS4 master parser + reducer                                         *
 * ──────────────────────────────────────────────────────────────────── */

/** Parse #EXT-X-MEDIA / #EXT-X-STREAM-INF attribute list. */
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
          name:  attrs.NAME || '',
          lang:  attrs.LANGUAGE || '',
          deflt: attrs.DEFAULT === 'YES',
          uri:   attrs.URI || '',
          attrs
        });
      }
    } else if (l.indexOf('#EXT-X-STREAM-INF:') === 0) {
      const sattrs = parseAttrs(l.substring('#EXT-X-STREAM-INF:'.length));
      let uri = '';
      for (let j = i + 1; j < lines.length; j++) {
        const next = (lines[j] || '').trim();
        if (next && next.charAt(0) !== '#') { uri = next; break; }
      }
      streamInfs.push({
        attrs: sattrs,
        audioGroup: sattrs.AUDIO || '',
        videoUri:   uri,
        bandwidth:  parseInt(sattrs.BANDWIDTH || '0', 10) || 0,
        resolution: sattrs.RESOLUTION || '',
        codecs:     sattrs.CODECS || ''
      });
    }
  }
  return { audioGroups, streamInfs };
}

/**
 * Build a reduced master: 1 audio MEDIA entry + best (highest-bandwidth)
 * video stream-inf. ASCII-only attribute values for AVPlayer parser
 * compatibility.
 *
 * Returns { text, pickedName } where pickedName is the ORIGINAL kinopub
 * NAME of the chosen audio (e.g. "04. Многоголосый. NewStudio (RUS)") so
 * the caller can log it for diagnostics.
 */
function buildReducedMaster(parsed, voiceIndex) {
  const out = ['#EXTM3U', '#EXT-X-VERSION:4', '#EXT-X-INDEPENDENT-SEGMENTS'];

  let bestStreamInf = null;
  parsed.streamInfs.forEach(s => {
    if (!s.videoUri) return;
    if (!bestStreamInf || s.bandwidth > bestStreamInf.bandwidth) bestStreamInf = s;
  });
  if (!bestStreamInf) return { text: out.join('\n') + '\n', pickedName: null };

  const groupId = bestStreamInf.audioGroup;
  const entries = parsed.audioGroups[groupId] || [];

  // Find by NAME prefix "01.", "02.", ... "12."
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
  if (!pickedEntry) return { text: out.join('\n') + '\n', pickedName: null };

  out.push('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Voice ' + voiceIndex +
           '",LANGUAGE="' + (pickedEntry.lang || 'und') +
           '",DEFAULT=YES,AUTOSELECT=YES,URI="' + pickedEntry.uri + '"');

  const parts = [];
  if (bestStreamInf.bandwidth)  parts.push('BANDWIDTH=' + bestStreamInf.bandwidth);
  if (bestStreamInf.resolution) parts.push('RESOLUTION=' + bestStreamInf.resolution);
  if (bestStreamInf.codecs)     parts.push('CODECS="' + bestStreamInf.codecs + '"');
  if (bestStreamInf.attrs['FRAME-RATE']) parts.push('FRAME-RATE=' + bestStreamInf.attrs['FRAME-RATE']);
  parts.push('AUDIO="aud"');
  out.push('#EXT-X-STREAM-INF:' + parts.join(','));
  out.push(bestStreamInf.videoUri);

  return { text: out.join('\n') + '\n', pickedName: pickedEntry.name };
}

/* ──────────────────────────────────────────────────────────────────── *
 *  In-memory cache (key = master+voice, TTL 60s)                        *
 * ──────────────────────────────────────────────────────────────────── */

const cache = new Map();
let cacheHits = 0;
let cacheMisses = 0;

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.t > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return e.v;
}

function cacheSet(key, value) {
  cache.set(key, { t: Date.now(), v: value });
  // Cap at 500 entries so a runaway accumulation can't OOM.
  if (cache.size > 500) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

/* ──────────────────────────────────────────────────────────────────── *
 *  Handlers                                                             *
 * ──────────────────────────────────────────────────────────────────── */

function logLine(req, status, extra) {
  const ip = (req.headers['cf-connecting-ip'] ||
              req.headers['x-forwarded-for']  ||
              req.socket.remoteAddress || '-').toString().split(',')[0].trim();
  const ts = new Date().toISOString();
  const line = `${ts} ${ip} ${req.method} ${req.url.split('?')[0]} ${status}` +
               (extra ? ' ' + extra : '');
  process.stdout.write(line + '\n');
}

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(obj));
}

function sendText(res, code, text, contentType) {
  res.writeHead(code, {
    'Content-Type': contentType || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(text);
}

async function handleManifestProxy(req, res) {
  const u = new URL(req.url, 'http://x');
  const master = u.searchParams.get('master');
  const voiceRaw = u.searchParams.get('voice') || '1';
  const voice = Math.min(Math.max(parseInt(voiceRaw, 10) || 1, 1), 99);

  if (!master) {
    logLine(req, 400, 'no master');
    return sendJson(res, 400, { ok: false, error: 'master query param required' });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(master);
  } catch {
    logLine(req, 400, 'bad master URL');
    return sendJson(res, 400, { ok: false, error: 'invalid master URL' });
  }

  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    logLine(req, 400, 'bad scheme');
    return sendJson(res, 400, { ok: false, error: 'only http/https master URLs allowed' });
  }

  if (!isAllowedHost(parsedUrl.hostname)) {
    logLine(req, 403, 'host=' + parsedUrl.hostname);
    return sendJson(res, 403, {
      ok: false,
      error: 'host not in whitelist',
      allowed: ALLOWED_HOSTS
    });
  }

  const cacheKey = master + '|v=' + voice;
  const cached = cacheGet(cacheKey);
  if (cached) {
    cacheHits++;
    logLine(req, 200, `voice=${voice} cache=HIT bytes=${cached.length}`);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'X-Cache': 'HIT'
    });
    res.end(cached);
    return;
  }
  cacheMisses++;

  try {
    const text = await httpsGet(master, FETCH_TIMEOUT_MS);
    const parsed = parseHls4Master(text);
    const audioGroupCount = Object.keys(parsed.audioGroups).length;
    const result = buildReducedMaster(parsed, voice);
    const reduced = result.text;
    cacheSet(cacheKey, reduced);
    logLine(req, 200, `voice=${voice} picked="${result.pickedName || '?'}" groups=${audioGroupCount} reduced=${reduced.length}`);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'X-Cache': 'MISS'
    });
    res.end(reduced);
  } catch (e) {
    logLine(req, 502, 'upstream: ' + (e.message || e));
    return sendJson(res, 502, { ok: false, error: String(e.message || e) });
  }
}

function handleHealth(req, res) {
  return sendJson(res, 200, {
    ok: true,
    service: 'lampa-kinopub-proxy',
    version: VERSION,
    uptimeSec: Math.floor((Date.now() - STARTED) / 1000),
    cache: {
      size: cache.size,
      ttlMs: CACHE_TTL_MS,
      hits: cacheHits,
      misses: cacheMisses
    },
    allowedHosts: ALLOWED_HOSTS
  });
}

/* ──────────────────────────────────────────────────────────────────── *
 *  Server                                                               *
 * ──────────────────────────────────────────────────────────────────── */

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    });
    res.end();
    return;
  }

  const path = req.url.split('?')[0];

  if (path === '/health'         && req.method === 'GET') return handleHealth(req, res);
  if (path === '/manifest-proxy' && req.method === 'GET') return handleManifestProxy(req, res);

  logLine(req, 404);
  sendJson(res, 404, { ok: false, error: 'not_found' });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`lampa-kinopub-proxy v${VERSION} listening on ${HOST}:${PORT}\n`);
  process.stdout.write(`  GET /health\n`);
  process.stdout.write(`  GET /manifest-proxy?master=<encoded-url>&voice=<N>\n`);
  process.stdout.write(`  whitelist: ${ALLOWED_HOSTS.join(', ')}\n`);
  process.stdout.write(`  cache TTL: ${CACHE_TTL_MS}ms\n`);
});
