# Lampa kinopub plugin

Плагин-источник видео [kinopub](https://kino.pub) для медиацентра [Lampa](https://github.com/yumata/lampa). Ориентирован на Samsung Tizen (Tizen TV), работает также на webOS, Android и в браузере.

## Установка

Прямая ссылка плагина:

```
https://mainsync-afk.github.io/lampa_kinopub/kp.js
```

В Lampa: Настройки → Расширения → Добавить плагин → вставить URL → Сохранить.

## Авторизация

При первом запуске плагин показывает Device Flow код kinopub — открыть [kino.pub/device](https://kino.pub/device) на телефоне или ПК, ввести код, и плагин автоматически продолжит работу.

## Настройки

`Настройки → KinoPub`:

| Поле                | Назначение |
|---------------------|------------|
| URL лог-сервера     | Адрес [log-server](./log-server/) для удалённых логов с ТВ |
| Макс. качество      | Верхняя граница потока |
| Формат потока       | http / hls / hls2 / hls4 / авто |
| CORS-прокси         | Опционально, на Tizen не нужен |
| Авторизоваться      | Открыть окно с кодом для kino.pub/device |
| Выйти из аккаунта   | Удалить токены |

## Лог-сервер

`log-server/` — мини Node.js сервер для приёма JSON-логов от плагина. См. [log-server/README.md](./log-server/README.md).

## Структура

```
.
├─ github/        # содержимое GitHub Pages (kp.js, index.html)
│  └─ kp.js       # сам плагин
├─ log-server/    # мини HTTP сервер для удалённого логирования
└─ filmix.js      # рабочий пример другого источника (для сверки API Lampa)
```

## Лицензия

MIT (плагин). Плагин не аффилирован с kinopub. Используется публичный xbmc-клиент Device Flow OAuth, известный сообществу неофициальных клиентов.
