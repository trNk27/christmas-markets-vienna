/* Vienna Christmas market tracker — UI (map, list, filters, detail, gallery). Classic script. */
(function () {
  'use strict';

  var MS = window.MarketStatus;
  var Crowd = window.Crowd;
  var MARKETS = (window.MARKETS || []).slice();
  var byId = {};
  MARKETS.forEach(function (m) { byId[m.id] = m; });

  var TAGS = [
    ['ice-skating', 'Ice skating'], ['kids', 'Good for kids'], ['crafts', 'Crafts'], ['foodie', 'Foodie'],
    ['art', 'Art'], ['quiet', 'Quiet'], ['romantic', 'Romantic'], ['views', 'Views'],
    ['alternative', 'Alternative'], ['organic', 'Organic'], ['after-christmas', 'Open after Christmas'],
    ['new-year', "New Year's"], ['rides', 'Rides'], ['live-music', 'Live music'], ['imperial', 'Imperial']
  ];
  var STATE_RANK = { 'open': 0, 'closing-soon': 0, 'opens-today': 1, 'closed-today': 2, 'pre-season': 3, 'season-over': 4 };
  var STATE_CLASS = { 'open': 'open', 'closing-soon': 'closing', 'opens-today': 'later', 'closed-today': 'closed', 'pre-season': 'pre', 'season-over': 'over' };
  var PIN_CLASS = { 'open': 'open', 'closing-soon': 'open', 'opens-today': 'later', 'closed-today': 'off', 'pre-season': 'off', 'season-over': 'off' };
  var SIZE = { small: 'Small', medium: 'Medium', large: 'Large' };
  var DESKTOP = window.matchMedia('(min-width: 900px)');
  var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');

  var state = {
    when: null,            // null = live; else { date:'YYYY-MM-DD', time:'HH:MM' }
    search: '',
    openOnly: false,
    tags: [],
    sort: 'recommended',
    selected: null,
    userPos: null,
    theme: document.documentElement.getAttribute('data-theme') || 'dark'
  };
  var statusCache = {};

  // ---------------------------------------------------------------- helpers
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function icon(id, cls) { return '<svg class="ic ' + (cls || '') + '" aria-hidden="true"><use href="#' + id + '"/></svg>'; }
  function districtLabel(n) {
    if (!n) return '';
    var s = (n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
    return n + s + ' district';
  }
  function tagLabel(t) { for (var i = 0; i < TAGS.length; i++) if (TAGS[i][0] === t) return TAGS[i][1]; return t; }
  function safeUrl(u) { return /^(https?:)?\/\//i.test(u || '') || /^[\w./-]+$/.test(u || '') ? u : '#'; }
  function store(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } }
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  function moment() { return state.when ? MS.fromVienna(state.when.date, state.when.time) : new Date(); }
  function isLive() { return !state.when; }
  function statusOf(m) {
    if (!statusCache[m.id]) statusCache[m.id] = MS.statusAt(m, moment(), { live: isLive() });
    return statusCache[m.id];
  }
  function invalidate() { statusCache = {}; }
  function isOpenState(s) { return s.state === 'open' || s.state === 'closing-soon'; }

  function distanceKm(m) {
    if (!state.userPos) return null;
    var R = 6371, toR = Math.PI / 180;
    var dLat = (m.lat - state.userPos.lat) * toR, dLng = (m.lng - state.userPos.lng) * toR;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(state.userPos.lat * toR) * Math.cos(m.lat * toR) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  function fmtKm(km) { return km < 1 ? Math.round(km * 1000 / 10) * 10 + ' m' : km.toFixed(km < 10 ? 1 : 0) + ' km'; }

  function pillHTML(s, big) {
    return '<span class="pill pill--' + STATE_CLASS[s.state] + (big ? ' pill--big' : '') + '"><span class="pill-dot" aria-hidden="true"></span>' + esc(s.label) + '</span>';
  }
  function meterHTML(level, label, small) {
    var segs = '';
    for (var i = 0; i < 5; i++) segs += '<span class="' + (level != null && i <= level ? 'on' : '') + '"></span>';
    return '<span class="meter' + (small ? ' meter--sm' : '') + (level == null ? ' meter--none' : '') + '" role="img" aria-label="' + esc(label) + '">' + segs + '</span>';
  }

  // ---------------------------------------------------------------- theme
  function applyTheme(t, persist) {
    state.theme = t;
    document.documentElement.setAttribute('data-theme', t);
    var btn = $('themeBtn');
    btn.innerHTML = '<svg aria-hidden="true"><use href="#' + (t === 'dark' ? 'i-sun' : 'i-moon') + '"/></svg>';
    btn.setAttribute('aria-label', t === 'dark' ? 'Switch to daytime theme' : 'Switch to evening theme');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#0b1020' : '#f5f2ec');
    if (persist) store('xm-theme', t);
    setTiles();
    if (dio.handle && state.selected) {
      if (typeof dio.handle.setTheme === 'function') { try { dio.handle.setTheme(t); } catch (e) { remountDiorama(); } }
      else remountDiorama();
    }
  }

  // ---------------------------------------------------------------- map
  var map, tiles, markers = {}, userMarker;
  // OpenStreetMap standard tiles in both themes; the evening theme darkens them with a CSS filter.
  var TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  var TILE_ATTR = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>';
  var LABEL_ZOOM = 17;   // all labels permanent from this zoom; below it only the selected one

  function initMap() {
    if (!window.L) return;
    map = L.map('map', { zoomControl: false, attributionControl: true, minZoom: 11, maxZoom: 19, zoomSnap: 0.25 });
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    map.attributionControl.setPrefix(false);
    var pts = [];
    MARKETS.forEach(function (m) {
      pts.push([m.lat, m.lng]);
      var mk = L.marker([m.lat, m.lng], {
        icon: L.divIcon({ className: 'mk', html: '<span class="pin"><span class="pin-glow"></span><span class="pin-core"></span></span>', iconSize: [30, 30], iconAnchor: [15, 15] }),
        keyboard: true, riseOnHover: true
      });
      mk.on('click', function () { go(m.id); });
      mk.on('mouseover', function () { hot(m.id, true); });
      mk.on('mouseout', function () { hot(m.id, false); });
      mk.addTo(map);
      markers[m.id] = mk;
      bindTip(m, false);
      var el = mk.getElement();
      if (el) el.setAttribute('aria-label', m.name + ', ' + m.location);
    });
    fitAll(false);
    map.on('zoomend', updateTipMode);
    updateTipMode();
  }

  function fitAll(animate) {
    if (!map || !MARKETS.length) return;
    var b = L.latLngBounds(MARKETS.map(function (m) { return [m.lat, m.lng]; }));
    map.fitBounds(b, { padding: [48, 48], maxZoom: 15, animate: !!animate });
  }

  function setTiles() {
    // One tile layer for both themes: the theme only swaps a CSS filter, so the layer is created once.
    if (!map || tiles) return;
    tiles = L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTR }).addTo(map);
  }

  /** Short map label: text before the first comma, " / " or "(", max ~22 chars. */
  function shortLabel(m) {
    var t = String(m.location || m.name).split(/,| \/ | \(/)[0].trim();
    return t.length > 22 ? t.slice(0, 21).trim() + '…' : t;
  }
  var tipPerm = {};
  function bindTip(m, permanent) {
    var mk = markers[m.id];
    tipPerm[m.id] = permanent;
    mk.unbindTooltip();
    mk.bindTooltip(esc(shortLabel(m)), { direction: 'top', offset: [0, -12], permanent: permanent, className: 'mk-tip' + (permanent ? ' mk-tip--perm' : ''), opacity: 1 });
  }
  function updateTipMode() {
    if (!map) return;
    var all = map.getZoom() >= LABEL_ZOOM;
    MARKETS.forEach(function (m) {
      var want = all || state.selected === m.id;
      if (tipPerm[m.id] !== want) bindTip(m, want);
    });
  }

  function updateMarkers(visibleIds) {
    if (!map) return;
    MARKETS.forEach(function (m) {
      var el = markers[m.id].getElement();
      if (!el) return;
      var s = statusOf(m);
      el.classList.remove('mk--open', 'mk--later', 'mk--off');
      el.classList.add('mk--' + PIN_CLASS[s.state]);
      el.classList.toggle('is-dim', !visibleIds[m.id]);
      el.classList.toggle('is-selected', state.selected === m.id);
      el.setAttribute('aria-label', m.name + ' — ' + s.label);
      markers[m.id].setZIndexOffset(state.selected === m.id ? 1000 : (visibleIds[m.id] ? 100 : 0));
    });
    updateTipMode();
  }

  function flyToMarket(m) {
    if (!map) return;
    var z = Math.max(map.getZoom(), 15);
    var shift = 0;
    if (DESKTOP.matches) {
      var panel = $('detail').offsetWidth || 540, side = $('sidebar').offsetWidth || 400;
      shift = Math.max(0, (panel - side) / 2);
    }
    var pt = map.project([m.lat, m.lng], z).subtract([shift, 0]);
    var target = map.unproject(pt, z);
    if (REDUCED.matches) map.setView(target, z, { animate: false });
    else map.flyTo(target, z, { duration: 0.8 });
  }

  function hot(id, on) {
    var c = document.querySelector('.card[data-id="' + id + '"]');
    if (c) c.classList.toggle('is-hot', on);
    var mk = markers[id];
    if (mk && mk.getElement()) {
      mk.getElement().classList.toggle('is-hot', on);
      if (!tipPerm[id]) { if (on) mk.openTooltip(); else mk.closeTooltip(); }
    }
  }

  function locate() {
    if (!navigator.geolocation) return;
    var btn = $('locateBtn');
    btn.classList.add('is-busy');
    navigator.geolocation.getCurrentPosition(function (pos) {
      btn.classList.remove('is-busy');
      btn.classList.add('is-on');
      state.userPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      var opt = $('sortSel').querySelector('option[value="nearest"]');
      opt.disabled = false; opt.textContent = 'Nearest';
      state.sort = 'nearest'; $('sortSel').value = 'nearest';
      if (map) {
        if (userMarker) map.removeLayer(userMarker);
        userMarker = L.marker([state.userPos.lat, state.userPos.lng], {
          icon: L.divIcon({ className: 'me', html: '<span class="me-dot"></span>', iconSize: [18, 18] }), keyboard: false, interactive: false
        }).addTo(map);
      }
      render();
    }, function () { btn.classList.remove('is-busy'); }, { timeout: 10000, maximumAge: 300000 });
  }

  // ---------------------------------------------------------------- planner ("When are you going?")
  function viennaNow() { return MS.viennaParts(new Date()); }

  function quickPicks() {
    var now = viennaNow(), today = now.isoDate, wd = now.weekday;
    var toSat = wd === 6 ? 7 : (6 - wd), toSun = wd === 0 ? 7 : (7 - wd);
    if (wd === 6) toSun = 8; // Saturday today → next weekend
    var sat = MS.addDays(today, toSat), sun = MS.addDays(today, toSun);
    var tonightDate = now.minutes >= 21 * 60 ? MS.addDays(today, 1) : today;
    return [
      { key: 'now', label: 'Now', when: null, title: 'Live status for right now — updates every 30 s' },
      { key: 'tonight', label: tonightDate === today ? 'Tonight 19:00' : 'Tomorrow 19:00', when: { date: tonightDate, time: '19:00' } },
      { key: 'tomorrow', label: 'Tomorrow', when: { date: MS.addDays(today, 1), time: '17:00' }, title: MS.fmtDay(MS.addDays(today, 1)) + ', 17:00' },
      { key: 'sat', label: 'Sat ' + MS.fmtShort(sat).split(' ')[0], when: { date: sat, time: '17:00' }, title: MS.fmtDay(sat) + ', 17:00' },
      { key: 'sun', label: 'Sun ' + MS.fmtShort(sun).split(' ')[0], when: { date: sun, time: '16:00' }, title: MS.fmtDay(sun) + ', 16:00' }
    ];
  }

  function renderPlanner() {
    var picks = quickPicks(), html = '';
    picks.forEach(function (p) {
      var active = p.when ? (state.when && state.when.date === p.when.date && state.when.time === p.when.time) : !state.when;
      html += '<button type="button" class="chip chip--when' + (active ? ' is-active' : '') + '" data-key="' + p.key + '" aria-pressed="' + active + '"' +
        (p.title ? ' title="' + esc(p.title) + '"' : '') + '>' + (p.key === 'now' ? '<span class="live-dot" aria-hidden="true"></span>' : '') + esc(p.label) + (p.key === 'now' && active ? '<span class="chip-sub"> · live</span>' : '') + '</button>';
    });
    var box = $('whenChips');
    var focusedKey = document.activeElement && box.contains(document.activeElement) ? document.activeElement.getAttribute('data-key') : null;
    box.innerHTML = html;
    if (focusedKey) { var f = box.querySelector('[data-key="' + focusedKey + '"]'); if (f) f.focus(); }
    box._picks = picks;

    var now = viennaNow();
    var d = state.when ? state.when.date : now.isoDate, t = state.when ? state.when.time : now.time;
    if (document.activeElement !== $('whenDate')) $('whenDate').value = d;
    if (document.activeElement !== $('whenTime')) $('whenTime').value = t;
    $('whenSummary').innerHTML = state.when
      ? icon('i-clock') + '<span>Planning for <strong>' + esc(MS.fmtLong(state.when.date)) + ', ' + esc(state.when.time) + '</strong> (Vienna time)</span>'
      : '<span class="live-dot" aria-hidden="true"></span><span>Showing <strong>live status</strong> — updates every 30 s</span>';
    document.body.classList.toggle('is-planning', !!state.when);
  }

  function setWhen(w) {
    state.when = w;
    invalidate();
    render();
  }

  function onDateTimeInput() {
    var d = $('whenDate').value, t = $('whenTime').value || '17:00';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    setWhen({ date: d, time: t });
  }

  function renderToday() {
    var p = viennaNow();
    $('todayLine').innerHTML = '<span class="visually-hidden">Now in Vienna: </span>' + esc(MS.fmtDay(p.isoDate)) + ' · <strong>' + p.time + '</strong>';
    $('todayLine').setAttribute('title', MS.fmtLong(p.isoDate) + ', ' + p.time + ' in Vienna');
  }

  // ---------------------------------------------------------------- list
  var cardEls = {};

  function keywordsFor(m) {
    // Cards show only short words: up to 3 from `vibe` (specials are long phrases — detail panel only).
    return (m.vibe || []).slice(0, 3);
  }

  function thumbHTML(m) {
    var p = m.photos && m.photos[0];
    if (p) return '<img class="card-img" src="' + esc(p.thumb || p.src) + '" alt="" loading="lazy" decoding="async" width="480" height="' + Math.round(480 * (p.h || 3) / (p.w || 4)) + '">';
    return '<span class="card-img card-img--ph" aria-hidden="true">' + icon('i-lantern') + '</span>';
  }

  function buildCard(m) {
    var li = document.createElement('li');
    li.className = 'card-item';
    li.innerHTML =
      '<a class="card" href="#/market/' + encodeURIComponent(m.id) + '" data-id="' + esc(m.id) + '">' +
        '<span class="card-media">' + thumbHTML(m) + '</span>' +
        '<span class="card-body">' +
          '<span class="card-title">' + esc(m.name) + '</span>' +
          '<span class="card-loc" title="' + esc(m.location) + '">' + icon('i-pin') + '<span class="card-loc-t">' + esc(shortLabel(m)) + (m.district ? ' · ' + districtLabel(m.district) : '') + '<span class="card-dist"></span></span></span>' +
          '<span class="card-status"></span>' +
          '<span class="card-kw">' + keywordsFor(m).map(function (k) { return '<span class="kw" title="' + esc(k) + '">' + esc(k) + '</span>'; }).join('') + '</span>' +
          '<span class="card-crowd"></span>' +
        '</span>' +
      '</a>';
    var a = li.firstChild;
    a.addEventListener('mouseenter', function () { hot(m.id, true); });
    a.addEventListener('mouseleave', function () { hot(m.id, false); });
    a.addEventListener('focus', function () { hot(m.id, true); });
    a.addEventListener('blur', function () { hot(m.id, false); });
    a.addEventListener('click', function (e) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
      e.preventDefault(); lastCard = m.id; go(m.id);
    });
    return li;
  }

  function updateCard(m) {
    var li = cardEls[m.id], s = statusOf(m);
    li.querySelector('.card-status').innerHTML = pillHTML(s);
    var c = isOpenState(s) ? Crowd.estimate(m, moment()) : null;
    li.querySelector('.card-crowd').innerHTML = c
      ? meterHTML(c.level, 'Typical crowd: ' + c.label + ' (estimate)', true) + '<span class="crowd-txt">' + esc(c.label) + ' <span class="muted">· typical</span></span>'
      : '';
    var km = distanceKm(m);
    li.querySelector('.card-dist').textContent = km == null ? '' : ' · ' + fmtKm(km);
    li.querySelector('.card').classList.toggle('is-selected', state.selected === m.id);
  }

  function matches(m) {
    if (state.openOnly && !isOpenState(statusOf(m))) return false;
    for (var i = 0; i < state.tags.length; i++) if ((m.tags || []).indexOf(state.tags[i]) === -1) return false;
    var q = state.search.trim().toLowerCase();
    if (q) {
      var hay = [m.name, m.nameEn, m.location, m.address, districtLabel(m.district), m.summary, m.bestFor]
        .concat(m.vibe || [], m.sells || [], m.specials || [], (m.tags || []).map(tagLabel)).join(' ').toLowerCase();
      var words = q.split(/\s+/);
      for (var j = 0; j < words.length; j++) if (hay.indexOf(words[j]) === -1) return false;
    }
    return true;
  }

  function sorter(a, b) {
    var sa = statusOf(a), sb = statusOf(b);
    if (state.sort === 'az') return a.name.localeCompare(b.name, 'de');
    if (state.sort === 'nearest' && state.userPos) return distanceKm(a) - distanceKm(b);
    if (state.sort === 'latest') {
      var ka = sa.state === 'season-over' || sa.state === 'pre-season' ? -1 : (sa.closesAtMin || 0);
      var kb = sb.state === 'season-over' || sb.state === 'pre-season' ? -1 : (sb.closesAtMin || 0);
      if (kb !== ka) return kb - ka;
      return (b.popularity || 0) - (a.popularity || 0);
    }
    var r = STATE_RANK[sa.state] - STATE_RANK[sb.state];
    if (r) return r;
    if (sa.state === 'pre-season' && sb.state === 'pre-season') return (sa.daysUntil || 0) - (sb.daysUntil || 0) || (b.popularity || 0) - (a.popularity || 0);
    return (b.popularity || 0) - (a.popularity || 0) || a.name.localeCompare(b.name, 'de');
  }

  function renderTags() {
    var n = state.tags.length;
    $('filtersCount').textContent = n ? ' · ' + n : '';
    $('filtersBtn').setAttribute('aria-label', 'Filters' + (n ? ', ' + n + ' active' : ''));
    $('filtersBtn').classList.toggle('has-active', n > 0);
    var expanded = $('filtersBtn').getAttribute('aria-expanded') === 'true';
    var act = $('activeTags');
    act.hidden = expanded || !n;
    act.innerHTML = state.tags.map(function (t) {
      return '<button type="button" class="chip chip--tag chip--rm is-active" data-rm="' + esc(t) + '" aria-label="Remove filter ' + esc(tagLabel(t)) + '">' + esc(tagLabel(t)) +
        '<svg class="ic" aria-hidden="true"><use href="#i-close"/></svg></button>';
    }).join('');
    var present = {};
    MARKETS.forEach(function (m) { (m.tags || []).forEach(function (t) { present[t] = (present[t] || 0) + 1; }); });
    $('tagChips').innerHTML = TAGS.filter(function (t) { return present[t[0]]; }).map(function (t) {
      var on = state.tags.indexOf(t[0]) !== -1;
      return '<button type="button" class="chip chip--tag' + (on ? ' is-active' : '') + '" data-tag="' + t[0] + '" aria-pressed="' + on + '">' + esc(t[1]) + '</button>';
    }).join('');
  }

  function renderList() {
    var list = $('marketList');
    var visible = MARKETS.filter(matches).sort(sorter);
    var visibleIds = {};
    visible.forEach(function (m) { visibleIds[m.id] = 1; });

    var current = Array.prototype.map.call(list.children, function (li) { return li.firstChild.getAttribute('data-id'); });
    var wanted = visible.map(function (m) { return m.id; });
    if (current.join('|') !== wanted.join('|')) {
      var active = document.activeElement;
      var frag = document.createDocumentFragment();
      wanted.forEach(function (id) { frag.appendChild(cardEls[id]); });
      list.innerHTML = '';
      list.appendChild(frag);
      if (active && list.contains(active) && document.activeElement !== active) active.focus();
    }
    visible.forEach(updateCard);

    var n = visible.length, total = MARKETS.length;
    var filtered = state.openOnly || state.tags.length || state.search.trim();
    $('resultCount').textContent = filtered ? n + ' of ' + total + ' markets' : total + ' markets';
    $('clearBtn').hidden = !filtered;
    $('emptyState').hidden = n > 0;
    $('openOnly').setAttribute('aria-pressed', String(state.openOnly));
    updateMarkers(visibleIds);
  }

  function clearFilters() {
    state.search = ''; $('search').value = '';
    state.openOnly = false; state.tags = [];
    renderTags(); render();
  }

  // ---------------------------------------------------------------- detail
  var lastCard = null, detailId = null, pushedFromList = null;

  function go(id) {
    // Remember when we pushed a market entry directly on top of the list, so "close" can go back.
    pushedFromList = detailId ? null : id;
    if (location.hash === '#/market/' + id) route();
    else location.hash = '#/market/' + id;
  }

  function closeDetail() {
    if (pushedFromList && pushedFromList === detailId) { pushedFromList = null; history.back(); return; }
    pushedFromList = null;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { location.hash = '#/'; return; }
    route();
  }

  function route() {
    var m = /^#\/market\/([\w-]+)/.exec(location.hash);
    if (m && byId[m[1]]) showDetail(m[1]);
    else hideDetail();
  }

  function gloss(m) { return m.nameEn && m.nameEn !== m.name ? '<p class="d-gloss">' + esc(m.nameEn) + '</p>' : ''; }

  function heroHTML(m) {
    var s = statusOf(m), day = (state.when ? state.when.date : viennaNow().isoDate);
    var h = MS.hoursForDate(m, day);
    var dayWord = state.when ? MS.fmtDay(day) : 'Today';
    var hoursTxt = h ? dayWord + ' ' + h.open + '–' + h.close + (h.label ? ' (' + h.label + ')' : '') : dayWord + ': closed';
    return '' +
      '<header class="d-hero">' +
        '<p class="d-kicker">' + icon('i-pin') + esc(m.location) + (m.district ? ' · ' + districtLabel(m.district) : '') + '</p>' +
        '<h2 id="detailTitle" class="d-title">' + esc(m.name) + '</h2>' + gloss(m) +
        '<div class="d-status" data-slot="status">' + statusBlock(m, s) + '</div>' +
        '<p class="d-hours">' + icon('i-clock') + '<span data-slot="hoursline">' + esc(hoursTxt) + '</span><span class="d-season"><span class="sep" aria-hidden="true">·</span>Season ' + esc(MS.seasonLabel(m)) + '</span></p>' +
        (m.hoursConfidence === 'likely' ? '<p class="d-note">Hours not officially confirmed — check the website.</p>' : '') +
      '</header>';
  }

  function statusBlock(m, s) {
    var when = state.when ? 'On ' + MS.fmtDay(state.when.date) + ' at ' + state.when.time : 'Right now';
    return '<span class="d-when"><span>' + esc(when) + '</span><button type="button" class="d-change" data-act="change-when">Change time</button></span>' + pillHTML(s, true) + (s.detail ? '<span class="d-status-detail">' + esc(s.detail) + '</span>' : '');
  }

  function galleryHTML(m) {
    var ph = m.photos || [];
    if (!ph.length) {
      return '<section class="d-sec d-gallery-empty" aria-label="Photos"><div class="ph-empty">' + icon('i-photo') + '<p>Photos coming soon</p></div></section>';
    }
    var items = ph.map(function (p, i) {
      var set = p.thumb && p.src && p.thumb !== p.src ? ' srcset="' + esc(p.thumb) + ' 480w, ' + esc(p.src) + ' ' + (p.w || 1280) + 'w" sizes="' + (i === 0 ? '(min-width: 900px) 520px, 100vw' : '(min-width: 900px) 170px, 50vw') + '"' : '';
      return '<button type="button" class="g-item' + (i === 0 ? ' g-item--main' : '') + '" data-idx="' + i + '" aria-label="Open photo ' + (i + 1) + ' of ' + ph.length + (p.caption ? ': ' + esc(p.caption) : '') + '">' +
        '<img src="' + esc(p.thumb || p.src) + '"' + set + ' alt="' + esc(p.caption || m.name) + '" loading="lazy" decoding="async" width="' + (p.w || 4) + '" height="' + (p.h || 3) + '">' +
        '</button>';
    }).join('');
    return '<section class="d-sec d-gallery" aria-label="Photos"><div class="g-grid g-n' + Math.min(ph.length, 5) + '">' + items + '</div>' +
      '<p class="g-hint">' + ph.length + ' photos · tap to enlarge · credits in viewer</p></section>';
  }

  function chips(list, cls) { return (list || []).map(function (k) { return '<span class="kw ' + (cls || '') + '">' + esc(k) + '</span>'; }).join(''); }

  function glanceHTML(m) {
    var price = m.priceLevel ? '<span class="price" aria-label="Price level ' + m.priceLevel + ' of 3">' + '€€€'.slice(0, m.priceLevel) + '<span class="price-off">' + '€€€'.slice(m.priceLevel) + '</span></span>' : '';
    var size = (SIZE[m.size] || '') + (m.stalls ? ' · ~' + m.stalls + ' stalls' : '');
    return '<section class="d-sec" aria-labelledby="sGlance"><h3 id="sGlance" class="d-h">At a glance</h3>' +
      (m.summary ? '<p class="d-summary">' + esc(m.summary) + '</p>' : '') +
      '<dl class="glance">' +
        (m.vibe && m.vibe.length ? '<div><dt>The vibe</dt><dd>' + chips(m.vibe, 'kw--vibe') + '</dd></div>' : '') +
        (m.sells && m.sells.length ? '<div><dt>What they sell</dt><dd>' + chips(m.sells, 'kw--sell') + '</dd></div>' : '') +
        (m.specials && m.specials.length ? '<div><dt>Special here</dt><dd>' + chips(m.specials, 'kw--special') + '</dd></div>' : '') +
        (m.bestFor ? '<div><dt>Best for</dt><dd class="txt">' + esc(m.bestFor) + '</dd></div>' : '') +
      '</dl>' +
      '<div class="facts">' +
        (size ? '<div class="fact"><span class="fact-k">Size</span><span class="fact-v">' + esc(size) + '</span></div>' : '') +
        (price ? '<div class="fact"><span class="fact-k">Prices</span><span class="fact-v">' + price + '</span></div>' : '') +
        (m.tags && m.tags.length ? '<div class="fact fact--wide"><span class="fact-k">Good to know</span><span class="fact-v">' + m.tags.map(tagLabel).map(esc).join(', ') + '</span></div>' : '') +
      '</div></section>';
  }

  function dioramaHTML() {
    return '<section class="d-sec" aria-labelledby="s3d"><h3 id="s3d" class="d-h">The layout in 3D</h3>' +
      '<div class="dio" id="dioBox"><div class="dio-wait">' + icon('i-cube') + '<span>Preparing 3D sketch…</span></div></div>' +
      '<p class="d-cap">Stylised 3D sketch — not to scale. Drag to look around.</p></section>';
  }

  function hoursHTML(m) {
    var from = state.when ? state.when.date : viennaNow().isoDate;
    var today = viennaNow().isoDate, sel = from;
    var rows = MS.weekSchedule(m, from, 7).map(function (r) {
      var cls = r.isoDate === sel ? ' class="is-sel"' : '';
      var hrs = r.closed ? '<span class="muted">' + (r.reason === 'pre-season' ? 'Not open yet' : r.reason === 'season-over' ? 'Season over' : 'Closed') + '</span>'
        : esc(r.open) + '–' + esc(r.close) + (r.pastMidnight ? ' <span class="muted">(+1)</span>' : '');
      var tag = r.isoDate === today ? '<span class="tbadge">Today</span>' : '';
      return '<tr' + cls + '><th scope="row">' + esc(r.dayLabel) + tag + (r.label ? '<span class="rlabel">' + esc(r.label) + '</span>' : '') + '</th><td>' + hrs + '</td></tr>';
    }).join('');
    return '<section class="d-sec" aria-labelledby="sHours"><h3 id="sHours" class="d-h">Opening hours</h3>' +
      '<table class="hours"><caption class="visually-hidden">Opening hours for 7 days from ' + esc(MS.fmtDay(from)) + '</caption><tbody>' + rows + '</tbody></table>' +
      (m.hoursNote ? '<p class="d-small">' + esc(m.hoursNote) + '</p>' : '') +
      '<p class="d-small">Season ' + esc(MS.seasonLabel(m)) + ' · all times Vienna time.</p></section>';
  }

  function crowdHTML(m) {
    var at = moment(), c = Crowd.estimate(m, at);
    var day = state.when ? state.when.date : viennaNow().isoDate;
    var p = MS.viennaParts(at);
    var prof = Crowd.hourlyProfile(m, day);
    var nowBlock = c
      ? '<div class="crowd-now">' + meterHTML(c.level, 'Typical crowd: ' + c.label) + '<span class="crowd-big">' + esc(c.label) + '</span></div>'
      : '<div class="crowd-now"><span class="muted">Closed at this time — no estimate.</span></div>';
    var bars = prof.length ? '<div class="bars" role="img" aria-label="Typical busyness by hour on ' + esc(MS.fmtDay(day)) + ': ' +
        prof.map(function (b) { return b.hour + ':00 ' + b.label; }).join(', ') + '">' +
        prof.map(function (b) {
          var cur = p.isoDate === day && b.hour === p.hour;
          return '<span class="bar' + (cur ? ' is-cur' : '') + '"><span class="bar-fill" style="height:' + (18 + b.level * 20) + '%"></span><span class="bar-h">' + (b.hour % 3 === 0 || prof.length <= 8 ? b.hour : '') + '</span></span>';
        }).join('') + '</div>'
      : '<p class="muted d-small">Closed on ' + esc(MS.fmtDay(day)) + '.</p>';
    return '<section class="d-sec" aria-labelledby="sCrowd"><h3 id="sCrowd" class="d-h">How busy?</h3>' +
      '<div data-slot="crowd">' + nowBlock + '</div>' +
      '<p class="crowd-label" data-slot="crowdlabel"><span class="badge-est">Estimate</span>' + esc(Crowd.ESTIMATE_NOTE) + '</p>' +
      (prof.length ? '<p class="d-small">Typical pattern for ' + esc(MS.fmtDay(day)) + '</p>' : '') + bars +
      '<p class="d-small">Live crowd data: coming later.</p></section>';
  }

  function thereHTML(m) {
    var dir = 'https://www.google.com/maps/dir/?api=1&destination=' + m.lat + ',' + m.lng;
    var transit = (m.transit || []).map(function (t) { return '<li>' + icon('i-tram') + '<span>' + esc(t) + '</span></li>'; }).join('');
    var src = (m.sources || []).map(function (u, i) {
      var host = u; try { host = new URL(u).hostname.replace(/^www\./, ''); } catch (e) {}
      return '<a href="' + esc(safeUrl(u)) + '" target="_blank" rel="noopener">' + esc(host) + '</a>';
    }).join(', ');
    return '<section class="d-sec" aria-labelledby="sThere"><h3 id="sThere" class="d-h">Getting there</h3>' +
      '<p class="addr">' + icon('i-pin') + '<span>' + esc(m.address) + '</span></p>' +
      (transit ? '<ul class="transit">' + transit + '</ul>' : '') +
      '<div class="actions">' +
        '<a class="btn btn--primary" href="' + esc(dir) + '" target="_blank" rel="noopener">' + icon('i-route') + 'Directions</a>' +
        (m.website ? '<a class="btn" href="' + esc(safeUrl(m.website)) + '" target="_blank" rel="noopener">' + icon('i-ext') + 'Official website</a>' : '') +
      '</div>' +
      '<p class="d-fine">' + (src ? 'Sources: ' + src + '. ' : '') + (m.verified ? 'Last verified ' + esc(MS.fmtYear(m.verified)) + '. ' : '') + 'Always check the official site before travelling.</p>' +
      '</section>';
  }

  function showDetail(id) {
    var m = byId[id], el = $('detail');
    var same = detailId === id && !el.hidden;
    state.selected = id;
    if (!same) {
      disposeDiorama();
      detailId = id;
      el.innerHTML =
        '<div class="d-bar"><button type="button" class="d-close" id="detailClose" aria-label="Back to list">' + icon('i-back') + '<span>All markets</span></button>' +
        '<span class="d-bar-title" aria-hidden="true">' + esc(m.name) + '</span></div>' +
        '<div class="d-content">' + heroHTML(m) + galleryHTML(m) + glanceHTML(m) + dioramaHTML() + hoursHTML(m) + crowdHTML(m) + thereHTML(m) + '</div>';
      el.hidden = false;
      el.scrollTop = 0;
      document.body.classList.add('has-detail');
      requestAnimationFrame(function () { el.classList.add('is-open'); });
      $('detailClose').addEventListener('click', closeDetail);
      el.querySelectorAll('.g-item').forEach(function (b) {
        b.addEventListener('click', function () { openLightbox(m, +b.getAttribute('data-idx'), b); });
      });
      watchDiorama(m);
      liveCrowd(m);
      try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
      document.title = m.name + ' · Vienna Christmas Markets';
      flyToMarket(m);
    }
    renderList();
  }

  function onDetailScroll() {
    var el = $('detail');
    el.classList.toggle('is-scrolled', el.scrollTop > 120);
  }

  function refreshDetail() {
    if (!detailId || $('detail').hidden) return;
    var m = byId[detailId], el = $('detail');
    // Re-render the time-dependent sections in place (gallery + 3D untouched).
    var secs = el.querySelectorAll('.d-sec');
    secs.forEach(function (sec) {
      var h = sec.querySelector('.d-h');
      if (!h) return;
      var tmp = document.createElement('div');
      if (h.id === 'sHours') tmp.innerHTML = hoursHTML(m);
      else if (h.id === 'sCrowd') tmp.innerHTML = crowdHTML(m);
      else return;
      sec.replaceWith(tmp.firstChild);
    });
    var hero = el.querySelector('.d-hero');
    if (hero) { var t = document.createElement('div'); t.innerHTML = heroHTML(m); hero.replaceWith(t.firstChild); }
    liveCrowd(m);
  }

  function liveCrowd(m) {
    if (!Crowd.hasProvider() || !isLive()) return;
    Crowd.live(m).then(function (d) {
      if (!d || detailId !== m.id) return;
      var slot = $('detail').querySelector('[data-slot="crowd"]'), lab = $('detail').querySelector('[data-slot="crowdlabel"]');
      if (slot) slot.innerHTML = '<div class="crowd-now">' + meterHTML(d.level, 'Live crowd: ' + d.label) + '<span class="crowd-big">' + esc(d.label) + '</span></div>';
      if (lab) lab.innerHTML = '<span class="badge-live">Live</span>' + (d.updatedAt ? 'Updated ' + esc(new Date(d.updatedAt).toLocaleTimeString('en-GB', { timeZone: 'Europe/Vienna', hour: '2-digit', minute: '2-digit' })) : 'Live data');
    });
  }

  function hideDetail() {
    var el = $('detail');
    disposeDiorama();
    if (lb.open) closeLightbox();
    var wasOpen = !el.hidden;
    detailId = null;
    state.selected = null;
    document.body.classList.remove('has-detail');
    document.title = 'Vienna Christmas Markets';
    if (wasOpen) {
      el.classList.remove('is-open');
      var done = function () { if (!detailId) { el.hidden = true; el.innerHTML = ''; } };
      if (REDUCED.matches) done(); else setTimeout(done, 260);
      var card = lastCard && document.querySelector('.card[data-id="' + lastCard + '"]');
      if (card) { try { card.focus({ preventScroll: false }); } catch (e) { card.focus(); } }
    }
    renderList();
  }

  // ---------------------------------------------------------------- diorama integration
  var dio = { handle: null, observer: null, token: 0, loading: null, market: null };

  function loadScript(src) {
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = src; s.async = false;
      s.onload = function () { resolve(true); };
      s.onerror = function () { s.remove(); resolve(false); };
      document.body.appendChild(s);
    });
  }

  function ensureDiorama() {
    if (window.Diorama) return Promise.resolve(true);
    if (!dio.loading) {
      dio.loading = (window.THREE ? Promise.resolve(true) : loadScript('vendor/three.min.js'))
        .then(function () { return window.Diorama ? true : loadScript('js/diorama.js'); })
        .then(function () { return !!window.Diorama; });
    }
    return dio.loading;
  }

  function dioFallback(box, msg) {
    box.innerHTML = '<div class="dio-fallback">' + icon('i-cube') + '<p><strong>3D sketch unavailable</strong><br>' + esc(msg) + '</p></div>';
  }

  function watchDiorama(m) {
    var box = $('dioBox');
    if (!box) return;
    var token = ++dio.token;
    dio.market = m;
    var start = function () {
      ensureDiorama().then(function (ok) {
        if (token !== dio.token || !box.isConnected) return;
        mountInto(box, m, ok);
      });
    };
    if ('IntersectionObserver' in window) {
      dio.observer = new IntersectionObserver(function (entries) {
        if (entries.some(function (e) { return e.isIntersecting; })) {
          dio.observer.disconnect(); dio.observer = null; start();
        }
      }, { rootMargin: '150px 0px' });
      dio.observer.observe(box);
    } else start();
  }

  function mountInto(box, m, ok) {
    var D = window.Diorama;
    var supported = false;
    try { supported = !!(ok && D && D.isSupported && D.isSupported()); } catch (e) { supported = false; }
    if (!ok || !D) return dioFallback(box, 'The 3D view could not be loaded right now.');
    if (!supported) return dioFallback(box, 'Your browser or device doesn’t support WebGL.');
    box.innerHTML = '';
    try {
      dio.handle = D.mount(box, m, { theme: state.theme });
    } catch (e) {
      dio.handle = null;
      dioFallback(box, 'Something went wrong drawing this market.');
    }
  }

  function disposeDiorama() {
    dio.token++;
    if (dio.observer) { dio.observer.disconnect(); dio.observer = null; }
    if (dio.handle) { try { dio.handle.dispose(); } catch (e) { /* ignore */ } dio.handle = null; }
  }

  function remountDiorama() {
    var box = $('dioBox'), m = byId[detailId];
    if (!box || !m) return;
    if (dio.handle) { try { dio.handle.dispose(); } catch (e) { /* ignore */ } dio.handle = null; }
    mountInto(box, m, !!window.Diorama);
  }

  // ---------------------------------------------------------------- lightbox
  var lb = { open: false, market: null, idx: 0, trigger: null, x0: null };

  function openLightbox(m, idx, trigger) {
    lb.open = true; lb.market = m; lb.idx = idx; lb.trigger = trigger;
    var box = $('lightbox');
    box.hidden = false;
    document.body.classList.add('has-lightbox');
    showPhoto();
    requestAnimationFrame(function () { box.classList.add('is-open'); });
    $('lbClose').focus();
  }

  function showPhoto() {
    var ph = lb.market.photos, p = ph[lb.idx];
    var img = $('lbImg');
    img.classList.add('is-loading');
    img.onload = function () { img.classList.remove('is-loading'); };
    img.src = p.src || p.thumb;
    img.alt = p.caption || lb.market.name;
    if (p.w && p.h) { img.width = p.w; img.height = p.h; }
    $('lbCaption').textContent = p.caption || '';
    var author = p.sourceUrl ? '<a href="' + esc(safeUrl(p.sourceUrl)) + '" target="_blank" rel="noopener">' + esc(p.author || 'Unknown') + '</a>' : esc(p.author || 'Unknown');
    var lic = p.licenseUrl ? '<a href="' + esc(safeUrl(p.licenseUrl)) + '" target="_blank" rel="noopener">' + esc(p.license || 'Licence') + '</a>' : esc(p.license || '');
    $('lbCredit').innerHTML = 'Photo: ' + author + (lic ? ' · ' + lic : '');
    $('lbCount').textContent = (lb.idx + 1) + ' / ' + ph.length;
    var multi = ph.length > 1;
    $('lbPrev').hidden = !multi; $('lbNext').hidden = !multi;
    [ph[(lb.idx + 1) % ph.length], ph[(lb.idx - 1 + ph.length) % ph.length]].forEach(function (q) {
      if (q && q.src) { var i = new Image(); i.src = q.src; }
    });
  }

  function stepPhoto(d) {
    var n = lb.market.photos.length;
    lb.idx = (lb.idx + d + n) % n;
    showPhoto();
  }

  function closeLightbox() {
    var box = $('lightbox');
    lb.open = false;
    box.classList.remove('is-open');
    box.hidden = true;
    document.body.classList.remove('has-lightbox');
    $('lbImg').removeAttribute('src');
    if (lb.trigger && lb.trigger.isConnected) lb.trigger.focus();
  }

  function trapFocus(e) {
    var f = Array.prototype.filter.call($('lightbox').querySelectorAll('button, a[href]'), function (x) { return !x.hidden && x.offsetParent !== null; });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (!$('lightbox').contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  }

  // ---------------------------------------------------------------- wiring
  function render() {
    invalidate();
    renderPlanner();
    renderList();
    refreshDetail();
  }

  function bind() {
    $('themeBtn').addEventListener('click', function () { applyTheme(state.theme === 'dark' ? 'light' : 'dark', true); });
    var mq = window.matchMedia('(prefers-color-scheme: light)');
    var onScheme = function () { if (!load('xm-theme')) applyTheme(mq.matches ? 'light' : 'dark', false); };
    if (mq.addEventListener) mq.addEventListener('change', onScheme);

    $('aboutBtn').addEventListener('click', function () {
      var d = $('aboutDialog');
      if (d.showModal) d.showModal(); else d.setAttribute('open', '');
    });

    $('whenChips').addEventListener('click', function (e) {
      var b = e.target.closest('[data-key]');
      if (!b) return;
      var p = ($('whenChips')._picks || []).filter(function (x) { return x.key === b.getAttribute('data-key'); })[0];
      if (p) setWhen(p.when ? { date: p.when.date, time: p.when.time } : null);
    });
    $('whenDate').addEventListener('change', onDateTimeInput);
    $('whenTime').addEventListener('change', onDateTimeInput);

    var searchT;
    $('search').addEventListener('input', function (e) {
      clearTimeout(searchT);
      searchT = setTimeout(function () { state.search = e.target.value; renderList(); }, 80);
    });
    $('openOnly').addEventListener('click', function () { state.openOnly = !state.openOnly; renderList(); });
    $('sortSel').addEventListener('change', function (e) { state.sort = e.target.value; renderList(); });
    $('tagChips').addEventListener('click', function (e) {
      var b = e.target.closest('[data-tag]');
      if (!b) return;
      var t = b.getAttribute('data-tag'), i = state.tags.indexOf(t);
      if (i === -1) state.tags.push(t); else state.tags.splice(i, 1);
      renderTags();
      var nb = $('tagChips').querySelector('[data-tag="' + t + '"]');
      if (nb) nb.focus();
      renderList();
    });
    $('filtersBtn').addEventListener('click', function () {
      var open = this.getAttribute('aria-expanded') !== 'true';
      this.setAttribute('aria-expanded', String(open));
      $('tagChips').hidden = !open;
      renderTags();
    });
    $('activeTags').addEventListener('click', function (e) {
      var b = e.target.closest('[data-rm]');
      if (!b) return;
      var i = state.tags.indexOf(b.getAttribute('data-rm'));
      if (i !== -1) state.tags.splice(i, 1);
      renderTags();
      var next = $('activeTags').querySelector('[data-rm]');
      (next && !$('activeTags').hidden ? next : $('filtersBtn')).focus();
      renderList();
    });
    $('clearBtn').addEventListener('click', clearFilters);
    $('emptyClear').addEventListener('click', clearFilters);
    $('locateBtn').addEventListener('click', locate);
    $('detail').addEventListener('scroll', onDetailScroll, { passive: true });
    $('detail').addEventListener('click', function (e) {
      if (!e.target.closest('[data-act="change-when"]')) return;
      closeDetail();
      setTimeout(function () {
        var c = $('whenChips').querySelector('.is-active') || $('whenDate');
        if (c) { c.scrollIntoView({ block: 'center' }); c.focus(); }
      }, 50);
    });

    // List keyboard navigation: arrow keys move between cards.
    $('marketList').addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      var cards = Array.prototype.slice.call($('marketList').querySelectorAll('.card'));
      var i = cards.indexOf(document.activeElement);
      if (i === -1) return;
      e.preventDefault();
      var n = cards[Math.max(0, Math.min(cards.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      n.focus();
    });

    // Lightbox
    $('lbClose').addEventListener('click', closeLightbox);
    $('lbPrev').addEventListener('click', function () { stepPhoto(-1); });
    $('lbNext').addEventListener('click', function () { stepPhoto(1); });
    $('lightbox').addEventListener('click', function (e) { if (e.target === $('lightbox') || e.target.classList.contains('lb-stage')) closeLightbox(); });
    $('lightbox').addEventListener('touchstart', function (e) { lb.x0 = e.touches[0].clientX; lb.y0 = e.touches[0].clientY; }, { passive: true });
    $('lightbox').addEventListener('touchend', function (e) {
      if (lb.x0 == null) return;
      var dx = e.changedTouches[0].clientX - lb.x0, dy = e.changedTouches[0].clientY - lb.y0;
      lb.x0 = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) stepPhoto(dx < 0 ? 1 : -1);
    });

    document.addEventListener('keydown', function (e) {
      if (lb.open) {
        if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); }
        else if (e.key === 'ArrowRight') stepPhoto(1);
        else if (e.key === 'ArrowLeft') stepPhoto(-1);
        else if (e.key === 'Tab') trapFocus(e);
        return;
      }
      if (e.key === 'Escape' && detailId && !$('aboutDialog').open) { e.preventDefault(); closeDetail(); }
    });

    window.addEventListener('hashchange', route);
    var wasDesktop = DESKTOP.matches;
    var onResize = function () {
      if (map) map.invalidateSize();
      if (DESKTOP.matches !== wasDesktop) { wasDesktop = DESKTOP.matches; }
    };
    window.addEventListener('resize', onResize);

    // Live ticking
    setInterval(function () {
      renderToday();
      if (isLive()) render();
      else renderPlanner();
    }, 30000);
  }

  function init() {
    if (!MS || !Crowd) return;
    MARKETS.forEach(function (m) { cardEls[m.id] = buildCard(m); });
    var verified = MARKETS.map(function (m) { return m.verified || ''; }).sort().pop();
    document.querySelectorAll('.verified-date').forEach(function (n) { n.textContent = verified ? MS.fmtYear(verified) : 'recently'; });
    renderToday();
    renderTags();
    initMap();
    applyTheme(state.theme, false);
    bind();
    render();
    route();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
