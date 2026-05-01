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
 *   POST /log   — JSON {session, level, ts, tag, message, data}
 *   POST /logs  — массив записей (батч от плагина)
 *   GET  /tail  — последние записи (для быстрого просмотра в браузере)
 *   GET  /health — { ok: true }
 */

'use strict';

const http = require('http');
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
  process.stdout.write(`  POST /log    one record\n`);
  process.stdout.write(`  POST /logs   batch\n`);
  process.stdout.write(`  GET  /tail   last 100 records\n`);
  process.stdout.write(`  GET  /health\n`);
  if (LOG_TOKEN) process.stdout.write(`  AUTH: X-Log-Token header required\n`);
});
