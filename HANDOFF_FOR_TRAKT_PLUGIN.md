# Handoff: Lampa-Plugin Knowledge from kinopub Project for Trakt.tv Sync Plugin

Этот документ — конденсация технических знаний, накопленных при разработке плагина `kp.js` для kinopub в Lampa. Большинство пунктов — это «грабли», на которые мы наступили и нашли решения. Если ты пишешь плагин синхронизации с Trakt.tv для Lampa, эти знания должны сэкономить тебе дни.

Текущий baseline kp.js: **v1.0.65** (репо `mainsync-afk/lampa_kinopub`, доставка через GitHub Pages → `https://mainsync-afk.github.io/lampa_kinopub/kp.js`).

---

## 1. Жизненный цикл плагина и регистрация

### Структура

Плагин — это один JS-файл, который пользователь вешает в Lampa через Settings → Plugins → URL. Lampa загружает его на старте, выполняет глобально. Внутри файла мы оборачиваем всё в IIFE и регистрируем компонент через:

```js
Lampa.Component.add(COMPONENT_NAME, component);
```

### Запуск кода при старте

Lampa уже подняла `window.Lampa`. Слушай событие `Lampa.Listener.follow('app', e => { if (e.type === 'ready') ... })` если нужен момент полной готовности UI. Но 90% работы можно делать сразу при загрузке файла.

### Запуск при определённых страницах

```js
Lampa.Listener.follow('full', function (e) {
  if (e.type !== 'complite') return;
  // e.data.movie, e.object.activity ...
});
```

`full` — это карточка фильма/сериала. `complite` — момент когда всё нарисовано.

Аналогично есть слушатели на `activity`, `Player`, `PlayerVideo`. См. ниже.

### Lampa-events которые срабатывают

Для синка прогресса и состояний полезны:
- `app` (ready, start)
- `activity` (init, create, start, destroy)
- `full` (complite, build) — карточка фильма/сериала
- `Player` (create, start, ready, destroy)
- `PlayerVideo` (canplay, loadeddata, tracks, play, pause, rewind, timeupdate, error, subs, translate)

Хук:
```js
Lampa.Listener.follow('PlayerVideo', function (e) {
  if (e.type === 'timeupdate') {
    // e.duration, e.position в секундах
  }
});
```

`PlayerVideo/timeupdate` — для Trakt scrobbling. Это твой главный хук. Срабатывает при изменении position (можно throttle до 1/sec на нашей стороне). На Tizen работает (выяснили практикой — другой Claude утверждал что нет, ошибся).

---

## 2. Lampa.Storage — где хранить данные

Lampa оборачивает `localStorage` через `Lampa.Storage`:

```js
Lampa.Storage.set('my_key', value);
Lampa.Storage.get('my_key', defaultValue);
// .cache(key, ttl_ms, default) — авто-просроченный кеш в Storage
Lampa.Storage.cache('cache_key', 5000, {});
```

Для plugin-specific данных используй уникальный префикс (`trakt_` etc.).

**ВАЖНО**: `Lampa.Storage.field('language')` читает текущий язык интерфейса. Используй для локализации.

### Sync через CUB

Eugene НЕ использует cub.red. Не предлагай Lampa.Storage.sync через CUB как преимущество — у него своя интеграция (Trakt и есть его «синхронизация»). Не ссылайся на CUB.

---

## 3. Player events для scrobbling

Для Trakt scrobbling (start/pause/stop) нужны:

| Событие | Когда срабатывает | Что делать с Trakt |
|---------|---|---|
| `Player/start` или `PlayerVideo/play` | Начало воспроизведения | POST /scrobble/start |
| `PlayerVideo/pause` | Пауза | POST /scrobble/pause |
| `PlayerVideo/timeupdate` | Каждый tick (~1/sec) | Throttle, апдейт прогресса |
| `Player/destroy` | Юзер вышел из плеера или эпизод закончился | POST /scrobble/stop с финальным % |

### Получить metadata текущего просмотра

В обработчике `Player/start` или `Player/create` можно достать:

```js
var play = Lampa.Player.playdata();
// play.url, play.title, play.timeline, play.callback...
```

Но нет нативного `imdb_id` / `tmdb_id` в play-элементе — это нужно подкладывать самому при запуске. На стороне kinopub-плагина мы строили play из `element.kp.id` (kinopub ID). Если Lampa запускает trakt-able контент через TMDB-source, у play может быть `play.movie.id` (TMDB ID).

