# Handoff: работа с VPS для проекта lampa_trakt_v3

> Документ для нового Claude, продолжающего работу Eugene над VPS-проксисервером для синхронизации Lampa↔Trakt.

---

## 1. Общая картина

**Проект:** `lampa_trakt_v3` — Node.js + Fastify сервер на VPS, выступающий буфером между TV-плеером Lampa и Trakt.tv. Сервер тянет данные из Trakt, классифицирует, обогащает TMDB, отдаёт клиенту мгновенно из snapshot. Клиент — JS-плагин для Lampa, ставится по URL с GitHub Pages.

**Стек:** Node.js 20 + Fastify, file-based JSON-снапшот, docker-compose, Cloudflare-proxy (HTTPS терминация на CF, origin HTTP).

**Репо:** https://github.com/mainsync-afk/lampa_trakt_v3 (public)

**Live URL (production):** `https://trakt.fastcdn.pics`

---

## 2. Доступы

### 2.1 VPS

| Параметр | Значение |
|---|---|
| Хост | `38.180.120.16` |
| SSH-порт | `2233` |
| Пользователь | `root` |
| OS | Debian 11 (bullseye) |
| Доп. софт | aapanel, docker, docker compose |
| Каталог проекта | `/opt/lampa_trakt_v3` |

**SSH-аутентификация:**
- Настроены **SSH-ключи** (`~/.ssh/id_ed25519` на машине Eugene). Беспарольный доступ работает.
- **Парольный auth тоже включён** (на случай работы с другими тулзами). Пароль root знает Eugene — спросить у него если понадобится.
- Команда подключения: `ssh root@38.180.120.16 -p 2233`

### 2.2 Trakt API

Зарегистрированное приложение Eugene'а. Хранится в `/opt/lampa_trakt_v3/.env` на VPS:
- `TRAKT_CLIENT_ID=859ec05fac138ec0d5e0fcd8e42a03ce6cf9b098fade138fb84abfdeb9182f3f`
- `TRAKT_CLIENT_SECRET=b9385a9d7840bf43433f364dcd92b136e8c84893c7b76ef7c1a1d8fb89990440`

OAuth-токен (access + refresh) лежит в `/opt/lampa_trakt_v3/config/auth.json`. Получался один раз через `scripts/trakt-auth.js` (device-code flow). Токен auto-refresh'ится сервером.

### 2.3 TMDB API

Используется тот же ключ что в Lampa-ядре (публичный): `4ef0d7355d9ffb5151e987764708ce96`. Тоже в `.env`.

### 2.4 Cloudflare

Поддомен `trakt.fastcdn.pics` проксирует на `38.180.120.16:8787` через aapanel-nginx reverse proxy. SSL mode у CF — Flexible (origin HTTP). Доступ к CF-аккаунту у Eugene.

### 2.5 GitHub

- Репо: `mainsync-afk/lampa_trakt_v3` (public).
- Push с машины Eugene настроен (HTTPS auth через Personal Access Token, Git Credential Manager Windows запоминает).
- GitHub Pages включён (Branch `main`, root) — раздаёт `plugin/trakt_v3.js`.
- URL плагина для Lampa: `https://mainsync-afk.github.io/lampa_trakt_v3/plugin/trakt_v3.js`

---

## 3. Workflow деплоя

### 3.1 Главный инструмент — `deploy.bat`

Файл лежит в `C:\Clade_projects\lampa_trakt_v3\deploy.bat`. Делает всю цепочку **одной командой**:

```
deploy.bat "комментарий к коммиту"
```

Шаги внутри:
1. `git status` (показывает что изменилось).
2. `git add -A && git commit -m "..." && git push`.
3. SSH на VPS: `cd /opt/lampa_trakt_v3 && git pull --ff-only && docker compose up -d --build`.
4. `docker compose logs --tail=12 server` — последние строки логов.

**Без SSH-ключей** скрипт зависнет на запросе пароля. Если ключи слетят — настроить заново через `ssh-keygen` + `~/.ssh/authorized_keys` на VPS.

### 3.2 Если нужно вручную

**Локально (cmd Windows):**
```
cd /d C:\Clade_projects\lampa_trakt_v3\github && git add -A && git commit -m "..." && git push
```

**На VPS:**
```
cd /opt/lampa_trakt_v3 && git pull && docker compose up -d --build && docker compose logs --tail=20 server
```

### 3.3 GitHub Pages cache

