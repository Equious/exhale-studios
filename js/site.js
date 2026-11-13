/*
 * Getting around.
 *
 * The site is a front hall with a door for each game, and one page per game.
 * Only one of those places is on screen at a time.
 *
 *   Going through a door (or back out)  is a walk: the smoke closes into a
 *                                       wall, the name of the place ahead
 *                                       hangs in it, and it clears on the
 *                                       other side.
 *   Moving around inside one place      is ordinary scrolling. The smoke
 *                                       belongs to the page and scrolls with
 *                                       it, banked up between the rooms.
 */
(function () {
  'use strict';

  var root = document.documentElement;
  var canvas = document.getElementById('smoke');
  var gateEl = document.getElementById('gates');
  var gateText = gateEl ? gateEl.querySelector('.gate-text') : null;
  var navLinks = Array.prototype.slice.call(document.querySelectorAll('.bar-nav a'));
  var doors = Array.prototype.slice.call(document.querySelectorAll('.doors a.door'));
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var BASE_TITLE = document.title;

  var views = Array.prototype.slice.call(document.querySelectorAll('.view')).map(function (el) {
    var name = el.getAttribute('data-gate');
    return {
      el: el,
      id: el.id,
      gate: name ? name.split('|') : null,
      title: name ? name.replace(/\|/g, ' ') : '',
      tint: (el.getAttribute('data-tint') || '0.86,0.86,0.84').split(',').map(Number),
      tintAmt: parseFloat(el.getAttribute('data-tint-amt') || '0'),
      ping: el.hasAttribute('data-ping') ? 1 : 0,
      rooms: Array.prototype.slice.call(el.querySelectorAll('.room'))
    };
  });

  function viewIndex(id) {
    for (var i = 0; i < views.length; i++) if (views[i].id === id) return i;
    return -1;
  }

  // Each door glows with the colour of the smoke behind it.
  var lamps = doors.map(function (a) {
    var v = views[viewIndex(a.getAttribute('href').slice(1))];
    return { el: a, arch: a.querySelector('.door-arch') || a, tint: v ? v.tint : [1, 1, 1], lit: 0.5 };
  });
  var hotDoor = -1;

  var smoke = window.ExhaleSmoke ? window.ExhaleSmoke.create(canvas) : null;
  if (!smoke) root.classList.add('no-gl');

  var here = Math.max(0, viewIndex(root.getAttribute('data-view')));
  var walk = null;          // the walk in progress, if any
  var queued = null;        // where to go once it ends
  var travel = 0;           // how far the camera has walked; whole numbers at rest
  var lastTravel = 0;
  var lastScroll = window.scrollY;
  var fade = 0, fadeTo = 1;
  var clock = 0, last = 0;

  /* ---------- helpers ---------- */

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function smooth(a, b, v) { var t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function mix(a, b, t) { return a + (b - a) * t; }
  function vh() { return Math.max(window.innerHeight, 1); }

  /* ---------- which place is showing ---------- */

  function show(i) {
    here = i;
    root.setAttribute('data-view', views[i].id);
    navLinks.forEach(function (a) {
      if (a.getAttribute('href') === '#' + views[i].id) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    document.title = views[i].title ? views[i].title + ' | ' + BASE_TITLE : BASE_TITLE;
  }

  function scrollToAnchor(anchor, gently) {
    var top = 0;
    if (anchor) {
      var bar = parseFloat(getComputedStyle(root).getPropertyValue('--bar-h')) || 64;
      top = Math.max(0, anchor.getBoundingClientRect().top + window.scrollY - bar);
    }
    window.scrollTo({ top: top, behavior: gently && !reduceMotion.matches ? 'smooth' : 'auto' });
  }

  // A link can point at a place (#alembic) or at something inside one (#studio).
  function resolve(hash) {
    var id = (hash || '').replace(/^#/, '') || 'top';
    var el = document.getElementById(id);
    var place = el && el.closest ? el.closest('.view') : null;
    if (!place) return { view: 0, anchor: null, url: '' };
    var anchor = el === place ? null : el;
    return { view: viewIndex(place.id), anchor: anchor, url: id === 'top' ? '' : '#' + id };
  }

  function go(hash, record) {
    if (walk) { queued = { hash: hash, record: record }; return; }
    var to = resolve(hash);
    if (record && history.pushState && (location.hash || '') !== to.url) {
      try { history.pushState(null, '', to.url || location.pathname + location.search); } catch (err) { /* file:// */ }
    }
    if (to.view === here) { scrollToAnchor(to.anchor, true); return; }
    startWalk(to.view, to.anchor);
  }

  /* ---------- the walk between places ---------- */

  function startWalk(to, anchor) {
    if (reduceMotion.matches) {
      show(to);
      scrollToAnchor(anchor, false);
      lastScroll = window.scrollY;
      settle();
      return;
    }
    // Leaving a game for the front hall is a step back out, and quicker.
    var back = to === 0;
    walk = {
      from: here, to: to, anchor: anchor,
      dir: back ? -1 : 1,
      dur: back ? 1.9 : 2.6,
      start: performance.now(),
      travel0: travel,
      swapped: false,
      pin: null
    };
    views[here].el.style.transformOrigin = '50% ' + (window.scrollY + vh() / 2) + 'px';
    root.classList.add('walking');
    if (gateText) {
      gateText.textContent = '';
      var lines = back ? [] : views[to].gate || [];
      gateText.className = 'gate-text' + (lines.length > 2 ? ' is-long' : '');
      lines.forEach(function (line) {
        var span = document.createElement('span');
        span.textContent = line;
        gateText.appendChild(span);
      });
    }
  }

  function settle() {
    var el = views[here].el;
    if (el.hasAttribute('tabindex')) el.focus({ preventScroll: true });
  }

  function stepWalk(now) {
    var t = walk.pin !== null ? walk.pin : clamp((now - walk.start) / 1000 / walk.dur, 0, 1);
    var out = views[walk.from].el, into = views[walk.to].el;

    // The swap happens in the thick of it, where nobody can see.
    if (!walk.swapped && t >= 0.5) {
      walk.swapped = true;
      out.style.transform = out.style.opacity = out.style.transformOrigin = '';
      show(walk.to);
      scrollToAnchor(walk.anchor, false);
      lastScroll = window.scrollY;
      into.style.transformOrigin = '50% ' + (window.scrollY + vh() / 2) + 'px';
    }

    if (!walk.swapped) {
      // Walking forward, what you leave comes up and past you. Stepping back, it recedes.
      var p = t / 0.5;
      out.style.opacity = (1 - smooth(0.05, 0.8, p)).toFixed(3);
      out.style.transform = 'scale(' + (walk.dir > 0 ? 1 + 0.45 * p * p : 1 - 0.14 * p).toFixed(4) + ')';
    } else {
      var q = (t - 0.5) / 0.5, eased = 1 - Math.pow(1 - q, 3);
      into.style.opacity = smooth(0.2, 0.95, q).toFixed(3);
      into.style.transform = 'scale(' + (walk.dir > 0 ? 0.84 + 0.16 * eased : 1.2 - 0.2 * eased).toFixed(4) + ')';
    }

    if (gateEl) {
      var o = walk.dir > 0 ? smooth(0.2, 0.42, t) * smooth(0.86, 0.62, t) : 0;
      gateEl.style.visibility = o > 0.004 ? 'visible' : 'hidden';
      gateEl.style.opacity = o.toFixed(3);
      gateEl.style.transform = 'scale(' + (0.62 * Math.exp(0.95 * t)).toFixed(4) + ')';
      var blur = (1 - o) * 12;
      gateEl.style.filter = blur > 0.4 ? 'blur(' + blur.toFixed(1) + 'px)' : 'none';
    }

    travel = walk.travel0 + walk.dir * t * t * (3 - 2 * t);

    var blend = smooth(0.3, 0.7, t), A = views[walk.from], B = views[walk.to];
    for (var c = 0; c < 3; c++) state.tint[c] = mix(A.tint[c], B.tint[c], blend);
    state.tintAmt = mix(A.tintAmt, B.tintAmt, blend);
    state.wall = smooth(0, 0.36, t) * smooth(1, 0.64, t);

    if (t >= 1 && walk.pin === null) {
      into.style.transform = into.style.opacity = into.style.transformOrigin = '';
      if (gateEl) gateEl.style.visibility = 'hidden';
      travel = walk.travel0 + walk.dir;
      state.wall = 0;
      walk = null;
      root.classList.remove('walking');
      settle();
      if (queued) { var next = queued; queued = null; go(next.hash, next.record); }
    }
  }

  /* ---------- frame ---------- */

  var state = {
    time: 0, travel: 0, walked: 0, wall: 0, scroll: 0, shift: 0,
    column: 0.5, veil: 0.2, seams: [-9, -9, -9, -9],
    emit: new Float32Array(18), lampPos: new Float32Array(12), lampCol: new Float32Array(12),
    tint: [0.86, 0.86, 0.84], tintAmt: 0,
    ping: 0, pingT: 0, pingAt: [0.5, 0.5],
    fade: 0, still: false
  };

  // Where the gaps between this place's rooms are on screen right now.
  function findSeams() {
    var rooms = views[here].rooms, H = vh(), n = 0;
    state.seams[0] = state.seams[1] = state.seams[2] = state.seams[3] = -9;
    for (var i = 1; i < rooms.length && n < 4; i++) {
      var y = 1 - rooms[i].getBoundingClientRect().top / H;
      if (y > -0.4 && y < 1.4) state.seams[n++] = y;
    }
  }

  function findLamps(dt) {
    var W = Math.max(window.innerWidth, 1), H = vh();
    var on = here === 0 ? 1 - state.wall : 0;
    for (var i = 0; i < 4; i++) {
      var L = lamps[i], k = i * 3;
      if (!L || on <= 0) {
        state.lampCol[k] = state.lampCol[k + 1] = state.lampCol[k + 2] = 0;
        state.emit[k + 2] = 0;
        continue;
      }
      var want = hotDoor < 0 ? 0.5 : hotDoor === i ? 1 : 0.28;
      L.lit += (want - L.lit) * (1 - Math.exp(-dt * 5));
      var r = L.arch.getBoundingClientRect();
      state.lampPos[k] = (r.left + r.width / 2) / W;
      state.lampPos[k + 1] = 1 - (r.top + r.height * 0.62) / H;
      state.lampPos[k + 2] = Math.max(r.width, r.height * 0.6) * 0.62 / H;
      for (var c = 0; c < 3; c++) state.lampCol[k + c] = L.tint[c] * L.lit * on;
      // Smoke seeps out from under each door.
      state.emit[k] = state.lampPos[k];
      state.emit[k + 1] = 1 - (r.bottom - r.height * 0.06) / H;
      state.emit[k + 2] = on * (0.25 + 0.5 * L.lit) * 0.9;
    }
  }

  function frame(now) {
    requestAnimationFrame(frame);
    var dt = Math.min((now - last) / 1000 || 0.016, 0.05);
    last = now;
    var still = reduceMotion.matches;
    if (!still) clock += dt;

    if (walk) stepWalk(now);
    if (!walk) {
      var v = views[here];
      for (var c = 0; c < 3; c++) state.tint[c] = v.tint[c];
      state.tintAmt = v.tintAmt;
      state.wall = 0;
    }

    var H = vh(), y = window.scrollY;
    state.shift = clamp((y - lastScroll) / H, -2, 2);
    lastScroll = y;
    state.scroll = y / H;
    state.walked = travel - lastTravel;
    lastTravel = travel;
    state.travel = travel;

    // The column of content the smoke keeps thin over, as a share of the screen's height.
    var gutter = clamp(window.innerWidth * 0.05, 20, 72);
    state.column = Math.min(1240, window.innerWidth - gutter * 2) / 2 / H;
    state.veil = window.innerWidth < 700 ? 0.08 : 0.12;
    findSeams();
    findLamps(dt);

    state.ping = views[here].ping * (1 - state.wall) * (1 - smooth(0.25, 0.8, state.scroll));
    state.pingT = (clock / 3.4) % 1;
    state.pingAt[0] = window.innerWidth >= 900 ? 0.72 : 0.5;
    state.pingAt[1] = window.innerWidth >= 900 ? 0.5 : 0.66;

    root.classList.toggle('at-start', here === 0 && y < H * 0.35);

    fade += (fadeTo - fade) * (1 - Math.exp(-dt * 1.1));
    state.fade = still ? fadeTo : fade;
    state.time = clock + 40;
    state.still = still;

    if (smoke) smoke.render(state, dt);
    else canvas.style.setProperty('--veil', (0.14 + state.wall * 0.8).toFixed(3));
  }

  /* ---------- the first breath ---------- */

  function arrive() {
    var seen = false;
    try { seen = sessionStorage.getItem('exhale-arrived') === '1'; } catch (err) { /* private mode */ }

    function reveal() {
      root.classList.remove('arriving');
      root.classList.add('arrived');
      fadeTo = 1;
      setTimeout(function () { root.classList.add('settled'); }, 5200);
    }

    if (here !== 0 || location.hash || seen || reduceMotion.matches) {
      fade = reduceMotion.matches ? 1 : 0.2;
      root.classList.remove('arriving');
      root.classList.add('arrived', 'settled');
      return;
    }

    // The studio's own smoke: one long breath out across the screen, and the
    // name is there when it clears.
    root.classList.add('arriving');
    fade = 0; fadeTo = 0;
    var video = document.createElement('video');
    video.className = 'exhale';
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('aria-hidden', 'true');
    video.preload = 'auto';
    [['assets/brand/exhale.mp4', 'video/mp4'], ['assets/brand/exhale.webm', 'video/webm']].forEach(function (f) {
      var source = document.createElement('source');
      source.src = f[0]; source.type = f[1];
      video.appendChild(source);
    });
    document.body.appendChild(video);

    var done = false;
    function finish() {
      if (done) return;
      done = true;
      try { sessionStorage.setItem('exhale-arrived', '1'); } catch (err) { /* private mode */ }
      reveal();
      video.classList.add('is-done');
      setTimeout(function () { video.remove(); }, 1400);
      window.removeEventListener('scroll', onScroll);
      document.removeEventListener('click', finish, true);
    }
    function onScroll() { if (window.scrollY > 60) finish(); }

    var revealed = false;
    video.addEventListener('timeupdate', function () {
      if (!revealed && video.currentTime > 2.6) { revealed = true; reveal(); }
      if (video.currentTime > 6.6) finish();
    });
    video.addEventListener('ended', finish);
    video.addEventListener('error', finish);
    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('click', finish, true);
    video.playbackRate = 1.35;
    var p = video.play();
    if (p && p.catch) p.catch(finish);
    setTimeout(function () { if (video.readyState < 2) finish(); }, 2500);
  }

  /* ---------- video: only what is on screen plays ---------- */

  var watcher = null;
  if ('IntersectionObserver' in window) {
    watcher = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var video = entry.target;
        if (entry.isIntersecting && !reduceMotion.matches) {
          var p = video.play();
          if (p && p.catch) p.catch(function () {});
        } else {
          video.pause();
        }
      });
    }, { threshold: 0.25 });
    Array.prototype.forEach.call(document.querySelectorAll('.view video'), function (video) { watcher.observe(video); });
  }

  /* ---------- galleries and the lightbox ---------- */

  function swapMedia(button) {
    var gallery = button.closest('[data-gallery]');
    var frameEl = gallery.querySelector('.frame');
    var old = frameEl.querySelector('.frame-media');
    var kind = button.getAttribute('data-kind');
    var src = button.getAttribute('data-src');
    var label = button.getAttribute('data-label') || '';
    var next;
    if (kind === 'video') {
      next = document.createElement('video');
      next.muted = true; next.loop = true; next.playsInline = true;
      next.setAttribute('playsinline', '');
      next.preload = 'none';
      next.poster = button.getAttribute('data-poster') || '';
      next.src = src;
      next.setAttribute('aria-label', label);
    } else {
      next = document.createElement('img');
      next.src = src;
      next.alt = label;
    }
    next.className = 'frame-media';
    if (watcher && old.tagName === 'VIDEO') watcher.unobserve(old);
    frameEl.replaceChild(next, old);
    if (watcher && kind === 'video') watcher.observe(next);
    Array.prototype.forEach.call(gallery.querySelectorAll('.thumb'), function (t) {
      t.setAttribute('aria-pressed', t === button ? 'true' : 'false');
    });
  }

  var lightbox = document.querySelector('.lightbox');
  function zoom(button) {
    if (!lightbox || !lightbox.showModal) return;
    var img = lightbox.querySelector('img');
    img.src = button.getAttribute('data-zoom');
    img.alt = button.getAttribute('data-label') || '';
    lightbox.showModal();
  }
  if (lightbox) {
    lightbox.addEventListener('click', function (e) {
      if (e.target === lightbox || e.target.tagName === 'IMG') lightbox.close();
    });
  }

  /* ---------- input ---------- */

  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('a[href^="#"], .thumb, [data-zoom]') : null;
    if (!t) return;
    if (t.matches('.thumb')) { swapMedia(t); return; }
    if (t.matches('[data-zoom]')) { zoom(t); return; }
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(t.getAttribute('href'), true);
    if (t.classList.contains('skip') && doors[0]) doors[0].focus({ preventScroll: true });
  });

  // Back and forward walk too.
  window.addEventListener('popstate', function () { go(location.hash, false); });

  lamps.forEach(function (L, i) {
    L.el.addEventListener('pointerenter', function () { hotDoor = i; });
    L.el.addEventListener('pointerleave', function () { if (hotDoor === i) hotDoor = -1; });
    L.el.addEventListener('focus', function () { hotDoor = i; });
    L.el.addEventListener('blur', function () { if (hotDoor === i) hotDoor = -1; });
  });

  window.addEventListener('pointermove', function (e) {
    if (smoke) smoke.pointer(e.clientX, e.clientY);
  }, { passive: true });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (type) {
    window.addEventListener(type, function (e) {
      if (smoke && (e.pointerType !== 'mouse' || type === 'pointerleave')) smoke.pointerLift();
    }, { passive: true });
  });

  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { if (smoke) smoke.resize(); }, 120);
  });

  /* ---------- go ---------- */

  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  show(here);
  if (location.hash) {
    var first = resolve(location.hash);
    if (first.anchor) scrollToAnchor(first.anchor, false);
  }
  lastScroll = window.scrollY;
  arrive();
  requestAnimationFrame(function (t) { last = t; frame(t); });

  // For checking the site by hand or in tests.
  window.Exhale = {
    go: function (hash) { go(hash, true); },
    // Stand part-way through a walk: Exhale.pin('#alembic', 0.5) is the thick of it.
    pin: function (hash, t) {
      var to = resolve(hash);
      if (!walk && to.view !== here) startWalk(to.view, to.anchor);
      if (walk) walk.pin = t;
    },
    release: function () { if (walk) { walk.start = performance.now() - walk.pin * walk.dur * 1000; walk.pin = null; } },
    advance: function (seconds) { if (smoke) smoke.advance(state, seconds); },
    hasAir: function () { return !!(smoke && smoke.hasAir()); },
    where: function () { return views[here].id; }
  };
})();