### Hash для уникальной идентификации

`Lampa.Utils.hash([season, episode, original_title].join(''))` — Lampa так делает hash_timeline. Это не TMDB ID, не IMDB ID — это локальный хеш для своих чисел. Trakt просит IMDB / TMDB / TVDB IDs.

**Чтобы достать TMDB ID серии**, в момент `full/complite` у тебя есть `e.data.movie.id` (TMDB movie/show ID), `e.data.movie.imdb_id` (если TMDB вернул). Сохрани в свой mapping для будущей идентификации в Player.

---

## 4. Tizen / TV нюансы (что мы выяснили)

### Подопытные

- Samsung Tizen 9.0, Lampa Tizen-app
- Платформа: `webapis.avplay` (Tizen native AVPlayer)

### Tizen НЕ умеет

- HLS4 master с 12+ audio tracks → демуксер падает на 4K
- Mid-stream audio switching на HLS4 без close+open
- HEVC main10 hardware decoder нестабилен под нагрузкой (race с hls.js, accumulation после 3-4 close/open)

### Tizen умеет

- `webapis.avplay.setSelectTrack('AUDIO', N)` — переключение audio-track когда они уже распарсены
- HLS2 (TS, single-audio per stream) — стабильно
- HEVC main10 4K при HLS2 — играет
- `webapis.avplay.getTotalTrackInfo()` — получить список треков

### Сетевые ограничения на Tizen

CSP в Tizen Lampa-app строгий. Некоторые домены могут не отвечать через fetch, нужно либо:
- Использовать `Lampa.Reguest()` (`new Lampa.Reguest().native(url, onSuccess, onError)`) — она использует jQuery $.ajax под капотом и иногда обходит CSP
- Использовать VPS-прокси для проксирования API (см. §11)

Для Trakt OAuth: device flow (kinopub использует именно его — не PIN, не redirect). Возможно стоит так же. См. `auth_state` в kp.js.

---

## 5. Override стилей Lampa — паттерн который реально работает

### Проблема

Lampa stock CSS использует:
- `!important` на многих базовых правилах (margin, padding, font-size на `.simple-button`)
- Высокая specificity (часто `body .selector` или цепочки классов)
- Inline стили которые ставятся через JS на focus/blur events

**Обычный CSS-override через `<style>` блок НЕ ВСЕГДА работает.** Даже с `!important` и class-chain selectors (специфичность 0,3,0) Lampa может выиграть.

### Решение — JS-инлайн с MutationObserver

```js
function applyMyStyles(el) {
  el.style.setProperty('margin', '0', 'important');
  el.style.setProperty('padding', '0.3em 1em', 'important');
  // ... и т.д.
}

// Применить один раз
applyMyStyles(el);

// MutationObserver чтобы пере-применить когда Lampa меняет class или style
var obs = new MutationObserver(function () {
  obs.disconnect();
  applyMyStyles(el);
  obs.observe(el, { attributes: true, attributeFilter: ['class', 'style'], subtree: true });
});
obs.observe(el, { attributes: true, attributeFilter: ['class', 'style'], subtree: true });
```

`element.style.setProperty(..., 'important')` побеждает любой CSS — это inline-style с `!important`. Это **единственный гарантированный способ** изменить стиль кнопки в Lampa.

### Гнчо: Lampa использует inner-div с собственным стилем

Многие `.simple-button` элементы имеют структуру:

```html
<div class="simple-button">
  <svg>...</svg>           <!-- иконка -->
  <div class="hide">текст</div>  <!-- inner div с padding+bg -->
</div>
```

Lampa стилизует и outer и inner. Если переопределяешь outer — inner может оставить артефакты (полупрозрачный фон, лишний padding). Решение — обнулить стили на детях:

```js
for (var i = 0; i < el.children.length; i++) {
  var c = el.children[i];
  c.style.setProperty('padding', '0', 'important');
  c.style.setProperty('background', 'transparent', 'important');
  // svg отдельно — display: none
}
```

### Структура элементов которые мы переопределили

- `.filter--search` — кнопка с лупой и search query (показывает название текущего сериала)
- `.filter--sort` — кнопка сортировки (мы её удаляем через `filter.render().find('.filter--sort').remove()`)
- `.filter--filter` — кнопка фильтра (открывает sidebar)
- `.filter--back` — back-кнопка (мы её скрываем через `display: none`)
- `.simple-button` — общий класс
- `.simple-button--filter` — для filter-buttons
- `.selector` — focusable элемент
- `.focus` — класс добавляемый Lampa при фокусе