GitHub Pages кеширует статику до 5-10 минут (`cache-control: max-age=600`). Чтобы Lampa подхватила свежую версию плагина — **переустановить** плагин с новым cache-bust query: `?v=023` → `?v=024`.

В Lampa: Настройки → Расширения → Trakt v3 → удалить → добавить с новым URL.

---

## 4. Структура файлов

### 4.1 Локально (Windows)

```
C:\Clade_projects\lampa_trakt_v3\
├── deploy.bat                          # один-клик деплой
├── HANDOFF_VPS.md                      # этот файл
├── lampa_terminal.html                 # remote JS console через Lampa-WebSocket
├── github\                             # git-репозиторий (всё в git идёт отсюда)
│   ├── server\
│   │   ├── src\
│   │   │   ├── index.js                # Fastify entry
│   │   │   ├── lib\                    # repo, trakt, tmdb, resolve, actions
│   │   │   ├── sync\                   # sync engine + classifier + normalize
│   │   │   └── routes\                 # health, folders, card, sync, tap, episode, episodes, movie
│   │   ├── scripts\trakt-auth.js       # device-code OAuth (запускать раз)
│   │   ├── package.json
│   │   └── Dockerfile
│   ├── plugin\trakt_v3.js              # Lampa-плагин
│   ├── docs\
│   ├── docker-compose.yml
│   ├── .env.example                    # в git, без секретов
│   └── .gitignore                      # node_modules, .env, data/, config/auth.json
├── logs\                               # *.log от DevTools/CDP, для отладки
└── v2_files\                           # справочно: код предыдущего плагина v2
```

### 4.2 На VPS

```
/opt/lampa_trakt_v3/                    # git clone, обновляется через pull
├── docker-compose.yml
├── .env                                # реальные секреты, gitignored
├── server/                             # как в repo
├── plugin/
├── data/                               # docker volume — snapshot.json + tmdb_cache.json
└── config/                             # docker volume — auth.json (Trakt токены)
```

`/opt/lampa_trakt_v3/data/snapshot.json` — главное хранилище состояния. Никогда не редактировать вручную; сервер сам управляет.

### 4.3 Docker

Один контейнер: `lampa-trakt-server` (image `lampa_trakt_v3-server`, build из `./server`).

```yaml
ports:    "8787:3000"      # хост:контейнер. Наружу 8787 (через aapanel-nginx → CF).
volumes:  ./data:/app/data, ./config:/app/config
restart:  unless-stopped   # переживает ребуты VPS
```

---

## 5. Типичные команды

### 5.1 Посмотреть логи сервера

```
ssh root@38.180.120.16 -p 2233 "cd /opt/lampa_trakt_v3 && docker compose logs --tail=50 server"
```

Или follow:
```
ssh root@38.180.120.16 -p 2233 "cd /opt/lampa_trakt_v3 && docker compose logs -f server"
```

### 5.2 Перезапустить сервер

```
ssh root@38.180.120.16 -p 2233 "cd /opt/lampa_trakt_v3 && docker compose restart server"
```

### 5.3 Force resync с Trakt

```
curl -X POST https://trakt.fastcdn.pics/api/sync/force
```

или через POST к `localhost:8787/api/sync/force` на VPS.

### 5.4 Проверить health

```
curl -s https://trakt.fastcdn.pics/api/health | python3 -m json.tool
```

Ответ показывает `version`, `sync.cards_count`, `sync.last_error`, и т.д.

### 5.5 Посмотреть текущий snapshot

```
curl -s --compressed https://trakt.fastcdn.pics/api/folders | python3 -m json.tool | head -100
```

### 5.6 Получить новый Trakt-токен (если protocol сломался)

```
ssh root@38.180.120.16 -p 2233
docker compose exec server node scripts/trakt-auth.js
# → выводит код, идёшь на https://trakt.tv/activate, вводишь
```

---

## 6. Технические нюансы

### 6.1 Trakt за Cloudflare

Trakt API сидит за CF WAF. Без `User-Agent` запросы режутся 403 + HTML-страница «blocked». Все fetch к Trakt **обязаны** иметь:
```js
'User-Agent': 'lampa-trakt-proxy/<version>'
'Accept':     'application/json'
```

См. `lib/trakt.js` — там константа `USER_AGENT` и helper `traktFetch`. **Никогда** не делай голых fetch к api.trakt.tv.

