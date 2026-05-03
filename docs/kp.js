/*!
 * kp.js — kinopub source plugin for Lampa
 *
 * Author: mainsync-afk
 * Repo:   https://github.com/mainsync-afk/lampa_kinopub
 * URL:    https://mainsync-afk.github.io/lampa_kinopub/kp.js
 *
 * Targets: Samsung Tizen (primary), webOS, Android, browser.
 * Plays through Lampa's built-in HTML5 player and Tizen AVPlayer.
 *
 * Logs are streamed to a remote log-server (see log-server/server.js)
 * when its URL is set in plugin settings.
 */
(function () {
  'use strict';

  if (window.online_kp_plugin) return;
  if (typeof Lampa === 'undefined' || !Lampa.Manifest) return;
  if (Lampa.Manifest.app_digital && Lampa.Manifest.app_digital < 155) return;
  window.online_kp_plugin = true;

  /* ============================================================ *
   *  CONSTANTS                                                   *
   * ============================================================ */

  var PLUGIN_VERSION  = '1.0.24';
  var COMPONENT_NAME  = 'online_kp';
  var BALANSER        = 'kpapi';

  // OAuth credentials of the public xbmc/Kodi-style client used by
  // virtually every unofficial kinopub client. Documented in many
  // open-source projects (kodi.kino.pub, kinopub.webos, etc).
  var CLIENT_ID       = 'xbmc';
  var CLIENT_SECRET   = 'cgg3gtifu46urtfp2zp1nqtba0k2ezxh';

  var API_HOST        = 'https://api.service-kp.com';
  var DEVICE_PAGE     = 'https://kino.pub/device';

  // Storage keys
  var KEY_TOKEN       = 'kp_token';
  var KEY_REFRESH     = 'kp_refresh';
  var KEY_LOG_URL     = 'kp_log_url';
  var KEY_MAX_QUAL    = 'kp_max_quality';
  var KEY_FORMAT      = 'kp_format';
  var KEY_PROXY       = 'kp_proxy';
  var KEY_SUBS        = 'kp_subtitles_enabled';

  /* ============================================================ *
   *  LOGGER                                                      *
   *  - prints to console with [KP:tag] prefix                    *
   *  - batches records and POSTs to remote log-server            *
   * ============================================================ */

  var Logger = (function () {
    var sessionId = (Lampa.Utils && Lampa.Utils.uid) ? Lampa.Utils.uid(8)
                                                     : Math.random().toString(36).slice(2, 10);
    var queue       = [];
    var maxQueue    = 500;
    var endpoint    = '';
    var flushing    = false;
    var flushTimer  = null;
    var FLUSH_DELAY = 250; // fast flush so we don't miss player error bursts

    function readEndpoint() {
      var v = Lampa.Storage.get(KEY_LOG_URL, '') || '';
      endpoint = String(v).replace(/\/+$/, '');
    }

    function platform() {
      try {
        if (Lampa.Platform.is('tizen'))   return 'tizen';
        if (Lampa.Platform.is('webos'))   return 'webos';
        if (Lampa.Platform.is('android')) return 'android';
        if (Lampa.Platform.is('apple_tv')) return 'apple_tv';
        if (Lampa.Platform.is('apple'))   return 'apple';
      } catch (e) {}
      return 'browser';
    }

    function safeData(v) {
      if (v === undefined) return undefined;
      try { return JSON.parse(JSON.stringify(v)); }
      catch (e) { try { return String(v); } catch (e2) { return null; } }
    }

    function consolePrint(level, tag, message, data) {
      try {
        var prefix = '[KP:' + tag + ']';
        var args   = data === undefined ? [prefix, message] : [prefix, message, data];
        if      (level === 'error' && console.error) console.error.apply(console, args);
        else if (level === 'warn'  && console.warn)  console.warn.apply(console, args);
        else                                          console.log.apply(console, args);
      } catch (e) { /* ignore */ }
    }

    function add(level, tag, message, data) {
      var rec = {
        session: sessionId,
        plat:    platform(),
        level:   level,
        ts:      Date.now(),
        tag:     tag,
        message: message
      };
      var safe = safeData(data);
      if (safe !== undefined) rec.data = safe;

      consolePrint(level, tag, message, data);

      if (!endpoint) return;
      queue.push(rec);
      if (queue.length > maxQueue) queue.splice(0, queue.length - maxQueue);
      schedule();
    }

    function schedule() {
      if (flushTimer || flushing || !endpoint) return;
      flushTimer = setTimeout(flush, FLUSH_DELAY);
    }

    function flush() {
      flushTimer = null;
      if (flushing || !endpoint || queue.length === 0) return;
      flushing = true;

      var batch = queue.slice();
      try {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', endpoint + '/logs', true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.timeout = 6000;
        xhr.onreadystatechange = function () {
          if (xhr.readyState !== 4) return;
          flushing = false;
          if (xhr.status >= 200 && xhr.status < 300) {
            queue.splice(0, batch.length);
          }
          if (queue.length > 0 && endpoint) schedule();
        };
        xhr.ontimeout = function () { flushing = false; };
        xhr.onerror   = function () { flushing = false; };
        xhr.send(JSON.stringify(batch));
      } catch (e) {
        flushing = false;
      }
    }

    readEndpoint();

    return {
      debug:   function (tag, msg, data) { add('debug', tag, msg, data); },
      info:    function (tag, msg, data) { add('info',  tag, msg, data); },
      warn:    function (tag, msg, data) { add('warn',  tag, msg, data); },
      error:   function (tag, msg, data) { add('error', tag, msg, data); },
      reload:  readEndpoint,
      session: function () { return sessionId; },
      flush:   flush
    };
  })();

  // global error capture from anywhere in the plugin
  window.addEventListener('error', function (ev) {
    if (!ev || !ev.message) return;
    if (String(ev.message).indexOf('KP') === -1 &&
        String(ev.filename || '').indexOf('kp.js') === -1) return;
    Logger.error('window', ev.message, {
      file: ev.filename, line: ev.lineno, col: ev.colno
    });
  });

  // hook console.error/warn/log so HLS / video / network errors that bubble
  // through hls.js or Tizen AVPlayer get forwarded to our remote log.
  (function () {
    var origError = console.error;
    var origWarn  = console.warn;
    var origLog   = console.log;
    var KEEP = /hls|video|m3u8|cdn|player|tizen|avplay|networkerror|levelloaderror|fragloaderror|manifestloaderror|mediaerror|bufferappenderror|audiocodec|videocodec|fmp4|fragmented|track|src|fetch|xhr|ajax|cors|origin|kinopub|kp/i;
    function format(args) {
      try {
        return Array.prototype.slice.call(args).map(function (a) {
          if (a == null) return String(a);
          if (typeof a === 'string') return a;
          if (a instanceof Error) return a.name + ': ' + a.message;
          try { return JSON.stringify(a); } catch (e) { return String(a); }
        }).join(' ');
      } catch (e) { return ''; }
    }
    // ALL console.error reports (no filter — errors are rare, want every one)
    console.error = function () {
      try {
        var m = format(arguments);
        // skip our own [KP:...] log echoes to avoid feedback
        if (m.indexOf('[KP:') !== 0) Logger.error('console', m.slice(0, 1000));
      } catch (e) {}
      return origError.apply(console, arguments);
    };
    console.warn = function () {
      try {
        var m = format(arguments);
        if (m.indexOf('[KP:') !== 0 && KEEP.test(m)) {
          Logger.warn('console', m.slice(0, 1000));
        }
      } catch (e) {}
      return origWarn.apply(console, arguments);
    };
    // log filter is strict — too noisy otherwise
    console.log = function () {
      try {
        var m = format(arguments);
        if (m.indexOf('[KP:') !== 0 && KEEP.test(m)) {
          Logger.debug('console', m.slice(0, 1000));
        }
      } catch (e) {}
      return origLog.apply(console, arguments);
    };
  })();

  Logger.info('boot', 'kp.js v' + PLUGIN_VERSION + ' starting', {
    session: Logger.session(),
    app: Lampa.Manifest.app_digital,
    ua: navigator.userAgent
  });

  /* ============================================================ *
   *  KINOPUB API                                                 *
   * ============================================================ */

  var KP = (function () {

    function tokenAccess()  { return Lampa.Storage.get(KEY_TOKEN, ''); }
    function tokenRefresh() { return Lampa.Storage.get(KEY_REFRESH, ''); }

    function setTokens(access, refresh) {
      Lampa.Storage.set(KEY_TOKEN, access || '');
      if (refresh) Lampa.Storage.set(KEY_REFRESH, refresh);
    }
    function clearTokens() {
      Lampa.Storage.set(KEY_TOKEN, '');
      Lampa.Storage.set(KEY_REFRESH, '');
    }

    function proxify(url) {
      var p = (Lampa.Storage.get(KEY_PROXY, '') || '').replace(/\/+$/, '');
      if (!p) return url;
      // append URL — most CORS-proxies accept this format (cors.byskaz.ru/<full_url>)
      return p + '/' + url;
    }

    function commonForm(extra) {
      var s = 'client_id=' + encodeURIComponent(CLIENT_ID) +
              '&client_secret=' + encodeURIComponent(CLIENT_SECRET);
      if (extra) s += '&' + extra;
      return s;
    }

    /**
     * Use Lampa.Reguest if a network is supplied, so that network.clear() in the
     * source can cancel pending kinopub requests on destroy/back. Falls back to
     * a temporary network when none provided (e.g. background profile check).
     */
    function call(method, url, postData, headers, network, success, error, timeoutMs) {
      var net = network || new Lampa.Reguest();
      net.timeout(timeoutMs || 15000);

      var params = { headers: headers || {} };
      if (method === 'POST') {
        // Lampa.Reguest treats post_data argument as POST body and forces method=POST
      }

      var fullUrl = proxify(url);

      // .silent(url, complite, error, post_data?, params?) — params.headers supported.
      net.silent(fullUrl, function (json) {
        success(json);
      }, function (xhr, status) {
        error(xhr || {}, status);
      }, postData || false, params);
    }

    function deviceCode(network, success, error) {
      Logger.info('auth', 'POST /oauth2/device grant=device_code');
      call('POST', API_HOST + '/oauth2/device',
        commonForm('grant_type=device_code'),
        { 'Content-Type': 'application/x-www-form-urlencoded' },
        network,
        function (json) {
          // Lampa.Reguest may already parse JSON; tolerate both
          if (typeof json === 'string') { try { json = JSON.parse(json); } catch (e) {} }
          if (json && json.code) {
            Logger.info('auth', 'device code received', {
              user_code: json.user_code, expires_in: json.expires_in, interval: json.interval
            });
            success(json);
          } else {
            Logger.error('auth', 'device code unexpected response', json);
            error({}, 'bad_response');
          }
        },
        function (xhr, status) {
          Logger.error('auth', 'device code error', { http: xhr && xhr.status, status: status });
          error(xhr, status);
        },
        15000
      );
    }

    function pollDeviceToken(network, code, success, pending, error) {
      call('POST', API_HOST + '/oauth2/device',
        commonForm('grant_type=device_token&code=' + encodeURIComponent(code)),
        { 'Content-Type': 'application/x-www-form-urlencoded' },
        network,
        function (json) {
          if (typeof json === 'string') { try { json = JSON.parse(json); } catch (e) {} }
          if (json && json.access_token) {
            Logger.info('auth', 'access_token received');
            setTokens(json.access_token, json.refresh_token);
            success(json);
          } else if (json && (json.error === 'authorization_pending' || json.error === 'slow_down')) {
            pending();
          } else {
            Logger.warn('auth', 'unexpected device_token response', json);
            pending();
          }
        },
        function (xhr, status) {
          var resp = null;
          try { resp = JSON.parse(xhr && xhr.responseText || ''); } catch (e) {}
          if (resp && (resp.error === 'authorization_pending' || resp.error === 'slow_down')) {
            pending();
          } else {
            Logger.error('auth', 'device_token error', { http: xhr && xhr.status, status: status, body: resp });
            error(xhr, status);
          }
        },
        10000
      );
    }

    function refresh(network, success, error) {
      var rt = tokenRefresh();
      if (!rt) {
        Logger.warn('auth', 'no refresh token');
        if (error) error({}, 'no_refresh_token');
        return;
      }
      Logger.info('auth', 'POST /oauth2/token refresh');
      call('POST', API_HOST + '/oauth2/token',
        commonForm('grant_type=refresh_token&refresh_token=' + encodeURIComponent(rt)),
        { 'Content-Type': 'application/x-www-form-urlencoded' },
        network,
        function (json) {
          if (typeof json === 'string') { try { json = JSON.parse(json); } catch (e) {} }
          if (json && json.access_token) {
            setTokens(json.access_token, json.refresh_token);
            Logger.info('auth', 'token refreshed');
            success(json);
          } else {
            Logger.error('auth', 'refresh empty response', json);
            if (error) error({}, 'empty');
          }
        },
        function (xhr, status) {
          Logger.error('auth', 'refresh failed', { http: xhr && xhr.status, status: status });
          if (error) error(xhr, status);
        },
        10000
      );
    }

    /**
     * Authenticated GET against /v1/...
     * Auto-refreshes the token once on 401. The `_retried` flag prevents infinite
     * recursion if the refreshed token keeps getting rejected.
     */
    function api(network, path, params, success, error, _retried) {
      var qs = '';
      if (params) {
        var parts = [];
        for (var k in params) {
          if (params.hasOwnProperty(k) && params[k] !== undefined && params[k] !== null) {
            parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
          }
        }
        if (parts.length) qs = '?' + parts.join('&');
      }
      var url = API_HOST + '/v1' + path + qs;
      var t = tokenAccess();
      if (!t) {
        Logger.warn('api', 'no token', { path: path });
        if (error) error({ status: 401 }, 'no_token');
        return;
      }
      Logger.debug('api', 'GET ' + path, params);

      call('GET', url, false,
        { 'Authorization': 'Bearer ' + t },
        network,
        function (json) {
          Logger.debug('api', 'GET ' + path + ' ok');
          success(json);
        },
        function (xhr, status) {
          Logger.warn('api', 'GET ' + path + ' err', {
            http: xhr && xhr.status, status: status,
            body: (xhr && xhr.responseText || '').slice(0, 200)
          });
          if (xhr && xhr.status === 401 && !_retried) {
            refresh(network, function () {
              api(network, path, params, success, error, true);
            }, function () {
              clearTokens();
              if (error) error(xhr, status);
            });
          } else {
            if (error) error(xhr, status);
          }
        },
        20000
      );
    }

    /**
     * Authenticated POST against /v1/...
     * Used for settings updates. Body is x-www-form-urlencoded.
     */
    function apiPost(network, path, body, success, error, _retried) {
      var url = API_HOST + '/v1' + path;
      var t = tokenAccess();
      if (!t) {
        Logger.warn('api', 'no token', { path: path });
        if (error) error({ status: 401 }, 'no_token');
        return;
      }
      var bodyStr = '';
      if (body && typeof body === 'object') {
        var parts = [];
        for (var k in body) {
          if (body.hasOwnProperty(k) && body[k] !== undefined && body[k] !== null) {
            parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(body[k]));
          }
        }
        bodyStr = parts.join('&');
      } else {
        bodyStr = String(body || '');
      }
      Logger.debug('api', 'POST ' + path, body);

      call('POST', url, bodyStr,
        { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/x-www-form-urlencoded' },
        network,
        function (json) { Logger.debug('api', 'POST ' + path + ' ok'); success(json); },
        function (xhr, status) {
          Logger.warn('api', 'POST ' + path + ' err', { http: xhr && xhr.status, status: status });
          if (xhr && xhr.status === 401 && !_retried) {
            refresh(network, function () {
              apiPost(network, path, body, success, error, true);
            }, function () {
              clearTokens();
              if (error) error(xhr, status);
            });
          } else {
            if (error) error(xhr, status);
          }
        },
        15000
      );
    }

    return {
      tokenAccess:     tokenAccess,
      hasToken:        function () { return !!tokenAccess(); },
      clearTokens:     clearTokens,
      deviceCode:      deviceCode,
      pollDeviceToken: pollDeviceToken,
      refresh:         refresh,
      search: function (network, query, type, ok, err) {
        // /v1/items/search?q=&field=title is the proper endpoint per kinoapi.com.
        // /v1/items expects browsing-style filters (genre/year/etc), not a fulltext q.
        var params = { q: query, field: 'title', perpage: 50 };
        if (type) params.type = type;
        api(network, '/items/search', params, ok, err);
      },
      item: function (network, id, ok, err) {
        api(network, '/items/' + id, null, ok, err);
      },
      profile: function (network, ok, err) {
        api(network, '/user', null, ok, err);
      },
      deviceInfo: function (network, ok, err) {
        api(network, '/device/info', null, ok, err);
      },
      serverLocations: function (network, ok, err) {
        api(network, '/references/server-location', null, ok, err);
      },
      saveDeviceSettings: function (network, deviceId, settings, ok, err) {
        apiPost(network, '/device/' + deviceId + '/settings', settings, ok, err);
      },
      deviceNotify: function (network, info, ok, err) {
        // POST form-encoded title/hardware/software — kinoapi.com docs say
        // "call after auth and on every plugin start"
        apiPost(network, '/device/notify', info, ok, err);
      }
    };
  })();

  /* ============================================================ *
   *  HELPERS                                                     *
   * ============================================================ */

  /**
   * Build device identification fields for kinopub /v1/device/notify.
   * Without this call kinopub UI shows three "unknown" lines.
   */
  function detectDeviceInfo() {
    var ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    var platform = 'browser';
    var hardware = 'Web Browser';
    var title    = 'Lampa';

    try {
      if (Lampa.Platform.is('tizen')) {
        platform = 'tizen';
        var mt = ua.match(/Tizen\s+([\d.]+)/i);
        hardware = 'Samsung Tizen' + (mt ? ' ' + mt[1] : '');
        title = 'Lampa (Samsung TV)';
      } else if (Lampa.Platform.is('webos')) {
        platform = 'webos';
        var mw = ua.match(/Web0?[Oo]s\D*(\d+(?:\.\d+)?)/i) || ua.match(/webOS\.TV-(\d+)/i);
        hardware = 'LG webOS' + (mw ? ' ' + mw[1] : '');
        title = 'Lampa (LG TV)';
      } else if (Lampa.Platform.is('android')) {
        platform = 'android';
        var ma = ua.match(/Android\s+([\d.]+)/i);
        hardware = 'Android' + (ma ? ' ' + ma[1] : '');
        title = 'Lampa (Android)';
      } else if (Lampa.Platform.is('apple_tv')) {
        platform = 'apple_tv';
        hardware = 'Apple TV';
        title = 'Lampa (Apple TV)';
      } else if (Lampa.Platform.is('apple')) {
        platform = 'ios';
        var mi = ua.match(/OS\s+([\d_]+)/i);
        hardware = 'iOS' + (mi ? ' ' + mi[1].replace(/_/g, '.') : '');
        title = 'Lampa (iOS)';
      } else {
        var br = ua.match(/(Edg|Chrome|Firefox|Safari|Opera)\/([\d.]+)/);
        hardware = br ? br[1].replace('Edg', 'Edge') + ' ' + br[2] : 'Web Browser';
        title = 'Lampa (' + hardware + ')';
      }
    } catch (e) { /* keep defaults */ }

    var lampaVer = (Lampa.Manifest && Lampa.Manifest.app_digital)
      ? 'Lampa ' + Lampa.Manifest.app_digital
      : 'Lampa';
    var software = 'kp.js ' + PLUGIN_VERSION + ' / ' + lampaVer;

    return { title: title, hardware: hardware, software: software, _platform: platform };
  }

  /**
   * Send identity to kinopub. Idempotent — fine to call on every startup.
   * Failures are logged but never blocked further work.
   */
  function notifyDeviceIdentity(network) {
    if (!KP.hasToken()) return;
    var info = detectDeviceInfo();
    Logger.info('identity', 'sending /device/notify', info);
    KP.deviceNotify(network, {
      title:    info.title,
      hardware: info.hardware,
      software: info.software
    }, function (resp) {
      Logger.info('identity', 'notify ok', resp);
    }, function (xhr, status) {
      Logger.warn('identity', 'notify failed', { http: xhr && xhr.status, status: status });
    });
  }

  function maxQuality() {
    var q = parseInt(Lampa.Storage.get(KEY_MAX_QUAL, '1080'), 10);
    return q > 0 ? q : 1080;
  }

  // Per-launch override (set from contextmenu "try in different format").
  // Null means: fall back to user's saved KEY_FORMAT setting.
  var formatOverride = null;
  var lastAutoFormatLogKey = null;

  // Voice/audio-track state. When kpapi builds a play-element it sets
  // pendingVoice = { idx, label }. The PlayerVideo.canplay hook below consumes
  // it and calls the underlying player API to switch to that audio track,
  // without restarting the stream. This is what makes voice selection (made in
  // the source filter) actually take effect on Tizen / hls.js.
  var pendingVoice = null;

  // The currently active voice label, kept fresh whenever toPlayElement runs.
  // Used by setupNextEpisodeLabelOverride() to repaint the
  // `.player-panel__next-episode-name` DOM with the voice instead of the
  // next-episode title (per user request — that hint is more useful here).
  var currentVoiceLabel = '';

  /**
   * Applies an audio-track switch on the currently active player. Idempotent —
   * safe to call multiple times. Returns true if a backend handled it.
   *
   * Tizen native: webapis.avplay.setSelectTrack('AUDIO', native_idx)
   * HTML5 + hls.js: hls.audioTrack = idx (Lampa might not expose hls instance,
   *   we try a few common attachment patterns)
   */
  function applyVoiceTrack(idx) {
    if (idx == null || idx < 0) return false;

    // ── Tizen native AVPlayer ─────────────────────────────────────────
    try {
      if (window.webapis && window.webapis.avplay && typeof window.webapis.avplay.getTotalTrackInfo === 'function') {
        var tracks = window.webapis.avplay.getTotalTrackInfo() || [];
        var audios = [];
        for (var i = 0; i < tracks.length; i++) {
          if (tracks[i] && (tracks[i].type === 'AUDIO' || tracks[i].type === 1)) {
            audios.push(tracks[i]);
          }
        }
        if (idx < audios.length) {
          var nativeIdx = (audios[idx].index != null) ? audios[idx].index : idx;
          window.webapis.avplay.setSelectTrack('AUDIO', nativeIdx);
          Logger.info('voice', 'switched via avplay', {
            idx: idx, nativeIdx: nativeIdx, total: audios.length
          });
          return true;
        }
        Logger.warn('voice', 'avplay: idx out of range', { idx: idx, total: audios.length });
      }
    } catch (e) {
      Logger.warn('voice', 'avplay setSelectTrack failed', String(e));
    }

    // ── HTML5 / hls.js ────────────────────────────────────────────────
    try {
      var video = document.querySelector('video');
      if (video) {
        // Try common attachment patterns. Lampa's bundle may not expose hls,
        // in which case this fails silently and the stream plays in default
        // audio track.
        var hls = video.__hls__ || video._hls || video.hls ||
                  (window.Lampa && window.Lampa.PlayerVideo && window.Lampa.PlayerVideo.hls);
        if (hls && typeof hls.audioTrack !== 'undefined') {
          hls.audioTrack = idx;
          Logger.info('voice', 'switched via hls.js', { idx: idx });
          return true;
        }
        // Native HTMLMediaElement.audioTracks (rare on TVs but spec'd)
        if (video.audioTracks && video.audioTracks.length > idx) {
          for (var t = 0; t < video.audioTracks.length; t++) {
            video.audioTracks[t].enabled = (t === idx);
          }
          Logger.info('voice', 'switched via HTMLMediaElement.audioTracks', { idx: idx });
          return true;
        }
      }
    } catch (e) {
      Logger.warn('voice', 'hls.js audioTrack failed', String(e));
    }

    Logger.warn('voice', 'no track switch backend available, stream stays on default audio');
    return false;
  }

  /* ============================================================ *
   *  PHASE B — in-player voice switching                         *
   *                                                              *
   *  Lets the user pick a different audio track from the player  *
   *  UI itself (Lampa's voice button), without restarting the    *
   *  stream.                                                     *
   *                                                              *
   *  Mechanics: each voiceover entry in play.voiceovers[] gets   *
   *  an `onSelect(item)` callback. When user clicks it, Lampa's  *
   *  PlayerPanel calls our onSelect (see L7855 in Lampa source). *
   *  Inside the callback we call applyVoiceTrack(idx) — direct   *
   *  webapis.avplay.setSelectTrack — and sync source state via   *
   *  syncVoiceToSource. No URL trick / monkey-patch needed.      *
   *                                                              *
   *  Source kpapi exposes applyExternalVoiceChange(key,label) so *
   *  the callback can update the filter sidebar + DOM chips.     *
   *  window._kpCurrentSource is set/cleared by source on         *
   *  create/destroy.                                             *
   * ============================================================ */

  function syncVoiceToSource(key, label) {
    try {
      if (window._kpCurrentSource && window._kpCurrentSource.applyExternalVoiceChange) {
        window._kpCurrentSource.applyExternalVoiceChange(key, label);
        return;
      }
    } catch (e) {
      Logger.warn('phase-b', 'source sync failed', String(e));
    }
    // Fallback: just refresh visible chip DOM with forced active key
    try { refreshAllKpVoiceChips(key); } catch (e) {}
  }

  /**
   * Replaces the text of `.player-panel__next-episode-name` (where Lampa shows
   * "next episode title" hint near next/prev buttons) with the current voice
   * label. Per Eugene's request: that area is more useful for showing which
   * voice/dub is currently active than for previewing the next episode title
   * (which is already in the playlist popup).
   *
   * Implemented via MutationObserver because Lampa re-sets the text every time
   * PlayerPlaylist.set() fires — without observing we'd lose the override on
   * any playlist refresh / next-prev navigation.
   */
  var nextLabelObserver = null;
  function setupNextEpisodeLabelOverride() {
    cleanupNextEpisodeLabelOverride(); // ensure single instance

    setTimeout(function () {
      var el = document.querySelector('.player-panel__next-episode-name');
      if (!el) {
        Logger.warn('player-ui', '.player-panel__next-episode-name not found in DOM (Lampa version may differ)');
        return;
      }

      function applyLabel() {
        if (!currentVoiceLabel) return;
        if (el.textContent === currentVoiceLabel) return;
        el.textContent = currentVoiceLabel;
        // ensure not hidden — Lampa hides this element when there's no next ep
        try { el.classList.remove('hide'); } catch (e) {}
      }

      applyLabel();

      try {
        nextLabelObserver = new MutationObserver(function () {
          // defer to let Lampa's update settle, then override
          setTimeout(applyLabel, 0);
        });
        nextLabelObserver.observe(el, {
          childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class']
        });
        Logger.info('player-ui', 'next-episode-name override active', { label: currentVoiceLabel });
      } catch (e) {
        Logger.warn('player-ui', 'MutationObserver setup failed', String(e));
      }
    }, 150);
  }

  function cleanupNextEpisodeLabelOverride() {
    if (nextLabelObserver) {
      try { nextLabelObserver.disconnect(); } catch (e) {}
      nextLabelObserver = null;
    }
  }

  /**
   * Returns the active Lampa player choice: 'tizen', 'lampa', 'inner', 'webos',
   * 'android', or '' if not set. Used by `auto` format resolution.
   */
  function detectActualPlayer() {
    try {
      var v = '';
      if (typeof Lampa.Storage.field === 'function') v = Lampa.Storage.field('player');
      if (!v) v = Lampa.Storage.get('player', '');
      return String(v || '').toLowerCase();
    } catch (e) { return ''; }
  }

  /**
   * Resolves the URL field key (http|hls|hls2|hls4) to use when picking a stream.
   *
   * The `auto` mode is a smart default that picks based on which player the user
   * has chosen in Lampa settings:
   *   - Tizen native AVPlayer handles HLS4 / fMP4 perfectly + exposes embedded
   *     audio tracks via webapis.avplay → use `hls4` (full 4K + voice support)
   *   - Lampa built-in HTML5 player uses an old hls.js bundled with Lampa that
   *     chokes on fMP4 segments regardless of codec → use `hls2` (TS) which
   *     hls.js handles reliably
   */
  function preferredFormat() {
    if (formatOverride) return formatOverride;
    var setting = Lampa.Storage.get(KEY_FORMAT, 'auto');
    if (setting && setting !== 'auto') return setting;

    var player = detectActualPlayer();
    var resolved = (player === 'tizen') ? 'hls4' : 'hls2';
    var key = player + '|' + resolved;
    if (lastAutoFormatLogKey !== key) {
      Logger.info('format', 'auto resolved', { player: player || '(default)', format: resolved });
      lastAutoFormatLogKey = key;
    }
    return resolved;
  }

  function normalize(s) {
    s = String(s || '');
    // strip latin diacritics ("Léon" -> "Leon") if NFD is supported
    try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) {}
    return s.toLowerCase().replace(/[^a-zЀ-ӿ0-9]/g, '');
  }

  /**
   * Pull a codec/format string from a kinopub audio entry. Different fields
   * have shown up across content: `codec`, `format.title`, `audio_codec`.
   */
  function audioCodec(a) {
    if (!a) return '';
    if (typeof a.codec === 'string') return a.codec;
    if (a.format && a.format.title)  return a.format.title;
    if (typeof a.audio_codec === 'string') return a.audio_codec;
    return '';
  }

  /**
   * Stable identifier for a kinopub audio track. Combines lang + type + author
   * + codec so that AC3 vs AAC variants of the same dub stay distinct.
   * Used as canonical "voice" handle in filter / storage.
   */
  function voiceKey(a) {
    if (!a) return '';
    var t  = (a.type   && a.type.title)   || '';
    var au = (a.author && a.author.title) || '';
    var c  = audioCodec(a);
    return (a.lang || '') + '|' + t + '|' + au + '|' + c;
  }

  /**
   * "Chip-level" key — like voiceKey but WITHOUT codec. Used to dedupe chips
   * on episode cards: AAC and AC3 variants of the same dub collapse into one
   * chip (cleaner UI), and the chip is "active" if EITHER variant is the
   * current voice_key in storage.
   */
  function chipKey(a) {
    if (!a) return '';
    var t  = (a.type   && a.type.title)   || '';
    var au = (a.author && a.author.title) || '';
    return (a.lang || '') + '|' + t + '|' + au;
  }

  /**
   * Studios → short abbreviations for the chip badges on episode cards.
   * Unknown studios get an auto-fallback (first letters of words, then
   * first 4 chars).
   */
  var STUDIO_ABBR = {
    'AlexFilm':       'AF',
    'TVShows':        'TVS',
    'LostFilm':       'LF',
    'LE-Production':  'LE',
    'Red Head Sound': 'RHS',
    '1W':             '1W',
    'Кубик в Кубе':   'КвК',
    'Selena':         'SLN',
    'Fox Crime':      'FxC',
    'Foxlight':       'FxL'
  };

  /**
   * Voice TYPE → short label, used when there's no author and kinopub didn't
   * supply a `short_title` for the type.
   */
  var TYPE_SHORT = {
    'Многоголосый':       'MVO',
    'Двухголосый':        'DVO',
    'Одноголосый':        'AVO',
    'Дубляж':             'Дуб',
    'Оригинал':           'Orig',
    'Авторский':          'Авт',
    'Профессиональный':   'Pro'
  };

  /**
   * Voices matching ANY of these patterns are hidden from BOTH the source
   * filter sidebar AND the per-episode chips. Eugene's preference list.
   */
  var VOICE_HIDDEN_GLOBAL = [/UKR/i, /Пучков/i];

  /**
   * Hidden ONLY on episode cards (still pickable in sidebar filter — user can
   * select a "single-voice" / "auteur" / "original" track if they really want).
   */
  var VOICE_HIDDEN_CARDS = [/Одноголосый/i, /Авторский/i, /Оригинал/i];

  function audioCheckString(a) {
    if (!a) return '';
    return [
      a.lang || '',
      (a.type   && a.type.title)   || '',
      (a.author && a.author.title) || ''
    ].join(' ');
  }

  /**
   * Returns whether an audio track should appear in given context.
   * @param context 'sidebar' or 'card'
   */
  function isVoiceVisible(a, context) {
    var s = audioCheckString(a);
    for (var i = 0; i < VOICE_HIDDEN_GLOBAL.length; i++) {
      if (VOICE_HIDDEN_GLOBAL[i].test(s)) return false;
    }
    if (context === 'card') {
      for (var j = 0; j < VOICE_HIDDEN_CARDS.length; j++) {
        if (VOICE_HIDDEN_CARDS[j].test(s)) return false;
      }
    }
    return true;
  }

  /**
   * Short author/studio name. Uses STUDIO_ABBR map first, then auto-derives:
   *   "Red Head Sound" → "RHS" (initials, 2-4 words)
   *   "MyDubbingStudio" → "MyDu" (first 4 chars, single word)
   */
  function studioAbbr(name) {
    if (!name) return '';
    if (STUDIO_ABBR[name]) return STUDIO_ABBR[name];
    var words = String(name).split(/[\s\-.]+/).filter(Boolean);
    if (words.length >= 2 && words.length <= 4) {
      return words.map(function (w) { return w.charAt(0).toUpperCase(); }).join('');
    }
    return name.substring(0, 4);
  }

  /**
   * Build a single voice chip's textual content (just the inner label, no
   * HTML wrapper). Codec is INTENTIONALLY not appended — AAC and AC3 variants
   * of the same dub are grouped into a single chip (deduped by chipKey).
   *   <studio-or-type>[ <LANG>]
   * Examples: "AF", "AF EN", "MVO", "Orig EN".
   */
  function voiceChipText(a) {
    if (!a) return '?';
    var author = (a.author && a.author.title) || '';
    var typeShort = (a.type && a.type.short_title) || '';
    var typeFull  = (a.type && a.type.title) || '';

    var primary;
    if (author) primary = studioAbbr(author);
    else if (typeShort) primary = typeShort;
    else if (typeFull)  primary = TYPE_SHORT[typeFull] || typeFull.substring(0, 3);
    else primary = '?';

    var lang = (a.lang || '').toUpperCase();
    if (lang && lang !== 'RUS' && lang !== 'RU') {
      primary += ' ' + lang.substring(0, 3);
    }

    return primary;
  }

  /**
   * Build the voice-chips HTML for an episode card.
   *
   * Two indicator states (mutually exclusive, controlled by hasProgress):
   *   hasProgress === false  → chip with `is-active` class for activeKey
   *                            (soft green fill — "what plays if you click")
   *   hasProgress === true   → chip with `is-watched` class for watchedKey
   *                            (gray underline — "you watched this here")
   *
   * Dedupes by chipKey so AAC and AC3 variants of the same dub collapse into
   * one chip; the indicator triggers if EITHER variant matches the relevant
   * key. Card-level visibility filter applied (Оригинал/Одноголосый/Авторский
   * hidden on cards but visible in sidebar).
   */
  function voiceChipsHtml(audios, activeKey, watchedKey, hasProgress) {
    if (!audios || !audios.length) return '';
    var byChip = {};
    var order  = [];
    audios.forEach(function (a) {
      if (!isVoiceVisible(a, 'card')) return;
      var k = chipKey(a);
      if (!byChip[k]) {
        byChip[k] = { audio: a, isActive: false, isWatched: false };
        order.push(k);
      }
      var vk = voiceKey(a);
      if (vk === activeKey)  byChip[k].isActive  = true;
      if (vk === watchedKey) byChip[k].isWatched = true;
    });
    return order.map(function (k) {
      var entry = byChip[k];
      var classes = ['kp-voice-chip'];
      if (hasProgress && entry.isWatched)        classes.push('is-watched');
      else if (!hasProgress && entry.isActive)   classes.push('is-active');
      return '<span class="' + classes.join(' ') + '">' + voiceChipText(entry.audio) + '</span>';
    }).join('');
  }

  /**
   * Re-renders voice chips for every visible episode card. Called on
   * Player/destroy so that episodes which just gained timeline.percent>0
   * switch from green sidebar-pick chip to faded "watched" chip without
   * waiting for the user to leave-and-reenter the source view.
   *
   * Each rendered card has `$(html).data('kp-card', {element, activeVoiceKey})`
   * stashed by component.draw() — we use it to know per-card context.
   */
  function refreshAllKpVoiceChips() {
    try {
      var watchedMap = Lampa.Storage.cache('kp_episode_voice', 5000, {});
      $('.online-prestige').each(function () {
        var $card = $(this);
        var data = $card.data('kp-card');
        if (!data || !data.element) return;
        var $voicesEl = $card.find('.kp-voices');
        if (!$voicesEl.length) return;
        var element = data.element;
        var hasProgress = !!(element.timeline && element.timeline.percent > 0);
        var watchedKey  = watchedMap[element.timeline_hash] || '';
        $voicesEl.html(voiceChipsHtml(
          (element.kp && element.kp.audios) || [],
          data.activeVoiceKey || '',
          watchedKey,
          hasProgress
        ));
      });
    } catch (e) { /* swallow — DOM-state-dependent */ }
  }

  /**
   * Pretty label for an audio track. Prefer kinopub's pre-formatted display
   * field if present (`name` / `title`) — those match the kinopub web UI
   * exactly. Otherwise construct from parts:
   *   "Многоголосый LostFilm [RUS]"
   *   "Многоголосый AlexFilm [RUS] (AC3)"
   *   "Оригинал [ENG]"
   */
  function voiceLabel(a) {
    if (!a) return '';
    // 1) trust kinopub's own display string when API gives one
    if (typeof a.name  === 'string' && a.name.trim())  return a.name.trim();
    if (typeof a.title === 'string' && a.title.trim()) return a.title.trim();
    // 2) construct from parts
    var parts = [];
    if (a.type   && a.type.title)   parts.push(a.type.title);
    if (a.author && a.author.title) parts.push(a.author.title);
    var label = parts.join(' ');
    if (a.lang) {
      label = (label ? label + ' ' : '') + '[' + String(a.lang).toUpperCase() + ']';
    }
    var c = audioCodec(a);
    if (c) {
      label = (label ? label + ' ' : '') + '(' + String(c).toUpperCase() + ')';
    }
    return label || '';
  }

  /**
   * kinopub stores title as "Русское / Original" (single field, separator " / ").
   * Returns { rus, orig }; if no separator found, original is empty.
   */
  function splitKpTitle(t) {
    var s = String(t || '');
    var idx = s.indexOf(' / ');
    if (idx > 0) return { rus: s.slice(0, idx).trim(), orig: s.slice(idx + 3).trim() };
    return { rus: s, orig: '' };
  }

  function parseFiles(files) {
    if (!files || !files.length) return [];
    var arr = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var qs = f && (f.quality || f.q) || '';
      var qn = parseInt(String(qs).replace(/[^0-9]/g, ''), 10) || 0;
      if (!qn) continue;
      arr.push({
        quality: qn,
        label:   qs,
        urls:    f.url || {}
      });
    }
    arr.sort(function (a, b) { return b.quality - a.quality; });
    return arr;
  }

  /**
   * Build a full quality dictionary {"720p": url, "1080p": url, ...}
   * usable by Lampa.Player.play({quality: ...})
   * Plus return the URL for the requested target quality (or the largest available <= maxQuality).
   */
  function pickStream(files, format, target) {
    if (!files || !files.length) return null;
    // 'http' (progressive MP4) is intentionally NOT in any fallback list —
    // it freezes on Tizen players. Real auto resolution happens in
    // preferredFormat() before we get here, so 'auto' is just a defensive default.
    var fmtList = format === 'auto'
      ? ['hls4', 'hls2', 'hls']
      : [format, 'hls4', 'hls2', 'hls'];

    function pickUrl(u) {
      for (var i = 0; i < fmtList.length; i++) {
        var k = fmtList[i];
        if (u && u[k]) return u[k];
      }
      return null;
    }

    var maxQ  = maxQuality();
    var avail = files.filter(function (f) { return f.quality <= maxQ && pickUrl(f.urls); });
    if (!avail.length) avail = files.filter(function (f) { return pickUrl(f.urls); });
    if (!avail.length) return null;

    // sorted desc, so first is largest available
    var best = avail[0];
    if (target) {
      var tn = parseInt(String(target).replace(/[^0-9]/g, ''), 10);
      var pick = avail.find ? avail.find(function (f) { return f.quality === tn; })
                            : null;
      if (pick) best = pick;
    }

    var quality = {};
    avail.forEach(function (f) {
      var u = pickUrl(f.urls);
      if (u) quality[f.quality + 'p'] = u;
    });

    var url = pickUrl(best.urls);

    return {
      url: url,
      quality: quality,
      currentQuality: best.quality,
      label: best.label
    };
  }

  function buildSubtitles(subs) {
    if (!subs || !subs.length) return [];
    return subs.map(function (s) {
      return {
        label: (s.lang || s.title || 'sub') + (s.shift ? ' (' + s.shift + 's)' : ''),
        url:   s.url
      };
    }).filter(function (s) { return !!s.url; });
  }

  function audioInfo(audios) {
    if (!audios || !audios.length) return '';
    var names = [];
    audios.forEach(function (a) {
      var t = (a.lang || '') + (a.type && a.type.title ? ' / ' + a.type.title : '');
      if (a.author && a.author.title) t += ' [' + a.author.title + ']';
      if (t.trim()) names.push(t.trim());
    });
    return names.slice(0, 3).join(', ');
  }

  /* ============================================================ *
   *  REGION SETUP                                                *
   *  kinopub bakes ?loc=<region> into stream URLs based on the   *
   *  device's serverLocation setting. Default for the xbmc       *
   *  client is NL → laggy CDN. We pick a fast region (RU/UA/BY)  *
   *  once after auth and write it back via POST /device/{id}/    *
   *  settings.                                                   *
   * ============================================================ */

  function pickPreferredLocation(items) {
    if (!items || !items.length) return null;
    // Prefer Russia → Ukraine → Belarus, but fall back to anything
    // whose name/location string suggests a CIS host.
    var order = [/^ru$/i, /^ua$/i, /^by$/i, /russ/i, /росс/i, /europe/i];
    for (var p = 0; p < order.length; p++) {
      var rx = order[p];
      for (var i = 0; i < items.length; i++) {
        var l = items[i];
        if (rx.test(l.location || '') || rx.test(l.name || '')) return l;
      }
    }
    return items[0];
  }

  /**
   * Run the full region-fixup pipeline. Idempotent.
   * cb(ok: bool, locationName: string).
   */
  function setupRegion(force, cb) {
    var done = function (ok, name) { try { cb && cb(!!ok, name || ''); } catch (e) {} };

    if (!force && Lampa.Storage.get('kp_region_set', '') === '1') {
      Logger.debug('region', 'already set, skipping');
      return done(true, Lampa.Storage.get('kp_region_name', ''));
    }
    if (!KP.hasToken()) {
      Logger.warn('region', 'no token, skipping');
      return done(false);
    }

    var net = new Lampa.Reguest();
    Logger.info('region', 'setup begin' + (force ? ' (forced)' : ''));

    KP.deviceInfo(net, function (info) {
      // server can return { device: {...} } OR flat { id, hardware, ... }
      var device = (info && info.device) ? info.device : info;
      var deviceId = device && (device.id || device.hardware);
      if (!deviceId) {
        Logger.error('region', 'no device id in /device/info', info);
        return done(false);
      }
      Logger.info('region', 'device id', { id: deviceId });

      KP.serverLocations(net, function (locs) {
        var items = (locs && (locs.items || locs.locations)) || (Array.isArray(locs) ? locs : []);
        if (!items.length) {
          Logger.warn('region', 'no server locations available', locs);
          return done(false);
        }
        Logger.debug('region', 'available locations', items.map(function (l) {
          return { id: l.id, location: l.location, name: l.name };
        }));

        var pick = pickPreferredLocation(items);
        if (!pick) return done(false);

        Logger.info('region', 'picking location', { id: pick.id, name: pick.name, location: pick.location });

        KP.saveDeviceSettings(net, deviceId, { serverLocation: pick.id }, function () {
          Lampa.Storage.set('kp_region_set', '1');
          Lampa.Storage.set('kp_region_name', pick.name || pick.location || '');
          Lampa.Storage.set('kp_region_id', String(pick.id));
          Logger.info('region', 'serverLocation applied', { id: pick.id });
          done(true, pick.name || pick.location || '');
        }, function (xhr, status) {
          Logger.error('region', 'saveDeviceSettings failed', { http: xhr && xhr.status, status: status });
          done(false);
        });
      }, function (xhr, status) {
        Logger.error('region', 'list locations failed', { http: xhr && xhr.status, status: status });
        done(false);
      });
    }, function (xhr, status) {
      Logger.error('region', 'deviceInfo failed', { http: xhr && xhr.status, status: status });
      done(false);
    });
  }

  /* ============================================================ *
   *  AUTH MODAL                                                  *
   * ============================================================ */

  var auth_state = { modalOpen: false, pingTimer: null, network: null };

  function closeAuthModal(reason) {
    if (auth_state.pingTimer) {
      clearInterval(auth_state.pingTimer);
      auth_state.pingTimer = null;
    }
    if (auth_state.network) {
      try { auth_state.network.clear(); } catch (e) {}
      auth_state.network = null;
    }
    if (auth_state.modalOpen) {
      auth_state.modalOpen = false;
      try { Lampa.Modal.close(); } catch (e) {}
    }
    Logger.info('auth', 'modal closed', { reason: reason || 'manual' });
  }

  function openAuthModal(onSuccess) {
    Logger.info('auth', 'starting device flow');
    auth_state.network = new Lampa.Reguest();

    var modal = $(
      '<div>' +
        '<div class="broadcast__text" style="text-align:center; line-height:1.4;">' +
          Lampa.Lang.translate('kp_auth_text') +
        '</div>' +
        '<div class="broadcast__device selector" ' +
            'style="text-align:center; margin-top: 1em; background-color: #333; color: #fff; padding: 0.6em 1em; font-size: 1.4em; letter-spacing: 0.2em;">' +
          Lampa.Lang.translate('kp_auth_wait') + '...' +
        '</div>' +
        '<div style="margin-top:1em; opacity:.7; text-align:center;">' +
          Lampa.Lang.translate('kp_auth_url') +
        '</div>' +
        '<br>' +
        '<div class="broadcast__scan"><div></div></div>' +
      '</div>'
    );

    var user_code = '';
    var device_code = '';

    // Show the Lampa.Modal only AFTER we receive user_code from kinopub.
    // Opening it synchronously here (during the kpapi constructor) makes
    // Lampa's activity-toggle close it as a side effect — same trick filmix uses.
    function showModal() {
      if ($('.modal').length) {
        Logger.warn('auth', 'modal already exists, skipping open');
        return;
      }
      var prevController = (Lampa.Controller.enabled() || {}).name || 'content';
      auth_state.modalOpen = true;
      Lampa.Modal.open({
        title: Lampa.Lang.translate('kp_auth_title'),
        html:  modal,
        size:  'medium',
        onBack: function () {
          closeAuthModal('back');
          Lampa.Controller.toggle(prevController);
        },
        onSelect: function () {
          if (!user_code) return;
          Lampa.Utils.copyTextToClipboard(user_code, function () {
            Lampa.Noty.show(Lampa.Lang.translate('kp_copied'));
          }, function () {
            Lampa.Noty.show(Lampa.Lang.translate('kp_copy_fail'));
          });
        }
      });
    }

    KP.deviceCode(auth_state.network, function (json) {
      device_code = json.code;
      user_code = json.user_code;
      var interval = (json.interval || 5) * 1000;
      modal.find('.selector').text(user_code);

      showModal();

      auth_state.pingTimer = setInterval(function () {
        if (!auth_state.modalOpen) return;
        KP.pollDeviceToken(auth_state.network, device_code, function () {
          closeAuthModal('ok');
          // Note: we do NOT touch device serverLocation here — kinopub has its
          // own per-device UI for that. Plugin only offers a manual trigger in
          // settings as a convenience.
          // Send device identity once we have token so kinopub UI shows
          // a friendly name instead of three "unknown".
          notifyDeviceIdentity(new Lampa.Reguest());
          if (onSuccess) {
            try { onSuccess(); } catch (e) { Logger.error('auth', 'onSuccess threw', String(e)); }
          } else {
            try {
              var active = Lampa.Activity.active();
              if (active) Lampa.Activity.replace(active);
            } catch (e) {
              Logger.warn('auth', 'activity replace failed after auth', String(e));
            }
          }
        }, function () {
          // pending - keep polling
        }, function () {
          closeAuthModal('error');
          Lampa.Noty.show(Lampa.Lang.translate('kp_auth_error'));
        });
      }, interval);
    }, function () {
      closeAuthModal('init_error');
      Lampa.Noty.show(Lampa.Lang.translate('kp_auth_error'));
    });
  }

  /* ============================================================ *
   *  SOURCE  kpapi                                               *
   * ============================================================ */

  function kpapi(component, _object) {
    var self    = this;
    var network = new Lampa.Reguest();
    var object  = _object;

    var raw      = null;          // /v1/items/{id} response
    var extract  = null;          // normalized
    var choice   = { season: 0, voice: 0, voice_name: '' };
    var filterItems = {};
    var waitSimilars = false;

    // Expose this source to the Phase B Player.play patch so it can sync
    // filter / chips after an in-player voice switch.
    try { window._kpCurrentSource = self; } catch (e) {}

    if (!KP.hasToken()) {
      Logger.info('source', 'no token, opening auth modal');
      openAuthModal(function () {
        // Re-trigger the activity so the new token is used.
        try {
          var active = Lampa.Activity.active();
          if (active) Lampa.Activity.replace(active);
        } catch (e) { Logger.warn('source', 'replace after auth failed', String(e)); }
      });
      component.loading(false);
      return;
    }

    /* ---------- public API expected by component ---------- */

    this.search = function (_object_, similar) {
      Logger.info('source', 'search() with similar', similar && similar[0] && similar[0].id);
      object = _object_;
      if (similar && similar[0] && similar[0].id) this.find(similar[0].id);
    };

    this.searchByTitle = function (_object_, query) {
      var self = this;
      object = _object_;

      var year = parseInt((object.movie.release_date || object.movie.first_air_date || '0000').slice(0, 4), 10);
      var orig = object.movie.original_name || object.movie.original_title || '';
      var rus  = object.movie.name || object.movie.title || '';
      // imdb id may live on the movie object itself or under external_ids
      var imdbRaw = object.movie.imdb_id ||
                    (object.movie.external_ids && object.movie.external_ids.imdb_id) ||
                    '';
      var imdbNum = imdbRaw ? parseInt(String(imdbRaw).replace(/^tt/i, ''), 10) : 0;
      // serial detection: TMDB tv-show carries `name` and `first_air_date`
      var isSerial = !!(object.movie.name || object.movie.first_air_date || object.movie.number_of_seasons);
      var typeFilter = isSerial ? 'serial' : 'movie';

      Logger.info('source', 'searchByTitle', {
        query: query, year: year, orig: orig, rus: rus,
        imdb: imdbRaw, imdbNum: imdbNum, type: typeFilter
      });

      network.clear();
      KP.search(network, query, typeFilter, function (json) {
        var items = (json && json.items) || [];
        Logger.info('source', 'search ok', { count: items.length });

        if (items.length) {
          // log top-5 raw candidates so we can see what kinopub actually returned
          var preview = items.slice(0, 5).map(function (c) {
            return { id: c.id, title: c.title, year: c.year, type: c.type, imdb: c.imdb };
          });
          Logger.debug('source', 'top candidates', preview);
        }

        var card = null;

        // 1) IMDB ID exact match — by far the most reliable, skips title noise
        if (imdbNum) {
          card = items.find(function (c) {
            return parseInt(c.imdb || 0, 10) === imdbNum;
          });
          if (card) Logger.info('source', 'matched by imdb', { id: card.id, imdb: card.imdb });
        }

        // 2) type + year(±1) + parsed title match
        if (!card) {
          card = items.find(function (c) {
            var cy = parseInt(c.year || 0, 10);
            var t = splitKpTitle(c.title);
            var typeOk = isSerial ? /serial|tvshow/i.test(c.type || '')
                                  : !/serial|tvshow/i.test(c.type || '');
            var titleOk = (orig && normalize(t.orig) === normalize(orig)) ||
                          (rus  && normalize(t.rus)  === normalize(rus));
            return typeOk && Math.abs(cy - year) <= 1 && titleOk;
          });
          if (card) Logger.info('source', 'matched by title+year+type', { id: card.id, year: card.year });
        }

        // 3) loose title+year (any type) — TMDB and kinopub may disagree on type
        if (!card) {
          card = items.find(function (c) {
            var cy = parseInt(c.year || 0, 10);
            var t = splitKpTitle(c.title);
            return Math.abs(cy - year) <= 1 && (
              (orig && normalize(t.orig) === normalize(orig)) ||
              (rus  && normalize(t.rus)  === normalize(rus))
            );
          });
          if (card) Logger.info('source', 'matched by title+year (loose)', { id: card.id });
        }

        // 4) single hit — trust it
        if (!card && items.length === 1) {
          card = items[0];
          Logger.info('source', 'single result, taking it', { id: card.id });
        }

        if (card) {
          Logger.info('source', 'matched card', { id: card.id, title: card.title, year: card.year, type: card.type });
          self.find(card.id);
        } else if (items.length) {
          Logger.warn('source', 'no exact match, showing similars', { count: items.length });
          waitSimilars = true;
          component.similars(items.map(adaptSimilar));
          component.loading(false);
        } else {
          Logger.warn('source', 'nothing found');
          component.doesNotAnswer();
        }
      }, function (xhr, status) {
        Logger.error('source', 'search error', { http: xhr && xhr.status, status: status });
        component.doesNotAnswer();
      });
    };

    this.find = function (id) {
      var self = this;
      Logger.info('source', 'find() id=' + id);
      network.clear();
      KP.item(network, id, function (json) {
        if (!json || !json.item) {
          Logger.warn('source', 'item empty', json);
          component.doesNotAnswer();
          return;
        }
        try {
          success(json.item);
          component.loading(false);
        } catch (e) {
          Logger.error('source', 'parse error', { msg: String(e), stack: String(e && e.stack).slice(0, 600) });
          component.doesNotAnswer();
        }
      }, function (xhr, status) {
        Logger.error('source', 'find error', { http: xhr && xhr.status, status: status });
        component.doesNotAnswer();
      });
    };

    this.extendChoice = function (saved) { Lampa.Arrays.extend(choice, saved, true); };

    this.reset = function () {
      Logger.debug('source', 'reset');
      component.reset();
      choice = { season: 0, voice: 0, voice_name: '' };
      if (raw) {
        extractData(raw);
        buildFilter();
        append(filtered());
      }
    };

    this.filter = function (type, a, b) {
      Logger.debug('source', 'filter change', { type: a.stype, index: b.index });
      choice[a.stype] = b.index;
      if (a.stype === 'voice') {
        choice.voice_name = filterItems.voice[b.index] || '';
        choice.voice_key  = (filterItems.voice_keys && filterItems.voice_keys[b.index]) || '';
        // Per-season-of-series memory of the picked voice. When the user
        // returns to this season later, it auto-restores. Other seasons of
        // the same series can have different defaults.
        if (choice.voice_key) {
          if (!choice.voices_by_season) choice.voices_by_season = {};
          if (typeof choice.season !== 'undefined' && choice.season !== null) {
            choice.voices_by_season[choice.season] = choice.voice_key;
          }
        }
        Logger.info('voice', 'user picked', { season: choice.season, name: choice.voice_name, key: choice.voice_key });
      }
      component.reset();
      buildFilter();
      append(filtered());
    };

    /**
     * Called by the Player.play monkey-patch when the user picks a different
     * voice in the player UI. Updates local choice state, persists, refreshes
     * filter sidebar + card chips so everything stays consistent without
     * having to leave-and-reenter the source view.
     */
    this.applyExternalVoiceChange = function (key, label) {
      if (!key) return;
      Logger.info('phase-b', 'external voice change', { key: key, label: label });

      choice.voice_key = key;
      if (label) choice.voice_name = label;
      if (typeof choice.season !== 'undefined' && choice.season !== null) {
        if (!choice.voices_by_season) choice.voices_by_season = {};
        choice.voices_by_season[choice.season] = key;
      }

      if (filterItems.voice_keys) {
        var idx = filterItems.voice_keys.indexOf(key);
        if (idx >= 0) {
          choice.voice = idx;
          if (filterItems.voice[idx]) choice.voice_name = filterItems.voice[idx];
        }
      }

      try { component.saveChoice(choice); } catch (e) {}
      try { buildFilter(); } catch (e) {}
      try { refreshAllKpVoiceChips(key); } catch (e) {}
    };

    this.destroy = function () {
      Logger.debug('source', 'destroy');
      network.clear();
      raw = null;
      extract = null;
      // Release source ref used by Phase B patch
      try { if (window._kpCurrentSource === self) window._kpCurrentSource = null; } catch (e) {}
    };

    /* ---------- internal helpers ---------- */

    function adaptSimilar(c) {
      // kinopub gives us `title` as "Русское / Original"; split for prettier display
      var t = splitKpTitle(c.title);
      return {
        id:           c.id,
        title:        t.rus || c.title,
        ru_title:     t.rus,
        en_title:     t.orig,
        orig_title:   t.orig,
        year:         c.year,
        start_date:   c.year,
        rating:       c.imdb_rating || c.kinopoisk_rating || c.rating,
        countries:    c.countries ? c.countries.map(function (x) { return typeof x === 'string' ? x : (x.title || x.name); }) : [],
        categories:   c.genres ? c.genres.map(function (x) { return typeof x === 'string' ? x : (x.title || x.name); }) : [],
        filmId:       c.id
      };
    }

    function success(item) {
      Logger.info('source', 'item loaded', {
        id: item.id, type: item.type,
        seasons: (item.seasons || []).length,
        videos:  (item.videos || []).length
      });
      // Dump first audio entry verbatim — helps diagnose missing label fields
      // (e.g. "(AC3)" suffix kinopub UI shows but our parser drops).
      try {
        var firstAudios = null;
        if (item.seasons && item.seasons.length && item.seasons[0].episodes && item.seasons[0].episodes.length) {
          firstAudios = item.seasons[0].episodes[0].audios;
        } else if (item.videos && item.videos.length) {
          firstAudios = item.videos[0].audios;
        }
        if (firstAudios && firstAudios.length) {
          Logger.debug('source', 'sample audio entry [0]', firstAudios[0]);
          if (firstAudios.length > 1) {
            Logger.debug('source', 'sample audio entry [1]', firstAudios[1]);
          }
        }
      } catch (e) { Logger.warn('source', 'audio sample dump failed', String(e)); }
      raw = item;
      extractData(item);
      buildFilter();
      append(filtered());
    }

    /**
     * Build a deduped, ordered voice list from a set of audio-track entries
     * (across one or more episodes). Returns [{ key, label }, ...] in
     * first-seen order. Applies sidebar visibility filter (UKR / Пучков
     * are hidden everywhere).
     */
    function voiceListFromAudios(audiosArrays) {
      var voiceMap = {};
      var order = [];
      (audiosArrays || []).forEach(function (audios) {
        (audios || []).forEach(function (a) {
          if (!isVoiceVisible(a, 'sidebar')) return;
          var key = voiceKey(a);
          if (voiceMap[key]) return;
          var label = voiceLabel(a) || ('Track ' + (order.length + 1));
          voiceMap[key] = { key: key, label: label };
          order.push(key);
        });
      });
      return order.map(function (k) { return voiceMap[k]; });
    }


    function extractData(item) {
      extract = { type: 'movie', seasons: [], movie: null };

      var hasSeasons = item.seasons && item.seasons.length;
      var hasVideos  = item.videos  && item.videos.length;

      if (hasSeasons) {
        extract.type = 'serial';
        extract.seasons = (item.seasons || []).map(function (s) {
          return {
            number:   s.number,
            episodes: (s.episodes || []).map(function (ep, idx) {
              return {
                id:        ep.id || (s.number + '_' + (ep.number || idx + 1)),
                number:    ep.number || idx + 1,
                title:     ep.title || '',
                thumb:     ep.thumbnail,
                files:     parseFiles(ep.files),
                audios:    ep.audios || [],
                subtitles: ep.subtitles || []
              };
            })
          };
        });

        // Per-season voice count for diagnostics — actual filter list is
        // computed on demand in buildFilter() based on currently chosen season.
        var perSeasonVoices = extract.seasons.map(function (s) {
          return voiceListFromAudios(s.episodes.map(function (ep) { return ep.audios; })).length;
        });
        Logger.debug('source', 'extracted serial', {
          seasons: extract.seasons.length,
          totalEpisodes: extract.seasons.reduce(function (n, s) { return n + s.episodes.length; }, 0),
          voicesPerSeason: perSeasonVoices
        });
      } else if (hasVideos) {
        extract.type = 'movie';
        var v = item.videos[0];
        extract.movie = {
          files:     parseFiles(v.files),
          audios:    v.audios || [],
          subtitles: v.subtitles || []
        };

        Logger.debug('source', 'extracted movie', {
          files: extract.movie.files.length,
          audios: extract.movie.audios.length,
          subs: extract.movie.subtitles.length,
          voices: voiceListFromAudios([v.audios]).length
        });
      } else {
        Logger.warn('source', 'no playable structure in item', { id: item.id, type: item.type });
      }
    }

    function buildFilter() {
      filterItems = { season: [], voice: [], voice_keys: [] };

      // Voice list is built per-season for serials (matches kinopub web UI).
      // For movies it's based on the single video's audios.
      var voices = [];
      if (extract && extract.type === 'serial') {
        extract.seasons.forEach(function (s, i) {
          filterItems.season.push(Lampa.Lang.translate('torrent_serial_season') + ' ' + (s.number || i + 1));
        });
        var seasonIdx = (choice.season >= 0 && choice.season < extract.seasons.length) ? choice.season : 0;
        var season = extract.seasons[seasonIdx];
        if (season) {
          voices = voiceListFromAudios(season.episodes.map(function (ep) { return ep.audios; }));
        }
      } else if (extract && extract.type === 'movie' && extract.movie) {
        voices = voiceListFromAudios([extract.movie.audios]);
      }

      voices.forEach(function (v) {
        filterItems.voice.push(v.label);
        filterItems.voice_keys.push(v.key);
      });

      // Per-season-of-series voice memory. When user changes season, the
      // voice they had picked for THAT season takes priority over whatever
      // was saved as "current" voice_key (which was for the previous season).
      if (choice.voices_by_season && typeof choice.season !== 'undefined' && choice.season !== null) {
        var savedForSeason = choice.voices_by_season[choice.season];
        if (savedForSeason) {
          choice.voice_key = savedForSeason;
        }
      }

      // Restore the previously picked voice — priority order:
      //   1. per-(series+season) voice_key (already loaded into choice.voice_key above)
      //   2. legacy voice_name match (older saves)
      //   3. last-known index, then 0
      if (filterItems.voice_keys.length) {
        var inx = -1;
        if (choice.voice_key) {
          inx = filterItems.voice_keys.indexOf(choice.voice_key);
        }
        if (inx === -1 && choice.voice_name) {
          inx = filterItems.voice.map(function (v) { return v.toLowerCase(); })
                                 .indexOf(choice.voice_name.toLowerCase());
        }
        if (inx === -1) inx = (choice.voice >= 0 && choice.voice < filterItems.voice.length) ? choice.voice : 0;
        choice.voice      = inx;
        choice.voice_key  = filterItems.voice_keys[inx] || '';
        choice.voice_name = filterItems.voice[inx] || '';
      }

      component.filter(filterItems, choice);
    }

    function filtered() {
      if (!extract) return [];
      var fmt = preferredFormat();

      if (extract.type === 'serial') {
        var season = extract.seasons[choice.season];
        if (!season) return [];
        return season.episodes.map(function (ep) {
          var stream = pickStream(ep.files, fmt);
          return {
            kp:           { kind: 'episode', files: ep.files, audios: ep.audios, subtitles: ep.subtitles },
            episode:      ep.number,
            season:       season.number,
            // display title for the in-source episode list (filmix-style)
            title:        Lampa.Lang.translate('torrent_serial_episode') + ' ' + ep.number + (ep.title ? ' - ' + ep.title : ''),
            // raw episode name from kinopub — used by toPlayElement to build
            // clean player titles like "s1e3 Долгий день уходит в ночь"
            ep_title:     ep.title || '',
            quality:      stream ? (stream.currentQuality + 'p ') : '',
            translation:  1,
            voice_name:   filterItems.voice[choice.voice] || '',
            // info row stays for rating/year (set in draw()). voices is built
            // in component.draw() because it depends on per-episode timeline
            // progress and the watched-voice memory.
            info:         '',
            voices:       ''
          };
        });
      } else if (extract.type === 'movie' && extract.movie) {
        var stream2 = pickStream(extract.movie.files, fmt);
        return [{
          kp:          { kind: 'movie', files: extract.movie.files, audios: extract.movie.audios, subtitles: extract.movie.subtitles },
          title:       (object.movie && (object.movie.title || object.movie.name)) || '',
          quality:     stream2 ? (stream2.currentQuality + 'p ') : '',
          translation: 1,
          voice_name:  filterItems.voice[choice.voice] || '',
          info:        '',
          voices:      ''
        }];
      }
      return [];
    }

    function streamForElement(element, target) {
      var fmt = preferredFormat();
      var stream = pickStream(element.kp.files, fmt, target);
      if (!stream) {
        Logger.warn('source', 'no stream picked', { kind: element.kp.kind, fmt: fmt });
        return null;
      }
      return stream;
    }

    /**
     * If the chosen format fails (fatal MediaError), fall through this chain
     * looking for any URL we haven't tried yet for the same file.
     */
    // 'http' is intentionally excluded — kinopub's progressive MP4 freezes on
    // every Tizen player tested. Falling back to it makes things worse, not better.
    var FALLBACK_CHAIN = ['hls4', 'hls2', 'hls'];

    function nextFallbackUrl(element, triedSet) {
      // pick best file <= maxQ
      var maxQ = maxQuality();
      var avail = (element.kp.files || []).filter(function (f) { return f.quality <= maxQ; });
      if (!avail.length) avail = element.kp.files || [];
      if (!avail.length) return null;
      var best = avail[0]; // already sorted desc
      for (var i = 0; i < FALLBACK_CHAIN.length; i++) {
        var fmt = FALLBACK_CHAIN[i];
        var url = best.urls && best.urls[fmt];
        if (url && !triedSet[url]) return { url: url, fmt: fmt, q: best.quality };
      }
      return null;
    }

    function toPlayElement(element) {
      var stream = streamForElement(element, element.quality);
      if (!stream) return null;

      // Title formatting:
      //   serial episodes → "s1e03 - Долгий день уходит в ночь"  (used in
      //                                                            playlist popup)
      //   movies          → just the movie title
      // The MAIN player title gets a richer format (with series name) — that
      // override happens in the onEnter handler below, just before play().
      var displayTitle;
      if (element.season && element.episode) {
        var rawEpTitle = element.ep_title || '';
        var epPad = ('0' + element.episode).slice(-2);
        displayTitle = 's' + element.season + 'e' + epPad +
                       (rawEpTitle ? ' - ' + rawEpTitle : '');
      } else {
        displayTitle = element.title || '';
      }

      var play = {
        title:    displayTitle,
        url:      stream.url,
        quality:  stream.quality,
        timeline: element.timeline,
        callback: element.mark
      };

      // ── Voice selection ────────────────────────────────────────────────
      // Filter is the canonical UI for picking voice (choice.voice_key).
      // For each episode we resolve which audio-track index in this episode's
      // `audios[]` corresponds to the chosen voice, then queue it via
      // pendingVoice for the PlayerVideo.canplay hook to apply via
      // setSelectTrack / hls.audioTrack — without restarting the stream.
      //
      // We still pass play.voiceovers but with ONE entry (the active voice).
      // Two reasons to keep at least one entry:
      //   1. Empty voiceovers on Tizen broke the player lifecycle in v1.0.12.
      //   2. Single entry keeps player UI showing the active voice as label.
      var player   = detectActualPlayer();
      var audios   = element.kp.audios || [];
      var voiceIdx = -1;
      var pickedLabel = '';
      if (choice && choice.voice_key) {
        for (var ai = 0; ai < audios.length; ai++) {
          if (voiceKey(audios[ai]) === choice.voice_key) {
            voiceIdx = ai;
            break;
          }
        }
      }
      if (voiceIdx === -1 && audios.length > 0) voiceIdx = 0;
      if (voiceIdx >= 0 && audios[voiceIdx]) {
        pickedLabel = voiceLabel(audios[voiceIdx]) || ('Track ' + (voiceIdx + 1));
      }
      pendingVoice = (voiceIdx >= 0)
        ? { idx: voiceIdx, label: pickedLabel, key: (choice && choice.voice_key) || '' }
        : null;

      // Keep the current-voice label fresh for the DOM override of
      // .player-panel__next-episode-name (see setupNextEpisodeLabelOverride).
      if (pickedLabel) currentVoiceLabel = pickedLabel;

      // Build full multi-entry voiceovers list for in-player switching.
      // Each entry includes an `onSelect(item)` callback — Lampa calls it
      // when user clicks the voice in the player tracks menu (see Lampa
      // source ~L7855: `if (a.onSelect) a.onSelect(a);`). Inside we call
      // applyVoiceTrack(idx) directly + sync source state, no restart.
      // Card-level filters (Original/Authoring/etc) DON'T apply here —
      // user can still pick those from the player if they want.
      if (audios.length) {
        var voiceovers = [];
        for (var ai2 = 0; ai2 < audios.length; ai2++) {
          if (!isVoiceVisible(audios[ai2], 'sidebar')) continue;
          var lbl = voiceLabel(audios[ai2]) || ('Track ' + (ai2 + 1));
          voiceovers.push({
            name:    lbl,
            url:     stream.url,         // same URL — onSelect handles switching
            index:   ai2,
            'default': ai2 === voiceIdx,
            onSelect: (function (idx, audiosRef) {
              return function (a) {
                var audio = audiosRef[idx];
                if (!audio) {
                  Logger.warn('phase-b', 'audio missing at idx', { idx: idx });
                  return;
                }
                var key   = voiceKey(audio);
                var label = voiceLabel(audio);
                Logger.info('phase-b', 'voice onSelect', { idx: idx, key: key });
                var ok = applyVoiceTrack(idx);
                Logger.info('phase-b', 'switch result', { idx: idx, ok: !!ok });
                syncVoiceToSource(key, label);
              };
            })(ai2, audios)
          });
        }
        if (voiceovers.length) play.voiceovers = voiceovers;
        // also set top-level `translate` — some Lampa builds display this in
        // the player UI as "current voice" label
        play.translate = pickedLabel;
      }

      var subsAttached = 0;
      var subsEnabled  = Lampa.Storage.get(KEY_SUBS, false);
      if (subsEnabled) {
        var subs = buildSubtitles(element.kp.subtitles);
        if (subs.length) {
          play.subtitles = subs;
          subsAttached = subs.length;
        }
      }

      // Lampa calls play.error(work, cb) on fatal MediaError. cb(reserveUrl)
      // makes the player retry with the new URL. We walk the format chain.
      var tried = {};
      tried[stream.url] = true;
      play.error = function (work, cb) {
        var nxt = nextFallbackUrl(element, tried);
        if (!nxt) {
          Logger.warn('player', 'no fallback URLs left', { tried: Object.keys(tried).length });
          if (cb) cb(false);
          return;
        }
        tried[nxt.url] = true;
        Logger.warn('player', 'falling back to ' + nxt.fmt, { url: nxt.url, q: nxt.q });
        Lampa.Noty.show(Lampa.Lang.translate('kp_fallback') + ': ' + nxt.fmt);
        if (cb) cb(nxt.url);
      };

      Logger.debug('player', 'play-element built', {
        title:    play.title,
        url:      play.url,
        q:        stream.currentQuality,
        voiceIdx: voiceIdx,
        voice:    pickedLabel,
        voicesAvailable: audios.length,
        player:   player || '(default)',
        subs:     subsAttached,
        subsAvailable: (element.kp.subtitles || []).length
      });
      return play;
    }

    function append(items) {
      Logger.debug('source', 'append items', { count: items.length });
      component.reset();
      component.draw(items, {
        similars: waitSimilars,
        onEnter: function (item) {
          var play = toPlayElement(item);
          if (!play) {
            Lampa.Noty.show(Lampa.Lang.translate('online_nolink'));
            return;
          }
          var playlist = [];
          if (item.season) {
            items.forEach(function (e) {
              var p = toPlayElement(e);
              if (p) playlist.push(p);
            });
          } else {
            playlist.push(play);
          }

          // Override the MAIN player title with the rich format including the
          // series name. Playlist items keep the same "sNeMM - title" format
          // (built in toPlayElement) so the popup stays consistent.
          //   Main:     "Извне s1e03 - Долгий день уходит в ночь"
          //   Playlist: "s1e03 - Долгий день уходит в ночь"
          if (item.season && item.episode) {
            var seriesName = (object.movie &&
              (object.movie.name || object.movie.title || object.movie.original_name || object.movie.original_title)) || '';
            var rawEpTitle = item.ep_title || '';
            var epPad = ('0' + item.episode).slice(-2);
            play.title = (seriesName ? seriesName + ' ' : '') +
                         's' + item.season + 'e' + epPad +
                         (rawEpTitle ? ' - ' + rawEpTitle : '');
          }

          // Remember voice for this episode so the watched-indicator chip
          // can show on next visit. Saved per timeline_hash (set in draw()).
          if (item.season && pendingVoice && pendingVoice.key && item.timeline_hash) {
            try {
              var watchedMap = Lampa.Storage.cache('kp_episode_voice', 5000, {});
              watchedMap[item.timeline_hash] = pendingVoice.key;
              Lampa.Storage.set('kp_episode_voice', watchedMap);
              Logger.debug('voice', 'remembered for episode', {
                hash: item.timeline_hash, key: pendingVoice.key
              });
            } catch (e) { Logger.warn('voice', 'remember failed', String(e)); }
          }

          if (playlist.length > 1) play.playlist = playlist;
          Logger.info('player', 'launching', { url: play.url, playlist: playlist.length, title: play.title });
          Lampa.Player.play(play);
          Lampa.Player.playlist(playlist);
          if (item.mark) item.mark();
        },
        onContextMenu: function (item, html, data, call) {
          var stream = streamForElement(item, item.quality);
          call({
            file:    stream ? stream.url : '',
            quality: stream ? stream.quality : null
          });
        }
      });
    }
  }

  /* ============================================================ *
   *  COMPONENT  online_kp                                        *
   *  (closely modelled on online_fxapi from filmix.js)           *
   * ============================================================ */

  function component(object) {
    var network = new Lampa.Reguest();
    var scroll  = new Lampa.Scroll({ mask: true, over: true });
    var files   = new Lampa.Explorer(object);
    var filter  = new Lampa.Filter(object);

    var sources = { kpapi: kpapi };
    var balanser = BALANSER;
    var source;
    var initialized;
    var last;
    var images = [];
    var selected_id;
    var extended;

    var filter_translate = {
      season: Lampa.Lang.translate('torrent_serial_season'),
      voice:  Lampa.Lang.translate('torrent_parser_voice'),
      source: Lampa.Lang.translate('settings_rest_source')
    };

    this.initialize = function () {
      var self = this;
      source = this.createSource();
      if (!source) return;

      filter.onSearch = function (value) {
        Lampa.Activity.replace({ search: value, clarification: true });
      };
      filter.onBack = function () { self.start(); };
      filter.render().find('.selector').on('hover:enter', function () {});
      filter.onSelect = function (type, a, b) {
        if (type === 'filter') {
          if (a.reset) {
            if (extended) source.reset();
            else self.start();
          } else {
            source.filter(type, a, b);
          }
        } else if (type === 'sort') {
          Lampa.Select.close();
        }
      };

      if (filter.addButtonBack) filter.addButtonBack();
      filter.render().find('.filter--sort').remove();
      files.appendFiles(scroll.render());
      files.appendHead(filter.render());
      scroll.body().addClass('torrent-list');
      scroll.minus(files.render().find('.explorer__files-head'));
      this.search();
    };

    this.createSource = function () {
      try {
        return new sources[balanser](this, object);
      } catch (e) {
        Logger.error('component', 'createSource', String(e));
        return null;
      }
    };

    this.create = function () { return this.render(); };

    this.search = function () {
      this.activity.loader(true);
      this.find();
    };

    this.find = function () {
      if (source && source.searchByTitle) {
        this.extendChoice();
        var q = object.search || object.movie.original_title || object.movie.original_name ||
                object.movie.title || object.movie.name;
        Logger.info('component', 'find query=' + q);
        source.searchByTitle(object, q);
      }
    };

    this.getChoice = function (for_balanser) {
      var data = Lampa.Storage.cache('online_choice_' + (for_balanser || balanser), 3000, {});
      var save = data[selected_id || object.movie.id] || {};
      Lampa.Arrays.extend(save, {
        season: 0, voice: 0, voice_name: '', voice_key: '', voice_id: 0,
        voices_by_season: {},
        episodes_view: {}, movie_view: ''
      });
      return save;
    };

    this.extendChoice = function () {
      extended = true;
      if (source) source.extendChoice(this.getChoice());
    };

    this.saveChoice = function (choice, for_balanser) {
      var data = Lampa.Storage.cache('online_choice_' + (for_balanser || balanser), 3000, {});
      data[selected_id || object.movie.id] = choice;
      Lampa.Storage.set('online_choice_' + (for_balanser || balanser), data);
    };

    this.similars = function (json) {
      var self = this;
      json.forEach(function (elem) {
        var info = [];
        var year = ((elem.start_date || elem.year || '') + '').slice(0, 4);
        if (elem.rating && elem.rating !== 'null') info.push(Lampa.Template.get('online_prestige_rate', { rate: elem.rating }, true));
        if (year) info.push(year);
        if (elem.countries && elem.countries.length) info.push(elem.countries.join(', '));
        if (elem.categories && elem.categories.length) info.push(elem.categories.slice(0, 4).join(', '));
        var name = elem.title || elem.ru_title || elem.en_title;
        var orig = elem.orig_title || elem.en_title || '';
        elem.title = name + (orig && orig !== name ? ' / ' + orig : '');
        elem.time  = '';
        elem.info  = info.join('<span class="online-prestige-split">●</span>');
        var item = Lampa.Template.get('online_prestige_folder', elem);
        item.on('hover:enter', function () {
          self.activity.loader(true);
          self.reset();
          object.search_date = year;
          selected_id = elem.id;
          self.extendChoice();
          if (source && source.search) {
            source.search(object, [elem]);
          } else self.doesNotAnswer();
        }).on('hover:focus', function (e) {
          last = e.target;
          scroll.update($(e.target), true);
        });
        scroll.append(item);
      });
    };

    this.clearImages = function () {
      images.forEach(function (img) { img.onerror = function () {}; img.onload = function () {}; img.src = ''; });
      images = [];
    };

    this.reset = function () {
      last = false;
      network.clear();
      this.clearImages();
      scroll.render().find('.empty').remove();
      scroll.clear();
    };

    this.loading = function (status) {
      if (status) this.activity.loader(true);
      else { this.activity.loader(false); this.activity.toggle(); }
    };

    this.filter = function (filter_items, choice) {
      var self = this;
      var select = [];
      var add = function (type, title) {
        var need  = self.getChoice();
        var items = filter_items[type];
        var subitems = [];
        var value = need[type];
        items.forEach(function (name, i) {
          subitems.push({ title: name, selected: value === i, index: i });
        });
        select.push({ title: title, subtitle: items[value], items: subitems, stype: type });
      };
      select.push({ title: Lampa.Lang.translate('torrent_parser_reset'), reset: true });
      this.saveChoice(choice);
      if (filter_items.voice  && filter_items.voice.length)  add('voice',  Lampa.Lang.translate('torrent_parser_voice'));
      if (filter_items.season && filter_items.season.length) add('season', Lampa.Lang.translate('torrent_serial_season'));
      filter.set('filter', select);
      this.selected(filter_items);
    };

    this.selected = function (filter_items) {
      var need = this.getChoice(), select = [];
      for (var i in need) {
        if (filter_items[i] && filter_items[i].length) {
          if (i === 'voice') select.push(filter_translate[i] + ': ' + filter_items[i][need[i]]);
          else if (i === 'season' && filter_items.season.length >= 1) select.push(filter_translate.season + ': ' + filter_items[i][need[i]]);
        }
      }
      filter.chosen('filter', select);
      filter.chosen('sort', [balanser]);
    };

    this.getEpisodes = function (season, call) {
      var episodes = [];
      if (typeof object.movie.id === 'number' && object.movie.name) {
        var url = 'tv/' + object.movie.id + '/season/' + season +
                  '?api_key=' + Lampa.TMDB.key() +
                  '&language=' + Lampa.Storage.get('language', 'ru');
        var baseurl = Lampa.TMDB.api(url);
        network.timeout(10000);
        network['native'](baseurl, function (data) {
          episodes = data.episodes || [];
          call(episodes);
        }, function () { call(episodes); });
      } else call(episodes);
    };

    this.append = function (item) {
      item.on('hover:focus', function (e) { last = e.target; scroll.update($(e.target), true); });
      scroll.append(item);
    };

    this.watched = function (set) {
      var file_id = Lampa.Utils.hash(object.movie.number_of_seasons ? object.movie.original_name : object.movie.original_title);
      var watched = Lampa.Storage.cache('online_watched_last', 5000, {});
      if (set) {
        if (!watched[file_id]) watched[file_id] = {};
        Lampa.Arrays.extend(watched[file_id], set, true);
        Lampa.Storage.set('online_watched_last', watched);
      } else return watched[file_id];
    };

    this.draw = function (items, params) {
      var self = this;
      params = params || {};
      if (!items.length) return this.empty();

      this.getEpisodes(items[0].season, function (episodes) {
        var viewed = Lampa.Storage.cache('online_view', 5000, []);
        var serial = object.movie.name ? true : false;
        var choice = self.getChoice();
        var fully  = window.innerWidth > 480;
        var scroll_to_element = false;
        var scroll_to_mark = false;

        items.forEach(function (element, index) {
          var episode = serial && episodes.length && !params.similars
            ? episodes.find(function (e) { return e.episode_number === element.episode; })
            : false;
          var episode_num  = element.episode || index + 1;
          var episode_last = choice.episodes_view[element.season];
          Lampa.Arrays.extend(element, {
            info:    element.info || '',
            quality: element.quality || '',
            time:    Lampa.Utils.secondsToTime(((episode ? episode.runtime : object.movie.runtime) || 0) * 60, true)
          });

          var hash_timeline = Lampa.Utils.hash(element.season
            ? [element.season, element.episode, object.movie.original_title].join('')
            : object.movie.original_title);
          var hash_behold = Lampa.Utils.hash(element.season
            ? [element.season, element.episode, object.movie.original_title, element.voice_name].join('')
            : object.movie.original_title + element.voice_name);

          var info = [];
          element.timeline = Lampa.Timeline.view(hash_timeline);
          // Expose hash so onEnter can save remembered voice keyed by episode
          element.timeline_hash = hash_timeline;

          if (episode) {
            element.title = episode.name;
            if (episode.vote_average) info.push(Lampa.Template.get('online_prestige_rate', {
              rate: parseFloat(episode.vote_average + '').toFixed(1)
            }, true));
            if (episode.air_date && fully) info.push(Lampa.Utils.parseTime(episode.air_date).full);
          } else if (object.movie.release_date && fully) {
            info.push(Lampa.Utils.parseTime(object.movie.release_date).full);
          }
          if (!serial && object.movie.tagline) info.push(object.movie.tagline);
          if (element.info) info.push(element.info);
          if (info.length) element.info = info.map(function (i) { return '<span>' + i + '</span>'; }).join('<span class="online-prestige-split">●</span>');

          // Build voice chips with full progress + watched-voice context.
          // Two indicator states (mutually exclusive):
          //   timeline.percent > 0 → show watched chip (gray underline)
          //   else                 → show active chip (soft green)
          var watchedMap   = Lampa.Storage.cache('kp_episode_voice', 5000, {});
          var watchedKey   = watchedMap[hash_timeline] || '';
          var hasProgress  = !!(element.timeline && element.timeline.percent > 0);
          element.voices = voiceChipsHtml(
            (element.kp && element.kp.audios) || [],
            (choice && choice.voice_key) || '',
            watchedKey,
            hasProgress
          );

          var html  = Lampa.Template.get('online_prestige_full', element);
          var loader = html.find('.online-prestige__loader');
          var image  = html.find('.online-prestige__img');

          if (!serial) {
            if (choice.movie_view === hash_behold) scroll_to_element = html;
          } else if (typeof episode_last !== 'undefined' && episode_last === episode_num) {
            scroll_to_element = html;
          }

          if (serial && !episode) {
            image.append('<div class="online-prestige__episode-number">' + ('0' + (element.episode || index + 1)).slice(-2) + '</div>');
            loader.remove();
          } else {
            var img = html.find('img')[0];
            if (img) {
              img.onerror = function () { img.src = './img/img_broken.svg'; };
              img.onload  = function () {
                image.addClass('online-prestige__img--loaded');
                loader.remove();
                if (serial) image.append('<div class="online-prestige__episode-number">' + ('0' + (element.episode || index + 1)).slice(-2) + '</div>');
              };
              img.src = Lampa.TMDB.image('t/p/w300' + (episode ? episode.still_path : object.movie.backdrop_path));
              images.push(img);
            }
          }

          html.find('.online-prestige__timeline').append(Lampa.Timeline.render(element.timeline));

          if (viewed.indexOf(hash_behold) !== -1) {
            scroll_to_mark = html;
            html.find('.online-prestige__img').append('<div class="online-prestige__viewed">' + Lampa.Template.get('icon_viewed', {}, true) + '</div>');
          }

          element.mark = function () {
            viewed = Lampa.Storage.cache('online_view', 5000, []);
            if (viewed.indexOf(hash_behold) === -1) {
              viewed.push(hash_behold);
              Lampa.Storage.set('online_view', viewed);
              if (html.find('.online-prestige__viewed').length === 0) {
                html.find('.online-prestige__img').append('<div class="online-prestige__viewed">' + Lampa.Template.get('icon_viewed', {}, true) + '</div>');
              }
            }
            choice = self.getChoice();
            if (!serial) choice.movie_view = hash_behold;
            else choice.episodes_view[element.season] = episode_num;
            self.saveChoice(choice);
            self.watched({
              balanser: balanser,
              balanser_name: 'KinoPub',
              voice_id: choice.voice_id,
              voice_name: choice.voice_name || element.voice_name,
              episode: element.episode,
              season: element.season
            });
          };

          element.unmark = function () {
            viewed = Lampa.Storage.cache('online_view', 5000, []);
            if (viewed.indexOf(hash_behold) !== -1) {
              Lampa.Arrays.remove(viewed, hash_behold);
              Lampa.Storage.set('online_view', viewed);
              if (Lampa.Manifest.app_digital >= 177) Lampa.Storage.remove('online_view', hash_behold);
              html.find('.online-prestige__viewed').remove();
            }
          };

          element.timeclear = function () {
            element.timeline.percent = 0;
            element.timeline.time = 0;
            element.timeline.duration = 0;
            Lampa.Timeline.update(element.timeline);
            // Drop the remembered voice for this episode — episode is "fresh" now
            try {
              var wmap = Lampa.Storage.cache('kp_episode_voice', 5000, {});
              if (wmap[hash_timeline]) {
                delete wmap[hash_timeline];
                Lampa.Storage.set('kp_episode_voice', wmap);
              }
            } catch (e) {}
            // Repaint chips so the gray underline disappears and the green
            // sidebar-pick indicator takes over (now hasProgress = false).
            try {
              var voicesEl = html.find('.kp-voices');
              if (voicesEl.length) {
                var ch = self.getChoice();
                voicesEl.html(voiceChipsHtml(
                  (element.kp && element.kp.audios) || [],
                  (ch && ch.voice_key) || '',
                  '',
                  false
                ));
              }
            } catch (e) {}
          };

          // Stash element + active voice key on the DOM node so the global
          // refreshAllKpVoiceChips() (called on Player/destroy) can re-render
          // chips for cards that gained progress without a full source redraw.
          html.data('kp-card', { element: element, activeVoiceKey: choice.voice_key || '' });

          html.on('hover:enter', function () {
            if (object.movie.id) Lampa.Favorite.add('history', object.movie, 100);
            if (params.onEnter) params.onEnter(element, html, {});
          }).on('hover:focus', function (e) {
            last = e.target;
            if (params.onFocus) params.onFocus(element, html, {});
            scroll.update($(e.target), true);
          });

          if (params.onRender) params.onRender(element, html, {});

          self.contextMenu({
            html: html,
            element: element,
            onFile: function (call) {
              if (params.onContextMenu) params.onContextMenu(element, html, {}, call);
            },
            onClearAllMark: function () { items.forEach(function (e) { e.unmark(); }); },
            onClearAllTime: function () { items.forEach(function (e) { e.timeclear(); }); }
          });

          scroll.append(html);
        });

        if (scroll_to_element) last = scroll_to_element[0];
        else if (scroll_to_mark) last = scroll_to_mark[0];

        Lampa.Controller.enable('content');
      });
    };

    this.contextMenu = function (params) {
      params.html.on('hover:long', function () {
        function show(extra) {
          var enabled = Lampa.Controller.enabled().name;
          var menu = [];
          if (Lampa.Platform.is('webos'))   menu.push({ title: Lampa.Lang.translate('player_lauch') + ' - Webos',   player: 'webos' });
          if (Lampa.Platform.is('android')) menu.push({ title: Lampa.Lang.translate('player_lauch') + ' - Android', player: 'android' });
          menu.push({ title: Lampa.Lang.translate('player_lauch') + ' - Lampa', player: 'lampa' });
          menu.push({ title: Lampa.Lang.translate('online_video'), separator: true });
          menu.push({ title: Lampa.Lang.translate('kp_try_format'), kpformat: true });
          menu.push({ title: Lampa.Lang.translate('torrent_parser_label_title'),        mark: true });
          menu.push({ title: Lampa.Lang.translate('torrent_parser_label_cancel_title'), unmark: true });
          menu.push({ title: Lampa.Lang.translate('time_reset'),                         timeclear: true });
          if (extra) menu.push({ title: Lampa.Lang.translate('copy_link'), copylink: true });
          menu.push({ title: Lampa.Lang.translate('more'), separator: true });
          menu.push({ title: Lampa.Lang.translate('online_clear_all_marks'),     clearallmark: true });
          menu.push({ title: Lampa.Lang.translate('online_clear_all_timecodes'), timeclearall: true });
          Lampa.Select.show({
            title: Lampa.Lang.translate('title_action'),
            items: menu,
            onBack: function () { Lampa.Controller.toggle(enabled); },
            onSelect: function (a) {
              if (a.mark)         params.element.mark();
              if (a.unmark)       params.element.unmark();
              if (a.timeclear)    params.element.timeclear();
              if (a.clearallmark) params.onClearAllMark();
              if (a.timeclearall) params.onClearAllTime();
              Lampa.Controller.toggle(enabled);
              if (a.player) { Lampa.Player.runas(a.player); params.html.trigger('hover:enter'); }
              if (a.kpformat) {
                var formats = [
                  { title: 'HLS v4 (fMP4)', fmt: 'hls4' },
                  { title: 'HLS v2 (TS)',   fmt: 'hls2' },
                  { title: 'HLS',           fmt: 'hls' },
                  { title: Lampa.Lang.translate('kp_format_clear'), fmt: null }
                ];
                Lampa.Select.show({
                  title: Lampa.Lang.translate('kp_try_format'),
                  items: formats,
                  onBack: function () { Lampa.Controller.toggle(enabled); },
                  onSelect: function (b) {
                    formatOverride = b.fmt || null;
                    Logger.info('format', 'override set', { fmt: formatOverride });
                    Lampa.Controller.toggle(enabled);
                    params.html.trigger('hover:enter');
                  }
                });
                return;
              }
              if (a.copylink) {
                if (extra && extra.quality) {
                  var qual = [];
                  for (var k in extra.quality) qual.push({ title: k, file: extra.quality[k] });
                  Lampa.Select.show({
                    title: Lampa.Lang.translate('settings_server_links'),
                    items: qual,
                    onBack: function () { Lampa.Controller.toggle(enabled); },
                    onSelect: function (b) {
                      Lampa.Utils.copyTextToClipboard(b.file,
                        function () { Lampa.Noty.show(Lampa.Lang.translate('copy_secuses')); },
                        function () { Lampa.Noty.show(Lampa.Lang.translate('copy_error')); });
                    }
                  });
                } else if (extra && extra.file) {
                  Lampa.Utils.copyTextToClipboard(extra.file,
                    function () { Lampa.Noty.show(Lampa.Lang.translate('copy_secuses')); },
                    function () { Lampa.Noty.show(Lampa.Lang.translate('copy_error')); });
                }
              }
            }
          });
        }
        params.onFile(show);
      }).on('hover:focus', function () {
        if (Lampa.Helper) Lampa.Helper.show('online_file', Lampa.Lang.translate('helper_online_file'), params.html);
      });
    };

    this.empty = function () {
      var html = Lampa.Template.get('online_does_not_answer', {});
      html.find('.online-empty__buttons').remove();
      html.find('.online-empty__title').text(Lampa.Lang.translate('empty_title_two'));
      scroll.append(html);
      this.loading(false);
    };

    this.doesNotAnswer = function () {
      this.reset();
      var html = Lampa.Template.get('online_does_not_answer', { balanser: balanser });
      scroll.append(html);
      this.loading(false);
    };

    this.getLastEpisode = function (items) {
      var last_episode = 0;
      items.forEach(function (e) {
        if (typeof e.episode !== 'undefined') last_episode = Math.max(last_episode, parseInt(e.episode, 10));
      });
      return last_episode;
    };

    this.start = function () {
      if (Lampa.Activity.active().activity !== this.activity) return;
      if (!initialized) { initialized = true; this.initialize(); }
      Lampa.Background.immediately(Lampa.Utils.cardImgBackgroundBlur(object.movie));
      Lampa.Controller.add('content', {
        toggle: function () {
          Lampa.Controller.collectionSet(scroll.render(), files.render());
          Lampa.Controller.collectionFocus(last || false, scroll.render());
        },
        up:    function () { if (Navigator.canmove('up'))    Navigator.move('up');    else Lampa.Controller.toggle('head'); },
        down:  function () { Navigator.move('down'); },
        right: function () { if (Navigator.canmove('right')) Navigator.move('right'); else filter.show(Lampa.Lang.translate('title_filter'), 'filter'); },
        left:  function () { if (Navigator.canmove('left'))  Navigator.move('left');  else Lampa.Controller.toggle('menu'); },
        gone:  function () {},
        back:  this.back
      });
      Lampa.Controller.toggle('content');
    };

    this.render  = function () { return files.render(); };
    this.back    = function () { Lampa.Activity.backward(); };
    this.pause   = function () {};
    this.stop    = function () {};
    this.destroy = function () {
      network.clear();
      this.clearImages();
      files.destroy();
      scroll.destroy();
      if (source && source.destroy) source.destroy();
      // ensure no orphaned auth modal stays alive after activity closes
      if (auth_state.modalOpen) closeAuthModal('component_destroy');
    };
  }

  /* ============================================================ *
   *  TEMPLATES (CSS + DOM, copied from filmix style)             *
   * ============================================================ */

  function injectStyles() {
    Lampa.Template.add('online_prestige_css',
      "<style>" +
      ".online-prestige{position:relative;border-radius:.3em;background-color:rgba(0,0,0,0.3);display:flex;will-change:transform}" +
      ".online-prestige__body{padding:1.2em;line-height:1.3;flex-grow:1;position:relative}" +
      "@media screen and (max-width:480px){.online-prestige__body{padding:.8em 1.2em}}" +
      ".online-prestige__img{position:relative;width:13em;flex-shrink:0;min-height:8.2em}" +
      ".online-prestige__img>img{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;border-radius:.3em;opacity:0;transition:opacity .3s}" +
      ".online-prestige__img--loaded>img{opacity:1}" +
      "@media screen and (max-width:480px){.online-prestige__img{width:7em;min-height:6em}}" +
      ".online-prestige__folder{padding:1em;flex-shrink:0}" +
      ".online-prestige__folder>svg{width:4.4em !important;height:4.4em !important}" +
      ".online-prestige__viewed{position:absolute;top:1em;left:1em;background:rgba(0,0,0,0.45);border-radius:100%;padding:.25em;font-size:.76em}" +
      ".online-prestige__viewed>svg{width:1.5em !important;height:1.5em !important}" +
      ".online-prestige__episode-number{position:absolute;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;font-size:2em}" +
      ".online-prestige__loader{position:absolute;top:50%;left:50%;width:2em;height:2em;margin-left:-1em;margin-top:-1em;background:url(./img/loader.svg) no-repeat center center;background-size:contain}" +
      ".online-prestige__head,.online-prestige__footer{display:flex;justify-content:space-between;align-items:center}" +
      ".online-prestige__timeline{margin:.8em 0}" +
      ".online-prestige__timeline>.time-line{display:block !important}" +
      ".online-prestige__title{font-size:1.7em;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical}" +
      "@media screen and (max-width:480px){.online-prestige__title{font-size:1.4em}}" +
      ".online-prestige__time{padding-left:2em}" +
      ".online-prestige__info{display:flex;align-items:center}" +
      ".online-prestige__info>*{overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical}" +
      ".online-prestige__quality{padding-left:1em;white-space:nowrap}" +
      ".online-prestige .online-prestige-split{font-size:.8em;margin:0 1em;flex-shrink:0}" +
      ".online-prestige.focus::after{content:'';position:absolute;top:-0.6em;left:-0.6em;right:-0.6em;bottom:-0.6em;border-radius:.7em;border:solid .3em #fff;z-index:-1;pointer-events:none}" +
      ".online-prestige+.online-prestige{margin-top:1.5em}" +
      ".online-prestige--folder .online-prestige__footer{margin-top:.8em}" +
      ".online-prestige-rate{display:inline-flex;align-items:center}" +
      ".online-prestige-rate>svg{width:1.3em !important;height:1.3em !important}" +
      ".online-prestige-rate>span{font-weight:600;font-size:1.1em;padding-left:.7em}" +
      ".online-empty{line-height:1.4}" +
      ".online-empty__title{font-size:2em;margin-bottom:.9em}" +
      ".online-empty-template{background-color:rgba(255,255,255,0.3);padding:1em;display:flex;align-items:center;border-radius:.3em}" +
      ".online-empty-template>*{background:rgba(0,0,0,0.3);border-radius:.3em}" +
      ".online-empty-template__ico{width:4em;height:4em;margin-right:2.4em}" +
      ".online-empty-template__body{height:1.7em;width:70%}" +
      ".online-empty-template+.online-empty-template{margin-top:1em}" +
      ".online-empty__templates .online-empty-template:nth-child(2){opacity:.5}" +
      ".online-empty__templates .online-empty-template:nth-child(3){opacity:.2}" +
      // — voice chips inline in footer (kp.js v1.0.20) ————————————
      // Footer was originally `space-between` — override to `flex-start` so
      // info / voices / quality line up left-to-right with voices flush
      // against quality on the right.
      ".online-prestige__footer{justify-content:flex-start}" +
      ".online-prestige__info{flex:1 1 auto;min-width:0;overflow:hidden}" +
      ".kp-voices{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:.3em;" +
        "margin:0 .8em 0 .5em;flex-shrink:1;line-height:1.2}" +
      ".kp-voices:empty{display:none}" +
      ".online-prestige__quality{flex-shrink:0;padding-left:0}" +
      ".kp-voice-chip{display:inline-block;padding:.2em .55em;background:rgba(255,255,255,0.10);" +
        "border-radius:.3em;border:1px solid transparent;font-size:.78em;white-space:nowrap;" +
        "color:rgba(255,255,255,0.85)}" +
      // is-active = sidebar pick on a fresh (zero-progress) episode.
      // Soft green fill — "this is what plays if you click".
      ".kp-voice-chip.is-active{background:rgba(110,200,110,0.28);" +
        "border-color:rgba(110,200,110,0.6);color:#e6ffe6;font-weight:600}" +
      // is-watched = remembered voice for an in-progress / completed episode.
      // Faded gray look — "this track has done its job", muted vs default.
      ".kp-voice-chip.is-watched{background:rgba(255,255,255,0.04);" +
        "color:rgba(255,255,255,0.38);" +
        "border-color:transparent}" +
      "</style>");
    $('body').append(Lampa.Template.get('online_prestige_css', {}, true));
  }

  function resetTemplates() {
    Lampa.Template.add('online_prestige_full',
      '<div class="online-prestige online-prestige--full selector">' +
        '<div class="online-prestige__img"><img alt=""><div class="online-prestige__loader"></div></div>' +
        '<div class="online-prestige__body">' +
          '<div class="online-prestige__head">' +
            '<div class="online-prestige__title">{title}</div>' +
            '<div class="online-prestige__time">{time}</div>' +
          '</div>' +
          '<div class="online-prestige__timeline"></div>' +
          '<div class="online-prestige__footer">' +
            '<div class="online-prestige__info">{info}</div>' +
            '<div class="kp-voices">{voices}</div>' +
            '<div class="online-prestige__quality">{quality}</div>' +
          '</div>' +
        '</div>' +
      '</div>');
    Lampa.Template.add('online_does_not_answer',
      '<div class="online-empty">' +
        '<div class="online-empty__title" style="font-size: 2em; margin-bottom: .9em;">#{online_balanser_dont_work}</div>' +
        '<div class="online-empty__templates">' +
          '<div class="online-empty-template"><div class="online-empty-template__ico"></div><div class="online-empty-template__body"></div></div>' +
          '<div class="online-empty-template"><div class="online-empty-template__ico"></div><div class="online-empty-template__body"></div></div>' +
          '<div class="online-empty-template"><div class="online-empty-template__ico"></div><div class="online-empty-template__body"></div></div>' +
        '</div>' +
      '</div>');
    Lampa.Template.add('online_prestige_rate',
      '<div class="online-prestige-rate">' +
        '<svg width="17" height="16" viewBox="0 0 17 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
          '<path d="M8.39409 0.192139L10.99 5.30994L16.7882 6.20387L12.5475 10.4277L13.5819 15.9311L8.39409 13.2425L3.20626 15.9311L4.24065 10.4277L0 6.20387L5.79819 5.30994L8.39409 0.192139Z" fill="#fff"></path>' +
        '</svg><span>{rate}</span>' +
      '</div>');
    Lampa.Template.add('online_prestige_folder',
      '<div class="online-prestige online-prestige--folder selector">' +
        '<div class="online-prestige__folder">' +
          '<svg viewBox="0 0 128 112" fill="none" xmlns="http://www.w3.org/2000/svg">' +
            '<rect y="20" width="128" height="92" rx="13" fill="white"/>' +
            '<path d="M29.9963 8H98.0037C96.0446 3.3021 91.4079 0 86 0H42C36.5921 0 31.9555 3.3021 29.9963 8Z" fill="white" fill-opacity="0.23"/>' +
            '<rect x="11" y="8" width="106" height="76" rx="13" fill="white" fill-opacity="0.51"/>' +
          '</svg>' +
        '</div>' +
        '<div class="online-prestige__body">' +
          '<div class="online-prestige__head">' +
            '<div class="online-prestige__title">{title}</div>' +
            '<div class="online-prestige__time">{time}</div>' +
          '</div>' +
          '<div class="online-prestige__footer">' +
            '<div class="online-prestige__info">{info}</div>' +
          '</div>' +
        '</div>' +
      '</div>');
  }

  /* ============================================================ *
   *  SETTINGS UI                                                 *
   * ============================================================ */

  function addSettings() {
    // ensure default values exist so they appear in storage
    if (Lampa.Storage.get(KEY_MAX_QUAL, '') === '') Lampa.Storage.set(KEY_MAX_QUAL, '1080');
    // Default migration history:
    //   v1: '' → no value
    //   v2: '' → 'http' (was wrong — laggy on Tizen)
    //   v3: → 'hls4' (still wrong — broken on Lampa-built-in player)
    //   v4: → 'auto'  (current — smart pick by player type)
    if (Lampa.Storage.get('kp_format_migrated_v4', '') !== '1') {
      Lampa.Storage.set(KEY_FORMAT, 'auto');
      Lampa.Storage.set('kp_format_migrated_v4', '1');
    }
    if (Lampa.Storage.get(KEY_FORMAT, '') === '') Lampa.Storage.set(KEY_FORMAT, 'auto');
    // 'http' option was removed in v1.0.11 — progressive MP4 freezes on Tizen.
    // Reset anyone explicitly stuck on it.
    if (Lampa.Storage.get(KEY_FORMAT, '') === 'http') Lampa.Storage.set(KEY_FORMAT, 'auto');

    if (!Lampa.SettingsApi) {
      Logger.warn('settings', 'Lampa.SettingsApi unavailable on this build, skipping settings');
      return;
    }

    Lampa.SettingsApi.addComponent({
      component: 'kp',
      name:      'KinoPub',
      icon: '<svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">' +
            '<rect x="6" y="14" width="52" height="36" rx="4" stroke="currentColor" stroke-width="3"/>' +
            '<polygon points="27,24 27,40 41,32" fill="currentColor"/></svg>'
    });

    Lampa.SettingsApi.addParam({
      component: 'kp',
      param: { name: KEY_LOG_URL, type: 'input', values: '', "default": '' },
      field: { name: Lampa.Lang.translate('kp_set_log_url'),  description: Lampa.Lang.translate('kp_set_log_url_descr') },
      onChange: function () { Logger.reload(); }
    });

    Lampa.SettingsApi.addParam({
      component: 'kp',
      param: {
        name: KEY_MAX_QUAL, type: 'select',
        values: { '480': '480p', '720': '720p', '1080': '1080p', '1440': '1440p', '2160': '2160p' },
        "default": '1080'
      },
      field: { name: Lampa.Lang.translate('kp_set_max_quality'), description: Lampa.Lang.translate('kp_set_max_quality_descr') }
    });

    Lampa.SettingsApi.addParam({
      component: 'kp',
      param: {
        name: KEY_FORMAT, type: 'select',
        values: {
          'auto': Lampa.Lang.translate('kp_set_format_auto'),
          'hls4': 'HLS v4 (fMP4)',
          'hls2': 'HLS v2 (TS)',
          'hls':  'HLS'
        },
        "default": 'auto'
      },
      field: { name: Lampa.Lang.translate('kp_set_format'), description: Lampa.Lang.translate('kp_set_format_descr') }
    });

    Lampa.SettingsApi.addParam({
      component: 'kp',
      param: { name: KEY_PROXY, type: 'input', values: '', "default": '' },
      field: { name: Lampa.Lang.translate('kp_set_proxy'), description: Lampa.Lang.translate('kp_set_proxy_descr') }
    });

    Lampa.SettingsApi.addParam({
      component: 'kp',
      param: { name: KEY_SUBS, type: 'trigger', "default": false },
      field: { name: Lampa.Lang.translate('kp_set_subs'), description: Lampa.Lang.translate('kp_set_subs_descr') }
    });

    Lampa.SettingsApi.addParam({
      component: 'kp',
      param: { name: 'kp_action_logout', type: 'trigger', "default": false },
      field: { name: Lampa.Lang.translate('kp_set_logout'), description: Lampa.Lang.translate('kp_set_logout_descr') },
      onChange: function () {
        KP.clearTokens();
        Logger.info('settings', 'tokens cleared by user');
        Lampa.Noty.show(Lampa.Lang.translate('kp_logged_out'));
      }
    });

    Lampa.SettingsApi.addParam({
      component: 'kp',
      param: { name: 'kp_action_login', type: 'trigger', "default": false },
      field: { name: Lampa.Lang.translate('kp_set_login'), description: Lampa.Lang.translate('kp_set_login_descr') },
      onChange: function () { openAuthModal(); }
    });

    Lampa.SettingsApi.addParam({
      component: 'kp',
      param: { name: 'kp_action_region', type: 'trigger', "default": false },
      field: { name: Lampa.Lang.translate('kp_set_region'), description: Lampa.Lang.translate('kp_set_region_descr') },
      onChange: function () {
        Lampa.Noty.show(Lampa.Lang.translate('kp_region_running'));
        setupRegion(true, function (ok, name) {
          Lampa.Noty.show(ok
            ? Lampa.Lang.translate('kp_region_done') + ': ' + name
            : Lampa.Lang.translate('kp_region_fail'));
        });
      }
    });
  }

  /* ============================================================ *
   *  STARTUP                                                     *
   * ============================================================ */

  function launchActivity(movie) {
    var ruTitle = (movie && (movie.title || movie.name)) || '';
    var origTitle = (movie && (movie.original_title || movie.original_name)) || '';
    Logger.info('launch', 'open activity', { id: movie && movie.id, title: ruTitle, orig: origTitle });
    Lampa.Activity.push({
      url:        '',
      title:      Lampa.Lang.translate('title_online'),
      component:  COMPONENT_NAME,
      search:     ruTitle,
      search_one: ruTitle,
      search_two: origTitle,
      movie:      movie,
      page:       1
    });
  }

  function startPlugin() {
    var manifest = {
      type:        'video',
      version:     PLUGIN_VERSION,
      name:        'KinoPub',
      description: 'Источник kinopub для Lampa (Tizen-friendly)',
      component:   COMPONENT_NAME,
      onContextMenu: function () {
        return { name: Lampa.Lang.translate('kp_watch'), description: '' };
      },
      onContextLauch: function (object) {
        resetTemplates();
        Lampa.Component.add(COMPONENT_NAME, component);
        launchActivity(object);
      }
    };
    Lampa.Manifest.plugins = manifest;

    Lampa.Lang.add({
      kp_watch: {
        ru: 'Смотреть на kinopub',
        en: 'Watch on kinopub',
        ua: 'Дивитися на kinopub'
      },
      kp_auth_title: {
        ru: 'Авторизация kinopub',
        en: 'kinopub authorization',
        ua: 'Авторизація kinopub'
      },
      kp_auth_text: {
        ru: 'Откройте на телефоне или ПК страницу kino.pub/device и введите код:',
        en: 'Open kino.pub/device on your phone or PC and enter the code:',
        ua: 'Відкрийте на телефоні чи ПК сторінку kino.pub/device та введіть код:'
      },
      kp_auth_url: {
        ru: 'https://kino.pub/device',
        en: 'https://kino.pub/device',
        ua: 'https://kino.pub/device'
      },
      kp_auth_wait: {
        ru: 'Получаем код',
        en: 'Getting code',
        ua: 'Отримуємо код'
      },
      kp_auth_error: {
        ru: 'Ошибка авторизации kinopub',
        en: 'kinopub auth error',
        ua: 'Помилка авторизації kinopub'
      },
      kp_copied: {
        ru: 'Код скопирован',
        en: 'Code copied',
        ua: 'Код скопійовано'
      },
      kp_copy_fail: {
        ru: 'Ошибка копирования',
        en: 'Copy error',
        ua: 'Помилка копіювання'
      },
      kp_logged_out: {
        ru: 'Сессия kinopub очищена',
        en: 'kinopub session cleared',
        ua: 'Сесію kinopub очищено'
      },
      kp_set_log_url: {
        ru: 'URL лог-сервера',
        en: 'Log server URL',
        ua: 'URL лог-серверу'
      },
      kp_set_log_url_descr: {
        ru: 'Адрес сервера для удалённого приёма логов плагина (например http://192.168.1.10:8088). Оставьте пустым чтобы выключить.',
        en: 'Address of remote log server (e.g. http://192.168.1.10:8088). Empty to disable.',
        ua: 'Адреса сервера для віддаленого приймання логів (наприклад http://192.168.1.10:8088). Порожнє - вимкнути.'
      },
      kp_set_max_quality: {
        ru: 'Макс. качество',
        en: 'Max quality',
        ua: 'Макс. якість'
      },
      kp_set_max_quality_descr: {
        ru: 'Верхняя граница качества при выборе потока',
        en: 'Upper limit of stream quality',
        ua: 'Верхня межа якості потоку'
      },
      kp_set_format: {
        ru: 'Формат потока',
        en: 'Stream format',
        ua: 'Формат потоку'
      },
      kp_set_format_descr: {
        ru: 'Авто = подбирать формат под текущий плеер: HLS4 для нативного Tizen-плеера (4K + полная поддержка озвучек), HLS2 для встроенного плеера Lampa (стабильно, без зависаний на fMP4). HLS4/HLS2/HLS — принудительно.',
        en: 'Auto = pick format by current player: HLS4 for Tizen native player (4K + full audio tracks), HLS2 for Lampa built-in (stable, no fMP4 hangs). HLS4/HLS2/HLS = forced.',
        ua: 'Авто = підбирати формат під плеєр: HLS4 для Tizen, HLS2 для вбудованого Lampa.'
      },
      kp_set_format_auto: {
        ru: 'Авто (по плееру)',
        en: 'Auto (by player)',
        ua: 'Авто (за плеєром)'
      },
      kp_set_proxy: {
        ru: 'CORS-прокси',
        en: 'CORS proxy',
        ua: 'CORS-проксі'
      },
      kp_set_proxy_descr: {
        ru: 'Опционально. Если api kinopub режут CORS - укажите http(s)-прокси, на который добавится URL запроса. Оставьте пустым на Tizen.',
        en: 'Optional. Address of CORS proxy if needed. Leave empty on Tizen.',
        ua: 'Не обовязково. Адреса CORS-проксі якщо потрібно.'
      },
      kp_set_subs: {
        ru: 'Внешние субтитры',
        en: 'External subtitles',
        ua: 'Зовнішні субтитри'
      },
      kp_try_format: {
        ru: 'Запустить в формате...',
        en: 'Launch in format...',
        ua: 'Запустити у форматі...'
      },
      kp_format_clear: {
        ru: 'Сбросить (использовать настройку)',
        en: 'Reset (use setting)',
        ua: 'Скинути (використати налаштування)'
      },
      kp_fallback: {
        ru: 'Откат на формат',
        en: 'Falling back to',
        ua: 'Відкат на формат'
      },
      kp_set_subs_descr: {
        ru: 'Передавать плееру URL .vtt-субтитров от kinopub. Если плеер виснет на старте — выключите.',
        en: 'Attach kinopub .vtt subtitle URLs to the player. If playback hangs — turn off.',
        ua: 'Передавати плеєру URL субтитрів kinopub. Якщо плеєр зависає - вимкніть.'
      },
      kp_set_logout: {
        ru: 'Выйти из аккаунта',
        en: 'Logout',
        ua: 'Вийти з акаунту'
      },
      kp_set_logout_descr: {
        ru: 'Удалить токены kinopub из памяти',
        en: 'Remove kinopub tokens from storage',
        ua: 'Видалити токени kinopub'
      },
      kp_set_login: {
        ru: 'Авторизоваться',
        en: 'Sign in',
        ua: 'Авторизуватися'
      },
      kp_set_login_descr: {
        ru: 'Открыть окно с кодом для kino.pub/device',
        en: 'Open the kino.pub/device code dialog',
        ua: 'Відкрити вікно з кодом для kino.pub/device'
      },
      kp_set_region: {
        ru: 'Авто-выбор региона CDN',
        en: 'Auto-pick CDN region',
        ua: 'Автовибір регіону CDN'
      },
      kp_set_region_descr: {
        ru: 'Опционально. Полноценное управление настройками устройства доступно на kino.pub в разделе устройств. Эта кнопка - быстрый способ переключить kinopub на ближайший CDN (RU/UA/BY) одним нажатием.',
        en: 'Optional shortcut. Full device-settings UI is available on kino.pub. This just switches the device to a CIS CDN (RU/UA/BY) in one tap.',
        ua: 'Опціонально. Повне керування налаштуваннями пристрою доступне на kino.pub. Ця кнопка - швидке перемикання на найближчий CDN (RU/UA/BY).'
      },
      kp_region_running: {
        ru: 'Перенастройка региона...',
        en: 'Re-configuring region...',
        ua: 'Переналаштування регіону...'
      },
      kp_region_done: {
        ru: 'Регион',
        en: 'Region',
        ua: 'Регіон'
      },
      kp_region_fail: {
        ru: 'Не удалось перенастроить регион (см. лог)',
        en: 'Failed to re-configure region (see log)',
        ua: 'Не вдалося переналаштувати регіон (див. лог)'
      },
      online_balanser_dont_work: {
        ru: 'Ничего не нашлось',
        en: 'Nothing found',
        ua: 'Нічого не знайдено'
      }
    });

    injectStyles();
    resetTemplates();

    Lampa.Component.add(COMPONENT_NAME, component);

    // settings
    addSettings();

    // button on movie card
    var button = '' +
      '<div class="full-start__button selector view--online" data-subtitle="KinoPub v' + PLUGIN_VERSION + '">' +
        '<svg width="135" height="147" viewBox="0 0 135 147" fill="none" xmlns="http://www.w3.org/2000/svg">' +
          '<path d="M121.5 96.8823C139.5 86.49 139.5 60.5092 121.5 50.1169L41.25 3.78454C23.25 -6.60776 0.750004 6.38265 0.750001 27.1673L0.75 51.9742C4.70314 35.7475 23.6209 26.8138 39.0547 35.7701L94.8534 68.1505C110.252 77.0864 111.909 97.8693 99.8725 109.369L121.5 96.8823Z" fill="currentColor"/>' +
          '<path d="M63 84.9836C80.3333 94.991 80.3333 120.01 63 130.017L39.75 143.44C22.4167 153.448 0.749999 140.938 0.75 120.924L0.750001 94.0769C0.750002 74.0621 22.4167 61.5528 39.75 71.5602L63 84.9836Z" fill="currentColor"/>' +
        '</svg>' +
        '<span>KinoPub</span>' +
      '</div>';

    Lampa.Listener.follow('full', function (e) {
      if (e.type !== 'complite') return;
      try {
        var btn = $(Lampa.Lang.translate(button));
        btn.on('hover:enter', function () {
          resetTemplates();
          Lampa.Component.add(COMPONENT_NAME, component);
          launchActivity(e.data.movie);
        });
        var holder = e.object.activity.render();
        var anchor = holder.find('.view--torrent');
        if (anchor.length) anchor.after(btn);
        else {
          var buttons = holder.find('.full-start-new__buttons, .full-start__buttons').first();
          if (buttons.length) buttons.append(btn);
          else holder.find('.full-start__button').first().after(btn);
        }
      } catch (err) {
        Logger.error('button', 'mount failed', String(err));
      }
    });

    // Background token health check
    if (KP.hasToken()) {
      var bg = new Lampa.Reguest();
      KP.profile(bg, function (j) {
        Logger.info('auth', 'profile ok', j && j.user && { name: j.user.username, subscribed: j.user.subscription });
      }, function () {
        Logger.warn('auth', 'profile check failed');
      });
      // Refresh device identity on every startup — kinoapi.com docs recommend
      // this so kinopub UI keeps device record up-to-date with current OS/build.
      notifyDeviceIdentity(new Lampa.Reguest());
    } else {
      Logger.info('auth', 'no token at startup');
    }

    if (Lampa.Manifest.app_digital >= 177) {
      Lampa.Storage.sync('online_choice_' + BALANSER, 'object_object');
    }

    // Subscribe to GLOBAL Lampa.Listener channels (only app/activity/controller
    // actually fire here — `player` and `video` channels DON'T exist globally).
    var DENY_TYPES = { timeupdate: 1, progress: 1, time: 1, tick: 1 };
    function logEvt(channel, e) {
      if (!e || !e.type) return;
      if (DENY_TYPES[e.type]) return;
      var data = {};
      if (e.url)               data.url      = String(e.url).slice(0, 200);
      if (e.code != null)      data.code     = e.code;
      if (e.message)           data.message  = String(e.message).slice(0, 400);
      if (e.error)             data.error    = String(e.error).slice(0, 400);
      if (e.fatal != null)     data.fatal    = e.fatal;
      if (e.time != null)      data.time     = e.time;
      if (e.duration != null)  data.duration = e.duration;
      if (e.status != null)    data.status   = e.status;
      if (e.down)              data.down     = e.down;
      if (e.networkState != null) data.networkState = e.networkState;
      if (e.readyState != null)   data.readyState   = e.readyState;
      Logger.info('lampa-evt', channel + '/' + e.type, Object.keys(data).length ? data : undefined);
    }
    ['app', 'activity', 'controller'].forEach(function (ch) {
      try {
        Lampa.Listener.follow(ch, function (e) { logEvt(ch, e); });
      } catch (err) {
        Logger.warn('lampa-evt', 'cannot follow ' + ch, String(err));
      }
    });

    // Lampa keeps player events on LOCAL listeners on its modules, NOT global.
    // Player.listener: create / start / ready / destroy / external
    // PlayerVideo.listener: error / canplay / loadeddata / ended / tracks / levels / subs / translate
    //   error payload: { error: <string>, fatal: <bool> }  ← what we need
    try {
      if (Lampa.Player && Lampa.Player.listener) {
        ['create', 'start', 'ready', 'destroy', 'external'].forEach(function (evt) {
          Lampa.Player.listener.follow(evt, function (e) { logEvt('Player', { type: evt }); });
        });
        // DOM injection for next-episode-name override
        Lampa.Player.listener.follow('start',   function () { setupNextEpisodeLabelOverride(); });
        Lampa.Player.listener.follow('destroy', function () { cleanupNextEpisodeLabelOverride(); });
        // After the player closes, repaint chips on visible cards so episodes
        // that just gained timeline progress flip from green to faded immediately.
        Lampa.Player.listener.follow('destroy', function () {
          // Small delay to let Lampa flush the timeline update before we read it.
          setTimeout(refreshAllKpVoiceChips, 100);
        });
      } else {
        Logger.warn('player-evt', 'Lampa.Player.listener unavailable');
      }
    } catch (err) {
      Logger.warn('player-evt', 'Player.listener failed', String(err));
    }
    try {
      if (Lampa.PlayerVideo && Lampa.PlayerVideo.listener) {
        // every event we care about — error first because that's the diagnosis goal
        ['error', 'canplay', 'loadeddata', 'ended', 'tracks', 'levels', 'subs', 'translate', 'play', 'pause', 'rewind']
          .forEach(function (evt) {
            Lampa.PlayerVideo.listener.follow(evt, function (e) {
              logEvt('PlayerVideo', { type: evt,
                error:   e && e.error,
                fatal:   e && e.fatal,
                tracks:  e && e.tracks && e.tracks.length,
                levels:  e && e.levels && e.levels.length,
                subs:    e && e.subs && e.subs.length
              });
            });
          });

        // Voice track switching — fired when audio backend has read tracks
        // and the stream is ready. We try canplay first, then fall back to
        // tracks event (hls.js fires it after loading), whichever comes first.
        var voiceApplied = false;
        function tryApplyPendingVoice(source) {
          if (voiceApplied || !pendingVoice || pendingVoice.idx < 0) return;
          Logger.debug('voice', 'apply via ' + source, pendingVoice);
          if (applyVoiceTrack(pendingVoice.idx)) {
            voiceApplied = true;
          }
        }
        Lampa.PlayerVideo.listener.follow('canplay',    function () { tryApplyPendingVoice('canplay'); });
        Lampa.PlayerVideo.listener.follow('loadeddata', function () { tryApplyPendingVoice('loadeddata'); });
        Lampa.PlayerVideo.listener.follow('tracks',     function () { tryApplyPendingVoice('tracks'); });
        // reset the one-shot guard when player is destroyed so next launch can apply again
        Lampa.Player.listener.follow('destroy', function () {
          voiceApplied = false;
          pendingVoice = null;
        });
      } else {
        Logger.warn('player-evt', 'Lampa.PlayerVideo.listener unavailable');
      }
    } catch (err) {
      Logger.warn('player-evt', 'PlayerVideo.listener failed', String(err));
    }

    // Direct delegate on any <video> element that gets created by Lampa.
    // Captures HTMLMediaElement errors which often don't reach console.
    try {
      $(document).on('error', 'video', function (e) {
        var v = e && e.target;
        var err = v && v.error;
        Logger.error('video-elem', 'native error', {
          code: err && err.code,
          message: err && err.message,
          src: v && (v.currentSrc || v.src || '').slice(0, 200),
          networkState: v && v.networkState,
          readyState: v && v.readyState
        });
      });
      $(document).on('stalled waiting abort', 'video', function (e) {
        var v = e && e.target;
        Logger.warn('video-elem', e.type, {
          src: v && (v.currentSrc || v.src || '').slice(0, 200),
          networkState: v && v.networkState,
          readyState: v && v.readyState
        });
      });
    } catch (err) {
      Logger.warn('video-elem', 'delegate error handler failed', String(err));
    }

    Logger.info('boot', 'kp.js initialized');
  }

  startPlugin();

})();