---

## 6. Filter-sidebar / Component pattern

Lampa предоставляет два класса для построения list-page компонента:

```js
var filter = new Lampa.Filter(object);  // боковой sidebar с фильтрами + top-bar buttons
var scroll = new Lampa.Scroll({ mask: true, over: true }); // body со скроллом
var files  = new Lampa.Explorer(object); // обёртка
```

`filter.set('filter', items)` — наполняет sidebar. `items` — массив `{title, items: [{title, selected, index}], stype}`. Если у item нет `items[]` — это flat-entry, кликается напрямую.

`filter.chosen('filter', ['Сезон 1, ...'])` — устанавливает текст в кнопке фильтра. Lampa ограничивает 25 chars через `Utils.shortText`. Для длиннее — переписывай DOM напрямую:

```js
filter.render().find('.filter--filter > div').html(fullText);
```

`filter.onSelect = function (type, a, b) { ... }` — обработчик клика. `a` — выбранный entry, `b` — sub-entry если открывался submenu.

### Activity / Component lifecycle

Активити — это страница в Lampa. Создаётся через `Lampa.Activity.push({...})` или `Lampa.Activity.replace({...})`. У компонента (зарегистрированного через `Lampa.Component.add`) lifecycle — `initialize → start → pause → resume → destroy`.

В нашем kp.js:
- `this.start()` — вызывается когда страница активна
- `this.initialize()` — один раз
- `this.create()` / `this.render()` — DOM
- `this.destroy()` — cleanup

