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

  var PLUGIN_VERSION  = '1.0.1';
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
    var FLUSH_DELAY = 1500;

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

    return {
      tokenAccess:     tokenAccess,
      hasToken:        function () { return !!tokenAccess(); },
      clearTokens:     clearTokens,
      deviceCode:      deviceCode,
      pollDeviceToken: pollDeviceToken,
      refresh:         refresh,
      search: function (network, query, ok, err) {
        api(network, '/items', { q: query, perpage: 50 }, ok, err);
      },
      item: function (network, id, ok, err) {
        api(network, '/items/' + id, null, ok, err);
      },
      profile: function (network, ok, err) {
        api(network, '/user', null, ok, err);
      }
    };
  })();

  /* ============================================================ *
   *  HELPERS                                                     *
   * ============================================================ */

  function maxQuality() {
    var q = parseInt(Lampa.Storage.get(KEY_MAX_QUAL, '1080'), 10);
    return q > 0 ? q : 1080;
  }

  function preferredFormat() {
    return Lampa.Storage.get(KEY_FORMAT, 'http'); // http | hls | hls2 | hls4
  }

  function normalize(s) {
    s = String(s || '');
    // strip latin diacritics ("Léon" -> "Leon") if NFD is supported
    try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) {}
    return s.toLowerCase().replace(/[^a-zЀ-ӿ0-9]/g, '');
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
    var fmtList = format === 'auto'
      ? ['http', 'hls4', 'hls2', 'hls']
      : [format, 'http', 'hls4', 'hls2', 'hls'];

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
    var network = new Lampa.Reguest();
    var object  = _object;

    var raw      = null;          // /v1/items/{id} response
    var extract  = null;          // normalized
    var choice   = { season: 0, voice: 0, voice_name: '' };
    var filterItems = {};
    var waitSimilars = false;

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
      Logger.info('source', 'searchByTitle', { query: query, year: year, orig: orig });

      network.clear();
      KP.search(network, query, function (json) {
        var items = (json && json.items) || [];
        Logger.info('source', 'search ok', { count: items.length });

        // 1) try exact match by year + original title
        var card = items.find(function (c) {
          var cy = parseInt((c.year || 0), 10);
          return cy === year && normalize(c.orig_title || c.title) === normalize(orig || rus);
        });

        // 2) try year window + title
        if (!card) {
          card = items.find(function (c) {
            var cy = parseInt((c.year || 0), 10);
            return Math.abs(cy - year) <= 1 &&
                   (normalize(c.orig_title) === normalize(orig) ||
                    normalize(c.title) === normalize(rus));
          });
        }

        // 3) only one — take it
        if (!card && items.length === 1) card = items[0];

        if (card) {
          Logger.info('source', 'matched card', { id: card.id, title: card.title, year: card.year });
          self.find(card.id);
        } else if (items.length) {
          Logger.info('source', 'showing similars', { count: items.length });
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
      if (a.stype === 'voice') choice.voice_name = filterItems.voice[b.index] || '';
      component.reset();
      buildFilter();
      append(filtered());
    };

    this.destroy = function () {
      Logger.debug('source', 'destroy');
      network.clear();
      raw = null;
      extract = null;
    };

    /* ---------- internal helpers ---------- */

    function adaptSimilar(c) {
      // map kinopub item summary to the fields filmix-like .similars() expects
      return {
        id:           c.id,
        title:        c.title,
        ru_title:     c.title,
        en_title:     c.orig_title,
        orig_title:   c.orig_title,
        year:         c.year,
        start_date:   c.year,
        rating:       c.rating || c.imdb_rating || c.kinopoisk_rating,
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
      raw = item;
      extractData(item);
      buildFilter();
      append(filtered());
    }

    function extractData(item) {
      extract = { type: 'movie', voices: [], seasons: [], movie: null };

      var hasSeasons = item.seasons && item.seasons.length;
      var hasVideos  = item.videos  && item.videos.length;

      if (hasSeasons) {
        extract.type = 'serial';
        // Build voices list: kinopub has audios per episode (embedded). We expose
        // a "voice" filter that lists the union of audios as informational labels;
        // selecting one doesn't change the URL — switching is handled by player.
        var voiceMap = {};
        item.seasons.forEach(function (s) {
          (s.episodes || []).forEach(function (ep) {
            (ep.audios || []).forEach(function (a) {
              var key = (a.lang || '') + '|' + ((a.type && a.type.title) || '');
              voiceMap[key] = {
                key:   key,
                lang:  a.lang || '',
                type:  (a.type && a.type.title) || '',
                label: ((a.type && a.type.title) ? a.type.title + ' ' : '') + (a.lang || '')
              };
            });
          });
        });
        extract.voices = Object.keys(voiceMap).map(function (k) { return voiceMap[k]; });

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

        Logger.debug('source', 'extracted serial', {
          seasons: extract.seasons.length,
          totalEpisodes: extract.seasons.reduce(function (n, s) { return n + s.episodes.length; }, 0),
          voices: extract.voices.length
        });
      } else if (hasVideos) {
        extract.type = 'movie';
        var v = item.videos[0];
        extract.movie = {
          files:     parseFiles(v.files),
          audios:    v.audios || [],
          subtitles: v.subtitles || []
        };
        var voiceMap2 = {};
        (v.audios || []).forEach(function (a) {
          var key = (a.lang || '') + '|' + ((a.type && a.type.title) || '');
          voiceMap2[key] = {
            key:   key,
            lang:  a.lang || '',
            type:  (a.type && a.type.title) || '',
            label: ((a.type && a.type.title) ? a.type.title + ' ' : '') + (a.lang || '')
          };
        });
        extract.voices = Object.keys(voiceMap2).map(function (k) { return voiceMap2[k]; });

        Logger.debug('source', 'extracted movie', {
          files: extract.movie.files.length,
          audios: extract.movie.audios.length,
          subs: extract.movie.subtitles.length
        });
      } else {
        Logger.warn('source', 'no playable structure in item', { id: item.id, type: item.type });
      }
    }

    function buildFilter() {
      filterItems = { season: [], voice: [], voice_info: [] };

      if (extract && extract.type === 'serial') {
        extract.seasons.forEach(function (s, i) {
          filterItems.season.push(Lampa.Lang.translate('torrent_serial_season') + ' ' + (s.number || i + 1));
        });
      }
      if (extract && extract.voices && extract.voices.length) {
        extract.voices.forEach(function (v, i) {
          filterItems.voice.push(v.label || v.lang || ('voice ' + (i + 1)));
          filterItems.voice_info.push({ id: i + 1, key: v.key });
        });
      }

      if (choice.voice_name) {
        var inx = filterItems.voice.map(function (v) { return v.toLowerCase(); }).indexOf(choice.voice_name.toLowerCase());
        if (inx === -1) choice.voice = 0;
        else if (inx !== choice.voice) choice.voice = inx;
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
          var info   = audioInfo(ep.audios);
          return {
            kp:           { kind: 'episode', files: ep.files, audios: ep.audios, subtitles: ep.subtitles },
            episode:      ep.number,
            season:       season.number,
            title:        Lampa.Lang.translate('torrent_serial_episode') + ' ' + ep.number + (ep.title ? ' - ' + ep.title : ''),
            quality:      stream ? (stream.currentQuality + 'p ') : '',
            translation:  1,
            voice_name:   filterItems.voice[choice.voice] || '',
            info:         info
          };
        });
      } else if (extract.type === 'movie' && extract.movie) {
        var stream2 = pickStream(extract.movie.files, fmt);
        var info2   = audioInfo(extract.movie.audios);
        return [{
          kp:          { kind: 'movie', files: extract.movie.files, audios: extract.movie.audios, subtitles: extract.movie.subtitles },
          title:       (object.movie && (object.movie.title || object.movie.name)) || '',
          quality:     stream2 ? (stream2.currentQuality + 'p ') : '',
          translation: 1,
          voice_name:  filterItems.voice[choice.voice] || '',
          info:        info2
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

    function toPlayElement(element) {
      var stream = streamForElement(element, element.quality);
      if (!stream) return null;
      var play = {
        title:    element.title,
        url:      stream.url,
        quality:  stream.quality,
        timeline: element.timeline,
        callback: element.mark
      };
      var subs = buildSubtitles(element.kp.subtitles);
      if (subs.length) {
        play.subtitles = subs;
        // Some Lampa builds + Tizen AVPlayer expect a single `subtitle` field for the
        // initially active external track. We pass the first one as a hint.
        play.subtitle = subs[0].url;
      }
      Logger.debug('player', 'play-element built', {
        title: play.title, url: play.url, q: stream.currentQuality, subs: subs.length
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
          if (playlist.length > 1) play.playlist = playlist;
          Logger.info('player', 'launching', { url: play.url, playlist: playlist.length });
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
        season: 0, voice: 0, voice_name: '', voice_id: 0,
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
          };

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
    if (Lampa.Storage.get(KEY_FORMAT,   '') === '') Lampa.Storage.set(KEY_FORMAT,   'http');

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
        values: { 'http': 'HTTP / mp4', 'hls4': 'HLS v4', 'hls2': 'HLS v2', 'hls': 'HLS', 'auto': Lampa.Lang.translate('kp_set_format_auto') },
        "default": 'http'
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
        ru: 'Что брать из url-полей kinopub. http = mp4, hls = m3u8',
        en: 'Which url-field to use. http = mp4, hls = m3u8',
        ua: 'Яке поле url використовувати. http = mp4, hls = m3u8'
      },
      kp_set_format_auto: {
        ru: 'Авто',
        en: 'Auto',
        ua: 'Авто'
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
    } else {
      Logger.info('auth', 'no token at startup');
    }

    if (Lampa.Manifest.app_digital >= 177) {
      Lampa.Storage.sync('online_choice_' + BALANSER, 'object_object');
    }

    Logger.info('boot', 'kp.js initialized');
  }

  startPlugin();

})();
