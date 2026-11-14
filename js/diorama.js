/*
 * Diorama — stylised low-poly 3D dioramas of Vienna's Christmas markets.
 *
 * Classic script (no modules, no build). Needs the vendored three.js r170 global `THREE`
 * (incl. THREE.OrbitControls). Everything is procedural: geometry is generated from a few
 * unit primitives and merged into a handful of vertex-coloured meshes per scene.
 *
 *   window.Diorama.isSupported()                       -> boolean
 *   window.Diorama.mount(containerEl, market, opts)    -> { dispose(), setTheme(theme) }
 *     opts: { theme: 'dark'|'light' (default 'dark'), autoRotate: true,
 *             still: false (no animation, fixed 3/4 view — for screenshots),
 *             reducedMotion: undefined (override prefers-reduced-motion detection) }
 *
 * Structure:
 *   utils / palette / unit primitives  ->  Builder (merges geometry per layer)
 *   shared helpers (stall, tree, lamp, person, house …)
 *   LANDMARKS[key](ctx)   — the signature building(s) at the back of the board
 *   LAYOUTS[key](ctx)     — stall slots, feature spots, lamps, walk areas, extra scenery
 *   FEATURES[key](ctx,s)  — optional attractions
 *   buildScene()          — landmark -> layout -> features -> stalls -> decoration
 *   mount()               — renderer, camera fit, controls, loop, theme, dispose
 */
