/* Kizzey Web — health, location, weather, navigation and device tools */
(function () {
  'use strict';
  const K = window.K;
  const h = K.esc;

  function head(kind, title, sub, actions = '') {
    return K.rpcHeader(kind, title, sub, actions);
  }

  function card(title, sub, body, opts = {}) {
    return `<section class="card ${opts.cls || ''}" style="margin-bottom:14px;${opts.style || ''}">
      ${title ? `<div class="card-row" style="margin-bottom:12px"><div><div class="card-title">${title}</div>${sub ? `<div class="card-sub">${sub}</div>` : ''}</div>${opts.end || ''}</div>` : ''}
      ${body}
    </section>`;
  }

  function statusDot(ok, text) {
    return `<span class="badge ${ok ? 'good' : 'plain'}">${ok ? '<span class="dot" style="width:5px;height:5px"></span>' : ''}${h(text)}</span>`;
  }

  function imageValue(path) {
    const value = K.get(path, '') || '';
    if (String(value).startsWith('http://') || String(value).startsWith('https://') || String(value).startsWith('/uploads/') || String(value).startsWith('data:image/')) return value;
    return '';
  }

  function placeLine(place) {
    if (!place) return '';
    return [place.name, place.admin, place.country].filter(Boolean).join(', ');
  }

  function openPlaceSearch(mode, initial) {
    K.placeMode = mode;
    K.sheet({
      title: mode === 'nav-origin' ? 'Set starting point' : mode === 'nav-destination' ? 'Search destination' : 'Find a place',
      subtitle: 'Search a city, town or landmark.',
      body: `<div class="input-row">
        <div class="input-wrap">${K.icon('search', 'sm')}<input id="place-query" class="input" style="padding-left:38px" value="${h(initial || '')}" placeholder="Search a place"></div>
        <button class="btn btn-primary btn-sm" data-action="place-search-run">Search</button>
      </div>
      <div id="place-results" class="mt-16"><div class="empty" style="padding:22px"><div class="empty-icon">${K.icon('map-pin', 'lg')}</div><h3>Where are you headed?</h3><p>Results use Open-Meteo geocoding.</p></div></div>
      ${mode !== 'weather' ? `<div class="modal-actions"><button class="btn btn-ghost" data-action="place-use-current" data-mode="${h(mode)}">${K.icon('navigation', 'sm')}Use my current location</button></div>` : `<div class="modal-actions"><button class="btn btn-ghost" data-action="place-use-current" data-mode="weather">${K.icon('navigation', 'sm')}Use my current location</button></div>`}`,
    });
    setTimeout(() => document.getElementById('place-query')?.focus(), 100);
  }

  K.actions['open-place-search'] = el => openPlaceSearch(el.dataset.mode || 'weather', el.dataset.initial || '');

  K.actions['place-search-run'] = async function () {
    const input = document.getElementById('place-query');
    const resultsEl = document.getElementById('place-results');
    if (!input || !resultsEl) return;
    const q = input.value.trim();
    if (!q) { input.focus(); return; }
    resultsEl.innerHTML = '<div class="loading-line"><span></span></div>';
    try {
      const data = await K.api('/api/geocode?q=' + encodeURIComponent(q));
      const results = data.results || [];
      if (!results.length) {
        resultsEl.innerHTML = `<div class="empty" style="padding:20px"><div class="empty-icon">${K.icon('search', 'lg')}</div><h3>No matches</h3><p>Try a city and country.</p></div>`;
        return;
      }
      resultsEl.innerHTML = `<div class="list">${results.map(place => `<button class="list-item" data-action="place-pick" data-name="${h(place.name)}" data-admin="${h(place.admin || '')}" data-country="${h(place.country || '')}" data-lat="${h(place.lat)}" data-lon="${h(place.lon)}">
        <span class="list-icon">${K.icon('map-pin')}</span>
        <span class="list-body"><span class="list-title">${h(place.name)}</span><span class="list-desc">${h([place.admin, place.country].filter(Boolean).join(', '))}</span></span>
        <span class="list-end">${K.icon('chevron-right', 'sm')}</span>
      </button>`).join('')}</div>`;
    } catch (error) {
      resultsEl.innerHTML = `<div class="empty" style="padding:20px"><div class="empty-icon">${K.icon('cloud-off', 'lg')}</div><h3>Search unavailable</h3><p>${h(error.message)}</p></div>`;
    }
  };

  K.actions['place-pick'] = async function (el) {
    const place = {
      name: el.dataset.name || '',
      admin: el.dataset.admin || '',
      country: el.dataset.country || '',
      lat: Number(el.dataset.lat),
      lon: Number(el.dataset.lon),
    };
    const mode = K.placeMode;
    K.closeSheet();
    if (mode === 'weather') {
      await loadWeather(place.lat, place.lon, placeLine(place) || place.name);
      return;
    }
    if (mode === 'location') {
      const patch = { location: { place: place.name, lat: place.lat, lon: place.lon, useMyLocation: false } };
      K.deepMerge(K.state, patch);
      await K.queuePatch(patch, 0);
      K.toast('Location updated', placeLine(place), 'ok');
      K.render();
      return;
    }
    if (mode === 'nav-origin' || mode === 'nav-destination') {
      const dest = mode === 'nav-destination';
      const patch = {
        navigation: dest
          ? { destination: place.name, destLat: place.lat, destLon: place.lon, distance: null, duration: null, distanceText: '', durationText: '' }
          : { origin: place.name, lat: place.lat, lon: place.lon },
      };
      K.deepMerge(K.state, patch);
      await K.queuePatch(patch, 0);
      K.toast(dest ? 'Destination set' : 'Starting point set', placeLine(place), 'ok');
      K.render();
    }
  };

  function getPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) { reject(new Error('Geolocation is not available in this browser.')); return; }
      navigator.geolocation.getCurrentPosition(
        pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
        err => reject(new Error(err.code === 1 ? 'Location permission was denied.' : 'Could not get your location.')),
        { enableHighAccuracy: false, timeout: 12000, maximumAge: 60000 }
      );
    });
  }
  K.getPosition = getPosition;

  K.actions['place-use-current'] = async function (el) {
    const mode = el.dataset.mode || K.placeMode;
    try {
      const pos = await getPosition();
      K.closeSheet();
      if (mode === 'weather') await loadWeather(pos.lat, pos.lon, 'Current location');
      else if (mode === 'location') {
        const patch = { location: { place: 'Current location', lat: pos.lat, lon: pos.lon, useMyLocation: true } };
        K.deepMerge(K.state, patch);
        await K.queuePatch(patch, 0);
        K.toast('Using your location', `${pos.lat.toFixed(3)}, ${pos.lon.toFixed(3)}`, 'ok');
        K.render();
      } else if (mode === 'nav-origin' || mode === 'nav-destination') {
        const dest = mode === 'nav-destination';
        const patch = {
          navigation: dest
            ? { destination: 'Current location', destLat: pos.lat, destLon: pos.lon, distance: null, duration: null, distanceText: '', durationText: '' }
            : { origin: 'Current location', lat: pos.lat, lon: pos.lon },
        };
        K.deepMerge(K.state, patch);
        await K.queuePatch(patch, 0);
        K.render();
      }
    } catch (error) {
      K.toast('Location unavailable', error.message, 'error');
    }
  };

  // ---------------------------------------------------------------------
  // health
  // ---------------------------------------------------------------------
  let motionHandler = null;
  let motionLastStep = 0;
  let motionLast = 0;
  let motionSteps = 0;

  function stopMotion(show = true) {
    if (motionHandler) window.removeEventListener('devicemotion', motionHandler);
    motionHandler = null;
    if (K.motionActive) {
      K.motionActive = false;
      K.queuePatch({ health: { steps: K.num(K.get('health.steps'), 0) } }, 0);
      if (show) { K.toast('Motion tracking stopped', `${motionSteps} new steps captured.`, 'ok'); K.render(); }
    }
  }
  K.stopMotionTracking = stopMotion;

  setInterval(() => {
    if (K.motionActive && K.current.route !== 'health') stopMotion(false);
  }, 3000);

  K.actions['health-motion'] = async function () {
    if (K.motionActive) { stopMotion(); return; }
    if (typeof DeviceMotionEvent === 'undefined') {
      K.toast('Motion sensor unavailable', 'This browser does not expose device motion. Enter steps manually.', 'error');
      return;
    }
    try {
      if (typeof DeviceMotionEvent.requestPermission === 'function') {
        const permission = await DeviceMotionEvent.requestPermission();
        if (permission !== 'granted') { K.toast('Motion permission denied', '', 'error'); return; }
      }
    } catch (error) {
      K.toast('Motion permission denied', error.message, 'error');
      return;
    }
    motionSteps = 0;
    motionLastStep = 0;
    motionLast = 0;
    motionHandler = event => {
      const a = event.accelerationIncludingGravity;
      if (!a || a.x == null) return;
      const magnitude = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
      const now = performance.now();
      if (motionLast && magnitude - motionLast > 2.2 && now - motionLastStep > 300) {
        motionLastStep = now;
        motionSteps += 1;
        const next = K.num(K.get('health.steps'), 0) + 1;
        K.setLocal('health.steps', next);
        document.querySelectorAll('[data-health-steps]').forEach(el => { el.textContent = next.toLocaleString(); });
        const input = document.querySelector('[data-model="health.steps"]');
        if (input) input.value = next;
        if (motionSteps % 5 === 0) K.queuePatch({ health: { steps: next } }, 0);
      }
      motionLast = magnitude;
    };
    window.addEventListener('devicemotion', motionHandler, { passive: true });
    K.motionActive = true;
    K.toast('Motion tracking on', 'Move gently; step estimation is approximate.', 'ok');
    K.render();
  };

  K.actions['health-snapshot'] = async () => {
    const health = K.get('health', {});
    const history = K.clone(health.history || []);
    history.unshift({
      time: Date.now(),
      steps: K.num(health.steps, 0),
      heart: K.num(health.heart, 0),
      sleep: Number(health.sleep) || 0,
      stress: K.num(health.stress, 0),
      weight: Number(health.weight) || 0,
    });
    health.history = history.slice(0, 60);
    K.setLocal('health.history', health.history);
    await K.queuePatch({ health: { history: health.history } }, 0);
    K.toast('Snapshot saved', K.fmtDateTime(Date.now()), 'ok');
    K.render();
  };

  K.actions['health-clear-history'] = () => {
    K.confirm({
      title: 'Clear health history?',
      subtitle: 'Saved snapshots are removed. Current values stay.',
      confirm: 'Clear', danger: true,
      onConfirm: async () => {
        K.setLocal('health.history', []);
        await K.queuePatch({ health: { history: [] } }, 0);
        K.render();
      },
    });
  };

  K.actions['health-import'] = () => {
    K.bindFilePicker(async file => {
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const source = data.health && typeof data.health === 'object' ? data.health : data;
        const patch = {};
        for (const key of ['steps', 'heart', 'sleep', 'weight', 'stress', 'goal']) {
          if (source[key] != null && Number.isFinite(Number(source[key]))) patch[key] = Number(source[key]);
        }
        if (!Object.keys(patch).length) throw new Error('No steps, heart, sleep, weight or stress values found.');
        K.deepMerge(K.state, { health: patch });
        await K.queuePatch({ health: patch }, 0);
        K.toast('Health data imported', Object.keys(patch).join(', '), 'ok');
        K.render();
      } catch (error) {
        K.toast('Import failed', error.message, 'error');
      }
    }, 'application/json,.json');
  };

  K.actions['toggle-health'] = async function (el) {
    const value = el.dataset.value;
    const shown = K.clone(K.get('health.show', []) || []);
    const idx = shown.indexOf(value);
    if (idx >= 0) { if (shown.length > 1) shown.splice(idx, 1); } else shown.push(value);
    K.setLocal('health.show', shown);
    await K.queuePatch({ health: { show: shown } }, 0);
    K.render();
  };

  K.screens.health = {
    title: 'Health',
    render() {
      const x = K.get('health', {});
      const steps = K.num(x.steps, 0);
      const goal = Math.max(1, K.num(x.goal, 8000));
      const pct = Math.min(100, steps / goal * 100);
      const shown = x.show || [];
      const history = x.history || [];
      const lastSeven = history.slice(0, 7).reverse();
      const maxSteps = Math.max(goal, ...lastSeven.map(row => K.num(row.steps, 0)), 1);
      return `<div class="page">
        ${head('health', 'Health', 'A calm read on your day.', `<button class="icon-btn" data-action="health-snapshot" aria-label="Save snapshot">${K.icon('bookmark')}</button>`)}
        ${K.rpcStatusCard('health', 'Health RPC', 'Share only the metrics you choose.')}
        <div class="metric" style="min-height:150px;margin-bottom:12px">
          <div class="card-row between" style="align-items:flex-start">
            <div><div class="metric-label">Steps today</div><b style="font-size:2.125rem;display:block;margin-top:8px" data-health-steps>${steps.toLocaleString()}</b><small>${Math.round(pct)}% of ${goal.toLocaleString()} goal</small></div>
            <div class="ring" style="background:conic-gradient(var(--primary) ${pct * 3.6}deg,var(--surface-2) 0)"><span>${Math.round(pct)}%</span></div>
          </div>
          <div class="field-hint">Browser health data is entered manually, imported, or estimated from device motion.</div>
        </div>
        <div class="metric-grid">
          <div class="metric"><div class="metric-icon">${K.icon('heart-pulse')}</div><div><b>${K.num(x.heart, 0)} <small style="font-size:0.625rem">bpm</small></b><small>Heart rate</small></div><div class="metric-label">Resting</div></div>
          <div class="metric"><div class="metric-icon">${K.icon('moon')}</div><div><b>${K.esc(x.sleep)} <small style="font-size:0.625rem">h</small></b><small>Sleep</small></div><div class="metric-label">Last night</div></div>
          <div class="metric"><div class="metric-icon">${K.icon('zap')}</div><div><b>${K.num(x.stress, 0)}<small style="font-size:0.625rem">%</small></b><small>Stress</small></div><div class="metric-label">Estimate</div></div>
          <div class="metric"><div class="metric-icon">${K.icon('scale')}</div><div><b>${K.num(x.weight, 0) || '—'}${x.weight ? ' <small style="font-size:0.625rem">kg</small>' : ''}</b><small>Weight</small></div><div class="metric-label">Optional</div></div>
        </div>
        <div class="quick-grid-2" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">
          <button class="btn ${K.motionActive ? 'btn-primary' : 'btn-tonal'} btn-sm" data-action="health-motion">${K.icon('activity', 'sm')}${K.motionActive ? 'Stop step sensor' : 'Use motion sensor'}</button>
          <button class="btn btn-ghost btn-sm" data-action="health-import">${K.icon('upload', 'sm')}Import health data</button>
        </div>
        ${K.sectionLabel('What goes on your card')}
        <div class="chips" style="margin-bottom:14px">
          ${[['steps', 'Steps'], ['heart', 'Heart rate'], ['sleep', 'Sleep'], ['stress', 'Stress']].map(([value, label]) => `<button class="chip-toggle ${shown.includes(value) ? 'active' : ''}" data-action="toggle-health" data-value="${value}">${label}</button>`).join('')}
        </div>
        ${card('Manual readings', 'No fake health sensors — edit the values yourself.', `
          <div class="two-col">${K.field({ label: 'Steps', path: 'health.steps', value: x.steps, type: 'number', min: 0 })}${K.field({ label: 'Step goal', path: 'health.goal', value: x.goal, type: 'number', min: 1 })}</div>
          <div class="two-col">${K.field({ label: 'Heart rate (bpm)', path: 'health.heart', value: x.heart, type: 'number', min: 0 })}${K.field({ label: 'Sleep (hours)', path: 'health.sleep', value: x.sleep, type: 'number', step: '0.1', min: 0 })}</div>
          <div class="two-col">${K.field({ label: 'Stress (%)', path: 'health.stress', value: x.stress, type: 'number', min: 0, max: 100 })}${K.field({ label: 'Weight (kg)', path: 'health.weight', value: x.weight, type: 'number', step: '0.1', min: 0 })}</div>
          ${K.field({ label: 'Card label', path: 'health.label', value: x.label, placeholder: 'Health' })}
          ${K.toggleRow({ title: 'Health alerts', desc: 'Show gentle nudges on the health screen', path: 'health.alerts', checked: x.alerts, icon: 'bell' })}
        `)}
        ${lastSeven.length ? card('Steps history', 'Most recent snapshots first', `<div class="day-bars">${lastSeven.map(row => `<div class="day-bar"><i style="height:${Math.max(4, K.num(row.steps, 0) / maxSteps * 100)}%"></i><span>${new Date(row.time).toLocaleDateString([], { weekday: 'short' }).slice(0, 2)}</span></div>`).join('')}</div>`) : ''}
        ${history.length ? `<div class="section-label"><span>Snapshots</span><button class="link-btn" data-action="health-clear-history">Clear</button></div><div class="list">${history.slice(0, 8).map(row => `<div class="list-item"><span class="list-icon">${K.icon('heart-pulse')}</span><span class="list-body"><span class="list-title">${K.num(row.steps, 0).toLocaleString()} steps · ${K.num(row.heart, 0)} bpm</span><span class="list-desc">${K.fmtDateTime(row.time)} · ${K.esc(row.sleep)}h sleep</span></span></div>`).join('')}</div>` : ''}
        <div style="height:4px"></div>
        ${K.rpcDock('health', 'Start Health RPC')}
      </div>`;
    },
  };

  // ---------------------------------------------------------------------
  // location
  // ---------------------------------------------------------------------
  function coordinates(lat, lon) {
    const la = Number(lat), lo = Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return 'No coordinates yet';
    return `${la.toFixed(4)}°, ${lo.toFixed(4)}°`;
  }

  function mapMarkup(lat, lon, label) {
    const la = Number(lat), lo = Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) {
      return `<div class="map-card" style="display:grid;place-items:center;min-height:170px"><div class="empty" style="padding:12px"><div class="empty-icon">${K.icon('map-pin', 'lg')}</div><h3>No place selected</h3><p>Search or use your current location.</p></div></div>`;
    }
    return `<div class="map-card" style="min-height:180px;background:radial-gradient(circle at 65% 35%,rgba(211,192,246,.14),transparent 42%),linear-gradient(135deg,#1f2b28,#15211f 55%,#1d1a26);overflow:hidden">
      <div style="position:absolute;inset:-30%;opacity:.4;background-image:linear-gradient(30deg,transparent 48%,rgba(255,255,255,.07) 49%,rgba(255,255,255,.07) 51%,transparent 52%),linear-gradient(115deg,transparent 48%,rgba(255,255,255,.05) 49%,rgba(255,255,255,.05) 51%,transparent 52%);background-size:74px 62px,92px 78px"></div>
      <div style="position:absolute;left:18px;top:17px;right:18px;display:flex;justify-content:space-between;align-items:flex-start"><span class="badge plain" style="background:rgba(15,12,18,.55);backdrop-filter:blur(8px)">${h(label || 'Pinned place')}</span><a class="icon-btn small" href="https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=13/${la}/${lo}" target="_blank" rel="noopener" style="background:rgba(15,12,18,.55)">${K.icon('external-link', 'sm')}</a></div>
      <div style="position:absolute;left:50%;top:52%;transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center;color:var(--primary);filter:drop-shadow(0 8px 13px rgba(0,0,0,.4))">${K.icon('map-pin', 'xl')}</div>
      <div style="position:absolute;left:18px;bottom:16px;font-family:var(--mono);font-size:0.625rem;color:rgba(255,255,255,.55)">${coordinates(la, lo)}</div>
    </div>`;
  }

  K.screens.location = {
    title: 'Location',
    render() {
      const loc = K.get('location', {});
      return `<div class="page">
        ${head('location', 'Location', 'A soft pin on the map.')}
        ${K.rpcStatusCard('location', 'Location RPC', 'Share a city, not a live trail.')}
        ${mapMarkup(loc.lat, loc.lon, loc.place)}
        <div class="card-row" style="margin-bottom:14px">
          <button class="btn btn-tonal btn-sm" data-action="open-place-search" data-mode="location" data-initial="${h(loc.place || '')}">${K.icon('search', 'sm')}Search city</button>
          <button class="btn btn-ghost btn-sm" data-action="place-use-current" data-mode="location">${K.icon('navigation', 'sm')}Current location</button>
        </div>
        ${card('Place', 'The card shows a human place, never exact GPS.', `
          ${K.field({ label: 'Place', path: 'location.place', value: loc.place, placeholder: 'London' })}
          <div class="two-col">${K.field({ label: 'Latitude', path: 'location.lat', value: loc.lat, type: 'number', step: 'any' })}${K.field({ label: 'Longitude', path: 'location.lon', value: loc.lon, type: 'number', step: 'any' })}</div>
          ${K.field({ label: 'Card template', path: 'location.template', value: loc.template, placeholder: 'In {{place}}', hint: '{{place}} expands to the place above.' })}
        `)}
        <div class="setting-group">
          ${K.toggleRow({ title: 'Use my location', desc: 'Let the browser request a coarse location when you search', path: 'location.useMyLocation', checked: loc.useMyLocation, icon: 'navigation' })}
          ${K.toggleRow({ title: 'Privacy mode', desc: 'Avoid embedding third-party map tiles', path: 'location.privacy', checked: loc.privacy, icon: 'shield' })}
          ${K.toggleRow({ title: 'Attach weather', desc: 'Use weather from this place when starting the card', path: 'location.showWeather', checked: loc.showWeather, icon: 'cloud-sun' })}
        </div>
        <div class="field-hint" style="padding:0 5px 16px">Coordinates are stored on your own server. The card itself only contains the place text.</div>
        ${K.rpcDock('location', 'Start Location RPC')}
      </div>`;
    },
  };

  // ---------------------------------------------------------------------
  // weather
  // ---------------------------------------------------------------------
  async function loadWeather(lat, lon, place) {
    const unit = K.get('weather.unit', 'c') || 'c';
    K.toast('Reading the sky…', place || '', '');
    try {
      const qs = new URLSearchParams({ lat: String(lat), lon: String(lon), unit });
      const data = await K.api('/api/weather?' + qs.toString());
      const patch = { weather: { place, lat: Number(lat), lon: Number(lon), last: data.weather } };
      K.deepMerge(K.state, patch);
      await K.queuePatch(patch, 0);
      K.toast('Weather updated', `${data.weather.emoji || ''} ${data.weather.temp}°${unit.toUpperCase()} · ${data.weather.desc}`, 'ok');
      if (K.current.route === 'weather') K.render();
      return data.weather;
    } catch (error) {
      K.toast('Weather unavailable', error.message, 'error');
      throw error;
    }
  }
  K.loadWeather = loadWeather;

  K.actions['weather-refresh'] = async () => {
    const lat = K.get('weather.lat', 51.5072);
    const lon = K.get('weather.lon', -0.1276);
    const place = K.get('weather.place', 'London');
    await loadWeather(lat, lon, place).catch(() => {});
  };

  K.actions['weather-unit'] = async function (el) {
    const unit = el.dataset.unit || 'c';
    K.setLocal('weather.unit', unit);
    await K.queuePatch({ weather: { unit } }, 0);
    await K.actions['weather-refresh']();
    K.render();
  };

  K.actions['weather-search'] = () => openPlaceSearch('weather', K.get('weather.place', ''));

  K.screens.weather = {
    title: 'Weather',
    render() {
      const w = K.get('weather', {});
      const last = w.last || null;
      const unit = String(w.unit || 'c').toUpperCase();
      const days = (last?.daily || []).slice(0, Math.max(1, K.num(w.forecast, 3)));
      return `<div class="page">
        ${head('weather', 'Weather', 'Live conditions, tuned for a card.', `<button class="icon-btn" data-action="weather-refresh" aria-label="Refresh">${K.icon('refresh')}</button>`)}
        ${K.rpcStatusCard('weather', 'Weather RPC', 'The card refreshes from live conditions.')}
        ${last ? `<div class="weather-hero">
          <div class="card-row between"><div class="weather-place">${K.icon('map-pin', 'sm')}${h(w.place || 'Current place')}</div><button class="icon-btn small" style="color:#fff;background:rgba(255,255,255,.09);border:0" data-action="weather-search" aria-label="Change place">${K.icon('search', 'sm')}</button></div>
          <div class="weather-main"><div><div class="weather-temp">${K.esc(last.temp)}°</div><div class="weather-desc">${h(last.desc)} · feels like ${K.esc(last.feels)}°${unit}</div></div><div class="weather-emoji">${K.esc(last.emoji || '☁️')}</div></div>
          <div class="weather-meta"><span>Humidity ${K.esc(last.humidity)}%</span><span>Wind ${K.esc(last.wind)} km/h</span><span>Rain ${K.esc(last.precip)} mm</span></div>
        </div>` : `<div class="weather-hero"><div class="weather-place">${K.icon('map-pin', 'sm')}${h(w.place || 'London')}</div><div class="weather-main"><div><div class="weather-temp">—°</div><div class="weather-desc">No forecast yet</div></div><div class="weather-emoji">🌤️</div></div><div class="weather-meta"><span>Look up live conditions to fill the card.</span></div></div>`}
        <div class="card-row" style="margin-bottom:14px">
          <button class="btn btn-tonal btn-sm" data-action="weather-search">${K.icon('search', 'sm')}Search city</button>
          <button class="btn btn-ghost btn-sm" data-action="weather-refresh">${K.icon('refresh', 'sm')}Refresh</button>
          <div class="segmented" style="margin-left:auto;min-width:100px"><button class="${w.unit !== 'f' ? 'active' : ''}" data-action="weather-unit" data-unit="c">°C</button><button class="${w.unit === 'f' ? 'active' : ''}" data-action="weather-unit" data-unit="f">°F</button></div>
        </div>
        ${days.length ? `<div class="section-label"><span>Forecast</span><span style="font-size:0.625rem;text-transform:none;letter-spacing:0;color:var(--faint)">${h(w.place || '')}</span></div><div class="forecast">${days.map(day => `<div class="forecast-day"><span>${new Date(day.date).toLocaleDateString([], { weekday: 'short' })}</span><div class="fe">${K.esc(day.emoji)}</div><b>${K.esc(day.max)}°</b><span>${K.esc(day.min)}° · ${K.esc(day.rain == null ? '—' : day.rain + '%')}</span></div>`).join('')}</div>` : ''}
        ${card('Card text', 'The weather card uses live values.', `
          ${K.field({ label: 'Activity name template', path: 'weather.template', value: w.template, placeholder: '{{weather_emoji}} {{weather_temp}} in {{place}}', hint: 'Tokens: {{weather_emoji}}, {{weather_temp}}, {{weather_feels}}, {{weather_desc}}, {{place}}.' })}
          ${K.field({ label: 'Details template', path: 'weather.details', value: w.details, placeholder: 'Feels like {{weather_feels}}' })}
          <div class="two-col">${K.select({ label: 'Forecast days', path: 'weather.forecast', value: w.forecast, options: [1, 2, 3, 5, 7].map(n => ({ value: n, label: `${n} day${n === 1 ? '' : 's'}` })) })}${K.select({ label: 'Unit', path: 'weather.unit', value: w.unit, options: [{ value: 'c', label: 'Celsius' }, { value: 'f', label: 'Fahrenheit' }] })}</div>
          <div class="field-hint">Changing the unit here saves it; use Refresh to fetch the new numbers.</div>
        `)}
        <div class="field-hint" style="padding:0 5px 16px">Weather is fetched from Open-Meteo. Your place and last forecast are stored on this server.</div>
        ${K.rpcDock('weather', 'Start Weather RPC')}
      </div>`;
    },
  };

  // ---------------------------------------------------------------------
  // navigation
  // ---------------------------------------------------------------------
  K.actions['nav-search'] = el => openPlaceSearch(el.dataset.mode === 'origin' ? 'nav-origin' : 'nav-destination', el.dataset.mode === 'origin' ? K.get('navigation.origin', '') : K.get('navigation.destination', ''));

  K.actions['nav-route'] = async () => {
    const nav = K.get('navigation', {});
    const lat1 = Number(nav.lat), lon1 = Number(nav.lon);
    const lat2 = Number(nav.destLat), lon2 = Number(nav.destLon);
    if (!Number.isFinite(lat1) || !Number.isFinite(lon1)) {
      K.toast('Set a starting point', 'Search an origin or use your current location.', 'error');
      return;
    }
    if (!Number.isFinite(lat2) || !Number.isFinite(lon2)) {
      K.toast('Set a destination', 'Search for a place first.', 'error');
      return;
    }
    K.toast('Calculating route…', '', '');
    try {
      const qs = new URLSearchParams({ lat1: String(lat1), lon1: String(lon1), lat2: String(lat2), lon2: String(lon2), name: nav.destination || 'Destination' });
      const data = await K.api('/api/route?' + qs.toString());
      const patch = { navigation: { distance: data.distance, duration: data.duration, distanceText: data.distanceText, durationText: data.durationText, routeName: data.name } };
      K.deepMerge(K.state, patch);
      await K.queuePatch(patch, 0);
      K.toast('Route ready', `${data.distanceText} · ${data.durationText}`, 'ok');
      K.render();
    } catch (error) {
      K.toast('Route unavailable', error.message, 'error');
    }
  };

  K.screens.navigation = {
    title: 'Navigation',
    render() {
      const nav = K.get('navigation', {});
      const hasRoute = !!(nav.distanceText && nav.durationText);
      return `<div class="page">
        ${head('navigation', 'Navigation', 'A destination, not a breadcrumb trail.')}
        ${K.rpcStatusCard('navigation', 'Navigation', 'The card shows where you are going.')}
        ${mapMarkup(nav.destLat ?? nav.lat, nav.destLon ?? nav.lon, nav.destination || nav.origin || 'No route yet')}
        ${card('Route', 'Search a start and destination.', `
          <button class="setting-row tappable" data-action="nav-search" data-mode="origin" style="width:100%;background:none;border:0;padding:0 0 10px;text-align:left">
            <div class="setting-icon">${K.icon('circle-dot')}</div><div class="setting-body"><div class="setting-title">${h(nav.origin || 'Starting point')}</div><div class="setting-desc">${h(coordinates(nav.lat, nav.lon))}</div></div>${K.icon('chevron-right', 'sm')}
          </button>
          <button class="setting-row tappable" data-action="nav-search" data-mode="destination" style="width:100%;background:none;border:0;padding:10px 0 0;text-align:left">
            <div class="setting-icon">${K.icon('map-pin')}</div><div class="setting-body"><div class="setting-title">${h(nav.destination || 'Destination')}</div><div class="setting-desc">${h(coordinates(nav.destLat, nav.destLon))}</div></div>${K.icon('chevron-right', 'sm')}
          </button>
          <button class="btn btn-tonal btn-block mt-12" data-action="nav-route">${K.icon('navigation', 'sm')}Calculate route</button>
        `)}
        ${hasRoute ? `<div class="card soft" style="margin-bottom:14px"><div class="card-row between"><div><div class="metric-label">Distance</div><b style="font-size:1.5rem">${h(nav.distanceText)}</b></div><div style="text-align:right"><div class="metric-label">Drive time</div><b style="font-size:1.5rem">${h(nav.durationText)}</b></div></div><div class="field-hint mt-8">Routing by OSRM · ${h(nav.routeName || nav.destination || '')}</div></div>` : ''}
        ${card('Card text', '', `
          ${K.field({ label: 'Destination', path: 'navigation.destination', value: nav.destination, placeholder: 'Home' })}
          ${K.field({ label: 'Route name', path: 'navigation.routeName', value: nav.routeName, placeholder: 'Home' })}
          ${K.field({ label: 'ETA text', path: 'navigation.durationText', value: nav.durationText, placeholder: '24 min' })}
          ${K.field({ label: 'Distance text', path: 'navigation.distanceText', value: nav.distanceText, placeholder: '12.4 km' })}
        `)}
        <div class="field-hint" style="padding:0 5px 16px">Browser navigation cannot follow you in real time. Use Kizzey Android for live turn-by-turn state.</div>
        ${K.rpcDock('navigation', 'Start Navigation RPC')}
      </div>`;
    },
  };

  // ---------------------------------------------------------------------
  // Android Auto
  // ---------------------------------------------------------------------
  K.actions['android-auto-connect'] = async () => {
    const connected = !K.get('androidAuto.connected', false);
    K.setLocal('androidAuto.connected', connected);
    await K.queuePatch({ androidAuto: { connected } }, 0);
    K.toast(connected ? 'Driving mode ready' : 'Driving mode off', connected ? 'Android Auto is simulated in the browser.' : '', connected ? 'ok' : '');
    K.render();
  };

  K.actions['auto-dashboard'] = () => {
    const nav = K.get('navigation', {});
    const weather = K.get('weather.last', {});
    K.sheet({
      title: 'Driving dashboard',
      subtitle: 'A calm, high-contrast view for the road.',
      body: `<div class="card" style="padding:28px 20px;background:radial-gradient(120% 130% at 80% 0,#283d42,#161d22 60%);color:#edf8fb">
        <div class="card-row between"><span class="badge plain" style="background:rgba(255,255,255,.09);color:#edf8fb">${K.icon('navigation', 'sm')}Android Auto</span><span style="font-size:2.625rem;font-weight:300;letter-spacing:-.05em">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
        <div style="margin-top:28px"><div style="font-size:0.625rem;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.5)">Next destination</div><div style="font-size:1.625rem;font-weight:700;margin-top:6px">${h(nav.destination || 'Pick a destination')}</div><div style="font-size:0.75rem;color:rgba(255,255,255,.6);margin-top:4px">${h([nav.durationText, nav.distanceText].filter(Boolean).join(' · ') || 'Navigation is not ready')}</div></div>
        <div class="card-row" style="margin-top:26px;gap:8px;flex-wrap:wrap"><span class="chip">${K.esc(weather.emoji || '🌤️')} ${K.esc(weather.temp != null ? weather.temp + '°' : 'Weather')}</span><span class="chip">${h(weather.desc || 'Look up the weather')}</span></div>
      </div>
      <div class="modal-actions"><button class="btn btn-ghost" data-close-sheet>Close</button><button class="btn btn-primary" data-route="navigation">${K.icon('navigation', 'sm')}Change route</button></div>`,
    });
  };

  K.screens['android-auto'] = {
    title: 'Android Auto',
    render() {
      const auto = K.get('androidAuto', {});
      return `<div class="page">
        ${head('android_auto', 'Android Auto', 'A simpler card for the car.')}
        ${K.rpcStatusCard('android_auto', 'Android Auto', auto.connected ? 'Driving mode is ready.' : 'Start driving mode below.')}
        ${card('', '', `<div class="card-row"><div class="feature-icon" style="width:48px;height:48px;background:var(--surface-2);color:var(--primary)">${K.icon('car')}</div><div style="flex:1"><div class="card-title">${auto.connected ? 'Connected' : 'Not connected'}</div><div class="card-sub">${auto.connected ? 'The dashboard and card are ready.' : 'Browser preview of the car experience.'}</div></div><button class="btn ${auto.connected ? 'btn-ghost' : 'btn-primary'} btn-sm" data-action="android-auto-connect">${auto.connected ? 'Turn off' : 'Turn on'}</button></div>`, { cls: 'soft' })}
        <div class="quick-grid-2" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">
          <button class="btn btn-tonal btn-sm" data-action="auto-dashboard">${K.icon('panel-top', 'sm')}Driving dashboard</button>
          <button class="btn btn-ghost btn-sm" data-route="navigation">${K.icon('navigation', 'sm')}Navigation</button>
        </div>
        ${card('Card content', 'Keep the road first.', `
          ${K.field({ label: 'Activity name', path: 'androidAuto.template', value: auto.template, placeholder: 'On the road' })}
          ${K.field({ label: 'Details', path: 'androidAuto.details', value: auto.details, placeholder: 'Android Auto' })}
          ${K.toggleRow({ title: 'Show route button', desc: 'Attach a button when navigation is set on Android', path: 'androidAuto.showButtons', checked: auto.showButtons, icon: 'link' })}
        `)}
        <div class="field-hint" style="padding:0 5px 16px">Android Auto projection is only available in the native app. This screen simulates the car view and sends the configured presence.</div>
        ${K.rpcDock('android_auto', 'Start Android Auto RPC')}
      </div>`;
    },
  };

  // ---------------------------------------------------------------------
  // Samsung
  // ---------------------------------------------------------------------
  const SAMSUNG_GAMES = ['Genshin Impact', 'PUBG Mobile', 'Call of Duty: Mobile', 'Roblox', 'Asphalt 9', 'Minecraft'];

  K.screens.samsung = {
    title: 'Samsung RPC',
    render() {
      const sam = K.get('samsung', {});
      const hostModel = K.get('host.model') || K.get('host.device') || 'this server';
      return `<div class="page">
        ${head('samsung', 'Samsung RPC', 'Galaxy-tuned game presence.')}
        ${K.rpcStatusCard('samsung', 'Samsung RPC', 'A small card for Galaxy gaming.')}
        ${card('', '', `<div class="card-row"><div class="feature-icon" style="width:46px;height:46px;background:color-mix(in srgb,var(--primary) 10%,var(--surface-2));color:var(--primary)">${K.icon('smartphone')}</div><div style="flex:1"><div class="card-title">${h(hostModel)}</div><div class="card-sub">Server host detected. Browser can't read the Galaxy Game Launcher.</div></div>${statusDot(K.get('gateway.connected'), 'Presence ready')}</div>`, { cls: 'soft' })}
        ${card('Game', 'Pick what is running.', `${K.field({ label: 'Game name', path: 'samsung.game', value: sam.game, placeholder: 'Genshin Impact' })}<div class="chips">${SAMSUNG_GAMES.map(game => `<button class="chip-toggle ${sam.game === game ? 'active' : ''}" data-action="samsung-game" data-game="${h(game)}">${h(game)}</button>`).join('')}</div>`)}
        <div class="field-hint" style="padding:0 5px 16px">Samsung Game Launcher integration requires the native app. This sends the same presence fields with the Samsung platform tag.</div>
        ${K.rpcDock('samsung', 'Start Samsung RPC')}
      </div>`;
    },
  };

  K.actions['samsung-game'] = async el => {
    const game = el.dataset.game;
    K.setLocal('samsung.game', game);
    await K.queuePatch({ samsung: { game } }, 0);
    K.render();
  };

  // ---------------------------------------------------------------------
  // emulation
  // ---------------------------------------------------------------------
  const EMULATORS = ['RetroArch', 'Dolphin', 'PPSSPP', 'AetherSX2', 'Ryujinx', 'melonDS', 'DuckStation'];
  const CORES = ['Dolphin', 'SwanStation', 'Mupen64Plus', 'PPSSPP', 'Beetle PSX', 'MelonDS', 'SameBoy'];

  K.screens.emulation = {
    title: 'Emulation RPC',
    render() {
      const emu = K.get('emulation', {});
      const art = imageValue('emulation.art');
      return `<div class="page">
        ${head('emulation', 'Emulation RPC', 'The games you keep coming back to.')}
        ${K.rpcStatusCard('emulation', 'Emulation RPC', 'Console energy, emulator details.')}
        ${art ? `<div class="media-stage" style="background:linear-gradient(135deg,color-mix(in srgb,var(--primary) 12%,var(--surface-1)),var(--surface-1))"><div class="media-art" style="width:92px;height:92px"><img src="${h(art)}" alt=""></div><div class="media-meta"><div class="media-title">${h(emu.game || 'Your game')}</div><div class="media-artist">${h(emu.emulator || 'RetroArch')}${emu.core ? ' · ' + h(emu.core) : ''}</div></div></div>` : ''}
        ${card('Emulator', 'Pick the app and core.', `
          <div class="chips" style="margin-bottom:12px">${EMULATORS.map(name => `<button class="chip-toggle ${emu.emulator === name ? 'active' : ''}" data-action="emu-set" data-key="emulator" data-value="${h(name)}">${h(name)}</button>`).join('')}</div>
          ${K.field({ label: 'Emulator', path: 'emulation.emulator', value: emu.emulator, placeholder: 'RetroArch' })}
          ${K.field({ label: 'Core', path: 'emulation.core', value: emu.core, placeholder: 'Dolphin' })}
          <div class="chips">${CORES.map(core => `<button class="chip-toggle ${emu.core === core ? 'active' : ''}" data-action="emu-set" data-key="core" data-value="${h(core)}">${h(core)}</button>`).join('')}</div>
        `)}
        ${card('Game', 'What is running?', `${K.field({ label: 'Game', path: 'emulation.game', value: emu.game, placeholder: 'The Legend of Zelda' })}${K.imageField({ label: 'Game artwork', urlPath: 'emulation.art', assetPath: 'emulation.art', target: 'emulation-art', hint: 'Optional square artwork.' })}`)}
        <div class="field-hint" style="padding:0 5px 16px">Emulator detection is not possible in a browser. Pick the app, core and game manually and the presence fields behave the same.</div>
        ${K.rpcDock('emulation', 'Start Emulation RPC')}
      </div>`;
    },
  };

  K.actions['emu-set'] = async el => {
    const key = el.dataset.key;
    const value = el.dataset.value;
    if (!key) return;
    K.setLocal('emulation.' + key, value);
    await K.queuePatch({ emulation: { [key]: value } }, 0);
    K.render();
  };

  // ---------------------------------------------------------------------
  // screen read / OCR
  // ---------------------------------------------------------------------
  const SCREEN_PRESETS = {
    'Genshin Impact': {
      fields: { name: 'Genshin Impact', details: '{{screen_name}}', state: '{{screen_score}}' },
      rules: { name: '(?:Player|Adventurer|Name)\\s*[:\\-]?\\s*([A-Za-z0-9_]{2,20})', score: '(?:Score|AR|Level|Score)\\s*[:\\-]?\\s*([0-9,]+)' },
    },
    Valorant: {
      fields: { name: 'VALORANT', details: '{{screen_name}}', state: 'Rank: {{screen_score}}' },
      rules: { name: '([A-Za-z0-9_]{2,16})#([A-Za-z0-9]{2,8})', score: '(?:Rank|RR)\\s*[:\\-]?\\s*([A-Za-z0-9 ]{2,20})' },
    },
    'League of Legends': {
      fields: { name: 'League of Legends', details: '{{screen_name}}', state: '{{screen_score}}' },
      rules: { name: '([A-Za-z0-9_]{2,16})', score: '(?:Level|Mastery)\\s*[:\\-]?\\s*([0-9]+)' },
    },
    Custom: {
      fields: { name: 'Screen Read', details: '{{screen_name}}', state: '{{screen_score}}' },
      rules: { name: '(?:Player|Name)\\s*[:\\-]?\\s*([A-Za-z0-9_]{2,20})', score: '(?:Score|Level)\\s*[:\\-]?\\s*([0-9,]+)' },
    },
  };

  function applyRules(text, rules) {
    const fields = {};
    for (const key of ['name', 'score']) {
      const pattern = rules?.[key];
      if (!pattern) continue;
      try {
        const match = new RegExp(pattern, 'i').exec(text);
        if (match) fields['screen_' + key] = (match[1] || match[0] || '').trim();
      } catch (error) {
        fields['screen_' + key] = '';
      }
    }
    return fields;
  }

  async function ocrImage(url) {
    const data = await K.api('/api/ocr', { method: 'POST', body: { image: url } });
    return data.text || '';
  }

  async function processScreenData(dataUrl) {
    K.toast('Reading the screen…', 'Tesseract is looking for player and score fields.', '');
    const upload = await K.api('/api/upload', { method: 'POST', body: { data: dataUrl, filename: 'screen-read.jpg', localOnly: true } });
    const text = await ocrImage(upload.url);
    const rules = K.get('screenRead.rules', {}) || {};
    const fields = applyRules(text, rules);
    const patch = { screenRead: { lastImage: upload.url, lastText: text, lastFields: fields, capturedAt: Date.now() } };
    K.deepMerge(K.state, patch);
    await K.queuePatch(patch, 0);
    K.toast('Screen read', text ? `${fields.screen_name || 'Text found'}${fields.screen_score ? ' · ' + fields.screen_score : ''}` : 'No text was detected.', text ? 'ok' : '');
    K.render();
  }

  K.actions['capture-screen'] = async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      K.toast('Screen capture unavailable', 'Use the screenshot upload button instead.', 'error');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 2 }, audio: false });
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      await new Promise(resolve => {
        if (video.videoWidth) return resolve();
        video.addEventListener('loadedmetadata', resolve, { once: true });
        setTimeout(resolve, 1500);
      });
      const canvas = document.createElement('canvas');
      const width = video.videoWidth || 1280;
      const height = video.videoHeight || 720;
      const scale = Math.min(1, 1920 / width);
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      video.remove();
      stream.getTracks().forEach(track => track.stop());
      await processScreenData(canvas.toDataURL('image/jpeg', 0.9));
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      if (error.name === 'NotAllowedError') return;
      K.toast('Screen capture failed', error.message, 'error');
    }
  };

  K.actions['screen-upload'] = function () {
    K.bindFilePicker(async file => {
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        await processScreenData(dataUrl);
      } catch (error) {
        K.toast('Screen upload failed', error.message, 'error');
      }
    }, 'image/*');
  };

  K.actions['screen-preset'] = async el => {
    const name = el.dataset.preset;
    const preset = SCREEN_PRESETS[name];
    if (!preset) return;
    const patch = { screenRead: { preset: name, fields: preset.fields, rules: preset.rules } };
    K.deepMerge(K.state, patch);
    await K.queuePatch(patch, 0);
    K.toast('Preset applied', name, 'ok');
    K.render();
  };

  K.actions['screen-clear'] = async () => {
    const patch = { screenRead: { lastImage: '', lastText: '', lastFields: {}, capturedAt: null } };
    K.deepMerge(K.state, patch);
    await K.queuePatch(patch, 0);
    K.render();
  };

  K.screens['screen-read'] = {
    title: 'Screen Read',
    render() {
      const sr = K.get('screenRead', {});
      const last = sr.lastFields || {};
      const image = imageValue('screenRead.lastImage');
      return `<div class="page">
        ${head('screen_read', 'Screen Read', 'Turn a screenshot into a card.')}
        ${K.rpcStatusCard('screen_read', 'Screen Read', 'OCR runs on your own server with Tesseract.')}
        <div class="capture-frame" style="margin-bottom:12px">
          ${image ? `<img src="${h(image)}" alt="Captured screen">` : `<div class="capture-cta"><div class="empty-icon" style="margin:0">${K.icon('scan', 'xl')}</div><b>${sr.capturedAt ? 'Screen needs a refresh' : 'Capture a game screen'}</b><span>Share a browser tab, window or screen. Nothing is captured until you press the button.</span></div>`}
        </div>
        <div class="quick-grid-2" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">
          <button class="btn btn-primary btn-sm" data-action="capture-screen">${K.icon('scan', 'sm')}Capture screen</button>
          <button class="btn btn-tonal btn-sm" data-action="screen-upload">${K.icon('upload', 'sm')}Upload screenshot</button>
        </div>
        ${Object.keys(last).length ? `<div class="detected">${Object.entries(last).map(([key, value]) => `<span class="chip">${h(key.replace('screen_', ''))}: ${h(value || '—')}</span>`).join('')}</div>` : ''}
        ${sr.lastText ? `<details class="card soft" style="margin-bottom:14px"><summary class="card-title" style="cursor:pointer">Raw OCR text <span class="tiny muted">(${h(sr.lastText.length)} chars)</span></summary><pre class="ocr-result mt-12">${h(sr.lastText)}</pre><div class="field-hint">Captured ${h(K.fmtDateTime(sr.capturedAt))}</div></details>` : ''}
        ${card('Preset', 'Rules decide which text becomes name and score.', `<div class="chips">${Object.keys(SCREEN_PRESETS).map(name => `<button class="chip-toggle ${sr.preset === name ? 'active' : ''}" data-action="screen-preset" data-preset="${h(name)}">${h(name)}</button>`).join('')}</div>`)}
        ${K.rpcSection('screen-rules', 'Detection rules', 'JavaScript regular expressions', 'code', `
          <div class="two-col">${K.field({ label: 'Name pattern', path: 'screenRead.rules.name', value: sr.rules?.name, placeholder: 'Player\\s*:\\s*(.+)' })}${K.field({ label: 'Score pattern', path: 'screenRead.rules.score', value: sr.rules?.score, placeholder: 'Score\\s*:\\s*(.+)' })}</div>
          <div class="field-hint">The first capture group is stored as {{screen_name}} or {{screen_score}}. Text is read with Tesseract 5.</div>
        `, { open: true })}
        ${K.rpcSection('screen-fields', 'Card text', 'Use captured tokens', 'edit', `
          ${K.field({ label: 'Activity name', path: 'screenRead.fields.name', value: sr.fields?.name, placeholder: 'Genshin Impact' })}
          ${K.field({ label: 'Details', path: 'screenRead.fields.details', value: sr.fields?.details, placeholder: '{{screen_name}}' })}
          ${K.field({ label: 'State', path: 'screenRead.fields.state', value: sr.fields?.state, placeholder: '{{screen_score}}' })}
        `, { open: true })}
        <div class="card soft" style="margin-bottom:14px"><div class="card-row"><div class="feature-icon" style="width:40px;height:40px;background:var(--surface-2);color:var(--primary)">${K.icon('shield')}</div><div><div class="card-title" style="font-size:0.8125rem">Capture stays local</div><div class="card-sub">The image is sent to this Kizzey server for OCR and is stored under data/uploads. Discord only receives the resolved text.</div></div></div></div>
        ${image ? `<div class="card-row" style="margin:0 3px 8px"><button class="btn btn-ghost btn-sm" data-action="screen-clear">${K.icon('trash', 'sm')}Clear capture</button></div>` : ''}
        <div style="height:4px"></div>
        ${K.rpcDock('screen_read', 'Start Screen Read')}
      </div>`;
    },
  };
})();