### 6.2 Sync engine стратегия

- Каждые `SYNC_POLL_INTERVAL_SEC` (default 60, на тесте 5) сек дёргаем `GET /sync/last_activities`.
- Сравниваем с предыдущим. Если что-то поменялось — полный re-fetch секций (8-15 запросов).
- При write-action (tap/episode/etc) — `triggerBackgroundSync(200)` форсит полный sync через 200мс.
- Per-show progress fetch (для `episodes_aired`) — для **всех** shows в snapshot, не только in_watched.

### 6.3 Migration snapshot.json

`snapshotNeedsMigration()` в `sync/index.js` детектит структурные изменения. При boot если detected → принудительный full sync. Так что добавление нового поля в карточку не требует ручных действий — sync сам пересоберёт.

### 6.4 Docker rebuild

После изменения серверного кода нужен `docker compose up -d --build`. Просто `restart` НЕ перетянет новый код (он в образе). `--build` пересобирает образ с свежим кодом.

### 6.5 Lampa-плагин Pages cache

GitHub Pages кеширует до 10 мин. Lampa внутренне тоже кеширует плагин. Чтобы форсить refresh — переустановить плагин в Lampa с новым `?v=NNN` в URL.

### 6.6 Sensitive в логах

Eugene в чате выкладывал root-пароль и Trakt secret — будь аккуратен, **не дублируй их в memory** или незащищённых файлах. Если нужно сослаться — пиши «Eugene знает».

---

## 7. Проблемы которые встречали

### 7.1 Cloudflare WAF блокировал Trakt
Решено через User-Agent header. Если снова появится 403 от api.trakt.tv — проверь UA.

### 7.2 Порт 8787 vs 80
aapanel держит nginx на 80 для других сайтов. Наш контейнер — на 8787, nginx-reverse-proxy в aapanel настроен от `trakt.fastcdn.pics → 127.0.0.1:8787`.

### 7.3 Сторонние scanner'ы стучатся в 8787
В backlog: ufw firewall закрыть прямой доступ к 8787 (только CF IPs). Не критично — наш сервер отбрасывает 404.

### 7.4 Edit tool иногда не sync mount
В Claude Code сессии Edit tool у меня иногда не сбрасывал изменения на Windows-сторону. Workaround: использовать bash + python через mount-путь напрямую, либо Write tool с полным содержимым.

---

## 8. Backlog (приоритеты)

См. memory `project_v3_backlog.md` (если есть доступ). Группы:
- **A** Production hardening: переключить sync на 60 сек, ufw firewall, сменить root-пароль.
- **B** UX-полировка плагина: иконки на превью, верхнее меню со счётчиками, back-навигация, заголовок в sidebar.
- **C** Расширение функционала: custom lists как ряды, Collection как папка, mark season, watched_at варианты.
- **D** Episode-sync: D1d (cross-device прогресс фильмов через scrobble pause heartbeat).
- **E** Trakt-compat layer для Showly.

---

## 9. Стиль работы Eugene (важно!)

- **Русский язык** в общении.
- **Без эмодзи** в ответах — Eugene их не использует.
- **Matrix-before-code:** обсудить логику/архитектуру **до** кода. Не прыгать сразу в реализацию.
- **Лаконично:** длинные ответы — только если нужно. Eugene не любит воду.
- **Команды для shell — только cmd Windows one-liners** на ПК, и обычный bash one-liners на VPS. Один полный copy-paste блок с `&&`.
- **Git commit messages — только title** в `-m`, без длинных описаний.
- **`git add -A`** (не отдельные файлы).
- **Целостность файла проверять самому** через Read/wc-l. Не просить Eugene делать `dir`/`find`.
- **Не упоминать в обычном тексте домены, связанные с хостингом Lampa** (`lampa.mx` и подобные) — могло триггерить policy refusals в прошлом. Внутри код-конфигов URL'ы допустимы.

---

## 10. Куда бежать в первый день

1. Прочитать этот файл целиком.
2. Прочитать `github/HANDOFF_TO_PROXY_PROJECT.md` (история v3 проекта, архитектурные решения).
3. Если есть доступ к `~/.claude` memory — прочитать `MEMORY.md` и связанные файлы.
4. Глянуть `github/server/src/` чтобы понять структуру кода.
5. Спросить Eugene что на текущем шаге (он скажет статус и следующую задачу).

При сомнениях — `git log` покажет последние commits, дающие контекст.