`Lampa.Activity.active()` — текущая активити. Полезно чтобы убедиться что мы всё ещё на нашей странице (асинхронные callback'и могут срабатывать после ухода).

### Получить TMDB ID текущей карточки

В обработчике `full/complite`:
```js
e.data.movie.id          // TMDB id
e.data.movie.imdb_id     // IMDB id (если TMDB его вернул)
e.data.movie.name        // название (для серий) или undefined (для фильмов)
e.data.movie.original_name / original_title
e.data.movie.number_of_seasons
e.data.movie.first_air_date / release_date
```

---

## 7. Logger pattern — критически важно

На Tizen TV нет нормальной DevTools-консоли. Если плагин падает или ведёт себя странно — без удалённого лога ты слепой. Мы написали свой `Logger`:

```js
var Logger = {
  info:  function (cat, msg, data) { send('INFO',  cat, msg, data); },
  warn:  function (cat, msg, data) { send('WARN',  cat, msg, data); },
  error: function (cat, msg, data) { send('ERROR', cat, msg, data); },
  debug: function (cat, msg, data) { send('DEBUG', cat, msg, data); }
};

function send(level, cat, msg, data) {
  // Async POST to user's log server
  // session ID, plugin version, timestamp
}
```

Лог-сервер — простой Node.js на VPS, принимает POST, пишет в файл. Это окупилось десятки раз.

Lampa events тоже логируем:
```js
['app', 'activity', 'Player', 'PlayerVideo', 'full'].forEach(function (name) {
  Lampa.Listener.follow(name, function (e) {
    Logger.info('lampa-evt', name + '/' + e.type);
  });
});
```

Это даёт полный timeline что когда происходит — бесценно для дебага.

---

## 8. OAuth (Device Flow)

Для аутентификации на TV-устройствах используй **Device Flow** (RFC 8628), не PIN или redirect. Trakt поддерживает: `https://api.trakt.tv/oauth/device/code`.

Поток:
1. POST /oauth/device/code с client_id → получаешь user_code, device_code, verification_url, interval
2. Показываешь юзеру user_code и URL (qr-код опционально)
3. Polling POST /oauth/device/token с device_code раз в `interval` секунд
4. Когда юзер ввёл код — получаешь access_token + refresh_token
5. Сохраняешь в Lampa.Storage.set('trakt_auth', { access_token, refresh_token, expires_at })

**Refresh token logic**: при 401 от Trakt API → POST /oauth/token с refresh_token → новые токены.

В нашем kp.js см. `auth_state`, `notifyDeviceIdentity` — у kinopub своё API (`/device/code`, `/device/notify`), но паттерн идентичный.

---

## 9. Settings panel в Lampa

```js
Lampa.SettingsApi.addParam({
  component: 'plugins',
  param: { name: 'trakt_enabled', type: 'trigger', default: true },
  field: { name: 'Trakt sync enabled' },
  onChange: function (v) { /* ... */ }
});
```

Plugin-specific subsection: `Lampa.SettingsApi.addComponent({...})`.

Полезно: настройки `client_id`, `enable scrobble`, `sync watchlist`, `account info`, `re-auth` button.

---

## 10. Локализация

```js
Lampa.Lang.add({
  trakt_login: { ru: 'Войти в Trakt', en: 'Sign in to Trakt' },
  // ...
});
Lampa.Lang.translate('trakt_login');
```

Используй везде где есть user-visible текст. Lampa.Storage.field('language') = текущий язык.

---

## 11. VPS-прокси (если CORS / Tizen CSP блокирует)

У Eugene есть VPS на `38.180.120.16` (порт SSH `2233`). Использует aapanel-nginx + Cloudflare Flexible. Уже хостит:

- `kinopub.fastcdn.pics` → kinopub manifest proxy (для нашего плагина)
- `mainsync.fastcdn.pics` → trakt-related (если ты построишь свой backend) — это его рабочий домен на CF

Если Trakt API задышит из-под Tizen напрямую — отлично, ничего не нужно. Если будут CORS / network issues — можно прокинуть через VPS.

**Важное**: когда деплоишь свой docker container на VPS, не ломай существующие — там два сервиса (kinopub-proxy, trakt-related). См. `HANDOFF_VPS.md` (если попросишь Eugene).

Deploy one-liner для cmd Eugene предпочитает в одну строку:
```cmd
del /F C:\Clade_projects\<repo>\.git\index.lock 2>nul && cd /d C:\Clade_projects\<repo> && git add -A && git commit -m "..." && git push && ssh root@38.180.120.16 -p 2233 "cd /opt/<repo> && git pull --ff-only && docker compose up -d --build" && curl -s --max-time 5 https://<domain>/health
```

---

## 12. Hash и идентификация контента

Lampa использует свои хеши для timeline (`Lampa.Utils.hash`). Они не совместимы с Trakt API.

**Trakt идентификация:**
- `imdb_id` — лучше всего, у Trakt все есть
- `tmdb_id` — для фильмов и сериалов
- `slug` — Trakt slug, нужно искать

**В Lampa у тебя есть:**
- TMDB ID (`movie.id`)
- IMDB ID (`movie.imdb_id`) — иногда
- season number, episode number — для серий

**Стратегия:**
1. На `full/complite` забираешь TMDB ID
2. Отправляешь Trakt POST `/search/tmdb/{id}?type=show` или `/show/{trakt_id}` чтобы найти Trakt ID + slug
3. Кешируешь mapping `{tmdb_id → trakt_id}` в Lampa.Storage
4. На Player events используешь Trakt ID для scrobble

---

## 13. Полезные паттерны / готовые helpers

### MutationObserver-based DOM hook

```js
var observer = new MutationObserver(function (records) {
  records.forEach(function (r) {
    r.addedNodes.forEach(function (node) {
      if (node.nodeType !== 1) return;
      // node — добавленный элемент. Здесь ты можешь хукнуться.
    });
  });
});
observer.observe(document.body, { childList: true, subtree: true });
```

### Throttle (для timeupdate scrobble)

```js
function throttle(fn, ms) {
  var last = 0;
  return function () {
    var now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn.apply(this, arguments);
    }
  };
}
var throttledScrobble = throttle(scrobbleProgress, 5000); // раз в 5 сек
```

### Async XHR (Tizen-friendly)

```js
function xhr(method, url, body, onOk, onErr) {
  var x = new XMLHttpRequest();
  x.open(method, url, true);
  x.timeout = 10000;
  x.setRequestHeader('Content-Type', 'application/json');
  // ... auth headers
  x.onload = function () {
    if (x.status >= 200 && x.status < 300) {
      try { onOk(JSON.parse(x.responseText || 'null')); }
      catch (e) { onOk(x.responseText); }
    } else onErr({ status: x.status, body: x.responseText });
  };
  x.onerror = x.ontimeout = function () { onErr({ network: true }); };
  x.send(body ? JSON.stringify(body) : null);
}
```

(Lampa.Reguest.native — то же самое но с jQuery.)

---

## 14. Common pitfalls

### Не убивай play.voiceovers на Tizen

Если ты передаёшь `play.voiceovers = []` или `null` на Tizen — Lampa.PlayerPanel ломается, второе видео не запускается, процесс убивается. Передавай **минимум одну запись** даже если она не используется.

### Не закрывай плеер если активити меняется внутри plugin

Если ты делаешь `Lampa.Activity.replace` пока плеер открыт, может сработать `Player/destroy` неожиданно. Дождись `Player/destroy` сначала, потом меняй activity.

### Storage.set не сохраняет immediate

Lampa.Storage кеширует в JS-объекте + flush в localStorage не всегда сразу. Если важно — после `.set()` сделай `Lampa.Storage.save()` (если такой есть) или подожди event-loop tick.

### Lampa.Reguest имеет timeout по умолчанию

Если запрос медленный — `req.timeout(10000)` явно. Без этого 30s+ default.

### Двойная регистрация компонента

Если ты вызовешь `Lampa.Component.add(NAME, comp)` дважды — Lampa может крашнуться. У нас сохранён флаг `initialized` в plugin scope.

### CORS на самописном backend

Если будешь делать свой backend для Trakt OAuth/refresh — на CF Flexible у Eugene's VPS уже всё настроено. CORS заголовки через nginx/aapanel.

### Lampa.Listener.follow не отвязывается

Listener'ы добавленные через follow не отписываются автоматически. Если плагин может перезагружаться — либо не плоди дубли (флаг), либо используй namespaced events если поддерживаются.

---

## 15. Файлы в нашем репо которые могут пригодиться

В `mainsync-afk/lampa_kinopub`:

- `docs/kp.js` — основной плагин (~4000 строк, много паттернов которые можно скопировать: Logger, Storage helpers, OAuth, settings, hash helpers, MutationObserver-based UI overrides, lampa event listeners)
- `proxy-server/server.js` — пример Node.js HTTP-прокси (~280 строк, plain http+https, zero deps, in-memory cache)
- `proxy-server/Dockerfile` — node:20-alpine для VPS
- `docker-compose.yml` — пример как поднять на aapanel
- `_lampa_src.js` — распакованный исходник Lampa (gitignore'd, но Eugene может предоставить — там ВСЯ инфа про API)

---

## 16. Что у меня в памяти про Eugene'а (полезно)

- Tizen-only — на других платформах не тестирует
- Один TV: Samsung Tizen 9.0, Lampa Tizen-app build 318
- Не любит дробить deploy на шаги — хочет одну cmd-строку
- Использует cmd.exe (Windows), не PowerShell
- Кеш плагинов в Lampa живёт долго — каждое обновление требует cache-bust в URL (`?v=NNN`)
- Не хочет CUB-sync — у него своя Trakt-based будет (это ты)
- Не использует kinopub web-UI настройки активно — но всё равно их уважает (мы НЕ форсим device settings из плагина)
- Любит чёткое визуальное разделение состояний (focus/active/watched), плотный UI без лишних воздухов
- Hardcore про производительность плеера — playlist navigation, soft-swap, всё должно работать быстро и без мигания

---

## 17. План для Trakt sync — что я бы делал

(Это не директива, просто моё мнение):

1. Device Flow auth (как у kinopub) — UI: показать код, кнопку «открыл, ввёл», пока polling
2. Storage credentials → Lampa.Storage
3. Hook на `Player/start` + `PlayerVideo/timeupdate` (throttled) → POST /scrobble/start, /scrobble/pause
4. На `Player/destroy` → POST /scrobble/stop с финальным progress
5. На `full/complite` → POST /search/tmdb или GET /show/{id} → mapping cache
6. Setting: enable/disable scrobbling, manual sync watched, re-auth, account info
7. Watchlist sync (GET /sync/watchlist) → отображать в Lampa Favorites или своём listе

**Не делай Phase B-style mid-stream tricks с плеером** — наш kinopub соурс это делает (audio track switching), и это была боль на Tizen. Для Trakt тебе достаточно слушать events, не вмешиваться в плеер.

---

## 18. Контакт и debug

- Repo plugin'а: <твой-гит-репо>/<плагин>.js  
- Логирующий сервер: см. log-server в kp.js (можно переиспользовать тот же)
- Тестировать на Tizen: deploy через GitHub Pages → cache-bust ?v= → переустановить плагин в Lampa Settings → Plugins
- DevTools на ПК: `https://<github-pages>/your-plugin.js` через PWA-версию Lampa (`http://lampa.mx`) — там есть Chrome DevTools, Network, Console. На Tizen DevTools НЕТ, только удалённый лог.

Удачи! Если упрёшься в какую-то Lampa-специфичную странность — спроси Eugene или почитай `docs/kp.js`, скорее всего паттерн уже есть.
