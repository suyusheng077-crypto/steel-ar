/* 鋼構件參數 → three.js 模型。單位 mm。
   座標：原點在南端、梁底、腹板中心；x 往北，y 往上，z 正面為 +。 */
(function (root) {
  'use strict';

  var COLORS = { body: 0x7fe3ff, endHoles: 0xff8a3d, stiff: 0x4aa8ff, stiffHoles: 0xff8a3d, studs: 0x5fd08a, angle: 0xc58bff, hooks: 0xffd24a, lugs: 0xff6fae };

  var LAYERS = [
    { k: 'endHoles',   n: '端部螺栓孔' },
    { k: 'stiff',      n: '加勁板' },
    { k: 'stiffHoles', n: '板上孔' },
    { k: 'studs',      n: '剪力釘' },
    { k: 'angle',      n: '角鋼' },
    { k: 'lugs',       n: '吊耳' },
    { k: 'hooks',      n: '掛勾' },
    { k: 'body',       n: '主體外框' }
  ];

  // 虛構的範例梁（對外展示用，不含任何真實工程資料）
  var DEMO = {
    name: '範例梁 DEMO-01', drawing: '範例', note: '虛構資料，僅供展示',
    section: { H: 600, B: 200, tw: 11, tf: 17, L: 6000 },
    endHoles: { dia: 22, cols: [40, 100], firstFromTop: 120, pitch: 60, rows: 7 },
    stiffeners: [
      { x: 2000, t: 12, nearW: 180, farW: 94, narrowW: 94, tabTop: 80, tabH: 280, holes: { dia: 22, z: [140], firstFromTop: 130, pitch: 60, rows: 4 } },
      { x: 4000, t: 12, nearW: 180, farW: 94, narrowW: 94, tabTop: 80, tabH: 280, holes: { dia: 22, z: [140], firstFromTop: 130, pitch: 60, rows: 4 } }
    ],
    studs: { dia: 19, len: 100, first: 100, pitch: 200, count: 30 },
    lugs: { t: 12, size: 93, hole: 40, x: [1500, 4500] }
  };

  function build(P, THREE, style) {
    var ar = style !== 'solid';
    var S = P.section, H = S.H, B = S.B, tw = S.tw, tf = S.tf, L = S.L;
    var rootG = new THREE.Group(), G = {}, present = [];
    LAYERS.forEach(function (l) { G[l.k] = new THREE.Group(); rootG.add(G[l.k]); });

    function fill(k) {
      return ar ? new THREE.MeshBasicMaterial({ color: COLORS[k], transparent: true, opacity: 0.42 })
                : new THREE.MeshLambertMaterial({ color: k === 'body' ? 0x8a929c : COLORS[k] });
    }
    function line(k) { return new THREE.LineBasicMaterial({ color: ar ? COLORS[k] : 0x20252b }); }
    var M = {}, E = {};
    LAYERS.forEach(function (l) { M[l.k] = fill(l.k); E[l.k] = line(l.k); });
    M.endHoles.opacity = M.stiffHoles.opacity = 0.75;
    var occluder = new THREE.MeshBasicMaterial({ colorWrite: false });

    function box(k, x0, x1, y0, y1, z0, z1, mat) {
      var geo = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
      var m = new THREE.Mesh(geo, mat || M[k]); m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2); G[k].add(m);
      var e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), E[k]); e.position.copy(m.position); G[k].add(e);
      return m;
    }
    function cyl(k, geo, x, y, z, axis, mat) {
      var m = new THREE.Mesh(geo, mat || M[k]);
      if (axis === 'z') m.rotation.x = Math.PI / 2;
      if (axis === 'x') m.rotation.z = Math.PI / 2;
      m.position.set(x, y, z); G[k].add(m); return m;
    }
    function rod(k, r, p0, p1) {
      var a = new THREE.Vector3(p0[0], p0[1], p0[2]), b = new THREE.Vector3(p1[0], p1[1], p1[2]);
      var d = new THREE.Vector3().subVectors(b, a), len = d.length();
      var m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 8), M[k]);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
      m.position.copy(a).add(b).multiplyScalar(0.5); G[k].add(m);
    }

    // 主體：AR 模式只畫外框，並用看不見的實體遮住背面的零件
    var bodyMat = ar ? occluder : M.body;
    [[0, tf, -B / 2, B / 2], [H - tf, H, -B / 2, B / 2], [tf, H - tf, -tw / 2, tw / 2]].forEach(function (b) {
      var m = box('body', 0, L, b[0], b[1], b[2], b[3], bodyMat);
      if (ar) { m.renderOrder = -1; rootG.add(m); }   // 遮擋體不跟著「主體外框」圖層開關
    });
    present.push('body');

    if (P.endHoles) {
      var eh = P.endHoles, g1 = new THREE.CylinderGeometry(eh.dia / 2, eh.dia / 2, tw + 24, 20);
      (eh.ends || ['S', 'N']).forEach(function (end) {
        eh.cols.forEach(function (c) {
          for (var i = 0; i < eh.rows; i++) cyl('endHoles', g1, end === 'N' ? L - c : c, H - eh.firstFromTop - eh.pitch * i, 0, 'z');
        });
      });
      present.push('endHoles');
    }

    if (P.stiffeners && P.stiffeners.length) {
      var anyHoles = false;
      P.stiffeners.forEach(function (s) {
        var ph = s.plateH || (H - 2 * tf - 2), py0 = (H - ph) / 2, py1 = py0 + ph;
        var nw = s.narrowW || Math.min(s.nearW, (B - tw) / 2 - 10);
        var x0 = s.x - s.t / 2, x1 = s.x + s.t / 2;
        box('stiff', x0, x1, py0, py1, tw / 2, tw / 2 + nw);
        if (s.nearW > nw) { var ty1 = H - (s.tabTop || tf), ty0 = ty1 - (s.tabH || ph); box('stiff', x0, x1, ty0, ty1, tw / 2 + nw, tw / 2 + s.nearW); }
        if (s.farW) box('stiff', x0, x1, py0, py1, -tw / 2 - s.farW, -tw / 2);
        if (s.holes) {
          anyHoles = true;
          var hg = new THREE.CylinderGeometry(s.holes.dia / 2, s.holes.dia / 2, s.t + 24, 20);
          s.holes.z.forEach(function (z) { for (var i = 0; i < s.holes.rows; i++) cyl('stiffHoles', hg, s.x, H - s.holes.firstFromTop - s.holes.pitch * i, z, 'x'); });
        }
      });
      present.push('stiff'); if (anyHoles) present.push('stiffHoles');
    }

    if (P.studs) {
      var st = P.studs, shank = new THREE.CylinderGeometry(st.dia / 2, st.dia / 2, st.len, 12), head = new THREE.CylinderGeometry(16, 16, 10, 12);
      for (var i = 0; i < st.count; i++) { var sx = st.first + st.pitch * i; cyl('studs', shank, sx, H + st.len / 2, 0); cyl('studs', head, sx, H + st.len - 5, 0); }
      present.push('studs');
    }

    if (P.angles && P.angles.length) {
      P.angles.forEach(function (a) {
        var sd = a.side === 'front' ? 1 : -1, zw = sd * tw / 2, x1 = a.x0 + a.len;
        var zA = zw, zB = zw + sd * a.t, zC = zw + sd * a.leg;
        box('angle', a.x0, x1, a.bottom, a.bottom + a.leg, Math.min(zA, zB), Math.max(zA, zB));   // 垂直肢貼腹板
        box('angle', a.x0, x1, a.bottom, a.bottom + a.t, Math.min(zB, zC), Math.max(zB, zC));     // 水平肢在下
      });
      present.push('angle');
    }

    if (P.hooks) {
      var h = P.hooks, pitch = (L - 2 * h.first) / (h.count - 1), rr = h.dia / 2, ang = 40 * Math.PI / 180, y0 = tf + h.dia / 2;
      [1, -1].forEach(function (side) {
        var zv = side * (B / 2 - h.inset);
        for (var i = 0; i < h.count; i++) {
          var x = h.first + pitch * i;
          rod('hooks', rr, [x, y0, zv], [x, y0, zv - side * 50]);
          rod('hooks', rr, [x, y0, zv], [x, y0 + 60 * Math.sin(ang), zv - side * 60 * Math.cos(ang)]);
        }
      });
      present.push('hooks');
    }

    if (P.lugs) {
      var l = P.lugs, lg = new THREE.CylinderGeometry(l.hole / 2, l.hole / 2, l.t + 24, 24);
      l.x.forEach(function (x) { box('lugs', x - l.size / 2, x + l.size / 2, H, H + l.size, -l.t / 2, l.t / 2); cyl('lugs', lg, x, H + l.size / 2, 0, 'z', M.endHoles); });
      present.push('lugs');
    }

    return { root: rootG, layers: G, present: present, materials: M };
  }

  function validate(P) {
    if (!P || typeof P !== 'object') return '不是有效的資料檔';
    var s = P.section;
    if (!s || !(s.H > 0 && s.B > 0 && s.tw > 0 && s.tf > 0 && s.L > 0)) return '缺少斷面尺寸（section：H、B、tw、tf、L）';
    return null;
  }

  root.SteelModel = { build: build, validate: validate, LAYERS: LAYERS, COLORS: COLORS, DEMO: DEMO };
})(this);