(function (global) {
  'use strict';

  var THREE = global.THREE;
  var PI = Math.PI, TAU = PI * 2, HALF = PI / 2;
  var BOARD = 10, CORNER = 2.6;

  /* ------------------------------------------------------------------ utils */

  function hashStr(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function makeRng(seed) {
    var a = seed >>> 0;
    function next() {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    return {
      next: next,
      range: function (lo, hi) { return lo + (hi - lo) * next(); },
      int: function (lo, hi) { return lo + Math.floor(next() * (hi - lo + 1)); },
      pick: function (arr) { return arr[Math.floor(next() * arr.length)]; },
      chance: function (p) { return next() < p; }
    };
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  /* ---------------------------------------------------------------- palette */

  var P = {
    snow: 0xf3f6fa, plaza: 0xdcd7cf, cobble: 0xcbc2b5, path: 0xd3c7b5,
    plinth: 0x3a2a20, plinthTop: 0x5e4636,
    wood: 0x8c5a3a, woodDark: 0x5f3c26, woodLight: 0xc49463,
    red: 0xb4343b, white: 0xf4efe6, green: 0x2f5e49, gold: 0xd9aa48,
    stone: 0xdcd2bf, stoneDark: 0xa39985, sand: 0xd8cab0, cream: 0xf0e4c6, ochre: 0xdcb062,
    yellow: 0xeabc4c, slate: 0x58606f, tile: 0x8f4c3d, copper: 0x6fae96, bronze: 0x5a7a69,
    conifer: 0x2b5843, trunk: 0x5b3e2b, bark: 0x6e5a4a, iron: 0x2c2e35,
    warm: 0xffc46b, glowWin: 0xffd38a, bulb: 0xffdf9e, water: 0x23425c, ice: 0xd2ecf7,
    straw: 0xd9b860, skin: 0xf0c6a4
  };
  var COATS = [0xb4343b, 0x2f5f8a, 0x3d7a52, 0xd9aa48, 0x7b3f6e, 0x384556, 0xc4643c, 0xe7e1d6, 0x8a2f3c];
  var PASTEL = [0xeedbb5, 0xdcb68a, 0xe6c6c0, 0xcdd7c2, 0xf2e8d8, 0xd8c3a2, 0xc3d1db, 0xe8d08f, 0xe9c9a4];
  var ROOFS = [0x8f4c3d, 0x7e4436, 0x5c6372, 0x6b5a50];
  var BULBS = [0xffdf9e, 0xffd27a, 0xfff1cf];
  var PARTY = [0xffdf9e, 0xff6b6b, 0x7fd0ff, 0xffd27a, 0x9cff9c];

  var _linCache = {};
  function lin(hex) {
    var c = _linCache[hex];
    if (!c) { var col = new THREE.Color(hex); c = _linCache[hex] = [col.r, col.g, col.b]; }
    return c;
  }
  function shade(hex, f) {
    var r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
    return (clamp(Math.round(r * f), 0, 255) << 16) | (clamp(Math.round(g * f), 0, 255) << 8) | clamp(Math.round(b * f), 0, 255);
  }

  /* ------------------------------------------------------- unit primitives */
  // Each primitive is cached as a flat, non-indexed Float32Array of triangle positions.

  var PRIM = {};
  function prim(key, make) {
    var a = PRIM[key];
    if (!a) a = PRIM[key] = make();
    return a;
  }
  function fromGeo(g) {
    var ng = g.index ? g.toNonIndexed() : g;
    var a = new Float32Array(ng.attributes.position.array);
    if (ng !== g) ng.dispose();
    g.dispose();
    return a;
  }
  function triList(fill) {
    var out = [];
    fill(function (A, B, C) { out.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]); });
    return new Float32Array(out);
  }
  var PR = {
    box: function () { return prim('box', function () { return fromGeo(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)); }); },
    boxc: function () { return prim('boxc', function () { return fromGeo(new THREE.BoxGeometry(1, 1, 1)); }); },
    cyl: function (seg, top) {
      return prim('cyl' + seg + '_' + top, function () { return fromGeo(new THREE.CylinderGeometry(top, 1, 1, seg, 1, false).translate(0, 0.5, 0)); });
    },
    cone: function (seg, base) {
      return prim('cone' + seg + (base ? 'b' : ''), function () {
        return triList(function (t) {
          for (var i = 0; i < seg; i++) {
            var a0 = i / seg * TAU, a1 = (i + 1) / seg * TAU;
            var p0 = [Math.cos(a0), 0, -Math.sin(a0)], p1 = [Math.cos(a1), 0, -Math.sin(a1)];
            t(p0, p1, [0, 1, 0]);
            if (base) t(p1, p0, [0, 0, 0]);
          }
        });
      });
    },
    sph: function (w, h) { return prim('sph' + w + '_' + h, function () { return fromGeo(new THREE.SphereGeometry(1, w, h)); }); },
    ico: function () { return prim('ico', function () { return fromGeo(new THREE.IcosahedronGeometry(1, 0)); }); },
    dome: function (seg, rings) {
      return prim('dome' + seg + '_' + rings, function () { return fromGeo(new THREE.SphereGeometry(1, seg, rings, 0, TAU, 0, HALF)); });
    },
    halfcyl: function (seg) {
      return prim('hcyl' + seg, function () { return fromGeo(new THREE.CylinderGeometry(1, 1, 1, seg, 1, false, -HALF, PI).rotateX(-HALF)); });
    },
    gable: function () {
      return prim('gable', function () {
        return triList(function (t) {
          var P0 = [-.5, 0, .5], P1 = [.5, 0, .5], P2 = [.5, 1, 0], P3 = [-.5, 1, 0], Q0 = [.5, 0, -.5], Q1 = [-.5, 0, -.5];
          t(P0, P1, P2); t(P0, P2, P3); t(Q0, Q1, P3); t(Q0, P3, P2);
          t(P1, Q0, P2); t(Q1, P0, P3); t(Q1, Q0, P1); t(Q1, P1, P0);
        });
      });
    },
    hip: function (k) {
      k = Math.round(k * 100) / 100;
      return prim('hip' + k, function () {
        return triList(function (t) {
          var A = [-.5, 0, .5], B = [.5, 0, .5], C = [.5, 0, -.5], D = [-.5, 0, -.5], r1 = [-k / 2, 1, 0], r2 = [k / 2, 1, 0];
          t(A, B, r2); t(A, r2, r1); t(C, D, r1); t(C, r1, r2); t(B, C, r2); t(D, A, r1); t(D, C, B); t(D, B, A);
        });
      });
    },
    quad: function () { return prim('quad', function () { return fromGeo(new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0)); }); },
    disc: function (seg) { return prim('disc' + seg, function () { return fromGeo(new THREE.CircleGeometry(1, seg).rotateX(-HALF)); }); },
    torus: function (seg, tube, arc) {
      tube = Math.round(tube * 1000) / 1000; arc = Math.round(arc * 1000) / 1000;
      return prim('tor' + seg + '_' + tube + '_' + arc, function () { return fromGeo(new THREE.TorusGeometry(1, tube, 3, seg, arc)); });
    },
    arch: function (pointed, a) {
      a = Math.max(0.6, Math.round(a * 10) / 10);
      return prim('arch' + (pointed ? 'p' : 'r') + a, function () {
        var s = new THREE.Shape();
        s.moveTo(-.5, 0); s.lineTo(.5, 0);
        if (pointed) {
          var sp = Math.max(0, a - 0.866);
          s.lineTo(.5, sp); s.absarc(-.5, sp, 1, 0, PI / 3, false); s.absarc(.5, sp, 1, 2 * PI / 3, PI, false);
        } else {
          var sr = Math.max(0, a - 0.5);
          s.lineTo(.5, sr); s.absarc(0, sr, .5, 0, PI, false);
        }
        s.lineTo(-.5, 0);
        return fromGeo(new THREE.ShapeGeometry(s, 3));
      });
    },
    heart: function () {
      return prim('heart', function () {
        var s = new THREE.Shape();
        s.moveTo(0, -.5);
        s.bezierCurveTo(-.15, -.3, -.55, -.1, -.5, .2);
        s.bezierCurveTo(-.45, .5, -.05, .5, 0, .25);
        s.bezierCurveTo(.05, .5, .45, .5, .5, .2);
        s.bezierCurveTo(.55, -.1, .15, -.3, 0, -.5);
        return fromGeo(new THREE.ShapeGeometry(s, 3));
      });
    },
    star: function () {
      return prim('star', function () {
        var s = new THREE.Shape();
        for (var i = 0; i < 10; i++) {
          var r = i % 2 ? .21 : .5, a = i / 10 * TAU;
          if (i === 0) s.moveTo(Math.sin(a) * r, Math.cos(a) * r); else s.lineTo(Math.sin(a) * r, Math.cos(a) * r);
        }
        return fromGeo(new THREE.ShapeGeometry(s));
      });
    }
  };

  var _tm = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ');
  var _p = new THREE.Vector3(), _s = new THREE.Vector3(), _v = new THREE.Vector3();
  function M(x, y, z, rx, ry, rz, sx, sy, sz) {
    _e.set(rx || 0, ry || 0, rz || 0, 'YXZ');
    _q.setFromEuler(_e);
    _p.set(x, y, z);
    _s.set(sx == null ? 1 : sx, sy == null ? 1 : sy, sz == null ? 1 : sz);
    return new THREE.Matrix4().compose(_p, _q, _s);
  }

  /* ---------------------------------------------------------------- Builder */
  // Accumulates triangles (world space) per material layer, plus points (bulbs, halos),
  // ground light pools and wires. `build()` turns everything into a few meshes.

  function Builder(rng) {
    this.L = {};
    this.m = new THREE.Matrix4();
    this.stack = [];
    this.bulbs = []; this.bulbC = [];
    this.halos = []; this.haloC = [];
    this.pools = [];
    this.wires = [];
    this.extra = [];
    this.rng = rng;
  }
  var BP = Builder.prototype;

  BP.push = function (x, y, z, ry, s) {
    this.stack.push(this.m.clone());
    this.m.multiply(M(x, y, z, 0, ry || 0, 0, s || 1, s || 1, s || 1));
    return this;
  };
  BP.pop = function () { this.m = this.stack.pop(); return this; };
  BP.at = function (x, y, z, ry, fn, s) { this.push(x, y, z, ry, s); fn(); this.pop(); };
  BP.wp = function (x, y, z) { return new THREE.Vector3(x, y, z).applyMatrix4(this.m); };

  BP.raw = function (arr, col, local, layer, noAO) {
    layer = layer || 'solid';
    var L = this.L[layer] || (this.L[layer] = { p: [], c: [] });
    var e = _tm.multiplyMatrices(this.m, local).elements;
    var colFn = typeof col === 'function' ? col : null;
    var rgb = colFn ? null : lin(col);
    var ao = !noAO && layer === 'solid';
    var v = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (var i = 0, tri = 0; i < arr.length; i += 9, tri++) {
      for (var k = 0; k < 3; k++) {
        var x = arr[i + k * 3], y = arr[i + k * 3 + 1], z = arr[i + k * 3 + 2];
        v[k * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
        v[k * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        v[k * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      }
      var ax = v[3] - v[0], ay = v[4] - v[1], az = v[5] - v[2], bx = v[6] - v[0], by = v[7] - v[1], bz = v[8] - v[2];
      var cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
      if (cx * cx + cy * cy + cz * cz < 1e-12) continue;
      var c3 = colFn ? lin(colFn(tri)) : rgb;
      for (k = 0; k < 3; k++) {
        L.p.push(v[k * 3], v[k * 3 + 1], v[k * 3 + 2]);
        var f = 1;
        if (ao) { var Y = v[k * 3 + 1]; f = Y <= 0.02 ? 0.74 : Y < 0.9 ? 0.74 + 0.26 * (Y / 0.9) : 1; }
        L.c.push(c3[0] * f, c3[1] * f, c3[2] * f);
      }
    }
  };

  function oo(o) { return o || {}; }
  // box: anchor at bottom centre
  BP.box = function (x, y, z, w, h, d, col, o) { o = oo(o); this.raw(PR.box(), col, M(x, y, z, o.rx, o.ry, o.rz, w, h, d), o.layer, o.noAO); };
  BP.boxc = function (x, y, z, w, h, d, col, o) { o = oo(o); this.raw(PR.boxc(), col, M(x, y, z, o.rx, o.ry, o.rz, w, h, d), o.layer, o.noAO); };
  BP.cyl = function (x, y, z, r, h, col, o) {
    o = oo(o);
    this.raw(PR.cyl(o.seg || 8, o.top == null ? 1 : o.top), col, M(x, y, z, o.rx, o.ry, o.rz, r, h, r * (o.sz || 1)), o.layer, o.noAO);
  };
  BP.cone = function (x, y, z, r, h, col, o) {
    o = oo(o);
    this.raw(PR.cone(o.seg || 6, o.base), col, M(x, y, z, o.rx, o.ry, o.rz, r, h, r * (o.sz || 1)), o.layer, o.noAO);
  };
  BP.sph = function (x, y, z, r, col, o) {
    o = oo(o);
    this.raw(PR.sph(o.w || 8, o.h || 6), col, M(x, y, z, o.rx, o.ry, o.rz, r * (o.sx || 1), r * (o.sy || 1), r * (o.sz || 1)), o.layer, o.noAO);
  };
  BP.ico = function (x, y, z, r, col, o) {
    o = oo(o);
    this.raw(PR.ico(), col, M(x, y, z, o.rx, o.ry, o.rz, r * (o.sx || 1), r * (o.sy || 1), r * (o.sz || 1)), o.layer, o.noAO);
  };
  BP.dome = function (x, y, z, r, h, col, o) {
    o = oo(o);
    this.raw(PR.dome(o.seg || 10, o.rings || 4), col, M(x, y, z, o.rx, o.ry, o.rz, r, h, r * (o.sz || 1)), o.layer, o.noAO);
  };
  BP.halfcyl = function (x, y, z, rx, h, len, col, o) {
    o = oo(o);
    this.raw(PR.halfcyl(o.seg || 8), col, M(x, y, z, 0, o.ry, 0, rx, h, len), o.layer, o.noAO);
  };
  // gable roof, ridge along local x (w = ridge length, d = span, h = height)
  BP.gable = function (x, y, z, w, h, d, col, o) {
    o = oo(o);
    this.raw(PR.gable(), col, M(x, y, z, 0, o.ry, 0, w, h, d), o.layer);
    if (o.snow) {
      var k = o.k || 0.66;
      this.raw(PR.gable(), P.snow, M(x, y + h * (1 - k) + 0.03, z, 0, o.ry, 0, w * 1.01 + 0.02, h * k, d * k));
    }
  };
  // hip roof, ridge along local x, ridge fraction kr
  BP.hip = function (x, y, z, w, h, d, col, o) {
    o = oo(o);
    var kr = o.kr == null ? 0.4 : o.kr;
    this.raw(PR.hip(kr), col, M(x, y, z, 0, o.ry, 0, w, h, d), o.layer);
    if (o.snow) {
      var k = o.k || 0.62;
      var ws = w - (1 - k) * w * (1 - kr);
      this.raw(PR.hip(kr * w / ws), P.snow, M(x, y + h * (1 - k) + 0.03, z, 0, o.ry, 0, ws, h * k, d * k));
    }
  };
  BP.quad = function (x, y, z, w, h, col, o) { o = oo(o); this.raw(PR.quad(), col, M(x, y, z, o.rx, o.ry, o.rz, w, h, 1), o.layer || 'win'); };
  BP.arch = function (x, y, z, w, h, col, o) {
    o = oo(o);
    var a = h / w;
    var arr = PR.arch(o.pointed, a);
    var ra = Math.max(0.6, Math.round(a * 10) / 10);
    this.raw(arr, col, M(x, y, z, o.rx, o.ry, 0, w, w * (h / w) / ra, 1), o.layer || 'win');
  };
  BP.disc = function (x, y, z, r, col, o) { o = oo(o); this.raw(PR.disc(o.seg || 16), col, M(x, y, z, o.rx, o.ry, o.rz, r, 1, r * (o.sz || 1)), o.layer, o.noAO); };
  BP.torus = function (x, y, z, r, tube, col, o) {
    o = oo(o);
    this.raw(PR.torus(o.seg || 24, tube / r, o.arc || TAU), col, M(x, y, z, o.rx, o.ry, o.rz, r * (o.sx || 1), r * (o.sy || 1), r * (o.sz || 1)), o.layer, o.noAO);
  };
  BP.shape = function (kind, x, y, z, s, col, o) { o = oo(o); this.raw(PR[kind](), col, M(x, y, z, o.rx, o.ry, o.rz, s, s, s), o.layer || 'glow'); };
  // beam between two local points
  BP.beam = function (a, b, t, col, o) {
    o = oo(o);
    var dir = _v.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    var len = dir.length();
    if (len < 1e-6) return;
    dir.divideScalar(len);
    var q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    var m = new THREE.Matrix4().compose(new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), q, new THREE.Vector3(t, len, t * (o.tz || 1)));
    this.raw(PR.boxc(), col, m, o.layer, o.noAO);
  };
  BP.geoArr = function (arr, col, local, layer) { this.raw(arr, col, local || new THREE.Matrix4(), layer); };

  BP.bulb = function (x, y, z, col) {
    var p = this.wp(x, y, z);
    this.bulbs.push(p.x, p.y, p.z);
    var c = lin(col || P.bulb); this.bulbC.push(c[0], c[1], c[2]);
  };
  BP.halo = function (x, y, z, col, strength) {
    var p = this.wp(x, y, z);
    this.halos.push(p.x, p.y, p.z);
    var c = lin(col || P.warm), s = strength == null ? 1 : strength;
    this.haloC.push(c[0] * s, c[1] * s, c[2] * s);
  };
  BP.pool = function (x, z, r, col, strength) {
    var p = this.wp(x, 0, z);
    var c = lin(col || P.warm), s = strength == null ? 1 : strength;
    this.pools.push(p.x, p.z, r, c[0] * s, c[1] * s, c[2] * s);
  };
  BP.wire = function (a, b) { this.wires.push(a.x, a.y, a.z, b.x, b.y, b.z); };
  // string of fairy lights between two local points with sag
  BP.string = function (a, b, o) {
    o = oo(o);
    var sag = o.sag == null ? 0.18 : o.sag;
    var dist = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    var n = o.n || Math.max(3, Math.round(dist / 0.28));
    var prev = null;
    for (var i = 0; i <= n; i++) {
      var t = i / n;
      var x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), z = a[2] + (b[2] - a[2]) * t;
      var wpt = this.wp(x, y, z);
      if (prev && !o.noWire) this.wire(prev, wpt);
      prev = wpt;
      if (i > 0 && i < n || o.ends) {
        var col = o.cols ? o.cols[i % o.cols.length] : BULBS[i % BULBS.length];
        this.bulbs.push(wpt.x, wpt.y - 0.02, wpt.z);
        var c = lin(col); this.bulbC.push(c[0], c[1], c[2]);
      }
    }
  };
  BP.addMesh = function (mesh) { mesh.applyMatrix4(this.m); this.extra.push(mesh); };

  function faceNormals(pos) {
    var n = new Float32Array(pos.length);
    for (var i = 0; i < pos.length; i += 9) {
      var ax = pos[i + 3] - pos[i], ay = pos[i + 4] - pos[i + 1], az = pos[i + 5] - pos[i + 2];
      var bx = pos[i + 6] - pos[i], by = pos[i + 7] - pos[i + 1], bz = pos[i + 8] - pos[i + 2];
      var x = ay * bz - az * by, y = az * bx - ax * bz, z = ax * by - ay * bx;
      var l = Math.sqrt(x * x + y * y + z * z) || 1;
      x /= l; y /= l; z /= l;
      for (var k = 0; k < 3; k++) { n[i + k * 3] = x; n[i + k * 3 + 1] = y; n[i + k * 3 + 2] = z; }
    }
    return n;
  }
  function bufGeo(pos, col) {
    var g = new THREE.BufferGeometry();
    var p = new Float32Array(pos);
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(faceNormals(p), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
    g.computeBoundingSphere();
    return g;
  }
  BP.layerGeos = function () {
    var out = {};
    for (var name in this.L) if (this.L[name].p.length) out[name] = bufGeo(this.L[name].p, this.L[name].c);
    return out;
  };
  BP.build = function (mats, parent) {
    var geos = this.layerGeos();
    for (var name in geos) {
      var mesh = new THREE.Mesh(geos[name], mats[name] || mats.solid);
      if (name === 'glass') mesh.renderOrder = 3;
      parent.add(mesh);
    }
    function pts(arr, col, mat, order) {
      if (!arr.length) return;
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
      var p = new THREE.Points(g, mat);
      p.renderOrder = order;
      parent.add(p);
    }
    pts(this.halos, this.haloC, mats.halo, 5);
    pts(this.bulbs, this.bulbC, mats.bulb, 6);
    if (this.pools.length) {
      var pos = [], uv = [], col = [];
      for (var i = 0; i < this.pools.length; i += 6) {
        var x = this.pools[i], z = this.pools[i + 1], r = this.pools[i + 2], y = 0.06;
        var q = [[x - r, z + r, 0, 0], [x + r, z + r, 1, 0], [x + r, z - r, 1, 1], [x - r, z + r, 0, 0], [x + r, z - r, 1, 1], [x - r, z - r, 0, 1]];
        for (var k = 0; k < 6; k++) {
          pos.push(q[k][0], y, q[k][1]); uv.push(q[k][2], q[k][3]);
          col.push(this.pools[i + 3], this.pools[i + 4], this.pools[i + 5]);
        }
      }
      var pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      pg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      pg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      var pm = new THREE.Mesh(pg, mats.pool);
      pm.renderOrder = 2;
      parent.add(pm);
    }
    if (this.wires.length) {
      var wg = new THREE.BufferGeometry();
      wg.setAttribute('position', new THREE.Float32BufferAttribute(this.wires, 3));
      parent.add(new THREE.LineSegments(wg, mats.wire));
    }
    for (var j = 0; j < this.extra.length; j++) parent.add(this.extra[j]);
  };

  /* --------------------------------------------------------------- textures */

  function canvasTex(size, draw, h) {
    var cv = document.createElement('canvas');
    cv.width = size; cv.height = h || size;
    draw(cv.getContext('2d'), size, h || size);
    var t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  function radial(stops) {
    return function (g, s) {
      var gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      for (var i = 0; i < stops.length; i++) gr.addColorStop(stops[i][0], stops[i][1]);
      g.fillStyle = gr; g.fillRect(0, 0, s, s);
    };
  }
  function makeTextures() {
    return {
      dot: canvasTex(32, radial([[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.95)'], [0.5, 'rgba(255,255,255,0.25)'], [1, 'rgba(255,255,255,0)']])),
      halo: canvasTex(64, radial([[0, 'rgba(255,255,255,0.9)'], [0.2, 'rgba(255,255,255,0.4)'], [0.55, 'rgba(255,255,255,0.08)'], [1, 'rgba(255,255,255,0)']])),
      pool: canvasTex(64, radial([[0, 'rgba(255,255,255,0.75)'], [0.4, 'rgba(255,255,255,0.3)'], [1, 'rgba(255,255,255,0)']])),
      flake: canvasTex(32, radial([[0, 'rgba(255,255,255,1)'], [0.45, 'rgba(255,255,255,0.8)'], [1, 'rgba(255,255,255,0)']])),
      under: canvasTex(128, radial([[0, 'rgba(255,255,255,0.9)'], [0.45, 'rgba(255,255,255,0.45)'], [1, 'rgba(255,255,255,0)']]))
    };
  }
  // Stephansdom's glazed-tile roof: bands of yellow/green/black/white chevrons
  function chevronTex() {
    var t = canvasTex(128, function (g, w, h) {
      var cols = ['#d6a632', '#2f5f47', '#24282b', '#e6dfcc', '#d6a632', '#2f5f47', '#24282b', '#c99a2c'];
      var band = h / cols.length, amp = band * 1.25, step = w / 3;
      g.fillStyle = '#2b2f31'; g.fillRect(0, 0, w, h);
      for (var i = -1; i <= cols.length; i++) {
        g.fillStyle = cols[(i + cols.length) % cols.length];
        var y0 = i * band;
        g.beginPath();
        g.moveTo(-step, y0 + amp);
        for (var x = -step, k = 0; x <= w + step; x += step / 2, k++) g.lineTo(x, y0 + (k % 2 ? 0 : amp));
        for (x = w + step, k = 0; x >= -step; x -= step / 2, k++) g.lineTo(x, y0 + band + (k % 2 ? 0 : amp));
        g.closePath(); g.fill();
      }
    }, 128);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  }

  /* --------------------------------------------------------- shared helpers */

  function winCol(rng) { var r = rng.next(); return r < 0.13 ? 0x4b536a : r < 0.6 ? P.glowWin : 0xffc26e; }

  // rows of windows on the +z face of the current frame
  function windows(c, x0, x1, n, ys, z, w, h, o) {
    o = oo(o);
    for (var j = 0; j < ys.length; j++) for (var i = 0; i < n; i++) {
      var x = n === 1 ? (x0 + x1) / 2 : x0 + (x1 - x0) * i / (n - 1);
      if (o.skip && o.skip(x)) continue;
      var col = o.col || winCol(c.rng);
      if (o.shape) c.b.arch(x, ys[j], z, w, h, col, { pointed: o.shape === 'p', layer: o.layer || 'win' });
      else c.b.quad(x, ys[j], z, w, h, col, { layer: o.layer || 'win' });
    }
  }
  function statue(b, x, y, z, s, col) {
    b.cone(x, y, z, 0.11 * s, 0.32 * s, col, { seg: 5 });
    b.ico(x, y + 0.34 * s, z, 0.065 * s, col);
  }

  function conifer(c, x, z, s, o) {
    o = oo(o);
    var b = c.b, y = o.y || 0, col = o.col || P.conifer;
    b.cyl(x, y, z, 0.09 * s, 0.35 * s, P.trunk, { seg: 5 });
    var tiers = [[0.62, 0.9, 0.22], [0.48, 0.78, 0.62], [0.32, 0.64, 1.02]];
    for (var i = 0; i < 3; i++) {
      var r = tiers[i][0] * s, h = tiers[i][1] * s, ty = y + tiers[i][2] * s;
      b.cone(x, ty, z, r, h, col, { seg: 6, ry: i * 0.5 });
      var k = 0.42;
      b.cone(x, ty + h * (1 - k) + 0.02, z, r * k * 1.05, h * k, P.snow, { seg: 6, ry: i * 0.5 });
    }
    if (o.lights) {
      for (var j = 0; j < 14; j++) {
        var t = j / 14, a = j * 2.4;
        var rr = (0.6 - 0.45 * t) * s;
        b.bulb(x + Math.sin(a) * rr, y + (0.35 + t * 1.2) * s, z + Math.cos(a) * rr, PARTY[j % PARTY.length]);
      }
    }
  }

  function bareTree(c, x, z, s, o) {
    o = oo(o);
    var b = c.b, rng = c.rng, y = o.y || 0;
    var h = 1.5 * s;
    b.cyl(x, y, z, 0.13 * s, h, P.bark, { seg: 5, top: 0.45 });
    var nb = 5, a0 = rng.next() * TAU;
    for (var i = 0; i < nb; i++) {
      var a = a0 + i / nb * TAU + rng.range(-0.3, 0.3);
      var by = y + h * rng.range(0.5, 0.92), len = rng.range(0.7, 1.05) * s, up = rng.range(0.55, 0.95);
      var dx = Math.sin(a) * Math.cos(up), dz = Math.cos(a) * Math.cos(up), dy = Math.sin(up);
      var p0 = [x, by, z], p1 = [x + dx * len, by + dy * len, z + dz * len];
      b.beam(p0, p1, 0.06 * s, P.bark);
      var tw = [p1[0] + Math.sin(a + 0.7) * 0.35 * s, p1[1] + 0.3 * s, p1[2] + Math.cos(a + 0.7) * 0.35 * s];
      b.beam(p1, tw, 0.035 * s, P.bark);
      if (o.lights) {
        for (var k = 1; k <= 4; k++) { var t = k / 4; b.bulb(p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t + 0.04, p0[2] + (p1[2] - p0[2]) * t, o.lightCol || P.bulb); }
        b.bulb(tw[0], tw[1], tw[2], o.lightCol || P.bulb);
        if (o.hearts && i % 2 === 0) {
          var hx = p1[0] - dx * 0.2, hz = p1[2] - dz * 0.2, hy = p1[1] - 0.1;
          b.beam([hx, hy, hz], [hx, hy - 0.25, hz], 0.01, 0x8a1f2c, { layer: 'glow' });
          b.shape('heart', hx, hy - 0.42, hz, 0.24, i % 4 ? 0xff4f6a : 0xff8fa0, { ry: a });
          b.halo(hx, hy - 0.38, hz, 0xff5f78, 0.5);
        }
      }
    }
    if (o.lights) b.halo(x, y + h * 0.95, z, o.lightCol || P.warm, 0.6);
  }

  function person(c, x, z, o) {
    o = oo(o);
    var b = c.b, rng = c.rng, y = o.y == null ? c.groundY(x, z) : o.y;
    var col = o.col || rng.pick(COATS), s = o.s || rng.range(0.9, 1.08), ry = o.ry == null ? rng.range(0, TAU) : o.ry;
    b.cone(x, y, z, 0.12 * s, 0.42 * s, col, { seg: 6, ry: ry });
    b.cyl(x, y + 0.31 * s, z, 0.06 * s, 0.08 * s, col, { seg: 5 });
    b.ico(x, y + 0.44 * s, z, 0.072 * s, P.skin);
    var hat = rng.next();
    if (hat < 0.45) b.cone(x, y + 0.47 * s, z, 0.07 * s, 0.13 * s, rng.pick([P.red, P.white, P.green, 0x2f5f8a]), { seg: 5 });
    else if (hat < 0.75) b.dome(x, y + 0.46 * s, z, 0.075 * s, 0.06 * s, rng.pick([0x384556, P.red, 0x6b4a33]), { seg: 6, rings: 2 });
  }

  function lamp(c, x, z, o) {
    o = oo(o);
    var b = c.b, y = c.groundY(x, z);
    b.cyl(x, y, z, 0.05, 0.12, P.iron, { seg: 5 });
    b.cyl(x, y, z, 0.03, 1.85, P.iron, { seg: 5 });
    b.box(x, y + 1.82, z, 0.16, 0.2, 0.16, P.warm, { layer: 'glow' });
    b.cone(x, y + 2.02, z, 0.14, 0.14, P.iron, { seg: 4, ry: PI / 4 });
    b.halo(x, y + 1.92, z, P.warm, 0.9);
    b.pool(x, z, 1.15, P.warm, 0.5);
    return [x, y + 1.95, z];
  }

  var STALL_STYLES = {
    red: { body: P.wood, roof: P.red, trim: P.woodLight, awn: [P.red, P.white] },
    green: { body: P.woodDark, roof: P.green, trim: P.woodLight, awn: [P.green, P.white] },
    wood: { body: P.wood, roof: P.woodDark, trim: P.woodLight, awn: [P.red, P.white] },
    light: { body: P.woodLight, roof: P.red, trim: P.wood, awn: null },
    white: { body: 0xf3efe7, roof: 0xe7e2d8, trim: P.gold, awn: null, white: true }
  };
  var STALL_SCALE = 1.15;
  var GOODS = [0xd9aa48, 0xb4343b, 0x3d7a52, 0xf4efe6, 0x7fb3d9, 0xc4643c];

  function stall(c, x, z, ry, st) {
    var b = c.b, rng = c.rng, W = 1.3, H = 0.92, D = 0.9;
    b.push(x, 0, z, ry, STALL_SCALE);
    b.box(0, 0, 0, W, H, D, st.body);
    if (!st.white) { b.box(-W / 2 + 0.03, 0, D / 2 - 0.03, 0.08, H, 0.08, st.trim); b.box(W / 2 - 0.03, 0, D / 2 - 0.03, 0.08, H, 0.08, st.trim); }
    b.quad(0, 0.34, D / 2 + 0.012, W * 0.84, 0.48, P.warm, { layer: 'glow' });
    b.box(0, 0.28, D / 2 + 0.06, W * 0.94, 0.07, 0.26, st.trim);
    for (var i = 0; i < 3; i++) b.box(-0.36 + i * 0.36 + rng.range(-0.05, 0.05), 0.35, D / 2 + 0.07, 0.2, rng.range(0.08, 0.16), 0.12, rng.pick(GOODS));
    if (st.awn) {
      for (i = 0; i < 5; i++) b.box(-W / 2 + W / 10 * (2 * i + 1), 0.8, D / 2 + 0.15, W / 5 + 0.002, 0.035, 0.34, st.awn[i % 2], { rx: 0.42 });
    } else {
      b.box(0, 0.86, D / 2 + 0.03, W * 1.02, 0.08, 0.06, st.trim);
    }
    b.gable(0, H, 0, W + 0.2, 0.44, D + 0.34, st.roof, { snow: true });
    // back: small lit window + crates so rear views are not blank
    b.quad(0.25, 0.48, -D / 2 - 0.012, 0.3, 0.22, 0xffc978, { layer: 'glow', ry: PI });
    b.box(-0.4, 0, -D / 2 - 0.14, 0.26, 0.2, 0.22, P.woodLight, { ry: 0.2 });
    if (st.white) b.box(0, H + 0.38, 0, 0.06, 0.16, 0.06, P.gold);
    b.pool(0, 0.95, 1.2, P.warm, 0.85);
    b.pop();
  }

  // pastel town house; front faces local +z
  function house(c, x, z, w, d, floors, col, o) {
    o = oo(o);
    var b = c.b, rng = c.rng, fh = 0.82, h = floors * fh + 0.3;
    b.push(x, 0, z, o.ry || 0);
    b.box(0, 0, 0, w, h, d, col);
    b.box(0, 0, 0, w + 0.02, 0.28, d + 0.02, shade(col, 0.82));
    var n = Math.max(1, Math.round((w - 0.3) / 0.62));
    var ys = []; for (var f = 0; f < floors; f++) ys.push(0.42 + f * fh);
    windows(c, -w / 2 + 0.42, w / 2 - 0.42, n, ys, d / 2 + 0.012, 0.26, 0.42, { shape: o.archWin ? 'r' : null });
    if (o.both) b.at(0, 0, 0, PI, function () { windows(c, -w / 2 + 0.42, w / 2 - 0.42, n, ys, d / 2 + 0.012, 0.26, 0.42); });
    if (o.door !== false) b.arch(rng.range(-w / 4, w / 4), 0, d / 2 + 0.014, 0.34, 0.5, 0x6b4a33, { layer: 'solid' });
    var roof = o.roof || rng.pick(ROOFS), rh = Math.min(1.2, d * 0.5);
    if (o.ridgeZ) b.gable(0, h, 0, d + 0.16, rh, w + 0.12, roof, { ry: HALF, snow: true });
    else b.gable(0, h, 0, w + 0.12, rh, d + 0.2, roof, { snow: true });
    if (o.chimney !== false && rng.chance(0.6)) b.box(rng.range(-w / 3, w / 3), h + rh * 0.3, -d / 5, 0.16, rh * 0.75, 0.16, shade(col, 0.75));
    b.pop();
    return h;
  }

  // generic palace / wing block with hip roof and windows on the +z face
  function block(c, x, z, w, h, d, col, o) {
    o = oo(o);
    var b = c.b;
    b.push(x, 0, z, o.ry || 0);
    b.box(0, 0, 0, w, h, d, col);
    b.box(0, 0, 0, w + 0.03, 0.3, d + 0.03, shade(col, 0.85));
    b.box(0, h - 0.12, 0, w + 0.08, 0.12, d + 0.08, shade(col, 1.06));
    if (o.roof !== false) b.hip(0, h, 0, w + 0.12, o.rh || 0.8, d + 0.12, o.roof || P.slate, { kr: o.kr == null ? Math.max(0, 1 - d / w) : o.kr, snow: true });
    var floors = o.floors || Math.max(1, Math.floor((h - 0.3) / 0.85));
    var ys = []; for (var f = 0; f < floors; f++) ys.push(0.45 + f * ((h - 0.5) / floors));
    var n = Math.max(1, Math.round((w - 0.4) / (o.spacing || 0.7)));
    windows(c, -w / 2 + 0.4, w / 2 - 0.4, n, ys, d / 2 + 0.012, 0.26, 0.42, { shape: o.shape, skip: o.skip });
    if (o.back) b.at(0, 0, 0, PI, function () { windows(c, -w / 2 + 0.4, w / 2 - 0.4, n, ys, d / 2 + 0.012, 0.26, 0.42, { shape: o.shape }); });
    b.pop();
  }

  /* ============================================================ LANDMARKS */
  // Each builder draws at the back of the board (z < -3) facing +z and registers its
  // footprint with c.block / c.blockC so stalls and features avoid it.

  var LANDMARKS = {};

  LANDMARKS.generic = function (c) {
    var b = c.b, rng = c.rng;
    // church
    b.box(0, 0, -8.3, 2.8, 3.2, 3.0, 0xf1e9da);
    b.gable(0, 3.2, -8.3, 3.1, 1.3, 3.0, P.tile, { ry: HALF, snow: true });
    b.box(0, 0, -6.6, 1.1, 5.0, 1.1, 0xf1e9da);
    b.box(0, 4.6, -6.6, 1.2, 0.12, 1.2, 0xe3d8c4);
    b.disc(0, 4.1, -6.04, 0.3, 0xfff1cf, { rx: HALF, layer: 'glow' });
    b.cone(0, 4.72, -6.6, 0.62, 1.9, P.copper, { seg: 8 });
    b.sph(0, 6.66, -6.6, 0.07, P.gold);
    b.arch(0, 0, -6.04, 0.5, 0.9, 0x6b4a33, { layer: 'solid' });
    b.arch(0, 2.4, -6.04, 0.3, 0.6, P.glowWin);
    c.block(-1.6, 1.6, -9.9, -6.0);
    // back row
    var x = -9.3;
    while (x < 9.3) {
      var w = rng.range(1.6, 2.3);
      if (x + w > 9.3) break;
      if (!(x + w > -1.7 && x < 1.7)) house(c, x + w / 2, -8.5, w, 1.9, rng.int(2, 4), rng.pick(PASTEL));
      x += w + 0.02;
    }
    c.block(-9.6, 9.6, -9.7, -7.5);
    [-1, 1].forEach(function (s) {
      var z = -7.0;
      while (z < 1.5) {
        var d = rng.range(1.5, 2.2);
        house(c, s * 8.6, z + d / 2, d, 1.7, rng.int(2, 3), rng.pick(PASTEL), { ry: -s * HALF });
        z += d + 0.02;
      }
      c.block(s > 0 ? 7.7 : -9.6, s > 0 ? 9.6 : -7.7, -7.2, z);
    });
  };

  LANDMARKS.rathaus = function (c) {
    var b = c.b, S = 0xd9cdb4, S2 = 0xcabda2, R = 0x535a6a, z0 = -7.4, zf = z0 + 1.6 + 0.012;
    b.box(0, 0, z0, 15.4, 3.3, 3.2, S);
    b.box(0, 0, z0, 15.45, 0.35, 3.25, shade(S, 0.85));
    b.gable(0, 3.3, z0, 15.6, 1.6, 3.4, R, { snow: true });
    // pointed ground-floor arcade + upper windows
    for (var x = -7.05; x <= 7.06; x += 0.94) {
      if (Math.abs(x) < 2.3 || Math.abs(Math.abs(x) - 3.25) < 0.6 || Math.abs(x) > 5.9) continue;
      b.arch(x, 0.12, zf, 0.56, 1.05, 0xffb760, { pointed: true });
      b.arch(x, 1.5, zf, 0.3, 0.68, winCol(c.rng), { pointed: true });
      b.arch(x, 2.45, zf, 0.3, 0.6, winCol(c.rng), { pointed: true });
    }
    for (x = -7.0; x <= 7.0; x += 1.75) b.cone(x, 3.3, z0 + 1.62, 0.1, 0.55, S2, { seg: 4 });
    [-1, 1].forEach(function (s) {
      // corner risalits
      var cx = s * 6.95, cz = z0 + 0.3;
      b.box(cx, 0, cz, 1.9, 4.1, 3.8, S2);
      b.hip(cx, 4.1, cz, 2.05, 1.7, 3.95, R, { kr: 0.3, snow: true });
      windows(c, cx - 0.45, cx + 0.45, 2, [0.4, 1.45, 2.5], cz + 1.9 + 0.012, 0.28, 0.62, { shape: 'p' });
      b.cone(cx - 0.9, 4.1, cz + 1.85, 0.09, 0.6, S2, { seg: 4 }); b.cone(cx + 0.9, 4.1, cz + 1.85, 0.09, 0.6, S2, { seg: 4 });
      // the four flanking spires
      var tx = s * 3.25, tz = z0 + 1.35;
      b.box(tx, 0, tz, 1.1, 5.7, 1.1, S2);
      b.box(tx, 5.7, tz, 0.86, 0.55, 0.86, S);
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (q) { b.cone(tx + q[0] * 0.5, 5.7, tz + q[1] * 0.5, 0.09, 0.75, S2, { seg: 4 }); });
      b.cone(tx, 6.25, tz, 0.5, 2.0, R, { seg: 8 });
      b.sph(tx, 8.3, tz, 0.07, P.gold);
      b.arch(tx, 2.2, tz + 0.562, 0.3, 0.9, winCol(c.rng), { pointed: true });
      b.arch(tx, 4.2, tz + 0.562, 0.26, 0.8, winCol(c.rng), { pointed: true });
      b.arch(tx, 0.12, tz + 0.562, 0.56, 1.1, 0xffb760, { pointed: true });
      var ox = s * 5.3;
      b.cone(ox, 3.3, z0 + 1.62, 0.1, 0.55, S2, { seg: 4 });
    });
    // central risalit with front gable
    b.box(0, 0, z0 + 0.45, 4.3, 4.5, 4.1, S2);
    b.gable(0, 4.5, z0 + 0.45, 4.3, 1.9, 4.5, R, { ry: HALF, snow: true });
    for (x = -1.6; x <= 1.61; x += 1.6) if (Math.abs(x) > 0.1) b.arch(x, 0.12, z0 + 2.5 + 0.012, 0.75, 1.5, 0xffb760, { pointed: true });
    windows(c, -1.6, 1.6, 3, [2.0, 3.1], z0 + 2.5 + 0.012, 0.36, 0.78, { shape: 'p', skip: function (q) { return Math.abs(q) < 0.1; } });
    // central tower (Rathausmann on top)
    var tz = z0 + 1.95;
    b.box(0, 0, tz, 1.8, 8.3, 1.8, S);
    b.box(0, 8.3, tz, 1.95, 0.18, 1.95, S2);
    b.box(0, 8.48, tz, 1.4, 1.1, 1.4, S2);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (q) { b.cone(q[0] * 0.82, 8.48, tz + q[1] * 0.82, 0.13, 1.1, S2, { seg: 4 }); });
    b.cyl(0, 9.58, tz, 0.62, 0.8, S, { seg: 8, top: 0.85 });
    b.cone(0, 10.38, tz, 0.52, 1.75, R, { seg: 8 });
    b.cyl(0, 12.1, tz, 0.035, 0.32, P.gold, { seg: 4 });
    b.ico(0, 12.48, tz, 0.07, P.gold);
    b.cone(0, 12.25, tz, 0.07, 0.18, P.gold, { seg: 5 });
    b.disc(0, 7.2, tz + 0.912, 0.48, 0xfff1d0, { rx: HALF, layer: 'glow', seg: 16 });
    b.halo(0, 7.2, tz + 1.0, 0xfff1d0, 0.5);
    b.arch(0, 0.12, tz + 0.912, 0.9, 1.9, 0xffb760, { pointed: true });
    b.arch(0, 2.6, tz + 0.912, 0.42, 1.1, winCol(c.rng), { pointed: true });
    b.arch(0, 4.2, tz + 0.912, 0.42, 1.1, winCol(c.rng), { pointed: true });
    b.arch(0, 5.7, tz + 0.912, 0.36, 0.9, winCol(c.rng), { pointed: true });
    b.arch(0, 8.65, tz + 0.712, 0.3, 0.7, 0xffcf8a, { pointed: true });
    c.block(-8.0, 8.0, -9.4, z0 + 1.65);
    c.edgeBare = true;
    c.block(-2.2, 2.2, -9.4, z0 + 2.95);
    c.block(-3.9, 3.9, -9.4, z0 + 1.95);
  };

  LANDMARKS.stephansdom = function (c) {
    var b = c.b, S = 0xb3a891, S2 = 0xa1957e, zc = -6.6, W = 3.2, wallH = 2.7;
    // nave + choir walls
    b.box(-1.0, 0, zc, 9.0, wallH, W, S);
    b.box(4.6, 0, zc, 2.4, wallH, W - 0.3, S);
    b.cyl(5.8, 0, zc, (W - 0.3) / 2, wallH, S, { seg: 8, ry: PI / 8 });
    // buttresses + tall windows on the south side
    for (var x = -4.6; x <= 5.4; x += 1.25) {
      b.box(x, 0, zc + W / 2 + 0.12, 0.28, wallH + 0.1, 0.32, S2);
      b.cone(x, wallH + 0.1, zc + W / 2 + 0.12, 0.12, 0.5, S2, { seg: 4 });
      if (x < 5) b.arch(x + 0.62, 0.55, zc + W / 2 + 0.012, 0.42, 1.7, winCol(c.rng), { pointed: true });
    }
    // the famous tiled roof (canvas texture)
    var tex = chevronTex();
    c.textures.push(tex);
    var L = 11.0, D = W + 0.3, Hh = 3.5;
    var rg = new THREE.BufferGeometry();
    var pos = [], uv = [];
    function tri(a, bb, cc, ua, ub, uc) { pos.push(a[0], a[1], a[2], bb[0], bb[1], bb[2], cc[0], cc[1], cc[2]); uv.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]); }
    var x0 = -5.5, x1 = x0 + L, su = L / 3.4, sv = Math.hypot(D / 2, Hh) / 2.6;
    // south slope (+z)
    tri([x0, 0, D / 2], [x1, 0, D / 2], [x1, Hh, 0], [0, 0], [su, 0], [su, sv]);
    tri([x0, 0, D / 2], [x1, Hh, 0], [x0, Hh, 0], [0, 0], [su, sv], [0, sv]);
    // north slope
    tri([x1, 0, -D / 2], [x0, 0, -D / 2], [x0, Hh, 0], [0, 0], [su, 0], [su, sv]);
    tri([x1, 0, -D / 2], [x0, Hh, 0], [x1, Hh, 0], [0, 0], [su, sv], [0, sv]);
    // west gable + east hip
    tri([x0, 0, -D / 2], [x0, 0, D / 2], [x0, Hh, 0], [0, 0], [1, 0], [0.5, 0.8]);
    tri([x1, 0, D / 2], [x1, 0, -D / 2], [x1, Hh, 0], [0, 0], [1, 0], [0.5, 0.8]);
    rg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    rg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    rg.computeVertexNormals();
    var rm = new THREE.Mesh(rg, new THREE.MeshLambertMaterial({ map: tex }));
    rm.position.set(0, wallH, zc);
    b.addMesh(rm);
    // east apse roof (half cone) in slate
    b.cone(x1, wallH, zc, D / 2, Hh * 0.75, 0x3c5446, { seg: 8, ry: PI / 8 });
    // west front: Riesentor + the two Heidentürme
    var wx = -5.6;
    b.box(wx - 0.2, 0, zc, 0.7, 3.4, W + 0.2, S2);
    b.arch(wx - 0.56, 0, zc, 1.0, 1.7, 0xffb760, { ry: -HALF, pointed: true });
    [-1, 1].forEach(function (s) {
      var tz = zc + s * 1.15;
      b.box(wx - 0.25, 0, tz, 1.0, 3.6, 1.0, S2);
      b.cyl(wx - 0.25, 3.6, tz, 0.5, 1.4, S, { seg: 8, top: 0.9 });
      b.cone(wx - 0.25, 5.0, tz, 0.48, 1.3, S2, { seg: 8 });
      b.sph(wx - 0.25, 6.35, tz, 0.06, P.gold);
    });
    // south tower (Steffl)
    var sx = 0.9, sz = zc + W / 2 + 0.95;
    b.box(sx, 0, sz, 2.0, 3.4, 2.0, S);
    b.box(sx, 3.4, sz, 1.7, 2.5, 1.7, S);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (q) {
      b.cone(sx + q[0] * 0.92, 3.4, sz + q[1] * 0.92, 0.13, 0.9, S2, { seg: 4 });
      b.cone(sx + q[0] * 0.78, 5.9, sz + q[1] * 0.78, 0.11, 0.8, S2, { seg: 4 });
    });
    b.cyl(sx, 5.9, sz, 0.82, 2.5, S, { seg: 8, top: 0.68 });
    for (var i = 0; i < 8; i++) {
      var a = i / 8 * TAU + PI / 8;
      b.gable(sx + Math.sin(a) * 0.72, 5.9, sz + Math.cos(a) * 0.72, 0.2, 0.7, 0.55, S2, { ry: a + HALF });
    }
    b.cone(sx, 8.4, sz, 0.56, 3.8, S2, { seg: 8 });
    b.sph(sx, 12.25, sz, 0.07, P.gold);
    b.arch(sx, 1.0, sz + 1.012, 0.5, 1.8, winCol(c.rng), { pointed: true });
    b.arch(sx, 3.8, sz + 0.862, 0.4, 1.6, winCol(c.rng), { pointed: true });
    b.arch(sx, 6.2, sz + 0.71, 0.26, 1.0, 0xffcf8a, { pointed: true });
    // north tower (unfinished, Renaissance cap)
    var nz = zc - W / 2 - 0.9;
    b.box(sx, 0, nz, 1.8, 5.5, 1.8, S);
    b.cyl(sx, 5.5, nz, 0.7, 0.4, S2, { seg: 8 });
    b.dome(sx, 5.9, nz, 0.72, 0.7, P.copper, { seg: 8, rings: 3 });
    b.cyl(sx, 6.55, nz, 0.18, 0.4, P.copper, { seg: 6 });
    b.cone(sx, 6.95, nz, 0.2, 0.4, P.copper, { seg: 6 });
    c.block(-6.4, 7.2, zc - W / 2 - 1.9, zc + W / 2 + 0.35);
    c.block(sx - 1.15, sx + 1.15, zc, sz + 1.15);
  };

  LANDMARKS['am-hof'] = function (c) {
    var b = c.b, rng = c.rng, Wc = 0xf2eee6, zf = -7.6;
    // church body + façade
    b.box(0, 0, -9.0, 5.4, 3.6, 2.0, 0xe9e3d6);
    b.gable(0, 3.6, -9.0, 2.2, 1.4, 5.6, P.tile, { ry: HALF, snow: true });
    b.box(0, 0, zf, 7.4, 4.0, 0.8, Wc);
    b.box(0, 0, zf, 7.45, 0.3, 0.85, shade(Wc, 0.88));
    b.box(0, 3.9, zf, 7.6, 0.22, 0.9, shade(Wc, 0.95));
    b.box(0, 4.12, zf, 3.2, 0.85, 0.7, Wc);
    b.gable(0, 4.97, zf, 0.7, 0.6, 3.4, Wc, { ry: HALF });
    for (var x = -3.5; x <= 3.51; x += 0.5) b.box(x, 4.12, zf + 0.38, 0.07, 0.24, 0.07, Wc);
    [-3.4, -2.3, 2.3, 3.4].forEach(function (sx) { statue(b, sx, 4.12, zf + 0.3, 1.4, 0xe2dccd); });
    statue(b, 0, 5.55, zf + 0.1, 1.5, 0xe2dccd);
    windows(c, -3.1, 3.1, 2, [0.5, 2.3], zf + 0.412, 0.42, 0.95, { shape: 'r' });
    windows(c, -1.3, 1.3, 3, [2.45], zf + 0.412, 0.4, 0.95, { shape: 'r' });
    b.disc(0, 4.5, zf + 0.362, 0.22, 0xfff1d0, { rx: HALF, layer: 'glow' });
    // the loggia terrace (papal blessing balcony)
    var tz = -6.6;
    b.box(0, 0, tz, 4.6, 1.9, 1.2, Wc);
    for (x = -1.4; x <= 1.41; x += 1.4) b.arch(x, 0.05, tz + 0.612, 0.9, 1.45, 0xffbd6a, { shape: 'r' });
    b.box(0, 1.9, tz, 4.7, 0.08, 1.25, shade(Wc, 0.92));
    for (x = -2.25; x <= 2.26; x += 0.25) b.box(x, 1.98, tz + 0.56, 0.05, 0.28, 0.05, Wc);
    b.box(0, 2.24, tz + 0.56, 4.6, 0.06, 0.09, Wc);
    // small tower behind
    b.box(2.4, 0, -9.5, 0.9, 5.4, 0.9, 0xe9e3d6);
    b.dome(2.4, 5.4, -9.5, 0.5, 0.55, P.copper, { seg: 8, rings: 3 });
    b.cone(2.4, 5.9, -9.5, 0.1, 0.5, P.copper, { seg: 5 });
    c.block(-3.9, 3.9, -9.9, zf + 0.45);
    c.block(-2.4, 2.4, -7.3, tz + 0.65);
    // town palaces on both sides of the church
    block(c, -6.6, -7.9, 4.6, 3.5, 3.2, 0xe8d6a6, { roof: P.tile, shape: 'r' });
    block(c, 6.6, -7.9, 4.6, 3.2, 3.2, 0xe4cbbd, { roof: P.slate });
    c.block(-9.0, -4.2, -9.6, -6.2); c.block(4.2, 9.0, -9.6, -6.2);
    // Bürgerliches Zeughaus (left) with its ornate attic, houses (right)
    block(c, -8.75, -2.0, 6.6, 3.4, 1.6, 0xd9c39d, { ry: HALF, roof: P.slate });
    b.box(-8.4, 3.4, -2.0, 0.5, 1.0, 2.0, 0xd9c39d);
    b.dome(-8.4, 4.4, -2.0, 0.35, 0.5, P.gold, { seg: 6, rings: 2 });
    c.block(-9.6, -7.8, -5.4, 1.4);
    var z = -5.5;
    while (z < 1.5) { var d = rng.range(1.6, 2.1); house(c, 8.6, z + d / 2, d, 1.6, rng.int(2, 3), rng.pick(PASTEL), { ry: -HALF }); z += d + 0.02; }
    c.block(7.7, 9.6, -5.6, z);
    // Mariensäule
    var mx = 0, mz = -0.55, Sc = 0xdcd3c1;
    b.box(mx, 0, mz, 1.6, 0.22, 1.6, Sc);
    b.box(mx, 0.22, mz, 0.85, 1.0, 0.85, Sc);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (q) {
      b.box(mx + q[0] * 0.62, 0.22, mz + q[1] * 0.62, 0.32, 0.4, 0.32, Sc);
      statue(b, mx + q[0] * 0.62, 0.62, mz + q[1] * 0.62, 1.1, P.bronze);
    });
    b.box(mx, 1.22, mz, 0.6, 0.15, 0.6, Sc);
    b.cyl(mx, 1.37, mz, 0.12, 2.6, Sc, { seg: 8 });
    b.box(mx, 3.97, mz, 0.34, 0.14, 0.34, Sc);
    statue(b, mx, 4.11, mz, 1.5, P.gold);
    for (var i = 0; i < 8; i++) { var a = i / 8 * TAU; b.bulb(mx + Math.sin(a) * 0.2, 4.75, mz + Math.cos(a) * 0.2, 0xfff1c0); }
    b.halo(mx, 4.4, mz, 0xffe7b0, 0.6);
    c.blockC(mx, mz, 0.95);
  };

  LANDMARKS.freyung = function (c) {
    var b = c.b, rng = c.rng, O = 0xdcb46a;
    // Schottenkirche, angled on the triangular square
    b.push(4.3, 0, -7.0, -0.32);
    b.box(0, 0, -0.8, 4.4, 3.8, 3.4, O);
    b.box(0, 0, -0.8, 4.45, 0.35, 3.45, shade(O, 0.85));
    b.gable(0, 3.8, -0.8, 3.6, 1.6, 4.6, P.slate, { ry: HALF, snow: true });
    b.gable(0, 3.8, 0.95, 0.12, 1.5, 4.5, shade(O, 1.05), { ry: HALF });
    b.arch(0, 0, 0.912, 0.8, 1.5, 0xffbd6a, { shape: 'r' });
    windows(c, -1.4, 1.4, 2, [0.8, 2.3], 0.912, 0.42, 0.95, { shape: 'r' });
    b.arch(0, 2.2, 0.912, 0.5, 1.0, winCol(rng));
    b.disc(0, 4.5, 0.97, 0.22, 0xfff1d0, { rx: HALF, layer: 'glow' });
    // tower with green baroque helmet
    var tx = -2.75;
    b.box(tx, 0, -0.5, 1.3, 5.6, 1.3, O);
    b.box(tx, 5.6, -0.5, 1.4, 0.15, 1.4, shade(O, 1.05));
    b.arch(tx, 4.2, 0.162, 0.4, 0.9, winCol(rng), { shape: 'r' });
    b.arch(tx, 2.0, 0.162, 0.32, 0.7, winCol(rng), { shape: 'r' });
    b.disc(tx, 5.2, 0.17, 0.25, 0xfff1d0, { rx: HALF, layer: 'glow' });
    b.dome(tx, 5.75, -0.5, 0.72, 0.7, P.copper, { seg: 8, rings: 3 });
    b.cyl(tx, 6.4, -0.5, 0.22, 0.35, P.copper, { seg: 6 });
    b.sph(tx, 6.95, -0.5, 0.25, P.copper, { sy: 1.3 });
    b.cone(tx, 7.2, -0.5, 0.06, 0.45, P.gold, { seg: 4 });
    b.pop();
    c.block(1.2, 7.6, -9.6, -5.6);
    // Schottenstift along the right edge
    block(c, 8.7, -2.0, 6.4, 3.2, 1.6, 0xefe2c4, { ry: -HALF, roof: P.slate });
    c.block(7.8, 9.6, -5.4, 1.4);
    // palaces along the converging left side of the triangle
    var line = [[-9.0, -8.4], [-6.4, 3.6]];
    var dx = line[1][0] - line[0][0], dz = line[1][1] - line[0][1], len = Math.hypot(dx, dz);
    var ux = dx / len, uz = dz / len, ry = Math.atan2(uz, -ux);
    var cols = [0xeee4cf, 0xe2c9a6, 0xd9c7b5, 0xeadab2];
    var pos = 0.3, k = 0;
    while (pos < len - 1) {
      var w = Math.min(len - pos - 0.2, rng.range(2.6, 3.4));
      var px = line[0][0] + ux * (pos + w / 2), pz = line[0][1] + uz * (pos + w / 2);
      block(c, px, pz, w, rng.range(3.0, 3.8), 2.0, cols[k++ % cols.length], { ry: ry, roof: rng.pick([P.slate, P.tile]), shape: k % 2 ? 'r' : null });
      c.blockC(px, pz, 1.5);
      pos += w + 0.05;
    }
    // back-left houses
    block(c, -3.0, -8.6, 4.2, 3.0, 1.8, 0xe6d5b8, { roof: P.tile });
    c.block(-5.2, -0.8, -9.6, -7.6);
    // Austria fountain
    var fx = -3.1, fz = -0.4;
    b.cyl(fx, 0, fz, 1.15, 0.4, 0xc9c0ae, { seg: 8, ry: PI / 8 });
    b.cyl(fx, 0, fz, 1.0, 0.42, P.water, { seg: 8, ry: PI / 8, layer: 'water' });
    b.cyl(fx, 0, fz, 0.34, 1.5, 0xc9c0ae, { seg: 8 });
    b.cyl(fx, 1.5, fz, 0.42, 0.12, 0xc9c0ae, { seg: 8 });
    for (var i = 0; i < 4; i++) {
      var a = i / 4 * TAU + PI / 4;
      b.cyl(fx + Math.sin(a) * 0.45, 0.4, fz + Math.cos(a) * 0.45, 0.13, 0.35, 0xc9c0ae, { seg: 6 });
      statue(b, fx + Math.sin(a) * 0.45, 0.75, fz + Math.cos(a) * 0.45, 1.1, P.bronze);
    }
    statue(b, fx, 1.62, fz, 1.7, P.bronze);
    b.pool(fx, fz, 1.6, 0x9fd0ff, 0.35);
    c.blockC(fx, fz, 1.3);
  };

  LANDMARKS.michaelertor = function (c) {
    var b = c.b, Wc = 0xf2eee5, cz = 3.4, R = 11.2;
    var n = 13, a0 = -0.78, a1 = 0.78;
    for (var i = 0; i < n; i++) {
      var a = a0 + (a1 - a0) * (i + 0.5) / n;
      var x = R * Math.sin(a), z = cz - R * Math.cos(a), w = R * (a1 - a0) / n + 0.08;
      if (Math.abs(a) < 0.12) continue;
      b.push(x, 0, z, -a);
      b.box(0, 0, 0, w, 3.4, 1.6, Wc);
      b.box(0, 0, 0, w + 0.02, 0.4, 1.65, shade(Wc, 0.88));
      b.box(0, 3.3, 0, w + 0.03, 0.18, 1.7, shade(Wc, 0.95));
      b.box(0, 3.48, 0.7, w, 0.22, 0.08, Wc);
      b.hip(0, 3.48, -0.2, w + 0.02, 0.5, 1.2, P.slate, { kr: 1, snow: true });
      b.arch(0, 0.7, 0.812, 0.4, 0.95, winCol(c.rng), { shape: 'r' });
      b.quad(0, 2.0, 0.812, 0.34, 0.6, winCol(c.rng));
      b.box(-w / 2 + 0.05, 0.4, 0.82, 0.12, 2.9, 0.06, shade(Wc, 0.93));
      if (i % 2 === 0) statue(b, 0, 3.48, 0.7, 1.3, 0xe5dfd2);
      b.pop();
      c.blockC(x, z, 1.05);
    }
    // central gate pavilion + dome
    var gz = cz - R + 0.15;
    b.box(0, 0, gz, 3.0, 4.0, 2.2, Wc);
    b.box(0, 0, gz, 3.05, 0.4, 2.25, shade(Wc, 0.88));
    b.box(0, 3.85, gz, 3.2, 0.2, 2.3, shade(Wc, 0.95));
    b.arch(0, 0.2, gz + 1.112, 1.4, 2.4, 0xffbd6a, { shape: 'r' });
    [-1, 1].forEach(function (s) {
      b.cyl(s * 1.0, 0.4, gz + 1.25, 0.11, 2.6, 0xe8e2d5, { seg: 6 });
      b.cyl(s * 1.3, 0.4, gz + 1.25, 0.11, 2.6, 0xe8e2d5, { seg: 6 });
      statue(b, s * 1.15, 4.05, gz + 1.0, 1.6, 0xe5dfd2);
      // end fountain groups
      var ex = s * 8.25, ez = cz - R * Math.cos(0.83) + 0.9;
      b.box(ex, 0, ez, 1.2, 0.5, 0.8, 0xe2dccd, { ry: -s * 0.8 });
      statue(b, ex, 0.5, ez, 2.2, 0xe2dccd);
      // small corner domes
      var dx = R * Math.sin(s * 0.72), dz = cz - R * Math.cos(0.72);
      b.cyl(dx, 3.48, dz, 0.68, 0.55, Wc, { seg: 8 });
      b.dome(dx, 4.03, dz, 0.7, 0.85, P.copper, { seg: 8, rings: 3 });
      b.cyl(dx, 4.85, dz, 0.12, 0.3, P.copper, { seg: 5 });
      b.sph(dx, 5.2, dz, 0.08, P.gold);
    });
    var dzc = gz - 0.6;
    b.cyl(0, 4.05, dzc, 1.6, 0.9, Wc, { seg: 12 });
    for (var k = 0; k < 6; k++) { var aa = (k - 2.5) * 0.42; b.at(Math.sin(aa) * 1.6, 4.25, dzc + Math.cos(aa) * 1.6, aa, function () { b.arch(0, 0, 0.012, 0.3, 0.5, winCol(c.rng), { shape: 'r' }); }); }
    b.dome(0, 4.95, dzc, 1.65, 1.95, P.copper, { seg: 12, rings: 5 });
    b.cyl(0, 6.8, dzc, 0.32, 0.6, Wc, { seg: 8 });
    b.dome(0, 7.4, dzc, 0.34, 0.35, P.copper, { seg: 8, rings: 2 });
    b.sph(0, 7.85, dzc, 0.12, P.gold);
    c.block(-1.7, 1.7, gz - 2.2, gz + 1.4);
    c.ring = { x: 0, z: 1.2, r: 3.7 };
    c.stallStyle = 'white';
    c.center = [0, 1.2];
  };

  LANDMARKS['museums-twin'] = function (c) {
    var b = c.b, S = 0xd9ccb1, S2 = 0xcfc1a4;
    [-1, 1].forEach(function (s) {
      b.push(s * 6.65, 0, -1.3, -s * HALF);
      b.box(0, 0, 0, 12.4, 3.0, 2.6, S);
      b.box(0, 0, 0, 12.45, 0.45, 2.65, shade(S, 0.86));
      b.box(0, 2.9, 0, 12.5, 0.16, 2.7, S2);
      b.hip(0, 3.06, 0, 12.5, 0.75, 2.75, P.slate, { kr: 0.84, snow: true });
      windows(c, -5.0, 5.0, 13, [0.62, 1.85], 1.312, 0.3, 0.62, { shape: 'r', skip: function (q) { return Math.abs(q) < 1.8 || Math.abs(q) > 4.5; } });
      // central risalit + octagonal dome
      b.box(0, 0, 0.35, 3.6, 3.7, 2.6, S2);
      b.gable(0, 3.7, 1.55, 0.3, 0.7, 3.7, S, { ry: HALF });
      b.arch(0, 0.35, 1.662, 0.8, 1.6, 0xffbd6a, { shape: 'r' });
      windows(c, -1.2, 1.2, 2, [0.6, 2.1], 1.662, 0.34, 0.8, { shape: 'r' });
      b.cyl(0, 3.7, -0.2, 1.05, 1.0, S, { seg: 8, ry: PI / 8 });
      b.dome(0, 4.7, -0.2, 1.08, 1.5, P.copper, { seg: 8, rings: 3, ry: PI / 8 });
      b.cyl(0, 6.15, -0.2, 0.24, 0.45, S, { seg: 8 });
      b.cone(0, 6.6, -0.2, 0.26, 0.5, P.copper, { seg: 8 });
      for (var k = 0; k < 4; k++) { var aa = (k - 1.5) * 0.65; b.at(Math.sin(aa) * 1.05, 3.95, -0.2 + Math.cos(aa) * 1.05, aa, function () { b.arch(0, 0, 0.012, 0.28, 0.55, winCol(c.rng), { shape: 'r' }); }); }
      // corner pavilions
      [-1, 1].forEach(function (e) {
        b.box(e * 5.4, 0, 0.15, 1.9, 3.5, 2.9, S2);
        b.cyl(e * 5.4, 3.5, 0.15, 0.42, 0.3, S, { seg: 8 });
        b.dome(e * 5.4, 3.8, 0.15, 0.45, 0.55, P.copper, { seg: 8, rings: 3 });
        windows(c, e * 5.4 - 0.4, e * 5.4 + 0.4, 2, [0.62, 1.95], 1.612, 0.28, 0.62, { shape: 'r' });
      });
      b.pop();
      c.block(s > 0 ? 4.9 : -8.1, s > 0 ? 8.1 : -4.9, -7.7, 5.0);
    });
    // Maria Theresia monument
    var mz = -2.4, St = 0xd6cdbc, Br = P.bronze;
    b.box(0, 0, mz, 2.7, 0.25, 2.7, St);
    b.box(0, 0.25, mz, 2.1, 0.35, 2.1, St);
    b.box(0, 0.6, mz, 1.15, 1.7, 1.15, 0xcfc5b3);
    b.box(0, 2.3, mz, 1.4, 0.2, 1.4, St);
    b.box(0, 2.5, mz, 0.9, 0.35, 0.9, Br);
    b.cone(0, 2.85, mz, 0.42, 1.0, Br, { seg: 6 });
    b.ico(0, 3.95, mz, 0.15, Br);
    b.cone(0, 4.07, mz, 0.09, 0.14, P.gold, { seg: 5 });
    b.beam([0.2, 3.3, mz], [0.55, 3.55, mz + 0.2], 0.08, Br);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (q) {
      var hx = q[0] * 0.82, hz = mz + q[1] * 0.82;
      b.box(hx, 0.6, hz, 0.42, 0.32, 0.42, St);
      b.boxc(hx, 1.08, hz, 0.16, 0.2, 0.5, Br, { ry: q[0] * q[1] * 0.6 });
      b.beam([hx, 0.92, hz], [hx, 1.0, hz], 0.3, Br);
      b.cone(hx, 1.15, hz, 0.1, 0.32, Br, { seg: 5 });
      b.ico(hx, 1.5, hz, 0.06, Br);
    });
    b.halo(0, 3.6, mz + 0.4, P.warm, 0.4);
    c.blockC(0, mz, 1.6);
    // clipped topiary
    [[-3.6, -4.8], [3.6, -4.8], [-1.9, -4.6], [1.9, -4.6], [-3.6, 7.8], [3.6, 7.8]].forEach(function (p) {
      b.cone(p[0], 0, p[1], 0.36, 1.1, 0x2a4f39, { seg: 6 });
      b.cone(p[0], 0.75, p[1], 0.17, 0.36, P.snow, { seg: 6 });
      c.blockC(p[0], p[1], 0.42);
    });
    c.noEdgeTrees = true;
    c.az0 = 0.2; c.pol0 = 0.96;
    if (c.cfg.layout === 'square') c.layoutOverride = 'forecourt';
  };

  LANDMARKS.mq = function (c) {
    var b = c.b, rng = c.rng, Cr = 0xf0e1c0;
    // long low baroque former imperial stables
    b.box(0, 0, -8.8, 18.6, 2.6, 1.6, Cr);
    b.box(0, 0, -8.8, 18.65, 0.3, 1.65, shade(Cr, 0.86));
    b.hip(0, 2.6, -8.8, 18.7, 0.7, 1.75, 0x6f6660, { kr: 0.92, snow: true });
    windows(c, -8.6, 8.6, 22, [0.45, 1.5], -8.0 + 0.012, 0.3, 0.6, { shape: 'r', skip: function (q) { return Math.abs(q) < 2.4; } });
    b.box(0, 0, -8.6, 4.6, 3.4, 2.0, Cr);
    b.gable(0, 3.4, -7.65, 0.25, 0.8, 4.7, Cr, { ry: HALF });
    b.hip(0, 3.4, -8.7, 4.7, 0.6, 1.8, 0x6f6660, { kr: 0.6, snow: true });
    b.arch(0, 0, -7.588, 1.0, 1.6, 0xffbd6a, { shape: 'r' });
    windows(c, -1.5, 1.5, 2, [0.5, 1.9], -7.588, 0.36, 0.75, { shape: 'r' });
    b.cyl(0, 4.0, -8.6, 0.42, 0.7, Cr, { seg: 8 });
    b.dome(0, 4.7, -8.6, 0.44, 0.5, P.copper, { seg: 8, rings: 3 });
    b.disc(0, 4.35, -8.17, 0.18, 0xfff1d0, { rx: HALF, layer: 'glow' });
    // projections on the old façade
    [[-6.2, 0xff6fb5], [-4.0, 0x6ee7ff], [4.2, 0xb08cff], [6.4, 0xff9f5a]].forEach(function (p) {
      b.arch(p[0], 0.4, -7.985, 1.3, 1.6, p[1], { shape: 'r', layer: 'glow' });
    });
    c.block(-9.6, 9.6, -9.7, -7.5);
    // Leopold Museum — white limestone cube
    var Lx = -5.9, Lz = -3.6;
    b.box(Lx, 0, Lz, 4.2, 4.4, 5.0, 0xebe7dc);
    b.box(Lx, 4.4, Lz, 4.25, 0.08, 5.05, 0xd9d4c6);
    windows(c, Lx - 1.2, Lx + 1.2, 3, [1.2, 2.6], Lz + 2.512, 0.42, 0.42, {});
    b.quad(Lx, 0, Lz + 2.512, 1.6, 0.7, 0xffcf8a, { layer: 'glow' });
    b.at(Lx + 2.1, 0, Lz, HALF, function () {
      b.quad(-1.2, 1.0, 0.012, 1.0, 1.0, 0xff6fb5, { layer: 'glow' });
      b.quad(0.2, 2.2, 0.012, 1.2, 1.2, 0x6ee7ff, { layer: 'glow' });
      b.quad(1.5, 0.9, 0.012, 0.6, 2.2, 0xffd36e, { layer: 'glow' });
      b.quad(-0.6, 3.0, 0.012, 2.6, 0.18, 0xff6fb5, { layer: 'glow' });
    });
    c.block(Lx - 2.2, Lx + 2.2, Lz - 2.6, Lz + 2.6);
    // mumok — dark basalt block with curved roof
    var Mx = 5.9, Mz = -3.6, Mc = 0x6a6e76;
    b.box(Mx, 0, Mz, 4.2, 3.9, 5.0, Mc);
    b.halfcyl(Mx, 3.9, Mz, 2.1, 0.75, 5.0, Mc, { seg: 10 });
    for (var i = 0; i < 4; i++) b.quad(Mx - 1.5 + i, 0.5, Mz + 2.512, 0.12, 2.6, 0xffcf8a);
    b.at(Mx - 2.1, 0, Mz, -HALF, function () {
      for (var j = 0; j < 7; j++) b.quad(-2.0 + j * 0.66, 0.3, 0.012, 0.2, 3.3, j % 2 ? 0x6ee7ff : 0xff6fb5, { layer: 'glow' });
    });
    c.block(Mx - 2.2, Mx + 2.2, Mz - 2.6, Mz + 2.6);
    // punch igloos between the museums
    [-1.9, 1.9].forEach(function (x) {
      b.dome(x, 0, -6.6, 0.95, 0.95, 0xf6f6f8, { seg: 10, rings: 4 });
      b.arch(x, 0, -6.6 + 0.93, 0.45, 0.6, P.warm, { shape: 'r', layer: 'glow' });
      b.halo(x, 0.4, -5.6, P.warm, 0.8);
      b.pool(x, -5.6, 1.2, P.warm, 0.8);
      c.blockC(x, -6.6, 1.0);
    });
    // colourful "Enzi" lounge furniture, placed after the stalls
    c.post.push(function () {
      var cols = [0xf05aa0, 0xb4d43c, 0x3cb4e6, 0xf6a623];
      var placed = 0;
      for (var t = 0; t < 60 && placed < 6; t++) {
        var x = rng.range(-3.5, 3.5), z = rng.range(-4.8, 6.5);
        if (!c.fits(x, z, 0.6)) continue;
        var ry = rng.range(0, TAU), col = cols[placed % cols.length];
        b.push(x, 0, z, ry);
        b.box(0, 0, 0, 1.0, 0.32, 0.55, col);
        b.box(0, 0.32, -0.2, 1.0, 0.42, 0.18, col, { rx: -0.35 });
        b.box(0, 0, 0.27, 1.0, 0.2, 0.06, shade(col, 0.8));
        b.pop();
        c.blockC(x, z, 0.6);
        placed++;
      }
    });
    c.noEdgeTrees = true;
  };

  LANDMARKS.karlskirche = function (c) {
    var b = c.b, S = 0xe7ddc8, S2 = 0xd9ceb6;
    // central hall + oval drum + great copper dome
    b.box(0, 0, -7.4, 5.4, 3.3, 4.0, S);
    b.box(0, 0, -7.4, 5.45, 0.35, 4.05, shade(S, 0.87));
    b.box(0, 3.2, -7.4, 5.5, 0.16, 4.1, S2);
    b.cyl(0, 3.3, -7.5, 1.9, 1.9, S, { seg: 14, sz: 1.22 });
    for (var k = 0; k < 7; k++) {
      var aa = (k - 3) * 0.42;
      b.at(Math.sin(aa) * 1.9, 3.75, -7.5 + Math.cos(aa) * 1.9 * 1.22, aa, function () { b.arch(0, 0, 0.02, 0.36, 0.8, winCol(c.rng), { shape: 'r' }); });
    }
    b.cyl(0, 5.2, -7.5, 1.98, 0.14, S2, { seg: 14, sz: 1.22 });
    b.dome(0, 5.34, -7.5, 1.95, 2.35, P.copper, { seg: 14, rings: 5, sz: 1.22 });
    b.cyl(0, 7.55, -7.5, 0.38, 0.75, S, { seg: 8 });
    b.dome(0, 8.3, -7.5, 0.42, 0.45, P.copper, { seg: 8, rings: 2 });
    b.cyl(0, 8.7, -7.5, 0.03, 0.4, P.gold, { seg: 4 });
    b.box(0, 8.95, -7.5, 0.2, 0.04, 0.04, P.gold);
    // Greek temple portico
    var pz = -4.3;
    b.box(0, 0, pz, 4.8, 0.25, 1.9, S2);
    b.box(0, 0.25, pz - 0.4, 4.3, 2.4, 1.0, S);
    b.arch(0, 0.25, pz + 0.112, 0.9, 1.6, 0xffbd6a, { shape: 'r' });
    for (var i = 0; i < 6; i++) b.cyl(-1.75 + i * 0.7, 0.25, pz + 0.65, 0.16, 2.4, 0xefe7d5, { seg: 8 });
    b.box(0, 2.65, pz, 4.4, 0.38, 1.8, S2);
    b.gable(0, 3.03, pz, 1.8, 0.95, 4.5, S, { ry: HALF });
    statue(b, 0, 3.98, pz + 0.6, 1.3, S2);
    // the two triumphal columns with spiral reliefs
    [-1, 1].forEach(function (s) {
      var x = s * 3.55, z = -4.6;
      b.box(x, 0, z, 1.1, 0.95, 1.1, S2);
      b.cyl(x, 0.95, z, 0.48, 5.0, S, { seg: 10 });
      var pts = [];
      for (var t = 0; t <= 48; t++) { var a = t / 48 * 4 * TAU; pts.push(new THREE.Vector3(Math.sin(a) * 0.5, 1.15 + t / 48 * 4.5, Math.cos(a) * 0.5)); }
      var tg = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 0.07, 3, false);
      b.geoArr(fromGeo(tg), 0xcbbd9d, M(x, 0, z));
      b.box(x, 5.95, z, 1.15, 0.28, 1.15, S2);
      b.cyl(x, 6.23, z, 0.36, 0.45, S, { seg: 8 });
      b.dome(x, 6.68, z, 0.4, 0.45, P.copper, { seg: 8, rings: 2 });
      b.sph(x, 7.25, z, 0.12, P.gold);
      b.halo(x, 3.5, z + 0.6, P.warm, 0.35);
      // side pavilions (bell towers) with open arches
      var px = s * 6.45, pz2 = -5.7;
      b.box(px, 0, pz2, 2.2, 3.5, 2.6, S);
      b.box(px, 0, pz2, 2.25, 0.35, 2.65, shade(S, 0.87));
      b.arch(px, 0.1, pz2 + 1.312, 0.95, 1.7, 0xffbd6a, { shape: 'r' });
      b.arch(px, 2.2, pz2 + 1.312, 0.4, 0.8, winCol(c.rng), { shape: 'r' });
      b.hip(px, 3.5, pz2, 2.35, 1.0, 2.75, P.copper, { kr: 0.15, snow: true });
      b.cyl(px, 4.4, pz2, 0.18, 0.5, S, { seg: 6 });
      b.cone(px, 4.9, pz2, 0.2, 0.5, P.copper, { seg: 6 });
      b.box(s * 4.75, 0, -5.9, 1.4, 2.5, 1.6, S);
      b.box(s * 4.75, 2.5, -5.9, 1.45, 0.12, 1.65, S2);
    });
    c.block(-7.7, 7.7, -9.6, -4.3);
    c.block(-4.3, 4.3, -5.3, -3.25);
    // Resselpark pond — filled with straw for the kids' area during Art Advent
    var oz = 2.0, rx = 4.5, rz = 2.1;
    b.cyl(0, 0, oz, rx, 0.24, 0xcfc7b7, { seg: 28, sz: rz / rx });
    b.cyl(0, 0, oz, rx - 0.22, 0.29, P.straw, { seg: 28, sz: (rz - 0.22) / (rx - 0.22) });
    for (i = 0; i < 6; i++) b.box(-3 + i * 1.2, 0.29, oz + ((i * 7) % 3 - 1) * 0.6, 0.45, 0.32, 0.32, 0xc9a54c, { ry: i });
    c.block(-rx - 0.1, rx + 0.1, oz - rz - 0.1, oz + rz + 0.1);
    c.override.animals = { x: 0, z: oz, rx: rx - 0.6, rz: rz - 0.5 };
  };

  LANDMARKS.spittelberg = function (c) {
    var b = c.b, rng = c.rng;
    var x = -9.3;
    while (x < 9.3) {
      var w = rng.range(1.4, 2.1);
      if (x + w > 9.4) w = 9.4 - x;
      if (w < 1.0) break;
      var cx = x + w / 2;
      var lane = Math.abs(Math.abs(cx) - 3.65) < 0.9;
      house(c, cx, -8.5, w, 1.9, lane ? 3 : rng.int(2, 3), rng.pick(PASTEL), { archWin: rng.chance(0.4) });
      if (lane) { b.arch(cx, 0, -7.538, 0.9, 1.2, 0xffbd6a, { shape: 'r', layer: 'glow' }); b.pool(cx, -7.0, 1.0, P.warm, 0.6); }
      x += w + 0.02;
    }
    c.block(-9.6, 9.6, -9.7, -7.5);
    // a little Biedermeier corner tower
    b.box(-0.0, 3.4, -8.3, 0.9, 0.7, 0.9, 0xe9d7b0);
    b.dome(0, 4.1, -8.3, 0.5, 0.6, P.copper, { seg: 8, rings: 3 });
    b.cone(0, 4.65, -8.3, 0.06, 0.35, P.gold, { seg: 4 });
  };

  LANDMARKS['altes-akh'] = function (c) {
    var b = c.b, O = 0xe4c070, Rf = 0x8a4d3c;
    function wing(cx, cz, len, ry) {
      b.push(cx, 0, cz, ry);
      b.box(0, 0, 0, len, 3.0, 1.8, O);
      b.box(0, 0, 0, len + 0.02, 0.35, 1.82, shade(O, 0.86));
      b.box(0, 1.05, 0.9, len, 0.06, 0.05, shade(O, 1.08));
      b.hip(0, 3.0, 0, len + 0.15, 0.95, 2.0, Rf, { kr: 1 - 2 / len, snow: true });
      var n = Math.round((len - 0.6) / 0.72);
      windows(c, -len / 2 + 0.5, len / 2 - 0.5, n, [0.45, 1.35, 2.2], 0.912, 0.26, 0.48, { skip: function (q) { return ry === 0 && Math.abs(q) < 1.7; } });
      b.pop();
    }
    wing(0, -8.6, 19.0, 0);
    wing(-8.6, -1.1, 13.2, HALF);
    wing(8.6, -1.1, 13.2, -HALF);
    // gate tower in the back wing
    b.box(0, 0, -8.4, 3.0, 3.7, 2.2, shade(O, 1.04));
    b.hip(0, 3.7, -8.4, 3.15, 0.8, 2.35, Rf, { kr: 0.3, snow: true });
    b.arch(0, 0, -7.288, 1.3, 2.0, 0xffbd6a, { shape: 'r' });
    b.box(0, 4.3, -8.4, 0.8, 0.8, 0.8, shade(O, 1.04));
    b.disc(0, 4.7, -7.988, 0.25, 0xfff1d0, { rx: HALF, layer: 'glow' });
    b.dome(0, 5.1, -8.4, 0.46, 0.5, P.copper, { seg: 8, rings: 3 });
    b.cone(0, 5.55, -8.4, 0.05, 0.35, P.gold, { seg: 4 });
    // low front wall with gate pillars (cut-away so we can look inside)
    [-1, 1].forEach(function (s) {
      b.box(s * 5.05, 0, 6.6, 7.0, 0.55, 0.3, shade(O, 0.95));
      b.box(s * 5.05, 0.55, 6.6, 7.0, 0.06, 0.38, P.snow);
      b.box(s * 1.45, 0, 6.6, 0.5, 1.5, 0.5, shade(O, 0.95));
      b.cone(s * 1.45, 1.5, 6.6, 0.32, 0.35, P.snow, { seg: 4, ry: PI / 4 });
      b.sph(s * 1.45, 1.6, 6.6, 0.12, P.warm, { layer: 'glow' });
      b.halo(s * 1.45, 1.65, 6.6, P.warm, 0.7);
    });
    c.block(-9.6, 9.6, -9.6, -7.6);
    c.block(-9.6, -7.6, -7.8, 5.6);
    c.block(7.6, 9.6, -7.8, 5.6);
    c.block(-8.6, -1.2, 6.4, 6.8);
    c.block(1.2, 8.6, 6.4, 6.8);
    c.noEdgeTrees = true;
  };

  LANDMARKS.belvedere = function (c) {
    var b = c.b, Wc = 0xf3efe6, Cu = 0x73ad97, zc = -8.0;
    // centre block with curved copper roof and pedimented portico
    b.box(0, 0, zc + 0.2, 4.0, 3.8, 2.6, Wc);
    b.box(0, 0, zc + 0.2, 4.05, 0.4, 2.65, shade(Wc, 0.88));
    b.dome(0, 3.8, zc + 0.2, 2.0, 1.35, Cu, { seg: 12, rings: 4, sz: 0.68 });
    b.cyl(0, 5.1, zc + 0.2, 0.22, 0.35, Wc, { seg: 6 });
    b.sph(0, 5.55, zc + 0.2, 0.12, P.gold);
    b.box(0, 0, zc + 1.8, 2.5, 3.2, 0.6, Wc);
    b.gable(0, 3.2, zc + 1.8, 0.62, 0.75, 2.7, Wc, { ry: HALF });
    for (var i = -1; i <= 1; i++) b.arch(i * 0.75, 0.3, zc + 2.112, 0.5, 1.2, 0xffbd6a, { shape: 'r' });
    windows(c, -0.75, 0.75, 3, [1.95], zc + 2.112, 0.36, 0.75, { shape: 'r' });
    statue(b, -1.1, 3.2, zc + 1.95, 1.3, 0xe5dfd2); statue(b, 1.1, 3.2, zc + 1.95, 1.3, 0xe5dfd2);
    [-1, 1].forEach(function (s) {
      // wings with tent-like copper roofs
      b.box(s * 4.2, 0, zc, 4.4, 3.0, 2.2, Wc);
      b.box(s * 4.2, 0, zc, 4.45, 0.4, 2.25, shade(Wc, 0.88));
      b.box(s * 4.2, 2.9, zc, 4.5, 0.12, 2.3, shade(Wc, 0.95));
      windows(c, s * 4.2 - 1.8, s * 4.2 + 1.8, 6, [0.6, 1.9], zc + 1.112, 0.3, 0.7, { shape: 'r' });
      b.hip(s * 3.15, 3.02, zc, 2.2, 1.15, 2.35, Cu, { kr: 0.12, snow: true, k: 0.45 });
      b.hip(s * 5.3, 3.02, zc, 2.2, 1.15, 2.35, Cu, { kr: 0.12, snow: true, k: 0.45 });
      // octagonal corner pavilions with domed caps
      var px = s * 7.6;
      b.cyl(px, 0, zc, 1.3, 3.3, Wc, { seg: 8, ry: PI / 8 });
      b.cyl(px, 0, zc, 1.33, 0.4, shade(Wc, 0.88), { seg: 8, ry: PI / 8 });
      b.cyl(px, 3.2, zc, 1.38, 0.12, shade(Wc, 0.95), { seg: 8, ry: PI / 8 });
      b.dome(px, 3.32, zc, 1.32, 1.15, Cu, { seg: 8, rings: 3, ry: PI / 8 });
      b.cyl(px, 4.45, zc, 0.16, 0.35, Wc, { seg: 6 });
      b.sph(px, 4.9, zc, 0.11, P.gold);
      for (var k = 0; k < 3; k++) { var aa = (k - 1) * 0.78; b.at(px + Math.sin(aa) * 1.21, 0, zc + Math.cos(aa) * 1.21, aa, function () { b.arch(0, 0.6, 0.012, 0.32, 0.7, winCol(c.rng), { shape: 'r' }); b.arch(0, 1.9, 0.012, 0.32, 0.7, winCol(c.rng), { shape: 'r' }); }); }
    });
    c.block(-9.0, 9.0, -9.5, zc + 1.4);
    c.block(-1.4, 1.4, zc, zc + 2.2);
    // the long reflecting pond in front
    b.box(0, 0, -3.4, 10.4, 0.22, 4.6, 0xd2cabb);
    b.box(0, 0.0, -3.4, 10.0, 0.24, 4.2, P.water, { layer: 'water' });
    c.block(-5.3, 5.3, -5.8, -1.0);
    for (i = 0; i < 6; i++) { var bx = -4.5 + i * 1.8; b.pool(bx, -3.4, 0.9, 0x9fc8ff, 0.18); }
  };

  LANDMARKS.schoenbrunn = function (c) {
    var b = c.b, Y = 0xeabc4c, Wt = 0xf4ecd8, Sl = 0x6f7787, zc = -8.3;
    b.box(0, 0, zc, 18.6, 3.0, 2.0, Y);
    b.box(0, 0, zc, 18.65, 0.4, 2.05, shade(Y, 0.88));
    b.box(0, 2.9, zc, 18.7, 0.14, 2.1, Wt);
    b.hip(0, 3.04, zc, 18.8, 0.7, 2.2, Sl, { kr: 0.93, snow: true });
    windows(c, -8.7, 8.7, 24, [0.6, 1.4, 2.25], zc + 1.012, 0.24, 0.48, { skip: function (q) { return Math.abs(q) < 2.7 || Math.abs(Math.abs(q) - 6.4) < 1.3; } });
    for (var x = -8.6; x <= 8.61; x += 1.08) b.box(x, 0.4, zc + 1.02, 0.12, 2.5, 0.04, Wt);
    // central raised section with attic, pilasters and statues
    b.box(0, 0, -7.6, 5.2, 3.75, 2.8, Y);
    b.box(0, 0, -7.6, 5.25, 0.4, 2.85, shade(Y, 0.88));
    b.box(0, 3.62, -7.6, 5.35, 0.14, 2.95, Wt);
    b.box(0, 3.76, -7.6, 5.2, 0.3, 2.8, Y);
    b.hip(0, 4.06, -7.6, 5.3, 0.75, 2.9, Sl, { kr: 0.55, snow: true });
    for (x = -2.2; x <= 2.21; x += 0.88) { b.box(x, 0.4, -6.18, 0.16, 3.2, 0.05, Wt); statue(b, x, 4.06, -6.3, 1.3, Wt); }
    windows(c, -1.75, 1.75, 5, [1.5, 2.55], -6.188, 0.3, 0.7, { shape: 'r' });
    // side risalits
    [-1, 1].forEach(function (s) {
      b.box(s * 6.4, 0, -8.0, 2.6, 3.35, 2.45, Y);
      b.box(s * 6.4, 3.25, -8.0, 2.7, 0.12, 2.55, Wt);
      b.hip(s * 6.4, 3.37, -8.0, 2.75, 0.7, 2.6, Sl, { kr: 0.1, snow: true });
      windows(c, s * 6.4 - 0.8, s * 6.4 + 0.8, 3, [0.6, 1.45, 2.35], -6.762, 0.24, 0.5);
      // wings of the cour d'honneur
      block(c, s * 8.75, -3.7, 6.4, 2.5, 1.4, Y, { ry: -s * HALF, roof: Sl });
      // obelisk gate pillars
      var ox = s * 3.3, oz = 8.9;
      b.box(ox, 0, oz, 0.55, 0.55, 0.55, 0xd8d0be);
      b.cone(ox, 0.55, oz, 0.2, 1.9, 0xe6dfcf, { seg: 4, ry: PI / 4 });
      b.sph(ox, 2.5, oz, 0.11, P.gold);
      c.blockC(ox, oz, 0.5);
    });
    // the two fountains of the cour d'honneur
    [-1, 1].forEach(function (s) {
      var fx = s * 6.3, fz = -2.6;
      b.cyl(fx, 0, fz, 1.0, 0.3, 0xd8d0be, { seg: 12 });
      b.cyl(fx, 0, fz, 0.88, 0.32, P.water, { seg: 12, layer: 'water' });
      b.cyl(fx, 0.3, fz, 0.3, 0.5, 0xd8d0be, { seg: 8 });
      statue(b, fx - 0.15, 0.8, fz, 1.6, 0xe6dfcf); statue(b, fx + 0.18, 0.8, fz + 0.1, 1.3, 0xe6dfcf);
      c.blockC(fx, fz, 1.1);
    });
    // double external staircase in front of the centre
    var sz = -5.75;
    b.box(0, 0, sz, 2.6, 1.15, 1.0, Y);
    b.arch(0, 0, sz + 0.512, 0.8, 0.85, 0xffbd6a, { shape: 'r' });
    b.box(0, 1.15, sz, 2.6, 0.06, 1.0, Wt);
    for (x = -1.25; x <= 1.26; x += 0.2) b.box(x, 1.21, sz + 0.45, 0.04, 0.2, 0.04, Wt);
    [-1, 1].forEach(function (s) {
      for (var i = 0; i < 5; i++) b.box(s * (2.85 - i * 0.32), 0, sz, 0.34, 0.23 * (i + 1), 0.9, 0xe9e1cf);
    });
    c.block(-9.6, 9.6, -9.5, -7.2);
    c.block(-2.7, 2.7, -7.2, -6.1);
    c.block(-3.1, 3.1, -6.3, -5.15);
    c.block(-9.6, -8.0, -7.2, -0.4); c.block(8.0, 9.6, -7.2, -0.4);
    c.block(-7.7, -5.1, -7.2, -6.7); c.block(5.1, 7.7, -7.2, -6.7);
    c.noEdgeTrees = true;
  };

  LANDMARKS.riesenrad = function (c) {
    var b = c.b, St = 0x6d6560, hubY = 6.0, R = 4.8, wx = -1.6, wz = -6.6, wry = 0.28;
    // boarding station
    b.push(wx, 0, wz, wry);
    b.box(0, 0, 0, 5.0, 1.05, 2.4, 0x7a5b47);
    b.box(0, 1.05, 0, 5.2, 0.12, 2.6, 0x4a3a30);
    b.box(0, 1.17, 0, 5.2, 0.06, 2.6, P.snow);
    windows(c, -2.0, 2.0, 6, [0.3], 1.212, 0.42, 0.5, { col: P.glowWin });
    // legs (two A-frames)
    [-1, 1].forEach(function (s) {
      var zz = s * 0.95;
      b.beam([-3.0, 0, zz], [0, hubY, s * 0.5], 0.17, St);
      b.beam([3.0, 0, zz], [0, hubY, s * 0.5], 0.17, St);
      b.beam([-1.5, hubY / 2, (zz + s * 0.5) / 2], [1.5, hubY / 2, (zz + s * 0.5) / 2], 0.08, St);
      b.beam([-2.2, 1.5, zz * 0.9], [0, hubY, s * 0.5], 0.06, St);
      b.beam([2.2, 1.5, zz * 0.9], [0, hubY, s * 0.5], 0.06, St);
    });
    b.pop();
    c.block(wx - 3.2, wx + 3.2, wz - 1.5, wz + 1.6);
    // rotating wheel
    var g = c.dyn(function (sb) {
      [-1, 1].forEach(function (s) {
        sb.torus(0, 0, s * 0.42, R, 0.06, St, { seg: 40 });
        sb.torus(0, 0, s * 0.42, R - 0.45, 0.035, St, { seg: 40 });
        for (var i = 0; i < 15; i++) {
          var a = i / 15 * TAU;
          sb.beam([0, 0, s * 0.4], [Math.cos(a) * R, Math.sin(a) * R, s * 0.42], 0.035, St);
        }
      });
      for (var i = 0; i < 30; i++) { var a = (i + 0.5) / 30 * TAU; sb.beam([Math.cos(a) * (R - 0.45), Math.sin(a) * (R - 0.45), 0.42], [Math.cos(a) * R, Math.sin(a) * R, -0.42], 0.025, St); }
      for (i = 0; i < 15; i++) { var a2 = i / 15 * TAU; sb.beam([Math.cos(a2) * R, Math.sin(a2) * R, -0.45], [Math.cos(a2) * R, Math.sin(a2) * R, 0.45], 0.04, St); }
      sb.cyl(0, -0.6, 0, 0.32, 1.2, 0x3a3d45, { seg: 8, rx: HALF });
      for (i = 0; i < 45; i++) { var a3 = i / 45 * TAU; sb.bulb(Math.cos(a3) * R, Math.sin(a3) * R, 0.5, 0xfff0c8); if (i % 3 === 0) sb.halo(Math.cos(a3) * R, Math.sin(a3) * R, 0.5, 0xffd9a0, 0.3); }
    });
    var pivot = new THREE.Group();
    pivot.position.set(wx, hubY, wz);
    pivot.rotation.y = wry;
    c.scene.add(pivot);
    pivot.add(g);
    // 15 red cabins, kept upright
    var cab = new Builder(c.rng);
    cab.box(0, -0.5, 0, 0.62, 0.42, 0.42, 0xb3282d);
    cab.box(0, -0.08, 0, 0.7, 0.06, 0.5, 0xf2ece2);
    cab.box(0, -0.02, 0, 0.6, 0.05, 0.42, P.snow);
    cab.quad(0, -0.42, 0.212, 0.5, 0.2, P.glowWin, { layer: 'glow' });
    cab.at(0, 0, 0, PI, function () { cab.quad(0, -0.42, 0.212, 0.5, 0.2, P.glowWin, { layer: 'glow' }); });
    cab.beam([0, -0.08, 0], [0, 0.12, 0], 0.03, St);
    var cg = cab.layerGeos(), insts = [];
    for (var ln in cg) {
      var im = new THREE.InstancedMesh(cg[ln], c.mats[ln], 15);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      pivot.add(im); insts.push(im);
    }
    var mtx = new THREE.Matrix4();
    c.anim(function (t) {
      var rot = t * 0.06;
      g.rotation.z = rot;
      for (var i = 0; i < 15; i++) {
        var a = i / 15 * TAU + rot;
        mtx.makeTranslation(Math.cos(a) * R, Math.sin(a) * R - 0.02, 0);
        for (var j = 0; j < insts.length; j++) insts[j].setMatrixAt(i, mtx);
      }
      for (j = 0; j < insts.length; j++) insts[j].instanceMatrix.needsUpdate = true;
    });
    b.halo(wx, hubY, wz, 0xfff0c8, 0.5);
    // funfair hints: drop tower + swing carousel
    var tx = 6.9, tz = -7.4;
    b.cyl(tx, 0, tz, 0.55, 0.3, 0x3a3d45, { seg: 8 });
    for (var i = 0; i < 6; i++) b.cyl(tx, 0.3 + i * 1.05, tz, 0.17, 1.05, i % 2 ? 0xf2ece2 : 0xb3282d, { seg: 6 });
    b.cone(tx, 6.6, tz, 0.3, 0.6, 0xb3282d, { seg: 6 });
    b.torus(tx, 2.6, tz, 0.55, 0.12, P.warm, { seg: 12, rx: HALF, layer: 'glow' });
    for (i = 0; i < 18; i++) b.bulb(tx + Math.sin(i * 2.1) * 0.2, 0.6 + i * 0.33, tz + Math.cos(i * 2.1) * 0.2, PARTY[i % PARTY.length]);
    b.halo(tx, 6.4, tz, 0xff6b6b, 0.6);
    c.blockC(tx, tz, 0.9);
    var kx = 7.2, kz = -3.2;
    b.cyl(kx, 0, kz, 0.5, 0.2, 0x3a3d45, { seg: 8 });
    b.cyl(kx, 0.2, kz, 0.12, 2.6, P.gold, { seg: 6 });
    var sw = c.dyn(function (sb) {
      sb.cone(0, 0, 0, 1.25, 0.6, 0x2f5f8a, { seg: 10, base: true });
      sb.cyl(0, -0.2, 0, 1.27, 0.2, P.gold, { seg: 10 });
      for (var k = 0; k < 8; k++) {
        var a = k / 8 * TAU;
        var p0 = [Math.sin(a) * 1.1, -0.2, Math.cos(a) * 1.1], p1 = [Math.sin(a) * 1.45, -1.4, Math.cos(a) * 1.45];
        sb.beam(p0, p1, 0.015, 0x888888);
        sb.box(p1[0], p1[1] - 0.12, p1[2], 0.18, 0.12, 0.18, COATS[k % COATS.length], { ry: a });
        sb.bulb(Math.sin(a) * 1.25, -0.1, Math.cos(a) * 1.25, PARTY[k % PARTY.length]);
      }
    });
    sw.position.set(kx, 2.8, kz);
    c.scene.add(sw);
    c.anim(function (t) { sw.rotation.y = t * 0.5; });
    b.halo(kx, 2.6, kz, 0x7fd0ff, 0.4);
    c.blockC(kx, kz, 1.6);
  };

  LANDMARKS.park = function (c) {
    var b = c.b;
    c.mounds = [{ x: -6.2, z: -6.4, r: 3.6, h: 1.1 }, { x: 7.0, z: -8.2, r: 2.8, h: 0.7 }, { x: -8.2, z: 3.4, r: 2.4, h: 0.55 }, { x: 7.8, z: 4.8, r: 2.2, h: 0.45 }];
    c.mounds.forEach(function (m) {
      b.sph(m.x, 0, m.z, m.r, P.snow, { w: 14, h: 8, sy: m.h / m.r, noAO: true });
      c.blockC(m.x, m.z, m.r * 0.72, 'stall');
    });
    // Paulinenwarte lookout tower on the hill
    var tx = -6.2, tz = -6.4, y0 = 0.95, St = 0xb5a184;
    b.cyl(tx, y0 - 0.3, tz, 0.78, 3.7, St, { seg: 4, top: 0.86, ry: PI / 4 });
    b.box(tx, y0 + 3.4, tz, 1.25, 0.28, 1.25, shade(St, 0.92));
    for (var i = 0; i < 8; i++) {
      var a = i / 8 * TAU;
      b.box(tx + Math.sin(a) * 0.55, y0 + 3.68, tz + Math.cos(a) * 0.55, 0.16, 0.2, 0.16, St);
    }
    b.cyl(tx, y0 + 3.68, tz, 0.4, 0.8, St, { seg: 8 });
    b.cone(tx, y0 + 4.48, tz, 0.48, 1.0, P.slate, { seg: 8 });
    b.sph(tx, y0 + 5.5, tz, 0.06, P.gold);
    b.arch(tx, y0 + 1.0, tz + 0.58, 0.22, 0.5, winCol(c.rng), { shape: 'r' });
    b.arch(tx, y0 + 2.3, tz + 0.53, 0.22, 0.5, P.glowWin, { shape: 'r' });
    b.arch(tx, y0 + 3.8, tz + 0.4, 0.2, 0.4, P.glowWin, { shape: 'r' });
    b.halo(tx, y0 + 4.0, tz, P.warm, 0.5);
    c.blockC(tx, tz, 1.0);
    // small pond
    var px = 3.6, pz = -5.6;
    b.cyl(px, 0, pz, 2.3, 0.1, 0xe6ebf1, { seg: 14, sz: 0.62, noAO: true });
    b.cyl(px, 0, pz, 2.05, 0.12, P.water, { seg: 14, sz: 0.6, layer: 'water' });
    [[-1.6, 0.6], [1.8, -0.4], [0.4, 1.1]].forEach(function (p) { b.ico(px + p[0], 0.05, pz + p[1], 0.22, 0x9a958c, { sy: 0.6 }); });
    for (i = 0; i < 6; i++) b.cone(px - 1.6 + i * 0.2, 0.1, pz - 0.9 - (i % 2) * 0.1, 0.03, 0.5, 0x8a7a50, { seg: 3 });
    c.block(px - 2.4, px + 2.4, pz - 1.5, pz + 1.5);
  };

  LANDMARKS.fountain = function (c) {
    var b = c.b, St = 0xdad3c5;
    // Soviet war memorial: column with the soldier, semicircular colonnade
    var mz = -6.7;
    b.box(0, 0, mz, 1.8, 0.3, 1.8, St);
    b.box(0, 0.3, mz, 1.3, 0.5, 1.3, St);
    b.cyl(0, 0.8, mz, 0.55, 5.6, 0xe4ddd0, { seg: 4, top: 0.72, ry: PI / 4 });
    b.box(0, 6.4, mz, 0.7, 0.2, 0.7, St);
    var G = P.gold;
    b.cone(0, 6.6, mz, 0.22, 0.75, G, { seg: 6 });
    b.ico(0, 7.42, mz, 0.11, G);
    b.box(0.25, 6.7, mz + 0.1, 0.05, 1.3, 0.05, G);
    b.box(0.5, 7.6, mz + 0.1, 0.5, 0.36, 0.03, G, { rz: 0.1 });
    b.disc(-0.2, 7.05, mz + 0.14, 0.18, G, { rx: HALF, seg: 8 });
    b.halo(0, 7.1, mz + 0.5, P.warm, 0.6);
    var R = 2.9;
    for (var i = 0; i <= 12; i++) {
      var a = -1.45 + 2.9 * i / 12;
      b.cyl(R * Math.sin(a), 0, mz - R * Math.cos(a), 0.13, 2.2, 0xe9e3d7, { seg: 6 });
      if (i < 12) {
        var am = a + 2.9 / 24, w = R * 2.9 / 12 + 0.05;
        b.box(R * Math.sin(am), 2.2, mz - R * Math.cos(am), w, 0.42, 0.5, St, { ry: -am });
        b.box((R + 0.6) * Math.sin(am), 0, mz - (R + 0.6) * Math.cos(am), w * 1.2, 1.4, 0.3, 0xcfc8b9, { ry: -am });
      }
    }
    c.blockC(0, mz - 1.4, 3.2);
    c.block(-1.0, 1.0, mz - 1.0, mz + 1.0);
    // Hochstrahlbrunnen
    var fz = 0.8;
    b.cyl(0, 0, fz, 2.55, 0.35, St, { seg: 24 });
    b.cyl(0, 0, fz, 2.35, 0.37, P.water, { seg: 24, layer: 'water' });
    b.cyl(0, 0, fz, 0.55, 0.5, 0xa59d8f, { seg: 8 });
    b.cyl(0, 0.5, fz, 0.11, 3.8, 0xdff1ff, { seg: 6, top: 0.25, layer: 'glow' });
    b.cone(0, 3.6, fz, 0.32, 0.55, 0xeaf6ff, { seg: 6, layer: 'glow', base: true });
    for (i = 0; i < 10; i++) {
      var aa = i / 10 * TAU;
      var x = Math.sin(aa) * 1.45, z = fz + Math.cos(aa) * 1.45;
      b.beam([x, 0.35, z], [x * 0.85, 1.35, fz + (z - fz) * 0.85], 0.05, 0xcfe8ff, { layer: 'glow' });
      b.bulb(Math.sin(aa) * 2.45, 0.42, fz + Math.cos(aa) * 2.45, i % 2 ? 0x7fd0ff : 0xb08cff);
    }
    b.halo(0, 3.5, fz, 0xbfe3ff, 1.2);
    b.halo(0, 1.4, fz, 0x9fd0ff, 0.9);
    b.pool(0, fz, 3.4, 0x8fc3ff, 0.45);
    c.blockC(0, fz, 2.7);
    // framing palaces
    [-1, 1].forEach(function (s) {
      block(c, s * 8.5, -4.6, 5.0, 3.6, 1.8, s > 0 ? 0xeee2c8 : 0xe5d3b6, { ry: -s * HALF, roof: P.slate });
      c.block(s > 0 ? 7.5 : -9.5, s > 0 ? 9.5 : -7.5, -7.2, -2.0);
    });
  };

  LANDMARKS.greenhouse = function (c) {
    var b = c.b, Fr = 0xf2f2ee, Gl = 0xcfeaf2;
    var zc = -7.3;
    b.box(0, 0, zc, 13.0, 0.4, 3.0, 0xd9d4c8);
    b.box(0, 0.4, zc, 12.9, 0.06, 2.9, 0xffe2a8, { layer: 'glow' });
    // plants inside (seen through glass)
    for (var i = 0; i < 9; i++) {
      var x = -5.6 + i * 1.4, z = zc + (i % 2 ? 0.5 : -0.5);
      b.cyl(x, 0.4, z, 0.06, 1.0, 0x6b5a40, { seg: 4 });
      b.ico(x, 1.45, z, 0.5, i % 3 ? 0x3f8a52 : 0x5aa060, { sy: 0.55 });
    }
    b.box(0, 0.4, zc, 12.9, 1.1, 2.9, Gl, { layer: 'glass' });
    b.halfcyl(0, 1.5, zc, 1.45, 1.2, 12.9, Gl, { ry: HALF, seg: 10, layer: 'glass' });
    for (x = -6.4; x <= 6.41; x += 1.07) {
      b.box(x, 0.4, zc + 1.45, 0.05, 1.1, 0.05, Fr); b.box(x, 0.4, zc - 1.45, 0.05, 1.1, 0.05, Fr);
      b.torus(x, 1.5, zc, 1.45, 0.035, Fr, { seg: 10, arc: PI, ry: HALF, sy: 0.83 });
    }
    b.box(0, 1.5, zc + 1.45, 12.9, 0.05, 0.05, Fr);
    b.box(0, 2.7, zc, 12.9, 0.05, 0.05, Fr);
    // central palm-house pavilion with glass dome
    b.box(0, 0, zc + 0.2, 3.4, 0.4, 4.0, 0xd9d4c8);
    b.cyl(0, 0.4, zc + 0.2, 0.2, 2.6, 0x6b5a40, { seg: 4 });
    b.ico(0, 3.0, zc + 0.2, 0.9, 0x3f8a52, { sy: 0.5 });
    b.box(0, 0.4, zc + 0.2, 3.3, 2.1, 3.9, Gl, { layer: 'glass' });
    b.dome(0, 2.5, zc + 0.2, 1.75, 1.7, Gl, { seg: 12, rings: 4, sz: 1.15, layer: 'glass' });
    for (i = 0; i < 6; i++) b.torus(0, 2.5, zc + 0.2, 1.75, 0.035, Fr, { seg: 12, arc: PI, ry: i / 6 * PI, sy: 0.97 });
    [[-1.65, 2.15], [1.65, 2.15], [-1.65, -1.75], [1.65, -1.75]].forEach(function (q) { b.box(q[0], 0.4, zc + 0.2 + q[1] * 0.9, 0.06, 2.1, 0.06, Fr); });
    b.sph(0, 4.25, zc + 0.2, 0.1, P.gold);
    b.halo(0, 1.6, zc + 1.0, 0xffe2a8, 1.0);
    b.halo(-4, 1.2, zc + 1.0, 0xffe2a8, 0.7); b.halo(4, 1.2, zc + 1.0, 0xffe2a8, 0.7);
    b.pool(0, zc + 2.6, 2.6, P.warm, 0.5);
    c.block(-6.7, 6.7, zc - 1.6, zc + 2.3);
    // two smaller ridge-roof greenhouses
    [-1, 1].forEach(function (s) {
      var gx = s * 7.4, gz = -2.6;
      b.box(gx, 0, gz, 2.0, 0.3, 3.4, 0xd9d4c8);
      b.box(gx, 0.3, gz, 1.95, 0.05, 3.35, 0xffe2a8, { layer: 'glow' });
      for (var k = 0; k < 3; k++) b.ico(gx, 0.5, gz - 1 + k, 0.35, 0x4f9a5a, { sy: 0.6 });
      b.box(gx, 0.3, gz, 1.95, 0.8, 3.35, Gl, { layer: 'glass' });
      b.gable(gx, 1.1, gz, 3.4, 0.8, 2.0, Gl, { ry: HALF, layer: 'glass' });
      for (k = -1; k <= 1; k++) b.beam([gx - 1.0, 1.1, gz + k * 1.6], [gx, 1.9, gz + k * 1.6], 0.04, Fr), b.beam([gx + 1.0, 1.1, gz + k * 1.6], [gx, 1.9, gz + k * 1.6], 0.04, Fr);
      b.box(gx, 1.88, gz, 0.05, 0.05, 3.4, Fr);
      b.halo(gx, 0.9, gz, 0xffe2a8, 0.6);
      c.block(gx - 1.2, gx + 1.2, gz - 1.9, gz + 1.9);
      // snowy garden beds
      for (k = 0; k < 3; k++) {
        var bz = 1.0 + k * 1.15;
        b.box(gx, 0, bz, 1.8, 0.16, 0.8, 0x6b4a33);
        b.box(gx, 0.16, bz, 1.7, 0.05, 0.7, P.snow);
        for (var j = 0; j < 3; j++) b.cone(gx - 0.55 + j * 0.55, 0.2, bz, 0.1, 0.25, 0x4f7a50, { seg: 4 });
      }
      c.block(gx - 1.0, gx + 1.0, 0.5, 4.0);
    });
  };

  /* ============================================================== LAYOUTS */
  // Return { slots: [{x,z,ry,row,along,pri}], spots: [{x,z,t:[tags],w?}], lamps: [[chain]], walk: [[x0,x1,z0,z1]] }

  function sq(x0, x1, z0, z1) { return [x0, x1, z0, z1]; }

  function ringSlots(c, ring, n) {
    var slots = [];
    for (var i = 0; i < n; i++) {
      var a = i / n * TAU + PI / n;
      slots.push({ x: ring.x + Math.sin(a) * ring.r, z: ring.z + Math.cos(a) * ring.r, ry: a, row: 0, along: i, pri: i * 0.01, ring: true });
    }
    return slots;
  }

  var LAYOUTS = {};

  LAYOUTS.square = function (c) {
    var L = { slots: [], spots: [], lamps: [], walk: [sq(-8.6, 8.6, -3.0, 9.2)] };
    if (c.ring) {
      var ring = c.ring;
      L.slots = ringSlots(c, ring, c.cfg.stalls);
      L.spots = [
        { x: ring.x, z: ring.z, t: ['axis', 'center', 'big'], w: ring.r - 1.1 },
        { x: -6.4, z: 5.4, t: ['side', 'big'] }, { x: 6.4, z: 5.4, t: ['side', 'big'] },
        { x: -6.6, z: 0.5, t: ['side'] }, { x: 6.6, z: 0.5, t: ['side'] },
        { x: -7.8, z: 8.0, t: ['corner'] }, { x: 7.8, z: 8.0, t: ['corner'] },
        { x: 0, z: 8.9, t: ['front'] }
      ];
      var lc = [];
      for (var i = 0; i < 8; i++) { var a = i / 8 * TAU; lc.push([ring.x + Math.sin(a) * (ring.r + 1.9), ring.z + Math.cos(a) * (ring.r + 1.9)]); }
      lc.push(lc[0]);
      L.lamps = [lc];
      return L;
    }
    var rows = [{ z: -2.1, ry: 0 }, { z: 1.0, ry: PI }, { z: 3.7, ry: 0 }, { z: 6.8, ry: PI }];
    rows.forEach(function (r, ri) {
      for (var x = -8.1; x <= 8.11; x += 1.8) {
        if (Math.abs(x) < 1.4) continue;
        L.slots.push({ x: x, z: r.z, ry: r.ry, row: ri, along: x, pri: Math.abs(x) * 0.55 + ri * 1.3 });
      }
    });
    L.spots = [
      { x: 0, z: 5.25, t: ['big', 'center'] },
      { x: 0, z: -0.55, t: ['axis'] }, { x: 0, z: 2.35, t: ['axis', 'center'] },
      { x: -6.0, z: 5.25, t: ['side'] }, { x: 6.0, z: 5.25, t: ['side'] },
      { x: -6.9, z: -0.55, t: ['side', 'edge'] }, { x: 6.9, z: -0.55, t: ['side', 'edge'] },
      { x: -7.8, z: 8.2, t: ['corner'] }, { x: 7.8, z: 8.2, t: ['corner'] },
      { x: -3.5, z: 2.35, t: ['side'] }, { x: 3.5, z: 2.35, t: ['side'] },
      { x: 0, z: 8.95, t: ['front'] }
    ];
    L.lamps = [[[-1.15, -0.55], [-1.15, 2.35], [-1.15, 5.25], [-1.15, 8.2]], [[1.15, -0.55], [1.15, 2.35], [1.15, 5.25], [1.15, 8.2]]];
    L.cross = true;
    return L;
  };

  LAYOUTS.forecourt = function (c) {
    var L = { slots: [], spots: [], lamps: [], walk: [sq(-8.6, 8.6, -4.6, 9.2)] };
    [-1, 1].forEach(function (s) {
      for (var z = -3.4; z <= 8.4; z += 1.95) {
        L.slots.push({ x: s * 2.55, z: z, ry: -s * HALF, row: s > 0 ? 0 : 1, along: z, pri: Math.abs(z - 2.5) * 0.4 });
        L.slots.push({ x: s * 3.86, z: z, ry: s * HALF, row: s > 0 ? 2 : 3, along: z, pri: 3 + Math.abs(z - 2.5) * 0.4 });
        L.slots.push({ x: s * 6.7, z: z, ry: -s * HALF, row: s > 0 ? 4 : 5, along: z, pri: 6 + Math.abs(z - 2.5) * 0.4 });
      }
    });
    L.spots = [
      { x: 0, z: 4.8, t: ['big', 'center'], w: 1.55 },
      { x: 0, z: -2.0, t: ['axis'] }, { x: 0, z: 1.0, t: ['axis', 'center'] },
      { x: -6.6, z: 6.0, t: ['side'] }, { x: 6.6, z: 6.0, t: ['side'] },
      { x: -6.6, z: 1.0, t: ['side', 'edge'] }, { x: 6.6, z: 1.0, t: ['side', 'edge'] },
      { x: -7.8, z: 8.3, t: ['corner'] }, { x: 7.8, z: 8.3, t: ['corner'] },
      { x: 0, z: 8.95, t: ['front'] }
    ];
    L.lamps = [[[-1.3, -3.2], [-1.3, 0.0], [-1.3, 3.2], [-1.3, 6.4]], [[1.3, -3.2], [1.3, 0.0], [1.3, 3.2], [1.3, 6.4]]];
    L.cross = true;
    return L;
  };

  LAYOUTS.alley = function (c) {
    var b = c.b, rng = c.rng;
    var L = { slots: [], spots: [], lamps: [], walk: [sq(-5.6, -1.7, -7.0, 9.0), sq(1.7, 5.6, -7.0, 9.0), sq(-8, 8, 6.2, 9.2)] };
    // rows of small old houses; lanes at x = ±3.65
    function row(xc, w, z0, z1, both, maxF) {
      var z = z0;
      while (z < z1) {
        var d = rng.range(1.6, 2.3);
        if (z + d > z1) d = z1 - z;
        if (d < 1.1) break;
        var col = rng.pick(PASTEL), fl = rng.int(2, maxF || 3);
        if (both) {
          house(c, xc, z + d / 2, d, w, fl, col, { ry: HALF, both: true, archWin: rng.chance(0.3) });
        } else {
          house(c, xc, z + d / 2, d, w, fl, col, { ry: xc > 0 ? -HALF : HALF, archWin: rng.chance(0.3) });
        }
        z += d + 0.02;
      }
    }
    row(0, 2.4, -7.3, 3.4, true, 2);
    row(-7.8, 2.6, -7.3, 6.0, false);
    row(7.8, 2.6, -7.3, 6.0, false);
    c.block(-1.25, 1.25, -7.4, 3.5, 'all');
    c.block(-9.6, -6.45, -7.4, 6.1, 'all');
    c.block(6.45, 9.6, -7.4, 6.1, 'all');
    // cobbled lanes
    [-3.65, 3.65].forEach(function (lx) {
      b.box(lx, 0, -0.6, 5.1, 0.02, 13.4, P.cobble, { noAO: true });
      for (var z = -6.0; z <= 5.0; z += 2.2) {
        b.string([lx - 2.5, 2.25, z], [lx + 2.5, 2.25, z + 1.1], { sag: 0.3 });
      }
    });
    [-1, 1].forEach(function (s) {
      for (var z = -6.5; z <= 8.3; z += 1.72) {
        L.slots.push({ x: s * 5.5, z: z, ry: -s * HALF, row: s > 0 ? 0 : 1, along: z, pri: Math.abs(z - 2) * 0.5 });
        L.slots.push({ x: s * 1.88, z: z, ry: s * HALF, row: s > 0 ? 2 : 3, along: z, pri: 0.3 + Math.abs(z - 2) * 0.5 });
      }
    });
    for (var x = -7.6; x <= 7.6; x += 1.75) if (Math.abs(Math.abs(x) - 3.65) > 1.2) L.slots.push({ x: x, z: 7.9, ry: 0, row: 6, along: x, pri: 4 + Math.abs(x) * 0.3 });
    L.spots = [
      { x: 0, z: 6.6, t: ['big', 'center', 'axis'], w: 2.2 },
      { x: -3.65, z: -5.0, t: ['side', 'axis'], w: 1.0 }, { x: 3.65, z: -5.0, t: ['side'], w: 1.0 },
      { x: -3.65, z: 1.0, t: ['side', 'edge'], w: 1.0 }, { x: 3.65, z: 1.0, t: ['side', 'edge'], w: 1.0 },
      { x: -7.9, z: 8.2, t: ['corner', 'edge'] }, { x: 7.9, z: 8.2, t: ['corner', 'edge'] },
      { x: 3.65, z: 9.0, t: ['front'] }
    ];
    L.lamps = [[[-3.65, -3.0], [-3.65, 3.6]], [[3.65, -3.0], [3.65, 3.6]]];
    c.noEdgeTrees = true;
    return L;
  };

  LAYOUTS.courtyard = function (c) {
    var L = { slots: [], spots: [], lamps: [], walk: [sq(-6.8, 6.8, -6.8, 6.2)] };
    for (var x = -6.0; x <= 6.01; x += 1.72) L.slots.push({ x: x, z: -6.95, ry: 0, row: 0, along: x, pri: Math.abs(x) * 0.3 });
    [-1, 1].forEach(function (s) {
      for (var z = -5.2; z <= 5.0; z += 1.72) L.slots.push({ x: s * 6.95, z: z, ry: -s * HALF, row: s > 0 ? 1 : 2, along: z, pri: 1 + Math.abs(z + 1) * 0.3 });
    });
    for (x = -4.4; x <= 4.41; x += 1.75) if (Math.abs(x) > 1.2) L.slots.push({ x: x, z: 5.6, ry: PI, row: 3, along: x, pri: 6 + Math.abs(x) * 0.3 });
    // big old bare trees in the court
    [[-3.6, -3.8], [3.6, -3.8], [-3.9, 2.4], [3.9, 2.4], [0, -4.6]].forEach(function (p, i) {
      if (!c.fits(p[0], p[1], 0.7)) return;
      bareTree(c, p[0], p[1], 1.45, { lights: c.hasFeature('light-trees') || i % 2 === 0, hearts: false });
      c.blockC(p[0], p[1], 0.7);
    });
    L.spots = [
      { x: 0, z: -0.8, t: ['big', 'center', 'axis'] },
      { x: 0, z: 3.3, t: ['axis', 'center'] },
      { x: -3.6, z: -0.7, t: ['side'] }, { x: 3.6, z: -0.7, t: ['side'] },
      { x: -4.6, z: 4.4, t: ['corner', 'edge'] }, { x: 4.6, z: 4.4, t: ['corner', 'edge'] },
      { x: 0, z: 8.4, t: ['front'] }
    ];
    L.lamps = [[[-2.0, -5.4], [2.0, -5.4]], [[-5.4, -2.0], [-5.4, 2.4]], [[5.4, -2.0], [5.4, 2.4]]];
    c.center = [0, -0.5];
    return L;
  };

  LAYOUTS.park = function (c) {
    var b = c.b;
    var ctrl = [[0.5, 9.1], [-2.4, 6.6], [-1.6, 3.0], [2.4, 1.2], [3.4, -2.0], [0.2, -4.4], [-3.4, -4.9]].map(function (p) { return new THREE.Vector3(p[0], 0, p[1]); });
    var curve = new THREE.CatmullRomCurve3(ctrl);
    var N = 60, pts = curve.getSpacedPoints(N), len = curve.getLength();
    var pos = [];
    for (var i = 0; i < N; i++) {
      var a = pts[i], bb = pts[i + 1], dx = bb.x - a.x, dz = bb.z - a.z, l = Math.hypot(dx, dz) || 1;
      var nx = -dz / l * 0.75, nz = dx / l * 0.75;
      var A0 = [a.x - nx, 0.025, a.z - nz], A1 = [a.x + nx, 0.025, a.z + nz], B0 = [bb.x - nx, 0.025, bb.z - nz], B1 = [bb.x + nx, 0.025, bb.z + nz];
      pos.push.apply(pos, A0.concat(B0, B1, A0, B1, A1));
    }
    // orient path triangles upward
    var arr = new Float32Array(pos);
    for (i = 0; i < arr.length; i += 9) {
      var ux = arr[i + 3] - arr[i], uz = arr[i + 5] - arr[i + 2], vx = arr[i + 6] - arr[i], vz = arr[i + 8] - arr[i + 2];
      if (uz * vx - ux * vz < 0) { for (var k = 0; k < 3; k++) { var t = arr[i + 3 + k]; arr[i + 3 + k] = arr[i + 6 + k]; arr[i + 6 + k] = t; } }
    }
    b.geoArr(arr, P.path, new THREE.Matrix4(), 'solid');
    for (i = 0; i <= N; i += 2) c.blockC(pts[i].x, pts[i].z, 0.8, 'soft');
    c.pathPts = pts;
    var L = { slots: [], spots: [], lamps: [[]], walk: [] };
    var centres = [2.5, 8.5, 14.5, 20.5];
    for (var s = 1.2; s < len - 0.8; s += 1.75) {
      var u = s / len, p = curve.getPointAt(u), tg = curve.getTangentAt(u);
      var nx2 = -tg.z, nz2 = tg.x;
      var near = Math.min.apply(null, centres.map(function (q) { return Math.abs(q - s); }));
      [-1, 1].forEach(function (side) {
        var x = p.x + nx2 * side * 1.75, z = p.z + nz2 * side * 1.75;
        L.slots.push({ x: x, z: z, ry: Math.atan2(-nx2 * side, -nz2 * side), row: side > 0 ? 0 : 1, along: s, pri: near + (side > 0 ? 0 : 0.4) });
      });
      if (Math.round(s / 1.75) % 3 === 0) L.lamps[0].push([p.x + nx2 * 0.95, p.z + nz2 * 0.95]);
      L.walk.push(sq(p.x - 0.6, p.x + 0.6, p.z - 0.6, p.z + 0.6));
    }
    [[4.6, 4.8], [-5.6, -1.0], [5.8, 0.8], [-4.6, 6.0], [1.0, -1.6], [-1.2, -1.2], [6.2, -2.6], [-6.0, 2.0]].forEach(function (q) {
      L.spots.push({ x: q[0], z: q[1], t: ['big', 'center', 'side', 'axis', 'corner', 'edge'] });
    });
    L.spots.push({ x: 0.4, z: 8.9, t: ['front'], ry: -0.6 });
    c.treeMode = 'park';
    return L;
  };

  /* ============================================================= FEATURES */

  var FDEF = {
    'ice-rink': { order: 1, tags: ['big', 'center', 'side'], size: function (s) { var w = Math.min(2.8, s.w || 2.8); return [w, w < 2.2 ? 2.7 : 2.0]; } },
    'train': { order: 2, tags: ['big', 'side', 'corner'], size: function () { return [1.9, 1.45]; } },
    'pond': { order: 3, tags: ['side', 'corner', 'big'], size: function () { return [1.9, 1.4]; } },
    'animals': { order: 4, tags: ['side', 'corner', 'big'], size: function () { return [1.35, 1.1]; } },
    'ferris-wheel': { order: 5, tags: ['side', 'corner', 'big'], size: function () { return [1.35, 0.8]; } },
    'carousel': { order: 6, tags: ['side', 'center', 'corner', 'big'], size: function () { return [1.45, 1.45]; } },
    'stage': { order: 7, tags: ['side', 'corner', 'big'], size: function () { return [1.35, 1.0]; } },
    'curling': { order: 8, tags: ['side', 'corner', 'edge'], size: function () { return [0.6, 1.95]; } },
    'nativity': { order: 9, tags: ['side', 'corner', 'axis'], size: function () { return [0.95, 0.85]; } },
    'punch-pavilion': { order: 10, tags: ['side', 'center', 'corner', 'axis'], size: function () { return [1.05, 1.05]; } },
    'big-tree': { order: 11, tags: ['axis', 'center', 'side', 'big'], size: function () { return [0.95, 0.95]; } },
    'fire-pits': { order: 12, tags: ['side', 'corner', 'edge', 'axis'], size: function () { return [1.05, 1.05]; } },
    'light-trees': { order: 13, multi: 4, tags: ['edge', 'side', 'corner'], size: function () { return [0.55, 0.55]; } },
    'arch': { order: 14, tags: ['front'], size: function () { return [1.55, 0.35]; } }
  };
  var FEATURE_KEYS = Object.keys(FDEF);

  var FEATURES = {};
  // orientation for things with a front: towards the plaza centre, biased towards the viewer side
  function faceFront(c, s) { return Math.atan2(c.center[0] - s.x, c.center[1] + 6 - s.z); }

  FEATURES['ice-rink'] = function (c, s, hw, hd) {
    var b = c.b, rx = hw - 0.12, rz = hd - 0.12;
    b.cyl(s.x, 0, s.z, rx, 0.06, P.ice, { seg: 28, sz: rz / rx, layer: 'ice' });
    b.torus(s.x, 0.3, s.z, rx, 0.03, P.white, { seg: 28, rx: HALF, sy: rz / rx });
    for (var i = 0; i < 24; i++) {
      var a = i / 24 * TAU, x = s.x + Math.sin(a) * rx, z = s.z + Math.cos(a) * rz;
      b.box(x, 0, z, 0.05, 0.3, 0.05, i % 2 ? P.red : P.white);
      b.bulb(x, 0.38, z, PARTY[i % PARTY.length]);
    }
    b.pool(s.x, s.z, Math.max(rx, rz) * 1.1, 0x9fd0ff, 0.25);
    // skaters
    for (var k = 0; k < 6; k++) {
      (function (k) {
        var col = COATS[(k * 3) % COATS.length];
        var g = c.dyn(function (sb) {
          sb.cone(0, 0, 0, 0.11, 0.4, col, { seg: 6 });
          sb.ico(0, 0.43, 0, 0.07, P.skin);
          sb.cone(0, 0.46, 0, 0.065, 0.12, k % 2 ? P.red : P.white, { seg: 5 });
          sb.box(0.12, 0.24, 0, 0.2, 0.04, 0.04, col, { rz: -0.5 });
        });
        c.scene.add(g);
        var fr = 0.45 + (k % 3) * 0.17, ph = k * 1.1, sp = 0.18 + (k % 2) * 0.06;
        c.anim(function (t) {
          var a = ph + t * sp;
          g.position.set(s.x + Math.sin(a) * rx * fr, 0.06, s.z + Math.cos(a) * rz * fr);
          g.rotation.y = a + HALF;
          g.rotation.z = Math.sin(t * 3 + k) * 0.08;
        });
      })(k);
    }
  };

  FEATURES['big-tree'] = function (c, s) {
    var b = c.b, x = s.x, z = s.z, Gt = 0x24513c;
    b.cyl(x, 0, z, 0.36, 0.25, P.woodDark, { seg: 8 });
    b.cyl(x, 0.25, z, 0.12, 0.5, P.trunk, { seg: 6 });
    var tiers = [[0.95, 1.5, 0.45], [0.78, 1.35, 1.25], [0.58, 1.15, 2.0], [0.36, 0.95, 2.7]];
    tiers.forEach(function (t, i) {
      b.cone(x, t[2], z, t[0], t[1], Gt, { seg: 8, ry: i * 0.4 });
      b.cone(x, t[2] + t[1] * 0.68 + 0.02, z, t[0] * 0.33, t[1] * 0.32, P.snow, { seg: 8, ry: i * 0.4 });
    });
    for (var i = 0; i < 70; i++) {
      var t = i / 70, y = 0.6 + t * 2.95, a = i * 0.9;
      var rr = 0.95 * (1 - t) * 0.92 + 0.06;
      b.bulb(x + Math.sin(a) * rr, y, z + Math.cos(a) * rr, i % 5 === 0 ? 0xff5a5a : i % 7 === 0 ? 0xffd27a : 0xfff0c8);
    }
    for (i = 0; i < 10; i++) { var a2 = i * 2.3, y2 = 0.8 + (i / 10) * 2.4, r2 = 0.92 * (1 - (y2 - 0.45) / 3.3); b.ico(x + Math.sin(a2) * r2, y2, z + Math.cos(a2) * r2, 0.07, i % 2 ? P.red : P.gold); }
    b.shape('star', x, 3.62, z, 0.42, 0xffe27a, {});
    b.halo(x, 3.85, z, 0xffe27a, 1.2);
    b.halo(x, 1.8, z, P.warm, 0.8);
    b.pool(x, z, 2.0, P.warm, 0.9);
  };

  FEATURES.carousel = function (c, s) {
    var b = c.b;
    b.cyl(s.x, 0, s.z, 1.35, 0.12, 0x6b4a33, { seg: 12 });
    b.pool(s.x, s.z, 2.0, P.warm, 0.8);
    var g = c.dyn(function (sb) {
      sb.cyl(0, 0, 0, 1.25, 0.12, P.red, { seg: 12 });
      sb.cyl(0, 0, 0, 0.12, 1.6, P.gold, { seg: 6 });
      sb.cyl(0, 1.45, 0, 1.3, 0.22, P.red, { seg: 12 });
      sb.raw(PR.cone(12, true), function (tri) { return tri % 4 < 2 ? P.red : P.white; }, M(0, 1.67, 0, 0, 0, 0, 1.38, 0.62, 1.38));
      sb.sph(0, 2.33, 0, 0.09, P.gold);
      sb.box(0.12, 2.35, 0, 0.22, 0.12, 0.01, P.red);
      for (var k = 0; k < 6; k++) {
        var a = k / 6 * TAU, x = Math.sin(a) * 0.9, z = Math.cos(a) * 0.9, h = 0.55 + (k % 2) * 0.15;
        sb.cyl(x, 0.12, z, 0.02, 1.33, P.gold, { seg: 4 });
        sb.boxc(x, h, z, 0.1, 0.14, 0.34, k % 2 ? 0xf4efe6 : 0x8c5a3a, { ry: a + HALF });
        sb.boxc(x + Math.sin(a + HALF) * 0.17, h + 0.12, z + Math.cos(a + HALF) * 0.17, 0.08, 0.16, 0.1, k % 2 ? 0xf4efe6 : 0x8c5a3a, { ry: a + HALF, rx: -0.4 });
      }
      for (k = 0; k < 18; k++) { var a2 = k / 18 * TAU; sb.bulb(Math.sin(a2) * 1.33, 1.5, Math.cos(a2) * 1.33, k % 2 ? 0xfff0c8 : 0xffd27a); }
      sb.halo(0, 1.2, 0, P.warm, 0.9);
    });
    g.position.set(s.x, 0.12, s.z);
    c.scene.add(g);
    c.anim(function (t) { g.rotation.y = t * 0.45; });
  };

  FEATURES['ferris-wheel'] = function (c, s) {
    var b = c.b, R = 1.55, hy = 2.0, ry = s.ry || 0.35, F = 0xe9e3d7;
    b.push(s.x, 0, s.z, ry);
    [-1, 1].forEach(function (k) {
      b.beam([-0.95, 0, k * 0.4], [0, hy, k * 0.26], 0.07, F);
      b.beam([0.95, 0, k * 0.4], [0, hy, k * 0.26], 0.07, F);
    });
    b.box(0, 0, 0, 2.1, 0.12, 1.0, 0x6b4a33);
    b.pop();
    var pivot = new THREE.Group();
    pivot.position.set(s.x, hy, s.z);
    pivot.rotation.y = ry;
    c.scene.add(pivot);
    var g = c.dyn(function (sb) {
      [-1, 1].forEach(function (k) {
        sb.torus(0, 0, k * 0.2, R, 0.035, F, { seg: 24 });
        for (var i = 0; i < 8; i++) { var a = i / 8 * TAU; sb.beam([0, 0, k * 0.2], [Math.cos(a) * R, Math.sin(a) * R, k * 0.2], 0.03, F); }
      });
      for (var i = 0; i < 24; i++) { var a = i / 24 * TAU; sb.bulb(Math.cos(a) * R, Math.sin(a) * R, 0.24, PARTY[i % PARTY.length]); }
    });
    pivot.add(g);
    var gonds = [];
    for (var i = 0; i < 8; i++) {
      var col = [P.red, 0x2f5f8a, P.gold, 0x3d7a52][i % 4];
      var gd = c.dyn(function (sb) {
        sb.box(0, -0.38, 0, 0.32, 0.26, 0.3, col);
        sb.box(0, -0.12, 0, 0.36, 0.04, 0.34, P.white);
        sb.beam([0, -0.12, 0], [0, 0, 0], 0.02, F);
      });
      pivot.add(gd); gonds.push(gd);
    }
    c.anim(function (t) {
      var rot = t * 0.25;
      g.rotation.z = rot;
      for (var i = 0; i < 8; i++) { var a = i / 8 * TAU + rot; gonds[i].position.set(Math.cos(a) * R, Math.sin(a) * R, 0); }
    });
    b.halo(s.x, hy, s.z, 0xff9f9f, 0.6);
    b.pool(s.x, s.z, 1.8, 0xffb0b0, 0.5);
  };

  FEATURES.arch = function (c, s) {
    var b = c.b, G = 0x2c5640, ry = s.ry || 0;
    b.push(s.x, 0, s.z, ry);
    [-1, 1].forEach(function (k) {
      b.box(k * 1.3, 0, 0, 0.24, 2.2, 0.24, G);
      for (var i = 0; i < 9; i++) b.bulb(k * 1.3 + (i % 2 ? 0.13 : -0.13), 0.2 + i * 0.25, 0.13, 0xfff0c8);
    });
    b.torus(0, 2.2, 0, 1.3, 0.13, G, { seg: 14, arc: PI });
    for (var i = 0; i <= 16; i++) { var a = i / 16 * PI; b.bulb(Math.cos(a) * 1.3, 2.2 + Math.sin(a) * 1.3, 0.14, i % 3 ? 0xfff0c8 : 0xffd27a); }
    b.box(0, 2.35, 0, 1.6, 0.34, 0.06, P.red);
    b.quad(0, 2.4, 0.035, 1.4, 0.24, 0xffe7b0, { layer: 'glow' });
    b.shape('star', 0, 3.55, 0, 0.6, 0xffe27a, {});
    b.halo(0, 3.8, 0, 0xffe27a, 1.1);
    b.halo(0, 2.6, 0.2, P.warm, 0.7);
    b.pop();
  };

  FEATURES.pond = function (c, s, hw, hd) {
    var b = c.b, rx = hw - 0.1, rz = hd - 0.1;
    b.cyl(s.x, 0, s.z, rx, 0.08, 0xe6ebf1, { seg: 16, sz: rz / rx, noAO: true });
    b.cyl(s.x, 0, s.z, rx - 0.22, 0.1, P.water, { seg: 16, sz: (rz - 0.22) / (rx - 0.22), layer: 'water' });
    for (var i = 0; i < 5; i++) { var a = i * 1.3; b.ico(s.x + Math.sin(a) * rx * 0.95, 0.05, s.z + Math.cos(a) * rz * 0.95, 0.16, 0x9a958c, { sy: 0.6 }); }
    for (i = 0; i < 7; i++) b.cone(s.x - rx * 0.6 + i * 0.12, 0.08, s.z - rz * 0.75, 0.025, 0.45 + (i % 3) * 0.1, 0x8a7a50, { seg: 3 });
    b.pool(s.x, s.z, rx, 0x9fc8ff, 0.2);
  };

  FEATURES.curling = function (c, s, hw, hd) {
    var b = c.b, x = s.x, z = s.z;
    b.box(x, 0, z, hw * 2 - 0.2, 0.05, hd * 2 - 0.2, P.ice, { layer: 'ice' });
    b.box(x - hw + 0.12, 0, z, 0.08, 0.2, hd * 2 - 0.2, P.woodDark);
    b.box(x + hw - 0.12, 0, z, 0.08, 0.2, hd * 2 - 0.2, P.woodDark);
    b.box(x, 0, z - hd + 0.12, hw * 2 - 0.2, 0.2, 0.08, P.woodDark);
    b.disc(x, 0.055, z - hd + 0.6, 0.32, 0xc0393f, { seg: 12, layer: 'ice' });
    b.disc(x, 0.06, z - hd + 0.6, 0.2, 0xffffff, { seg: 12, layer: 'ice' });
    b.disc(x, 0.065, z - hd + 0.6, 0.08, 0x2f5f8a, { seg: 12, layer: 'ice' });
    [[0.1, -0.5, P.red], [-0.12, -0.9, P.gold], [0.05, 0.6, P.red]].forEach(function (q) {
      b.cyl(x + q[0], 0.05, z + q[1], 0.08, 0.06, 0x555a60, { seg: 8 });
      b.cyl(x + q[0], 0.11, z + q[1], 0.02, 0.1, q[2], { seg: 4 });
    });
    person(c, x - 0.15, z + hd - 0.45, { ry: PI });
    person(c, x + 0.2, z + hd - 0.75, { ry: PI });
    b.pool(x, z, hd, 0x9fd0ff, 0.2);
  };

  FEATURES.stage = function (c, s) {
    var b = c.b, ry = faceFront(c, s);
    b.push(s.x, 0, s.z, ry);
    b.box(0, 0, 0, 2.4, 0.35, 1.6, P.woodDark);
    b.box(0, 0.35, -0.75, 2.4, 1.6, 0.1, 0x6e2a33);
    [[-1.15, -0.75], [1.15, -0.75], [-1.15, 0.75], [1.15, 0.75]].forEach(function (q) { b.box(q[0], 0.35, q[1], 0.08, 1.6, 0.08, P.woodDark); });
    b.gable(0, 1.95, 0, 2.7, 0.55, 1.9, P.red, { snow: true });
    for (var i = 0; i < 10; i++) b.bulb(-1.15 + i * 0.255, 1.88, 0.8, PARTY[i % PARTY.length]);
    person(c, -0.45, 0.1, { y: 0.35, ry: 0, col: 0x384556 });
    person(c, 0.45, -0.1, { y: 0.35, ry: 0, col: P.red });
    b.box(0.6, 0.35, 0.05, 0.3, 0.25, 0.2, 0x2a2a2a);
    b.halo(0, 1.4, 0.4, 0xffe2b0, 1.0);
    b.pool(0, 1.4, 1.8, 0xffe2b0, 0.7);
    b.pop();
  };

  FEATURES.nativity = function (c, s) {
    var b = c.b, ry = faceFront(c, s), Wd = 0x7a5034;
    b.push(s.x, 0, s.z, ry);
    b.box(0, 0, 0, 1.7, 0.05, 1.3, P.straw);
    b.box(0, 0, -0.6, 1.6, 1.1, 0.1, Wd);
    b.box(-0.78, 0, -0.1, 0.08, 1.1, 1.1, Wd); b.box(0.78, 0, -0.1, 0.08, 1.1, 1.1, Wd);
    b.gable(0, 1.1, -0.05, 1.9, 0.6, 1.5, 0x5f3c26, { snow: true });
    b.box(0, 0.05, 0.05, 0.36, 0.16, 0.22, P.woodLight);
    b.box(0, 0.21, 0.05, 0.3, 0.03, 0.16, 0xffe7a0, { layer: 'glow' });
    person(c, -0.38, 0.0, { y: 0.05, ry: 0.4, col: 0x3f63a8, s: 0.9 });
    person(c, 0.4, -0.05, { y: 0.05, ry: -0.4, col: 0x6b4a33, s: 1.0 });
    b.box(0.5, 0.05, -0.4, 0.38, 0.22, 0.18, 0x8a6a4a); b.box(0.72, 0.15, -0.4, 0.12, 0.12, 0.12, 0x8a6a4a);
    b.box(-0.52, 0.05, -0.38, 0.32, 0.2, 0.16, 0x9a9590); b.box(-0.7, 0.14, -0.38, 0.1, 0.12, 0.1, 0x9a9590);
    b.shape('star', 0, 1.9, 0.3, 0.32, 0xffe27a, {});
    b.halo(0, 2.0, 0.3, 0xffe27a, 0.9);
    b.halo(0, 0.4, 0.2, P.warm, 0.6);
    b.pool(0, 0.4, 1.3, P.warm, 0.7);
    b.pop();
  };

  FEATURES['fire-pits'] = function (c, s) {
    var b = c.b;
    for (var i = 0; i < 3; i++) {
      var a = i / 3 * TAU + 0.4, x = s.x + Math.sin(a) * 0.6, z = s.z + Math.cos(a) * 0.6;
      b.cyl(x, 0, z, 0.06, 0.18, P.iron, { seg: 5 });
      b.cyl(x, 0.18, z, 0.26, 0.14, P.iron, { seg: 8, top: 1.25 });
      b.cone(x, 0.3, z, 0.2, 0.32, 0xff8a2a, { seg: 5, layer: 'glow' });
      b.cone(x, 0.3, z, 0.11, 0.42, 0xffd34a, { seg: 5, layer: 'glow', ry: 0.6 });
      b.halo(x, 0.55, z, 0xff8a2a, 1.0);
      b.pool(x, z, 1.0, 0xff8a3a, 0.9);
    }
    for (i = 0; i < 3; i++) { var a2 = i / 3 * TAU + 1.45; person(c, s.x + Math.sin(a2) * 1.0, s.z + Math.cos(a2) * 1.0, { ry: a2 + PI }); }
  };

  FEATURES.animals = function (c, s, hw, hd) {
    var b = c.b, rng = c.rng, ov = c.override.animals;
    var cx = ov ? ov.x : s.x, cz = ov ? ov.z : s.z, rx = ov ? ov.rx : hw - 0.25, rz = ov ? ov.rz : hd - 0.25, y0 = ov ? 0.29 : 0.04;
    if (!ov) {
      b.box(cx, 0, cz, hw * 2 - 0.1, 0.04, hd * 2 - 0.1, P.straw);
      var x0 = cx - hw + 0.05, x1 = cx + hw - 0.05, z0 = cz - hd + 0.05, z1 = cz + hd - 0.05;
      [[x0, z0, x1, z0], [x1, z0, x1, z1], [x0, z1, x1, z1], [x0, z0, x0, z1]].forEach(function (e) {
        var l = Math.hypot(e[2] - e[0], e[3] - e[1]), n = Math.round(l / 0.5);
        for (var i = 0; i <= n; i++) b.box(e[0] + (e[2] - e[0]) * i / n, 0, e[1] + (e[3] - e[1]) * i / n, 0.06, 0.4, 0.06, P.woodDark);
        b.beam([e[0], 0.32, e[1]], [e[2], 0.32, e[3]], 0.035, P.wood);
        b.beam([e[0], 0.16, e[1]], [e[2], 0.16, e[3]], 0.035, P.wood);
      });
      b.box(cx + hw - 0.5, 0.04, cz - hd + 0.4, 0.5, 0.3, 0.35, 0xd0aa4e);
    }
    var n = ov ? 7 : 3;
    for (var i = 0; i < n; i++) {
      var a = rng.range(0, TAU), rr = Math.sqrt(rng.next()) * 0.8;
      var x = cx + Math.sin(a) * rx * rr, z = cz + Math.cos(a) * rz * rr, ry = rng.range(0, TAU);
      var goat = i % 3 === 2, col = goat ? 0x8a6a4a : 0xf1ece2;
      b.push(x, y0, z, ry);
      b.ico(0, 0.22, 0, 0.17, col, { sx: 0.9, sz: 1.35 });
      b.box(0, 0.24, 0.24, 0.1, 0.12, 0.14, goat ? 0x6b4a33 : 0x3a3330);
      [[-0.07, -0.12], [0.07, -0.12], [-0.07, 0.12], [0.07, 0.12]].forEach(function (q) { b.box(q[0], 0, q[1], 0.035, 0.12, 0.035, 0x3a3330); });
      if (goat) { b.cone(-0.03, 0.34, 0.24, 0.02, 0.1, 0xddd0b0, { seg: 3 }); b.cone(0.03, 0.34, 0.24, 0.02, 0.1, 0xddd0b0, { seg: 3 }); }
      b.pop();
    }
    if (ov) {
      b.box(cx + rx - 0.6, y0, cz - rz * 0.4, 0.9, 0.7, 0.6, P.woodDark);
      b.gable(cx + rx - 0.6, y0 + 0.7, cz - rz * 0.4, 1.0, 0.35, 0.8, P.wood, { snow: true });
      b.arch(cx + rx - 0.6, y0, cz - rz * 0.4 + 0.312, 0.35, 0.45, P.warm, { layer: 'glow', shape: 'r' });
    }
    b.pool(cx, cz, Math.max(rx, rz) * 0.9, P.warm, 0.35);
  };

  FEATURES['light-trees'] = function (c, s) {
    bareTree(c, s.x, s.z, c.rng.range(0.95, 1.15), { lights: true, hearts: c.cfg.landmark === 'rathaus' || c.rng.chance(0.4) });
  };

  FEATURES['punch-pavilion'] = function (c, s) {
    var b = c.b, x = s.x, z = s.z;
    b.cyl(x, 0, z, 0.82, 0.32, P.woodDark, { seg: 10 });
    b.cyl(x, 0.32, z, 0.8, 0.42, P.warm, { seg: 10, layer: 'glow' });
    b.cyl(x, 0.3, z, 0.92, 0.06, P.woodLight, { seg: 10 });
    b.cyl(x, 0.74, z, 0.82, 0.24, P.red, { seg: 10 });
    b.raw(PR.cone(10, true), function (tri) { return tri % 4 < 2 ? P.red : P.white; }, M(x, 0.98, z, 0, 0, 0, 1.05, 0.65, 1.05));
    b.cone(x, 1.33, z, 0.4, 0.3, P.snow, { seg: 10 });
    b.sph(x, 1.68, z, 0.07, P.gold);
    for (var i = 0; i < 14; i++) { var a = i / 14 * TAU; b.bulb(x + Math.sin(a) * 1.02, 0.96, z + Math.cos(a) * 1.02, i % 2 ? 0xfff0c8 : 0xff7a7a); }
    b.halo(x, 0.6, z, P.warm, 1.0);
    b.pool(x, z, 1.8, P.warm, 0.9);
    for (i = 0; i < 2; i++) { var a2 = i * 2.6 + 0.6; person(c, x + Math.sin(a2) * 1.15, z + Math.cos(a2) * 1.15, { ry: a2 + PI }); }
  };

  FEATURES.train = function (c, s, hw, hd) {
    var b = c.b, rx = hw - 0.25, rz = hd - 0.25;
    b.torus(s.x, 0.03, s.z, rx, 0.06, 0x5a5048, { seg: 32, rx: HALF, sy: rz / rx });
    b.torus(s.x, 0.03, s.z, rx, 0.11, 0x8a7a6a, { seg: 32, rx: HALF, sy: rz / rx, sz: 0.25 });
    b.cyl(s.x, 0, s.z, rx - 0.6, 0.04, 0xe6ebf1, { seg: 16, sz: (rz - 0.6) / (rx - 0.6), noAO: true });
    conifer(c, s.x, s.z, 0.6, { lights: true });
    var cars = [];
    [0, 1, 2].forEach(function (k) {
      var g = c.dyn(function (sb) {
        if (k === 0) {
          sb.box(0, 0.05, 0, 0.26, 0.2, 0.42, P.red);
          sb.cyl(0, 0.25, 0.08, 0.09, 0.08, 0x2c2e35, { seg: 6, rx: HALF });
          sb.cyl(0, 0.25, 0.14, 0.05, 0.16, 0x2c2e35, { seg: 6 });
          sb.box(0, 0.25, -0.12, 0.26, 0.22, 0.18, P.red);
          sb.box(0, 0.47, -0.12, 0.3, 0.04, 0.24, 0x2c2e35);
          sb.quad(0, 0.32, -0.21 + 0.42, 0.12, 0.06, 0xfff0c8, { layer: 'glow' });
          sb.bulb(0, 0.15, 0.23, 0xfff0c8);
        } else {
          sb.box(0, 0.05, 0, 0.26, 0.16, 0.34, k === 1 ? 0x2f5f8a : 0x3d7a52);
          sb.ico(0, 0.28, 0, 0.06, P.skin);
          sb.cone(0, 0.18, 0, 0.07, 0.12, COATS[k + 2], { seg: 5 });
        }
        sb.cyl(-0.13, 0.05, 0.1, 0.05, 0.03, 0x2c2e35, { seg: 6, rz: HALF });
        sb.cyl(-0.13, 0.05, -0.1, 0.05, 0.03, 0x2c2e35, { seg: 6, rz: HALF });
        sb.cyl(0.16, 0.05, 0.1, 0.05, 0.03, 0x2c2e35, { seg: 6, rz: HALF });
        sb.cyl(0.16, 0.05, -0.1, 0.05, 0.03, 0x2c2e35, { seg: 6, rz: HALF });
      });
      c.scene.add(g); cars.push(g);
    });
    c.anim(function (t) {
      for (var k = 0; k < 3; k++) {
        var a = t * 0.35 - k * 0.42 / Math.max(rx, rz) * 1.2;
        var x = s.x + Math.sin(a) * rx, z = s.z + Math.cos(a) * rz;
        var dx = Math.cos(a) * rx, dz = -Math.sin(a) * rz;
        cars[k].position.set(x, 0.0, z);
        cars[k].rotation.y = Math.atan2(dx, dz);
      }
    });
  };

  /* ========================================================= build scene */

  var PRESETS = {
    rathaus: { layout: 'square', stalls: 14, features: ['ice-rink', 'big-tree', 'arch', 'light-trees'] },
    stephansdom: { layout: 'square', stalls: 10, features: ['big-tree', 'punch-pavilion'] },
    'am-hof': { layout: 'square', stalls: 10, features: ['big-tree', 'fire-pits'] },
    freyung: { layout: 'square', stalls: 10, features: ['big-tree', 'nativity', 'stage'] },
    michaelertor: { layout: 'square', stalls: 10, features: ['big-tree', 'punch-pavilion'] },
    'museums-twin': { layout: 'square', stalls: 14, features: ['big-tree', 'carousel', 'punch-pavilion'] },
    mq: { layout: 'square', stalls: 8, features: ['punch-pavilion', 'light-trees', 'fire-pits'] },
    karlskirche: { layout: 'square', stalls: 12, features: ['animals', 'big-tree', 'fire-pits', 'stage'] },
    spittelberg: { layout: 'alley', stalls: 12, features: ['light-trees'] },
    'altes-akh': { layout: 'courtyard', stalls: 12, features: ['curling', 'punch-pavilion', 'light-trees'] },
    belvedere: { layout: 'square', stalls: 12, features: ['big-tree', 'light-trees', 'arch'] },
    schoenbrunn: { layout: 'forecourt', stalls: 12, features: ['big-tree', 'ice-rink', 'ferris-wheel'] },
    riesenrad: { layout: 'square', stalls: 10, features: ['carousel', 'big-tree'] },
    park: { layout: 'park', stalls: 10, features: ['fire-pits', 'nativity', 'punch-pavilion', 'animals'] },
    fountain: { layout: 'square', stalls: 10, features: ['big-tree', 'punch-pavilion'] },
    greenhouse: { layout: 'square', stalls: 8, features: ['animals', 'train', 'fire-pits'] },
    generic: { layout: 'square', stalls: 8, features: ['big-tree'] }
  };

  function normConfig(market) {
    var d = (market && market.diorama) || {};
    var lm = LANDMARKS[d.landmark] ? d.landmark : 'generic';
    var pre = PRESETS[lm];
    var layout = LAYOUTS[d.layout] ? d.layout : (d.landmark && LANDMARKS[d.landmark] ? pre.layout : 'square');
    var stalls = Math.round(Number(d.stalls));
    if (!isFinite(stalls) || stalls <= 0) stalls = market && market.diorama ? pre.stalls : 8;
    stalls = clamp(stalls, 6, 18);
    var feats = Array.isArray(d.features) ? d.features.filter(function (f, i, a) { return FDEF[f] && a.indexOf(f) === i; }) : [];
    return { landmark: lm, layout: layout, stalls: stalls, features: feats };
  }

  function insideBoard(x, z, m) {
    var h = BOARD - m, cr = CORNER - m;
    var ax = Math.abs(x), az = Math.abs(z);
    if (ax > h || az > h) return false;
    var qx = ax - (BOARD - CORNER), qz = az - (BOARD - CORNER);
    if (qx > 0 && qz > 0) return qx * qx + qz * qz <= cr * cr;
    return true;
  }

  function makeContext(market, cfg, rng, mats, scene) {
    var c = {
      market: market, cfg: cfg, rng: rng, mats: mats, scene: scene,
      b: new Builder(rng), obs: [], spots: [], anims: [], post: [], textures: [], override: {},
      center: [0, 2.2], ring: null, stallStyle: null, mounds: null, treeMode: null, noEdgeTrees: false
    };
    c.hasFeature = function (k) { return cfg.features.indexOf(k) >= 0; };
    c.block = function (x0, x1, z0, z1, kind) { c.obs.push({ r: false, x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0: Math.min(z0, z1), z1: Math.max(z0, z1), kind: kind || 'all' }); };
    c.blockC = function (x, z, r, kind) { c.obs.push({ r: r, x: x, z: z, kind: kind || 'all' }); };
    // kind filter: 'stall' obstacles only block stalls/features; 'soft' block everything except people
    function hits(o, x0, x1, z0, z1, cx, cz, cr, who) {
      if (o.kind === 'stall' && who === 'deco') return false;
      if (o.kind === 'soft' && who === 'person') return false;
      if (cr != null) {
        if (o.r) return Math.hypot(o.x - cx, o.z - cz) < o.r + cr;
        var dx = Math.max(o.x0 - cx, 0, cx - o.x1), dz = Math.max(o.z0 - cz, 0, cz - o.z1);
        return dx * dx + dz * dz < cr * cr;
      }
      if (o.r) {
        var ex = Math.max(x0 - o.x, 0, o.x - x1), ez = Math.max(z0 - o.z, 0, o.z - z1);
        return ex * ex + ez * ez < o.r * o.r;
      }
      return x0 < o.x1 && x1 > o.x0 && z0 < o.z1 && z1 > o.z0;
    }
    c.fits = function (x, z, r, who) {
      if (!insideBoard(x, z, r + 0.25)) return false;
      for (var i = 0; i < c.obs.length; i++) if (hits(c.obs[i], 0, 0, 0, 0, x, z, r, who)) return false;
      return true;
    };
    c.fitsRect = function (x0, x1, z0, z1, who) {
      if (!insideBoard(x0, z0, 0.25) || !insideBoard(x1, z0, 0.25) || !insideBoard(x0, z1, 0.25) || !insideBoard(x1, z1, 0.25)) return false;
      for (var i = 0; i < c.obs.length; i++) if (hits(c.obs[i], x0, x1, z0, z1, null, null, null, who)) return false;
      return true;
    };
    c.groundY = function (x, z) {
      if (!c.mounds) return 0;
      var y = 0;
      for (var i = 0; i < c.mounds.length; i++) {
        var m = c.mounds[i], d = Math.hypot(x - m.x, z - m.z) / m.r;
        if (d < 1) y = Math.max(y, m.h * Math.sqrt(1 - d * d) - 0.06);
      }
      return y;
    };
    c.anim = function (fn) { c.anims.push(fn); };
    c.dyn = function (fn) {
      var sb = new Builder(rng);
      fn(sb);
      var g = new THREE.Group();
      sb.build(mats, g);
      return g;
    };
    return c;
  }

  function buildBoard(c) {
    var b = c.b;
    function rr(h, r) {
      var s = new THREE.Shape();
      s.moveTo(-h + r, -h); s.lineTo(h - r, -h); s.absarc(h - r, -h + r, r, -HALF, 0, false);
      s.lineTo(h, h - r); s.absarc(h - r, h - r, r, 0, HALF, false);
      s.lineTo(-h + r, h); s.absarc(-h + r, h - r, r, HALF, PI, false);
      s.lineTo(-h, -h + r); s.absarc(-h + r, -h + r, r, PI, PI * 1.5, false);
      return s;
    }
    var plinth = new THREE.ExtrudeGeometry(rr(BOARD - 0.15, CORNER - 0.15), { depth: 0.85, bevelEnabled: false, curveSegments: 4 }).rotateX(-HALF).translate(0, -1.08, 0);
    b.geoArr(fromGeo(plinth), P.plinth, new THREE.Matrix4(), 'solid');
    var lip = new THREE.ExtrudeGeometry(rr(BOARD - 0.1, CORNER - 0.1), { depth: 0.06, bevelEnabled: false, curveSegments: 4 }).rotateX(-HALF).translate(0, -0.29, 0);
    b.geoArr(fromGeo(lip), P.plinthTop, new THREE.Matrix4(), 'solid');
    var snow = new THREE.ExtrudeGeometry(rr(BOARD - 0.12, CORNER - 0.12), { depth: 0.12, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.12, bevelSegments: 1, curveSegments: 4 }).rotateX(-HALF).translate(0, -0.2, 0);
    b.raw(fromGeo(snow), P.snow, new THREE.Matrix4(), 'solid', true);
  }

  function placeFeature(c, key) {
    var def = FDEF[key], count = def.multi || 1, done = 0;
    for (var n = 0; n < count; n++) {
      var spot = null, hw = 0, hd = 0;
      var ov = key === 'animals' && c.override.animals;
      if (ov) { FEATURES[key](c, { x: ov.x, z: ov.z }, 0, 0); return; }
      for (var ti = 0; ti < def.tags.length && !spot; ti++) {
        for (var si = 0; si < c.spots.length; si++) {
          var s = c.spots[si];
          if (s.used || s.t.indexOf(def.tags[ti]) < 0) continue;
          var sz = def.size(s);
          if (c.fitsRect(s.x - sz[0], s.x + sz[0], s.z - sz[1], s.z + sz[1])) { spot = s; hw = sz[0]; hd = sz[1]; break; }
        }
      }
      if (!spot) {
        var sz2 = def.size({});
        for (var t = 0; t < 120; t++) {
          var w = c.walk[Math.floor(c.rng.next() * c.walk.length)];
          var x = c.rng.range(w[0], w[1]), z = c.rng.range(w[2], w[3]);
          if (key !== 'arch' && c.fitsRect(x - sz2[0], x + sz2[0], z - sz2[1], z + sz2[1])) { spot = { x: x, z: z, t: [] }; hw = sz2[0]; hd = sz2[1]; break; }
        }
      }
      if (!spot) continue;
      spot.used = true;
      c.block(spot.x - hw, spot.x + hw, spot.z - hd, spot.z + hd);
      FEATURES[key](c, spot, hw, hd);
      done++;
    }
    return done;
  }

  function stallBox(s) {
    var ca = Math.abs(Math.cos(s.ry)), sa = Math.abs(Math.sin(s.ry)), hw = 0.7 * STALL_SCALE, hd = 0.56 * STALL_SCALE;
    return [hw * ca + hd * sa, hw * sa + hd * ca];
  }

  function buildScene(c) {
    var cfg = c.cfg, b = c.b, rng = c.rng;
    buildBoard(c);
    LANDMARKS[cfg.landmark](c);
    var L = LAYOUTS[c.layoutOverride || cfg.layout](c);
    c.spots = L.spots;
    c.walk = L.walk.length ? L.walk : [sq(-8, 8, -3, 9)];

    // features, biggest first
    cfg.features.slice().sort(function (a, b2) { return FDEF[a].order - FDEF[b2].order; }).forEach(function (k) { placeFeature(c, k); });

    // stalls
    var styleKeys = c.stallStyle ? [c.stallStyle] : rng.chance(0.5) ? ['red', 'wood', 'red', 'light'] : ['red', 'green', 'wood', 'red'];
    var slots = L.slots.filter(c.slotFilter || function () { return true; }).sort(function (a, b2) { return a.pri - b2.pri; });
    var placed = [];
    for (var i = 0; i < slots.length && placed.length < cfg.stalls; i++) {
      var s = slots[i], e = stallBox(s);
      var axis = Math.abs(Math.sin(2 * s.ry)) < 0.05;
      if (axis) {
        if (!c.fitsRect(s.x - e[0], s.x + e[0], s.z - e[1], s.z + e[1])) continue;
        c.block(s.x - e[0], s.x + e[0], s.z - e[1], s.z + e[1]);
      } else {
        if (!c.fits(s.x, s.z, 0.8)) continue;
        c.blockC(s.x, s.z, 0.8);
      }
      placed.push(s);
    }
    c.placedStalls = placed.length;
    placed.forEach(function (s, k) { stall(c, s.x, s.z, s.ry, STALL_STYLES[styleKeys[k % styleKeys.length]]); });
    // garlands along each row of stalls (front eaves)
    var rows = {};
    placed.forEach(function (s) { (rows[s.row] = rows[s.row] || []).push(s); });
    Object.keys(rows).forEach(function (r) {
      var row = rows[r].sort(function (a, b2) { return a.along - b2.along; });
      for (var j = 0; j < row.length; j++) {
        var s = row[j];
        var SS = STALL_SCALE, fx = Math.sin(s.ry) * 0.62 * SS, fz = Math.cos(s.ry) * 0.62 * SS, tx = Math.cos(s.ry) * 0.72 * SS, tz = -Math.sin(s.ry) * 0.72 * SS;
        var A = [s.x + fx - tx, 0.96 * SS, s.z + fz - tz], B = [s.x + fx + tx, 0.96 * SS, s.z + fz + tz];
        b.string(A, B, { sag: 0.06, n: 5, ends: true, noWire: true });
        var nx = row[j + 1];
        if (nx && !s.ring && Math.hypot(nx.x - s.x, nx.z - s.z) < 2.0) {
          var fx2 = Math.sin(nx.ry) * 0.62 * SS, fz2 = Math.cos(nx.ry) * 0.62 * SS, tx2 = Math.cos(nx.ry) * 0.72 * SS, tz2 = -Math.sin(nx.ry) * 0.72 * SS;
          var C1 = [nx.x + fx2 - tx2, 0.96 * SS, nx.z + fz2 - tz2], C2 = [nx.x + fx2 + tx2, 0.96 * SS, nx.z + fz2 + tz2];
          var dA = Math.hypot(C1[0] - B[0], C1[2] - B[2]), dB = Math.hypot(C2[0] - B[0], C2[2] - B[2]);
          b.string(B, dA < dB ? C1 : C2, { sag: 0.1, n: 2 });
        }
      }
    });

    c.post.forEach(function (fn) { fn(); });

    // lamps + strings of lights between them
    var lampTops = [];
    (L.lamps || []).forEach(function (chain, ci) {
      var prev = null;
      lampTops[ci] = [];
      chain.forEach(function (p, pi) {
        if (!c.fits(p[0], p[1], 0.22, 'deco')) { prev = null; lampTops[ci][pi] = null; return; }
        var top = lamp(c, p[0], p[1]);
        c.blockC(p[0], p[1], 0.22);
        lampTops[ci][pi] = top;
        if (prev && Math.hypot(prev[0] - top[0], prev[2] - top[2]) < 5) b.string(prev, top, { sag: 0.35 });
        prev = top;
      });
    });
    if (L.cross && lampTops[0] && lampTops[1]) {
      for (i = 0; i < lampTops[0].length; i++) if (lampTops[0][i] && lampTops[1][i]) b.string(lampTops[0][i], lampTops[1][i], { sag: 0.3, cols: PARTY });
    }
    // trees
    if (c.treeMode === 'park') {
      var nT = 0;
      for (var t = 0; t < 400 && nT < 30; t++) {
        var x = rng.range(-9.3, 9.3), z = rng.range(-9.3, 9.3);
        if (z > 5.5 && Math.abs(x - 1) < 4.5) continue;
        var sc = rng.range(0.8, 1.35);
        if (!c.fits(x, z, 0.55 * sc, 'deco')) continue;
        if (rng.chance(0.68)) conifer(c, x, z, sc, { y: c.groundY(x, z) });
        else bareTree(c, x, z, sc * 0.95, { y: c.groundY(x, z), lights: rng.chance(0.35) });
        c.blockC(x, z, 0.5 * sc);
        nT++;
      }
    } else if (!c.noEdgeTrees) {
      var cand = [];
      for (z = -9.0; z <= 8.6; z += 1.25) { cand.push([-9.0, z]); cand.push([9.0, z]); }
      for (x = -7.8; x <= 7.8; x += 1.3) cand.push([x, -9.1]);
      var nE = 0;
      cand.forEach(function (p) {
        if (nE > 18) return;
        var sc = rng.range(0.75, 1.2);
        if (p[1] > 5 && Math.abs(p[0]) < 8) return;
        if (!rng.chance(0.7) || !c.fits(p[0], p[1], 0.5 * sc, 'deco')) return;
        if (c.edgeBare && p[1] > -7) bareTree(c, p[0], p[1], sc * 1.1, { lights: true, hearts: rng.chance(0.5) });
        else conifer(c, p[0], p[1], sc, { lights: rng.chance(0.12) });
        c.blockC(p[0], p[1], 0.5 * sc);
        nE++;
      });
    }
    // people
    var nP = clamp(Math.round(9 + cfg.stalls * 0.75), 10, 22), pp = 0;
    for (t = 0; t < 300 && pp < nP; t++) {
      var w = c.walk[Math.floor(rng.next() * c.walk.length)];
      x = rng.range(w[0], w[1]); z = rng.range(w[2], w[3]);
      if (!c.fits(x, z, 0.2, 'person')) continue;
      person(c, x, z);
      c.blockC(x, z, 0.22);
      pp++;
    }
    // little snow drifts
    for (t = 0, pp = 0; t < 60 && pp < 8; t++) {
      x = rng.range(-9.4, 9.4); z = rng.range(-9.4, 9.4);
      if (!c.fits(x, z, 0.4, 'deco')) continue;
      b.ico(x, -0.08, z, rng.range(0.25, 0.45), P.snow, { sy: 0.45, ry: rng.range(0, TAU) });
      pp++;
    }
  }

  /* ================================================================ mount */

  var _supported = null;
  function isSupported() {
    if (_supported !== null) return _supported;
    try {
      if (!THREE || !THREE.WebGLRenderer) return (_supported = false);
      var cv = document.createElement('canvas');
      var gl = cv.getContext('webgl2') || cv.getContext('webgl') || cv.getContext('experimental-webgl');
      _supported = !!gl;
      if (gl) { var ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); }
    } catch (e) { _supported = false; }
    return _supported;
  }

  var THEMES = {
    dark: {
      hemiSky: 0x7c8fd6, hemiGround: 0x232a44, hemi: 1.9,
      moon: 0xaebcff, moonI: 1.1, moonPos: [-10, 16, 6],
      fill: 0xffb877, fillI: 1.05, fillPos: [3, 4, 14],
      point: 0xffb062, pointI: 26,
      glow: 1.0, win: true, bulb: 1.0, halo: 0.55, pool: 0.6, snowOp: 0.9,
      under: 0x9db5ff, underOp: 0.28, underBlend: THREE.AdditiveBlending,
      wire: 0x0e0d12
    },
    light: {
      hemiSky: 0xf4f7ff, hemiGround: 0x9aa3b6, hemi: 2.25,
      moon: 0xfffaf0, moonI: 1.9, moonPos: [-9, 15, 7],
      fill: 0xfff1e0, fillI: 0.55, fillPos: [4, 5, 14],
      point: 0xffb062, pointI: 0,
      glow: 0.92, win: false, bulb: 0.75, halo: 0.25, pool: 0.18, snowOp: 0.95,
      under: 0x1d2433, underOp: 0.22, underBlend: THREE.NormalBlending,
      wire: 0x3a3632
    }
  };

  function mount(container, market, opts) {
    opts = opts || {};
    var noop = { dispose: function () {}, setTheme: function () {} };
    if (!container || !THREE) return noop;
    market = market || {};
    var theme = opts.theme === 'light' ? 'light' : 'dark';
    var reduced = opts.reducedMotion != null ? !!opts.reducedMotion : !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    var still = !!opts.still;
    var animate = !reduced && !still;
    var wantRotate = opts.autoRotate !== false && animate;

    var wrap = document.createElement('div');
    wrap.className = 'diorama';
    wrap.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    var label = 'Stylised 3D model of ' + (market.name || 'a Christmas market') + (market.location ? ' at ' + market.location : '');
    canvas.setAttribute('aria-label', label);
    canvas.style.cssText = 'display:block;width:100%;height:100%;outline:none;cursor:grab;';
    wrap.appendChild(canvas);
    container.appendChild(wrap);

    var renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true, powerPreference: 'low-power', preserveDrawingBuffer: still });
    } catch (err) {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      return noop;
    }
    renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(30, 1.6, 1, 300);
    var tex = makeTextures();
    var mats = {
      solid: new THREE.MeshLambertMaterial({ vertexColors: true }),
      glow: new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
      win: new THREE.MeshBasicMaterial({ vertexColors: true }),
      water: new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 90, specular: 0x7f8fa8 }),
      ice: new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 60, specular: 0x667788 }),
      glass: new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide, emissive: 0x334433 }),
      bulb: new THREE.PointsMaterial({ size: 0.34, map: tex.dot, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      halo: new THREE.PointsMaterial({ size: 2.4, map: tex.halo, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      pool: new THREE.MeshBasicMaterial({ map: tex.pool, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      wire: new THREE.LineBasicMaterial({ color: 0x0e0d12, transparent: true, opacity: 0.6 })
    };

    var cfg = normConfig(market);
    var seed = hashStr(String(market.id || '') + '|' + cfg.landmark + '|' + cfg.layout + '|' + cfg.features.join(','));
    var rng = makeRng(seed);
    var root = new THREE.Group();
    scene.add(root);
    var c = makeContext(market, cfg, rng, mats, root);
    try { buildScene(c); } catch (err) { if (global.console) console.error('[Diorama] build failed', err); }
    c.b.build(mats, root);

    // underglow / soft shadow beneath the board
    var under = new THREE.Mesh(new THREE.PlaneGeometry(36, 36).rotateX(-HALF), new THREE.MeshBasicMaterial({ map: tex.under, transparent: true, depthWrite: false }));
    under.position.y = -1.15;
    under.renderOrder = -1;
    scene.add(under);

    // snow
    var snowN = 320, snowPos = new Float32Array(snowN * 3), snowPh = new Float32Array(snowN);
    for (var i = 0; i < snowN; i++) {
      snowPos[i * 3] = rng.range(-11, 11); snowPos[i * 3 + 1] = rng.range(0, 14); snowPos[i * 3 + 2] = rng.range(-11, 11);
      snowPh[i] = rng.range(0, TAU);
    }
    var snowGeo = new THREE.BufferGeometry();
    snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
    var snowMat = new THREE.PointsMaterial({ size: 0.2, map: tex.flake, color: 0xffffff, transparent: true, depthWrite: false });
    var snowPts = new THREE.Points(snowGeo, snowMat);
    snowPts.renderOrder = 8;
    scene.add(snowPts);
    if (animate) c.anim(function (t, dt) {
      for (var i = 0; i < snowN; i++) {
        var k = i * 3;
        snowPos[k + 1] -= dt * (0.55 + (i % 7) * 0.06);
        snowPos[k] += Math.sin(t * 0.7 + snowPh[i]) * dt * 0.25;
        if (snowPos[k + 1] < -0.2) { snowPos[k + 1] = 13 + (i % 5) * 0.2; }
      }
      snowGeo.attributes.position.needsUpdate = true;
    });

    // lights
    var hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    var moon = new THREE.DirectionalLight(0xffffff, 1);
    var fill = new THREE.DirectionalLight(0xffffff, 1);
    var point = new THREE.PointLight(0xffb062, 1, 16, 1.4);
    point.position.set(c.center[0], 2.6, c.center[1] + 1);
    scene.add(hemi, moon, fill, point);

    // tall vertices for camera framing
    var fitPts = [];
    root.updateMatrixWorld(true);
    root.traverse(function (o) {
      if (!o.isMesh || !o.geometry) return;
      var pa = o.geometry.attributes.position.array;
      var stepV = Math.max(1, Math.floor(pa.length / 3 / 600));
      for (var j = 0; j < pa.length; j += 3 * stepV) {
        var wv = new THREE.Vector3(pa[j], pa[j + 1], pa[j + 2]).applyMatrix4(o.matrixWorld);
        if (o.isInstancedMesh) wv.y += 0.5;
        if (wv.y > 1.2) fitPts.push(wv);
      }
    });
    for (i = 0; i < 24; i++) {
      var a = i / 24 * TAU, sx = Math.sign(Math.cos(a)), sz = Math.sign(Math.sin(a));
      var px = clamp(Math.cos(a) * 14, -BOARD, BOARD), pz = clamp(Math.sin(a) * 14, -BOARD, BOARD);
      if (Math.abs(px) > BOARD - CORNER && Math.abs(pz) > BOARD - CORNER) {
        var ca = Math.atan2(Math.abs(pz) - (BOARD - CORNER), Math.abs(px) - (BOARD - CORNER));
        px = sx * (BOARD - CORNER + Math.cos(ca) * CORNER); pz = sz * (BOARD - CORNER + Math.sin(ca) * CORNER);
      }
      fitPts.push(new THREE.Vector3(px, 0, pz), new THREE.Vector3(px, -1.08, pz));
    }

    var controls = new THREE.OrbitControls(camera, canvas);
    canvas.style.touchAction = 'pan-y';
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.enableZoom = true;
    controls.rotateSpeed = 0.6;
    controls.minPolarAngle = 0.42;
    controls.maxPolarAngle = 1.32;
    controls.autoRotate = wantRotate;
    controls.autoRotateSpeed = 0.5;
    controls.zoomToCursor = false;

    var AZ0 = c.az0 == null ? 0.52 : c.az0, POL0 = c.pol0 || 1.02, fitD = 40, zoomF = 1;
    function frame(az, pol, d, ty, aspect) {
      var tanV = Math.tan(camera.fov / 2 * PI / 180), tanH = tanV * aspect;
      var dir = new THREE.Vector3(Math.sin(pol) * Math.sin(az), Math.cos(pol), Math.sin(pol) * Math.cos(az));
      var cam = new THREE.Vector3(0, ty, 0).addScaledVector(dir, d);
      var fwd = dir.clone().negate(), right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize(), up = new THREE.Vector3().crossVectors(right, fwd);
      var mx = 0, minY = 1e9, maxY = -1e9, v = new THREE.Vector3();
      for (var i = 0; i < fitPts.length; i++) {
        v.subVectors(fitPts[i], cam);
        var z = v.dot(fwd); if (z < 0.1) z = 0.1;
        var nx = Math.abs(v.dot(right) / (z * tanH)), ny = v.dot(up) / (z * tanV);
        if (nx > mx) mx = nx; if (ny < minY) minY = ny; if (ny > maxY) maxY = ny;
      }
      return { mx: mx, minY: minY, maxY: maxY, upY: up.y, tanV: tanV };
    }
    function computeFit(az, pol, aspect) {
      var ty = 2, d = 40;
      for (var it = 0; it < 3; it++) {
        var lo = 8, hi = 200;
        for (var k = 0; k < 26; k++) {
          var mid = (lo + hi) / 2, f = frame(az, pol, mid, ty, aspect);
          if (f.mx <= 0.95 && f.maxY - f.minY <= 1.84) hi = mid; else lo = mid;
        }
        d = hi;
        var fr = frame(az, pol, d, ty, aspect);
        var off = (fr.maxY + fr.minY) / 2;
        ty = clamp(ty + off * d * fr.tanV / Math.max(0.3, fr.upY), -1, 6);
      }
      return { d: d, ty: ty };
    }
    var sph = new THREE.Spherical();
    function applyFit(first) {
      var w = wrap.clientWidth, h = wrap.clientHeight;
      if (!w || !h) return false;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      var az = AZ0, pol = POL0;
      if (!first) {
        sph.setFromVector3(camera.position.clone().sub(controls.target));
        zoomF = sph.radius / fitD;
      }
      var f = computeFit(AZ0, POL0, w / h);
      if (!first) { az = sph.theta; pol = sph.phi; }
      fitD = f.d;
      controls.target.set(0, f.ty, 0);
      controls.minDistance = f.d * 0.55;
      controls.maxDistance = f.d * 1.3;
      var dist = clamp(f.d * zoomF, controls.minDistance, controls.maxDistance);
      camera.position.set(Math.sin(pol) * Math.sin(az) * dist, f.ty + Math.cos(pol) * dist, Math.sin(pol) * Math.cos(az) * dist);
      camera.lookAt(controls.target);
      controls.update();
      dirty = true;
      return true;
    }

    // zoom buttons (wheel zoom is disabled so the page keeps scrolling)
    var btnBox = document.createElement('div');
    btnBox.style.cssText = 'position:absolute;right:8px;bottom:8px;display:flex;flex-direction:column;gap:6px;z-index:1;';
    var btns = [['+', 'Zoom in', 0.85], ['−', 'Zoom out', 1 / 0.85]].map(function (d) {
      var bt = document.createElement('button');
      bt.type = 'button';
      bt.textContent = d[0];
      bt.setAttribute('aria-label', d[1]);
      bt.title = d[1];
      bt.style.cssText = 'width:30px;height:30px;border-radius:50%;border:1px solid rgba(255,255,255,.25);font:600 18px/1 system-ui,sans-serif;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);';
      bt.addEventListener('click', function () { zoomBy(d[2]); });
      btnBox.appendChild(bt);
      return bt;
    });
    wrap.appendChild(btnBox);
    function zoomBy(f) {
      var off = camera.position.clone().sub(controls.target);
      var l = clamp(off.length() * f, controls.minDistance, controls.maxDistance);
      off.setLength(l);
      camera.position.copy(controls.target).add(off);
      controls.update();
      pauseRotate();
      resumeLater();
      dirty = true;
    }

    var resumeTimer = 0;
    function pauseRotate() { controls.autoRotate = false; clearTimeout(resumeTimer); }
    function resumeLater() { clearTimeout(resumeTimer); if (wantRotate) resumeTimer = setTimeout(function () { controls.autoRotate = true; }, 4000); }
    controls.addEventListener('start', pauseRotate);
    controls.addEventListener('end', resumeLater);
    controls.addEventListener('change', function () { dirty = true; });
    function onWheel(e) { e.stopPropagation(); }
    wrap.addEventListener('wheel', onWheel, { capture: true, passive: true });
    function onDown() { canvas.style.cursor = 'grabbing'; }
    function onUp() { canvas.style.cursor = 'grab'; }
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);

    function setTheme(name) {
      theme = name === 'light' ? 'light' : 'dark';
      var T = THEMES[theme];
      hemi.color.setHex(T.hemiSky); hemi.groundColor.setHex(T.hemiGround); hemi.intensity = T.hemi;
      moon.color.setHex(T.moon); moon.intensity = T.moonI; moon.position.set(T.moonPos[0], T.moonPos[1], T.moonPos[2]);
      fill.color.setHex(T.fill); fill.intensity = T.fillI; fill.position.set(T.fillPos[0], T.fillPos[1], T.fillPos[2]);
      point.color.setHex(T.point); point.intensity = T.pointI; point.visible = T.pointI > 0;
      mats.glow.color.setScalar(T.glow);
      if (mats.win.vertexColors !== T.win) { mats.win.vertexColors = T.win; mats.win.needsUpdate = true; }
      mats.win.color.setHex(T.win ? 0xffffff : 0x6d7688);
      mats.bulb.opacity = T.bulb; mats.halo.opacity = T.halo; mats.pool.opacity = T.pool;
      mats.wire.color.setHex(T.wire);
      mats.glass.emissive.setHex(theme === 'dark' ? 0x4a5a3a : 0x1a2422);
      mats.glass.opacity = theme === 'dark' ? 0.42 : 0.5;
      snowMat.opacity = T.snowOp;
      snowMat.color.setHex(theme === 'dark' ? 0xffffff : 0xf4f7fb);
      under.material.color.setHex(T.under); under.material.opacity = T.underOp; under.material.blending = T.underBlend; under.material.needsUpdate = true;
      btns.forEach(function (bt) {
        bt.style.background = theme === 'dark' ? 'rgba(20,24,40,.55)' : 'rgba(255,255,255,.75)';
        bt.style.color = theme === 'dark' ? '#f3f0e8' : '#2a2f3a';
        bt.style.borderColor = theme === 'dark' ? 'rgba(255,255,255,.22)' : 'rgba(0,0,0,.15)';
      });
      dirty = true;
    }

    var dirty = true, raf = 0, last = 0, time = 1.3, visible = true, disposed = false, fitted = false;
    // initial animation state (still frames / reduced motion)
    for (i = 0; i < c.anims.length; i++) c.anims[i](time, 0);

    function loop(now) {
      raf = 0;
      if (disposed || !visible || document.hidden) return;
      raf = requestAnimationFrame(loop);
      var dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
      last = now;
      if (!fitted) fitted = applyFit(true);
      if (!fitted) return;
      var changed = controls.update(dt);
      if (animate) {
        time += dt;
        for (var i = 0; i < c.anims.length; i++) c.anims[i](time, dt);
      }
      if (animate || changed || dirty) {
        renderer.render(scene, camera);
        dirty = false;
      }
    }
    function start() {
      if (!raf && !disposed && visible && !document.hidden) { last = 0; raf = requestAnimationFrame(loop); }
    }
    function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }
    function onVis() { if (document.hidden) stop(); else start(); }
    document.addEventListener('visibilitychange', onVis);

    var ro = null, io = null;
    if (global.ResizeObserver) {
      ro = new ResizeObserver(function () { if (fitted) applyFit(false); else fitted = applyFit(true); start(); });
      ro.observe(wrap);
    } else {
      global.addEventListener('resize', onWinResize);
    }
    function onWinResize() { if (fitted) applyFit(false); }
    if (global.IntersectionObserver) {
      io = new IntersectionObserver(function (entries) {
        visible = entries[entries.length - 1].isIntersecting;
        if (visible) start(); else stop();
      });
      io.observe(wrap);
    }

    setTheme(theme);
    fitted = applyFit(true);
    if (fitted) { controls.update(0); renderer.render(scene, camera); dirty = false; }
    start();

    function dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      clearTimeout(resumeTimer);
      document.removeEventListener('visibilitychange', onVis);
      if (ro) ro.disconnect(); else global.removeEventListener('resize', onWinResize);
      if (io) io.disconnect();
      wrap.removeEventListener('wheel', onWheel, { capture: true });
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      controls.dispose();
      var geos = new Set(), ms = new Set(), txs = new Set();
      scene.traverse(function (o) {
        if (o.geometry) geos.add(o.geometry);
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { ms.add(m); if (m.map) txs.add(m.map); });
        if (o.isInstancedMesh && o.dispose) o.dispose();
      });
      Object.keys(mats).forEach(function (k) { ms.add(mats[k]); });
      Object.keys(tex).forEach(function (k) { txs.add(tex[k]); });
      c.textures.forEach(function (t) { txs.add(t); });
      geos.forEach(function (g) { g.dispose(); });
      ms.forEach(function (m) { m.dispose(); });
      txs.forEach(function (t) { t.dispose(); });
      scene.clear();
      renderer.renderLists.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    }

    return {
      dispose: dispose,
      setTheme: setTheme,
      /* extras for the demo page */
      stats: function () { return { triangles: renderer.info.render.triangles, calls: renderer.info.render.calls, stalls: c.placedStalls, config: cfg }; }
    };
  }

  global.Diorama = {
    isSupported: isSupported,
    mount: mount,
    landmarks: Object.keys(LANDMARKS),
    layouts: Object.keys(LAYOUTS),
    features: FEATURE_KEYS,
    presets: PRESETS
  };
})(window);
