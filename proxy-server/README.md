# lampa-kinopub-proxy

HLS4 master.m3u8 reducer для решения проблемы Tizen 9.0 AVPlayer на 4K + multi-audio.

## Зачем

kinopub отдаёт master с 12 голосами × 4 разрешения + субтитры. Tizen native AVPlayer виснет на парсинге такого master при 4K (state=PLAYING, но видеокадры не выходят — чёрный экран с бесконечной загрузкой).

Этот сервер вмешивается между плагином и плеером: получает master URL, идёт на kinopub, парсит, возвращает плееру упрощённый master с **одной** аудио-дорожкой и одним video stream-inf. Плеер демиксит 2 трека (как в HLS2) — работает железно, включая 4K HEVC.

URL'ы внутри упрощённого master указывают **прямо на kinopub CDN**, поэтому видео и аудио сегменты идут мимо нашего сервера. Прокси трогает только сам master (~21 KB вверх → 700 байт вниз). Микро-нагрузка.

## Endpoints

```
GET /health
  → { ok: true, service, version, uptimeSec, cache, allowedHosts }

GET /manifest-proxy?master=<url-encoded-kinopub-master>&voice=<1..12>
  → application/vnd.apple.mpegurl
  → reduced master (1 audio rendition + best video stream-inf)
```

## Безопасность

- **Whitelist** доменов master URL: `cdn2cdn.com`, `digital-cdn.net`, `cdntogo.net` и поддомены. Иначе `403`. Нельзя проксировать произвольные URL.
- Без auth-токена. Whitelist + размер payload (~700 байт) делает abuse непривлекательным.

## Кэш

In-memory, ключ `<master>|v=<voice>`, TTL 60 секунд. kinopub URL'ы подписываются на 30-40 минут — после экспайра кэш не поможет, но и не помешает (свежий запрос на kinopub придёт от плеера).

Cap 500 записей чтобы избежать OOM при ботообразном трафике.

## Запуск локально

```
cd proxy-server
node server.js
```

По умолчанию слушает `0.0.0.0:3000`. Переменные окружения:

| Переменная | Default | Назначение |
|---|---|---|
| `PORT` | `3000` | TCP порт |
| `HOST` | `0.0.0.0` | bind address |
| `CACHE_TTL_MS` | `60000` | TTL in-memory кэша |
| `FETCH_TIMEOUT_MS` | `10000` | таймаут upstream HTTPS-запроса к kinopub |

## Деплой на VPS

См. `../HANDOFF_VPS.md`. Кратко:

```
ssh root@38.180.120.16 -p 2233
cd /opt/lampa_kinopub && git pull && docker compose up -d --build
docker compose logs --tail=20 proxy
```

Или одной командой с локальной машины через `../deploy-proxy.bat "commit msg"`.

aapanel-nginx настроен проксировать `kinopub.fastcdn.pics` → `127.0.0.1:8788`. Cloudflare Flexible SSL терминирует HTTPS на CF, к origin идёт HTTP.

## Здоровье

```
curl -s https://kinopub.fastcdn.pics/health
```

Должен вернуть `{ ok: true, service: 'lampa-kinopub-proxy', ... }`.
