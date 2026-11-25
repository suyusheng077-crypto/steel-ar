/* 鋼構 AR 檢查：相機 + ArUco 標記定位 + 1:1 疊圖 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var MAX_ID = 5;            // 使用標記 #0–#5
  var DET_LONG = 1280;       // 偵測用影像的長邊上限（像素）

  // ---------- 儲存 ----------
  function load(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }
  var cfg = load('steelar.cfg', null) || {};
  if (!(cfg.fov > 0)) cfg.fov = 63;
  if (!(cfg.opacity > 0)) cfg.opacity = 42;
  if (!(cfg.ms > 0)) cfg.ms = 160;
  if (!cfg.markers) cfg.markers = {};
  var member = load('steelar.member', null);
  if (!member || SteelModel.validate(member)) member = SteelModel.DEMO;

  function markerCfg(id) {
    var key = (member.name || '') + '#' + id;
    if (!cfg.markers[key]) cfg.markers[key] = { x: 300, y: member.section.tf, side: 'front' };
    return cfg.markers[key];
  }

  // ---------- 首頁 ----------
  function showMember() {
    var s = member.section;
    $('memberName').textContent = member.name || '未命名構件';
    $('memberSpec').textContent = (member.drawing ? '圖號 ' + member.drawing + '　' : '') + s.H + '×' + s.B + '×' + s.tw + '×' + s.tf + '　L = ' + s.L + (member.note ? '　' + member.note : '');
    $('useDemo').hidden = member === SteelModel.DEMO;
  }
  $('fileInput').addEventListener('change', function (e) {
    var f = e.target.files[0]; if (!f) return;
    var rd = new FileReader();
    rd.onload = function () {
      try {
        var P = JSON.parse(rd.result), err = SteelModel.validate(P);
        if (err) { $('loadMsg').textContent = '載入失敗：' + err; return; }
        member = P; save('steelar.member', P); $('loadMsg').textContent = '已載入，資料只存在這支手機裡。'; showMember(); rebuild();
      } catch (ex) { $('loadMsg').textContent = '載入失敗：檔案不是正確的 JSON 格式'; }
    };
    rd.readAsText(f); e.target.value = '';
  });
  $('useDemo').addEventListener('click', function () { member = SteelModel.DEMO; try { localStorage.removeItem('steelar.member'); } catch (e) { } $('loadMsg').textContent = ''; showMember(); rebuild(); });

  // ---------- three.js ----------
  var video = $('video'), glc = $('gl');
  var renderer = new THREE.WebGLRenderer({ canvas: glc, alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setClearColor(0x000000, 0);
  var scene = new THREE.Scene();
  var camera = new THREE.Camera();
  var poseG = new THREE.Group(); poseG.matrixAutoUpdate = false; poseG.visible = false; scene.add(poseG);
  var holder = new THREE.Group(); poseG.add(holder);
  var model = null, hidden = {};
  var W = 0, H = 0, focal = 0;

  function rebuild() {
    if (model) holder.remove(model.root);
    model = SteelModel.build(member, THREE, 'ar');
    holder.add(model.root);
    applyOpacity(); buildChips(); buildPresets(); lastDet = null;
  }
  function applyOpacity() {
    if (!model) return;
    var o = cfg.opacity / 100;
    Object.keys(model.materials).forEach(function (k) { var m = model.materials[k]; if (m.transparent) m.opacity = (k === 'endHoles' || k === 'stiffHoles') ? Math.min(1, o * 1.7) : o; });
  }
  function setProjection() {
    if (!W) return;
    focal = (Math.max(W, H) / 2) / Math.tan(cfg.fov * Math.PI / 360);
    var n = 50, f = 80000;
    camera.projectionMatrix.set(
      2 * focal / W, 0, 0, 0,
      0, 2 * focal / H, 0, 0,
      0, 0, -(f + n) / (f - n), -2 * f * n / (f - n),
      0, 0, -1, 0);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }
  function setSize(w, h) {
    if (w === W && h === H) return;
    W = w; H = h; renderer.setSize(W, H, false); setProjection();
  }

  // ---------- 標記在構件上的位置 ----------
  var curId = 0, lastDet = null;
  function markerCorners(m) {      // 回傳標記四角在構件座標的 (x, y)，順序：面對標記時的左上、右上、右下、左下
    var s = member.section, sheet = cfg.ms * 10 / 8, hs = cfg.ms / 2;
    var cx = m.x + sheet / 2, cy = s.H - m.y - sheet / 2, sg = m.side === 'back' ? -1 : 1;
    return [[cx - sg * hs, cy + hs], [cx + sg * hs, cy + hs], [cx + sg * hs, cy - hs], [cx - sg * hs, cy - hs]];
  }
  function updateHolder() { if (lastDet) applyDetections(lastDet, true); }   // 位置或設定改了：用上一格的偵測結果重算

  // ---------- 姿態計算 ----------
  function solve8(A, b) {           // 高斯消去，N×N
    var n = b.length, i, j, k;
    for (i = 0; i < n; i++) {
      var p = i; for (j = i + 1; j < n; j++) if (Math.abs(A[j][i]) > Math.abs(A[p][i])) p = j;
      if (Math.abs(A[p][i]) < 1e-12) return null;
      var t = A[i]; A[i] = A[p]; A[p] = t; var tb = b[i]; b[i] = b[p]; b[p] = tb;
      for (j = i + 1; j < n; j++) { var c = A[j][i] / A[i][i]; for (k = i; k < n; k++) A[j][k] -= c * A[i][k]; b[j] -= c * b[i]; }
    }
    var x = new Array(n);
    for (i = n - 1; i >= 0; i--) { var s = b[i]; for (k = i + 1; k < n; k++) s -= A[i][k] * x[k]; x[i] = s / A[i][i]; }
    return x;
  }
  function homography(obj, img) {   // obj、img：n≥4 組對應點；先正規化再解最小平方
    var n = obj.length, sx = 0, su = 0, i, j, k;
    for (i = 0; i < n; i++) { sx += Math.hypot(obj[i][0], obj[i][1]); su += Math.hypot(img[i][0], img[i][1]); }
    sx = sx / n || 1; su = su / n || 1;
    var N = [], r = [];
    for (i = 0; i < 8; i++) { N.push([0, 0, 0, 0, 0, 0, 0, 0]); r.push(0); }
    function acc(row, b) { for (j = 0; j < 8; j++) { r[j] += row[j] * b; for (k = 0; k < 8; k++) N[j][k] += row[j] * row[k]; } }
    for (i = 0; i < n; i++) {
      var X = obj[i][0] / sx, Y = obj[i][1] / sx, u = img[i][0] / su, v = img[i][1] / su;
      acc([X, Y, 1, 0, 0, 0, -u * X, -u * Y], u); acc([0, 0, 0, X, Y, 1, -v * X, -v * Y], v);
    }
    var h = solve8(N, r); if (!h) return null;
    return [su * h[0] / sx, su * h[1] / sx, su * h[2], su * h[3] / sx, su * h[4] / sx, su * h[5], h[6] / sx, h[7] / sx];
  }
  var FLIP = new THREE.Matrix4().makeScale(1, -1, -1);
  function solvePose(items) {       // items：[{c: 四角像素, m: 標記設定}]，同一面；回傳「構件 → 相機」矩陣（three.js 座標）
    var back = items[0].m.side === 'back', sg = back ? -1 : 1, cz = sg * member.section.tw / 2;
    var bc = [], img = [], ox = 0, oy = 0, i, j;
    items.forEach(function (it) { var q = markerCorners(it.m); for (j = 0; j < 4; j++) { bc.push(q[j]); img.push([it.c[j].x - W / 2, it.c[j].y - H / 2]); ox += q[j][0]; oy += q[j][1]; } });
    ox /= bc.length; oy /= bc.length;
    var obj = bc.map(function (q) { return [sg * (q[0] - ox), -(q[1] - oy)]; });   // 貼著腹板的平面座標：X 向右、Y 向下
    var h = homography(obj, img); if (!h) return null;
    var c1 = new THREE.Vector3(h[0] / focal, h[3] / focal, h[6]), c2 = new THREE.Vector3(h[1] / focal, h[4] / focal, h[7]), c3 = new THREE.Vector3(h[2] / focal, h[5] / focal, 1);
    var lam = 2 / (c1.length() + c2.length());
    var r1 = c1.clone().normalize(), r2 = c2.clone().normalize();
    var s = r1.clone().add(r2).normalize(), d = r1.clone().sub(r2).normalize();    // 對稱正交化
    r1.copy(s).add(d).multiplyScalar(Math.SQRT1_2); r2.copy(s).sub(d).multiplyScalar(Math.SQRT1_2);
    var r3 = new THREE.Vector3().crossVectors(r1, r2), t = c3.multiplyScalar(lam);
    var M = new THREE.Matrix4().set(r1.x, r2.x, r3.x, t.x, r1.y, r2.y, r3.y, t.y, r1.z, r2.z, r3.z, t.z, 0, 0, 0, 1);
    M = refinePose(M, obj, img);
    t = new THREE.Vector3().setFromMatrixPosition(M);
    var Sd = new THREE.Matrix4().makeScale(sg, -1, -sg);
    return { B: new THREE.Matrix4().multiplyMatrices(FLIP, M).multiply(Sd).multiply(new THREE.Matrix4().makeTranslation(-ox, -oy, -cz)), dist: t.length() };
  }
  // 以單應分解的結果為起點，在「旋轉 + 平移」6 個自由度上把重投影誤差壓到最小（比直接用單應穩）
  function refinePose(M, obj, img) {
    var q = new THREE.Quaternion().setFromRotationMatrix(M), t = new THREE.Vector3().setFromMatrixPosition(M), n = obj.length, v = new THREE.Vector3();
    function resid(qq, tt, out) {
      var c = 0;
      for (var i = 0; i < n; i++) {
        v.set(obj[i][0], obj[i][1], 0).applyQuaternion(qq).add(tt);
        if (v.z < 1) return Infinity;
        var du = focal * v.x / v.z - img[i][0], dv = focal * v.y / v.z - img[i][1];
        if (out) { out[2 * i] = du; out[2 * i + 1] = dv; }
        c += du * du + dv * dv;
      }
      return c;
    }
    function step(d) {          // 在目前姿態上套一個小擾動
      var w = new THREE.Vector3(d[0], d[1], d[2]), a = w.length();
      var dq = a > 1e-12 ? new THREE.Quaternion().setFromAxisAngle(w.multiplyScalar(1 / a), a) : new THREE.Quaternion();
      return { q: dq.multiply(q), t: new THREE.Vector3(t.x + d[3], t.y + d[4], t.z + d[5]) };
    }
    var r0 = new Array(2 * n), r1 = new Array(2 * n), cost = resid(q, t, r0), lam = 1e-3, et = Math.max(0.05, t.length() * 1e-4), eps = [1e-5, 1e-5, 1e-5, et, et, et];
    if (!isFinite(cost)) return M;
    for (var it = 0; it < 8; it++) {
      var J = [], k, i, j;
      for (k = 0; k < 6; k++) { var d = [0, 0, 0, 0, 0, 0]; d[k] = eps[k]; var s = step(d); if (!isFinite(resid(s.q, s.t, r1))) return M; var col = new Array(2 * n); for (i = 0; i < 2 * n; i++) col[i] = (r1[i] - r0[i]) / eps[k]; J.push(col); }
      var A = [], g = [];
      for (j = 0; j < 6; j++) { A.push([0, 0, 0, 0, 0, 0]); var gs = 0; for (i = 0; i < 2 * n; i++) gs += J[j][i] * r0[i]; g.push(-gs); for (k = 0; k < 6; k++) { var a2 = 0; for (i = 0; i < 2 * n; i++) a2 += J[j][i] * J[k][i]; A[j][k] = a2; } }
      for (j = 0; j < 6; j++) A[j][j] *= (1 + lam);
      var dl = solve8(A, g); if (!dl) break;
      var ns = step(dl), nc = resid(ns.q, ns.t, r1);
      if (nc < cost) { q = ns.q; t = ns.t; var done = cost - nc < 1e-6 * cost; cost = nc; for (i = 0; i < 2 * n; i++) r0[i] = r1[i]; lam *= 0.3; if (done) break; }
      else { lam *= 10; if (lam > 1e6) break; }
    }
    return new THREE.Matrix4().compose(t, q.normalize(), new THREE.Vector3(1, 1, 1));
  }
  function reprojErr(B, it) {       // 用 B 預測某張標記的四角，回傳與實際偵測的平均像素差 ÷ 標記邊長
    var q = markerCorners(it.m), cz = (it.m.side === 'back' ? -1 : 1) * member.section.tw / 2, e = 0, v = new THREE.Vector3();
    for (var j = 0; j < 4; j++) { v.set(q[j][0], q[j][1], cz).applyMatrix4(B).applyMatrix4(camera.projectionMatrix); e += Math.hypot((v.x + 1) * W / 2 - it.c[j].x, (1 - v.y) * H / 2 - it.c[j].y); }
    return e / 4 / Math.hypot(it.c[0].x - it.c[1].x, it.c[0].y - it.c[1].y);
  }

  // ---------- 角點次像素修正 ----------
  // 偵測器給的角點是整數像素；沿四條邊找出灰階變化最大的位置，擬合直線後取交點，定位才夠準
  function refineCorners(g, c) {
    var w = g.width, h = g.height, d = g.data, lines = [], i, j;
    function px(x, y) {
      if (x < 0 || y < 0 || x > w - 2 || y > h - 2) return -1;
      var x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, o = y0 * w + x0;
      return (d[o] * (1 - fx) + d[o + 1] * fx) * (1 - fy) + (d[o + w] * (1 - fx) + d[o + w + 1] * fx) * fy;
    }
    for (i = 0; i < 4; i++) {
      var a = c[i], b = c[(i + 1) % 4], ex = b.x - a.x, ey = b.y - a.y, len = Math.hypot(ex, ey);
      if (len < 12) return c;
      var nx = -ey / len, ny = ex / len, R = Math.max(3, Math.min(7, len * 0.08)), pts = [];
      for (j = 0; j < 14; j++) {
        var t = 0.14 + 0.72 * j / 13, bx = a.x + ex * t, by = a.y + ey * t, best = 0, bs = 0, prev = px(bx - nx * R, by - ny * R), gm = [], k = 0;
        if (prev < 0) continue;
        var bad = false;
        for (var sdist = -R + 0.5; sdist <= R; sdist += 0.5) {
          var v = px(bx + nx * sdist, by + ny * sdist); if (v < 0) { bad = true; break; }
          gm.push(Math.abs(v - prev)); prev = v;
          if (gm[k] > best) { best = gm[k]; bs = k; } k++;
        }
        if (bad || best < 6) continue;
        var off = 0;
        if (bs > 0 && bs < gm.length - 1) { var den = gm[bs - 1] - 2 * gm[bs] + gm[bs + 1]; if (den < 0) off = 0.5 * (gm[bs - 1] - gm[bs + 1]) / den; }
        var sd = -R + 0.25 + (bs + off) * 0.5;
        pts.push([bx + nx * sd, by + ny * sd]);
      }
      if (pts.length < 6) return c;
      var ln = fitLine(pts);
      var keep = pts.filter(function (p) { return Math.abs((p[0] - ln.x) * ln.ny - (p[1] - ln.y) * ln.nx) < 1.2; });
      if (keep.length >= 6 && keep.length < pts.length) ln = fitLine(keep);
      lines.push(ln);
    }
    var out = [];
    for (i = 0; i < 4; i++) {
      var p = cross2(lines[(i + 3) % 4], lines[i]);
      if (!p || Math.hypot(p.x - c[i].x, p.y - c[i].y) > 6) return c;
      out.push(p);
    }
    return out;
  }
  function fitLine(pts) {          // 主成分方向
    var mx = 0, my = 0, n = pts.length, sxx = 0, sxy = 0, syy = 0;
    pts.forEach(function (p) { mx += p[0]; my += p[1]; }); mx /= n; my /= n;
    pts.forEach(function (p) { var dx = p[0] - mx, dy = p[1] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; });
    var th = 0.5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(th), uy = Math.sin(th);
    return { x: mx, y: my, ux: ux, uy: uy, nx: ux, ny: uy };
  }
  function cross2(l1, l2) {
    var den = l1.ux * l2.uy - l1.uy * l2.ux; if (Math.abs(den) < 1e-6) return null;
    var t = ((l2.x - l1.x) * l2.uy - (l2.y - l1.y) * l2.ux) / den;
    return { x: l1.x + l1.ux * t, y: l1.y + l1.uy * t };
  }

  // ---------- 偵測 ----------
  var detector = new AR.Detector({ dictionaryName: 'ARUCO_MIP_36h12', maxHammingDistance: 3 });
  var det = document.createElement('canvas'), dctx = det.getContext('2d', { willReadFrequently: true });
  var sPos = new THREE.Vector3(), sQuat = new THREE.Quaternion(), hasPose = false, lastSeen = 0, lastDist = 0, usedIds = [], badIds = [];
  var tp = new THREE.Vector3(), tq = new THREE.Quaternion(), ts = new THREE.Vector3(), ONE = new THREE.Vector3(1, 1, 1);

  function applyDetections(items, snap) {     // items[0] 是畫面中最大的標記
    var prim = items[0], side = prim.m.side || 'front';
    var res = solvePose([prim]); if (!res) return false;
    usedIds = [prim.id]; badIds = [];
    var set = [prim].concat(items.slice(1).filter(function (it) { return it.m.set && (it.m.side || 'front') === side; }));
    while (set.length > 1) {               // 一起解，再看每張標記對不對得上；對不上的（位置可能填錯）剔除
      var r2 = solvePose(set); if (!r2) break;
      var worst = -1, we = 0;
      for (var i = 1; i < set.length; i++) { var e = Math.max(reprojErr(r2.B, set[i]), reprojErr(r2.B, prim)); if (e > we) { we = e; worst = i; } }
      if (we > 0.08) { badIds.push(set[worst].id); set.splice(worst, 1); continue; }
      res = r2; usedIds = set.map(function (it) { return it.id; }); break;
    }
    res.B.decompose(tp, tq, ts);
    if (snap || !hasPose || tp.distanceTo(sPos) > 0.25 * res.dist) { sPos.copy(tp); sQuat.copy(tq); }
    else { sPos.lerp(tp, 0.35); sQuat.slerp(tq, 0.35); }
    hasPose = true; lastDist = res.dist;
    poseG.matrix.compose(sPos, sQuat, ONE); poseG.matrixWorldNeedsUpdate = true; poseG.visible = true;
    return true;
  }

  function processFrame(src, w, h, now) {
    setSize(w, h);
    var k = DET_LONG / Math.max(w, h); if (k > 1) k = 1;
    var dw = Math.round(w * k), dh = Math.round(h * k);
    if (det.width !== dw || det.height !== dh) { det.width = dw; det.height = dh; }
    dctx.drawImage(src, 0, 0, dw, dh);
    var ms, byId = {}, items = [];
    try { ms = detector.detect(dctx.getImageData(0, 0, dw, dh)); } catch (e) { ms = []; }
    for (var i = 0; i < ms.length; i++) {
      if (ms[i].id > MAX_ID) continue;
      var c = ms[i].corners, per = 0;
      for (var j = 0; j < 4; j++) per += Math.hypot(c[j].x - c[(j + 1) % 4].x, c[j].y - c[(j + 1) % 4].y);
      if (!byId[ms[i].id] || per > byId[ms[i].id].per) byId[ms[i].id] = { id: ms[i].id, per: per, raw: c };
    }
    Object.keys(byId).forEach(function (id) {
      var it = byId[id];
      it.c = refineCorners(detector.grey, it.raw).map(function (p) { return { x: (p.x + 0.5) / k, y: (p.y + 0.5) / k }; });
      it.m = markerCfg(it.id); items.push(it);
    });
    items.sort(function (a, b) { return b.per - a.per; });
    if (items.length) {
      if (items[0].id !== curId) { curId = items[0].id; hasPose = false; refreshPos(); }
      if (applyDetections(items, false)) { lastSeen = now; lastDet = items; }
    }
    if (hasPose && now - lastSeen > 350) { hasPose = false; poseG.visible = false; }
    renderer.render(scene, camera);
    return items.length > 0;
  }

  // ---------- 相機 ----------
  var stream = null, running = false, frozen = false, statusT = 0;
  function loop(now) {
    if (!running) return;
    requestAnimationFrame(loop);
    if (frozen || video.readyState < 2 || !video.videoWidth) return;
    processFrame(video, video.videoWidth, video.videoHeight, now);
    if (now - statusT > 200) {
      statusT = now;
      var st = $('status');
      if (hasPose) { st.textContent = '標記 #' + usedIds.join('+#') + '　距離 ' + (lastDist / 1000).toFixed(2) + ' m' + (badIds.length ? '　#' + badIds.join('、#') + ' 位置不一致' : ''); st.className = 'status ok'; }
      else { st.textContent = '尋找標記…請讓整張標記進入畫面'; st.className = 'status'; }
    }
  }
  function start() {
    $('camMsg').textContent = '';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $('camMsg').textContent = '這個瀏覽器無法開啟相機。請用 Safari 開啟 https 網址。'; return; }
    navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } })
      .then(function (s) {
        stream = s; video.srcObject = s;
        $('home').hidden = true; $('ar').hidden = false;
        var p = video.play(); if (p && p.catch) p.catch(function () { });
        running = true; frozen = false; hasPose = false; lastDet = null; refreshPos();
        requestAnimationFrame(loop);
      })
      .catch(function (e) {
        $('camMsg').textContent = e && e.name === 'NotAllowedError' ? '相機權限被拒絕。請到 Safari 的網站設定允許相機後再試。' : '無法開啟相機：' + (e && e.message ? e.message : e);
      });
  }
  function stop() {
    running = false;
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    video.srcObject = null; $('ar').hidden = true; $('home').hidden = false; setFrozen(false);
  }
  function setFrozen(v) {
    if (!v && align) endAlign();
    frozen = v; $('freezeBtn').classList.toggle('on', v); $('freezeBtn').textContent = v ? '繼續' : '凍結';
    if (v) video.pause(); else if (stream) { var p = video.play(); if (p && p.catch) p.catch(function () { }); }
  }
  function redraw() { if (frozen || !running) renderer.render(scene, camera); }

  $('startBtn').addEventListener('click', start);
  $('backBtn').addEventListener('click', stop);
  $('freezeBtn').addEventListener('click', function () { setFrozen(!frozen); });

  // ---------- 圖層 ----------
  function buildChips() {
    var box = $('chips'); box.innerHTML = '';
    SteelModel.LAYERS.forEach(function (l) {
      if (model.present.indexOf(l.k) < 0) return;
      var b = document.createElement('button'); b.type = 'button'; b.className = 'chip' + (hidden[l.k] ? '' : ' on');
      var hex = ('000000' + SteelModel.COLORS[l.k].toString(16)).slice(-6);
      b.innerHTML = '<span class="dot" style="background:#' + hex + '"></span>' + l.n;
      model.layers[l.k].visible = !hidden[l.k];
      b.addEventListener('click', function () { hidden[l.k] = !hidden[l.k]; model.layers[l.k].visible = !hidden[l.k]; b.classList.toggle('on', !hidden[l.k]); redraw(); });
      box.appendChild(b);
    });
  }

  // ---------- 面板 ----------
  function openPanel(id) { ['posPanel', 'setPanel', 'shotPanel'].forEach(function (p) { $(p).hidden = p !== id; }); }
  [].forEach.call(document.querySelectorAll('[data-close]'), function (b) { b.addEventListener('click', function () { $(b.dataset.close).hidden = true; }); });
  $('posBtn').addEventListener('click', function () { refreshPos(); openPanel('posPanel'); });
  $('setBtn').addEventListener('click', function () { refreshSet(); openPanel('setPanel'); });

  function refreshPos() {
    var m = markerCfg(curId);
    $('posId').textContent = '#' + curId; $('xVal').textContent = m.x; $('yVal').textContent = m.y;
    [].forEach.call($('sideSeg').children, function (b) { b.classList.toggle('on', b.dataset.side === (m.side || 'front')); });
  }
  function refreshSet() { $('aiCode').value = cfg.code || ''; $('aiHint').textContent = VISION_URL ? '按「半自動」時會把那一格畫面送去辨識，每次會產生少量 AI 費用。' : 'AI 辨識服務還沒啟用，目前只用手機本機偵測。'; $('fov').value = cfg.fov; $('fovVal').textContent = cfg.fov; $('opacity').value = cfg.opacity; $('opVal').textContent = cfg.opacity; $('msVal').textContent = cfg.ms; }
  [].forEach.call(document.querySelectorAll('.nudge'), function (row) {
    row.addEventListener('click', function (e) {
      var d = parseFloat(e.target.dataset.d); if (!d) return;
      var key = row.dataset.key;
      if (key === 'ax') { if (align) { align.dx += d; solveAlign(); } return; }
      if (key === 'ms') { cfg.ms = Math.max(40, Math.min(400, cfg.ms + d)); refreshSet(); }
      else { var m = markerCfg(curId); m[key] = Math.round(m[key] + d); m.set = true; refreshPos(); }
      save('steelar.cfg', cfg); updateHolder(); redraw();
    });
  });
  $('sideSeg').addEventListener('click', function (e) { var s = e.target.dataset.side; if (!s) return; markerCfg(curId).side = s; markerCfg(curId).set = true; save('steelar.cfg', cfg); refreshPos(); updateHolder(); redraw(); });
  function buildPresets() {
    var box = $('presets'); box.innerHTML = '';
    var s = member.section, sheet = function () { return cfg.ms * 10 / 8; }, list = [['齊南端', function () { return 0; }]];
    (member.stiffeners || []).forEach(function (st) {
      list.push(['加勁板 ' + st.x + ' 北面', function () { return st.x + st.t / 2; }]);
      list.push(['加勁板 ' + st.x + ' 南面', function () { return st.x - st.t / 2 - sheet(); }]);
    });
    list.push(['齊北端', function () { return s.L - sheet(); }]);
    list.forEach(function (p) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = p[0];
      b.addEventListener('click', function () { markerCfg(curId).x = Math.round(p[1]()); markerCfg(curId).set = true; save('steelar.cfg', cfg); refreshPos(); updateHolder(); redraw(); });
      box.appendChild(b);
    });
  }
  $('fov').addEventListener('input', function () { cfg.fov = parseFloat(this.value); $('fovVal').textContent = cfg.fov; save('steelar.cfg', cfg); setProjection(); updateHolder(); if (align) solveAlign(); redraw(); });
  $('aiCode').addEventListener('change', function () { cfg.code = this.value.trim(); save('steelar.cfg', cfg); });
  $('opacity').addEventListener('input', function () { cfg.opacity = parseFloat(this.value); $('opVal').textContent = cfg.opacity; save('steelar.cfg', cfg); applyOpacity(); redraw(); });

  // ---------- 半自動對位（不用標記）----------
  // 上線 = 上翼板靠相機這側的邊（梁頂），下線 = 下翼板靠相機這側的邊（梁底），紅線 = 梁端。
  // 兩條平行邊給出梁的方向，梁端兩個角給出距離與位置。
  var align = null, ov = $('ov'), octx = ov.getContext('2d');

  function linePose(P, endIsNorth, dx) {     // P：[上@梁端, 上@另一頭, 下@另一頭, 下@梁端]（影片像素）
    var S = member.section, f = focal;
    function ray(p) { return new THREE.Vector3((p.x - W / 2) / f, (p.y - H / 2) / f, 1); }
    var r1 = ray(P[0]), r2 = ray(P[1]), r3 = ray(P[2]), r4 = ray(P[3]);
    var d = new THREE.Vector3().crossVectors(new THREE.Vector3().crossVectors(r1, r2), new THREE.Vector3().crossVectors(r4, r3));
    if (d.length() < 1e-9) return null;
    d.normalize();
    for (var tries = 0; tries < 2; tries++) {
      var a = r1.dot(d), b = r4.dot(d), lam = 0.003;
      var rho = (a * b + lam) / (b * b + lam);                      // 梁底角與梁頂角的距離比；加一點正則避免正看時不穩
      var diff = r1.clone().sub(r4.clone().multiplyScalar(rho)), s1 = S.H / diff.length();
      var X1 = r1.clone().multiplyScalar(s1), X4 = r4.clone().multiplyScalar(s1 * rho);
      var q = X1.clone().add(d.clone().multiplyScalar(S.H));         // 沿 d 走一小段，看投影是不是朝另一頭
      var du = f * q.x / q.z + W / 2 - P[0].x, dv = f * q.y / q.z + H / 2 - P[0].y;
      if (du * (P[1].x - P[0].x) + dv * (P[1].y - P[0].y) >= 0) break;
      d.multiplyScalar(-1);
    }
    var u = X1.clone().sub(X4); u.sub(d.clone().multiplyScalar(u.dot(d))).normalize();
    var ex = d.clone().multiplyScalar(endIsNorth ? -1 : 1), ey = u, ez = new THREE.Vector3().crossVectors(ex, ey);
    var sgn = ez.dot(X1) < 0 ? 1 : -1;                               // 相機在腹板的哪一面
    var bx = (endIsNorth ? S.L : 0) + (dx || 0), by = S.H, bz = sgn * S.B / 2;
    var t = X1.clone().sub(ex.clone().multiplyScalar(bx)).sub(ey.clone().multiplyScalar(by)).sub(ez.clone().multiplyScalar(bz));
    var M = new THREE.Matrix4().set(ex.x, ey.x, ez.x, t.x, ex.y, ey.y, ez.y, t.y, ex.z, ey.z, ez.z, t.z, 0, 0, 0, 1);
    return { B: new THREE.Matrix4().multiplyMatrices(FLIP, M), dist: X1.length() };
  }

  // 找鋼梁：霍夫找長直線 → 挑一對大致平行、中間很「乾淨」（腹板是整片鋼板）的線當上下邊 → 再找中間的直立線當梁端
  function detectBeam(img) {
    var w = img.width, h = img.height, d = img.data, n = w * h, g = new Float32Array(n), mag = new Float32Array(n), ang = new Float32Array(n), i, x, y;
    for (i = 0; i < n; i++) g[i] = 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2];
    var sum = 0;
    for (y = 1; y < h - 1; y++) for (x = 1; x < w - 1; x++) {
      i = y * w + x;
      var gx = g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1];
      var gy = g[i + w - 1] + 2 * g[i + w] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - w] - g[i - w + 1];
      mag[i] = Math.hypot(gx, gy); ang[i] = Math.atan2(gy, gx); sum += mag[i];
    }
    var mean = sum / n, thr = Math.max(mean * 2.2, 18), nT = 180, diag = Math.ceil(Math.hypot(w, h)), nR = 2 * diag + 1, acc = new Float32Array(nT * nR), ct = [], st = [], t;
    for (t = 0; t < nT; t++) { ct.push(Math.cos(t * Math.PI / 180)); st.push(Math.sin(t * Math.PI / 180)); }
    for (y = 1; y < h - 1; y++) for (x = 1; x < w - 1; x++) {
      i = y * w + x; if (mag[i] < thr) continue;
      var t0 = Math.round(ang[i] * 180 / Math.PI); t0 = ((t0 % 180) + 180) % 180;
      for (var k = -3; k <= 3; k++) { t = (t0 + k + 180) % 180; acc[t * nR + Math.round(x * ct[t] + y * st[t]) + diag] += mag[i]; }
    }
    var lines = [];
    for (var pk = 0; pk < 16; pk++) {
      var bi = -1, bv = 0;
      for (i = 0; i < acc.length; i++) if (acc[i] > bv) { bv = acc[i]; bi = i; }
      if (bi < 0 || bv < thr * Math.min(w, h) * 0.25) break;
      var bt = (bi / nR) | 0, br = bi % nR;
      lines.push({ t: bt, c: ct[bt], s: st[bt], r: br - diag, v: bv });
      for (var a = -7; a <= 7; a++) { var tt = (bt + a + 180) % 180; for (var b2 = -9; b2 <= 9; b2++) { var rr = br + b2; if (rr >= 0 && rr < nR) acc[tt * nR + rr] = 0; } }
    }
    function yAt(l, xx) { return (l.r - xx * l.c) / l.s; }
    function xAt(l, yy) { return (l.r - yy * l.s) / l.c; }
    function m(xx, yy) { xx = Math.round(xx); yy = Math.round(yy); return xx < 1 || yy < 1 || xx >= w - 1 || yy >= h - 1 ? 0 : mag[yy * w + xx]; }
    var best = null;
    for (i = 0; i < lines.length; i++) for (var j = i + 1; j < lines.length; j++) {
      var A = lines[i], Bl = lines[j];
      if (Math.abs(A.s) < 0.6 || Math.abs(Bl.s) < 0.6) continue;                  // 梁在畫面中大致是橫的
      var dt = Math.abs(A.t - Bl.t); dt = Math.min(dt, 180 - dt); if (dt > 14) continue;
      var ya = [yAt(A, 0.15 * w), yAt(A, 0.5 * w), yAt(A, 0.85 * w)], yb = [yAt(Bl, 0.15 * w), yAt(Bl, 0.5 * w), yAt(Bl, 0.85 * w)];
      if ((ya[0] - yb[0]) * (ya[2] - yb[2]) <= 0) continue;                        // 不能在畫面內交叉
      var sep = Math.abs(ya[1] - yb[1]); if (sep < 0.08 * h || sep > 0.8 * h) continue;
      var dens = 0, cnt = 0;
      for (var u = 0.15; u <= 0.86; u += 0.07) for (var vv = 0.2; vv <= 0.81; vv += 0.15) { var xx = u * w; dens += m(xx, yAt(A, xx) * (1 - vv) + yAt(Bl, xx) * vv); cnt++; }
      dens = dens / cnt / (mean + 1);
      var sc = (A.v + Bl.v) / (0.35 + dens);
      if (!best || sc > best.sc) best = { sc: sc, top: ya[1] < yb[1] ? A : Bl, bot: ya[1] < yb[1] ? Bl : A, dens: dens };
    }
    if (!best) return { conf: 'none', pts: [{ x: 0.25 * w, y: 0.36 * h }, { x: 0.9 * w, y: 0.36 * h }, { x: 0.9 * w, y: 0.64 * h }, { x: 0.25 * w, y: 0.64 * h }] };
    var T = best.top, Bm = best.bot, end = null;
    lines.forEach(function (l) {
      if (Math.abs(l.c) < 0.75) return;                                            // 梁端在畫面中大致是直的
      var yt = (T.r * l.c - l.r * T.c) / (T.s * l.c - l.s * T.c), yb2 = (Bm.r * l.c - l.r * Bm.c) / (Bm.s * l.c - l.s * Bm.c), sup = 0;
      if (!(yb2 - yt > 4)) return;
      for (var q = 0.1; q <= 0.91; q += 0.05) { var yy = yt + (yb2 - yt) * q; sup += m(xAt(l, yy), yy) > thr ? 1 : 0; }
      var xm = xAt(l, (yt + yb2) / 2); if (xm < 0.03 * w || xm > 0.97 * w) return;
      if (sup < 9) return;
      // 真正的梁端：上下兩條長邊只在它的一側延續；加勁板則兩側都有
      function side(x0, x1) { var c2 = 0, tot = 0; for (var xs = x0; xs <= x1; xs += 2) { if (xs < 2 || xs > w - 3) continue; tot += 2; c2 += (m(xs, yAt(T, xs)) > thr ? 1 : 0) + (m(xs, yAt(Bm, xs)) > thr ? 1 : 0); } return tot ? c2 / tot : 0; }
      var win = 0.14 * w, sl = side(xm - win, xm - 4), sr = side(xm + 4, xm + win), endness = Math.abs(sl - sr) / (Math.max(sl, sr) + 0.05), score = sup * (0.25 + endness);
      if (!end || score > end.score) end = { l: l, sup: sup, xm: xm, score: score, right: sl > sr };
    });
    var xe = end ? end.xm : 0.25 * w, pe;
    function onLine(l, xx) { return { x: xx, y: yAt(l, xx) }; }
    function cross(l1, l2) { var den = l1.c * l2.s - l1.s * l2.c; return { x: (l1.r * l2.s - l2.r * l1.s) / den, y: (l2.r * l1.c - l1.r * l2.c) / den }; }
    var goRight = end ? !end.right : xe < 0.5 * w;                             // 梁往哪一邊延伸
    var xo = goRight ? Math.min(0.94 * w, xe + 0.6 * w) : Math.max(0.06 * w, xe - 0.6 * w);
    var p1 = end ? cross(T, end.l) : onLine(T, xe), p4 = end ? cross(Bm, end.l) : onLine(Bm, xe);
    return { conf: end ? 'ok' : 'noend', pts: [p1, onLine(T, xo), onLine(Bm, xo), p4] };
  }

  // 端面：四個角是梁端斷面外框（寬 B、高 H）的四角，順序 上、上、下、下（順時針）
  function endPose(P, endIsNorth, dx) {
    var S = member.section, Q = P.slice(), area = 0, i;
    for (i = 0; i < 4; i++) { var a = Q[i], b = Q[(i + 1) % 4]; area += a.x * b.y - b.x * a.y; }
    if (area < 0) Q = [P[1], P[0], P[3], P[2]];                        // 兩個「上」左右放反時自動對調
    var obj = [[-S.B / 2, -S.H / 2], [S.B / 2, -S.H / 2], [S.B / 2, S.H / 2], [-S.B / 2, S.H / 2]], img = Q.map(function (p) { return [p.x - W / 2, p.y - H / 2]; });
    var h = homography(obj, img); if (!h) return null;
    var c1 = new THREE.Vector3(h[0] / focal, h[3] / focal, h[6]), c2 = new THREE.Vector3(h[1] / focal, h[4] / focal, h[7]), c3 = new THREE.Vector3(h[2] / focal, h[5] / focal, 1);
    var lam = 2 / (c1.length() + c2.length()), r1 = c1.clone().normalize(), r2 = c2.clone().normalize();
    var s = r1.clone().add(r2).normalize(), d = r1.clone().sub(r2).normalize();
    r1.copy(s).add(d).multiplyScalar(Math.SQRT1_2); r2.copy(s).sub(d).multiplyScalar(Math.SQRT1_2);
    var r3 = new THREE.Vector3().crossVectors(r1, r2), t = c3.multiplyScalar(lam);
    var M = refinePose(new THREE.Matrix4().set(r1.x, r2.x, r3.x, t.x, r1.y, r2.y, r3.y, t.y, r1.z, r2.z, r3.z, t.z, 0, 0, 0, 1), obj, img);
    // 構件座標 → 端面座標（X 向右、Y 向下、Z 往梁裡面）
    var sg = endIsNorth ? -1 : 1, ox = (endIsNorth ? S.L : 0) + (dx || 0), oy = S.H / 2;
    var T = new THREE.Matrix4().set(0, 0, sg, 0, 0, -1, 0, oy, sg, 0, 0, -sg * ox, 0, 0, 0, 1);
    return { B: new THREE.Matrix4().multiplyMatrices(FLIP, M).multiply(T), dist: new THREE.Vector3().setFromMatrixPosition(M).length() };
  }

  var ALIGN_MSG = {
    side: {
      ok: '找到一段像鋼梁的東西。藍色外框對得上嗎？對不上就拖圓點修正。',
      noend: '找到上下兩條邊，但沒找到梁端。請把紅線的兩個圓點拖到梁端的上下角。',
      none: '沒有認出鋼梁。請把上線拖到上翼板靠你這側的邊、下線拖到下翼板靠你這側的邊，紅線拖到梁端。'
    },
    end: {
      ok: '判斷你是從梁端往裡看。藍色外框對得上嗎？對不上就拖四個角修正。',
      none: '請把四個圓點拖到梁端斷面的四個角：兩個「上」放上翼板那一側，兩個「下」放下翼板那一側。梁躺著也照翼板放。'
    }
  };
  var VISION_URL = window.STEEL_AR_VISION_URL || '';
  function visRect() { var mm = ovScale(); return { x0: -mm.ox / mm.sc, x1: (mm.r.width - mm.ox) / mm.sc, y0: (80 - mm.oy) / mm.sc, y1: (mm.r.height - $('bottom').offsetHeight - 24 - mm.oy) / mm.sc }; }
  function inVis(vis) { return function (p) { return p.x >= vis.x0 + 12 && p.x <= vis.x1 - 12 && p.y >= vis.y0 && p.y <= vis.y1; }; }
  function defaultPts(view) {
    var vis = visRect(), vw = vis.x1 - vis.x0, vh = vis.y1 - vis.y0, S = member.section;
    if (view === 'end') {
      var hh = 0.5 * vh, ww = Math.min(0.7 * vw, hh * S.B / S.H); hh = ww * S.H / S.B;
      var cx = vis.x0 + vw / 2, cy = vis.y0 + vh / 2;
      return [{ x: cx - ww / 2, y: cy - hh / 2 }, { x: cx + ww / 2, y: cy - hh / 2 }, { x: cx + ww / 2, y: cy + hh / 2 }, { x: cx - ww / 2, y: cy + hh / 2 }];
    }
    var xa = vis.x0 + 0.2 * vw, xb = vis.x0 + 0.85 * vw;
    return [{ x: xa, y: vis.y0 + 0.35 * vh }, { x: xb, y: vis.y0 + 0.35 * vh }, { x: xb, y: vis.y0 + 0.7 * vh }, { x: xa, y: vis.y0 + 0.7 * vh }];
  }
  // 圓點一定要落在看得到、按得到的範圍內（影片被裁切、下方有操作列）
  function fitToVisible() {
    var vis = visRect(), inside = inVis(vis), P = align.pts, vw = vis.x1 - vis.x0;
    if (align.view === 'end') { if (!P.every(inside)) { align.pts = defaultPts('end'); align.conf = 'none'; } return; }
    function yOn(p, q, x) { return p.y + (q.y - p.y) * (x - p.x) / ((q.x - p.x) || 1e-6); }
    var xa = vis.x0 + 0.2 * vw, xb = vis.x0 + 0.85 * vw, endRight = P[0].x > P[1].x;
    if (!inside(P[0]) || !inside(P[3])) {
      var xe2 = endRight ? xb : xa, t0 = { x: xe2, y: yOn(P[0], P[1], xe2) }, b0 = { x: xe2, y: yOn(P[3], P[2], xe2) };
      P[0] = t0; P[3] = b0; if (align.conf === 'ok') align.conf = 'noend';
    }
    var xo2 = endRight ? xa : xb, t1 = { x: xo2, y: yOn(P[0], P[1], xo2) }, b1 = { x: xo2, y: yOn(P[3], P[2], xo2) };
    P[1] = t1; P[2] = b1;
    if (!P.every(inside)) { align.conf = 'none'; align.pts = defaultPts('side'); }
  }
  function showProposal(view, pts, conf, extra) {
    var keepEnd = align && align.end;
    align = { view: view, pts: pts, end: keepEnd || 'S', dx: 0, conf: conf };
    if (!keepEnd && view === 'side' && pts[0].x > pts[1].x) align.end = 'N';   // 梁端在畫面右邊時，先猜它是北端（面對正面、南在左）
    fitToVisible();
    $('alignMsg').textContent = (extra || '') + (ALIGN_MSG[view][align.conf] || ALIGN_MSG[view].none);
    refreshEnd(); solveAlign();
  }
  function localDetect(extra) {
    var k = 400 / Math.max(W, H), dw = Math.round(W * k), dh = Math.round(H * k);
    det.width = dw; det.height = dh; dctx.drawImage(video, 0, 0, dw, dh);
    var res = detectBeam(dctx.getImageData(0, 0, dw, dh));
    showProposal('side', res.pts.map(function (p) { return { x: p.x / k, y: p.y / k }; }), res.conf, extra);
  }
  var AI_ERR = { bad_code: '通行碼不對，請到「設定」重新輸入。', not_configured: 'AI 服務還沒設定好金鑰。', rate_limited: '辨識太頻繁，請等一分鐘。', upstream: 'AI 服務暫時沒有回應。' };
  function aiDetect() {
    var k = Math.min(1, 1024 / Math.max(W, H)), c = document.createElement('canvas'); c.width = Math.round(W * k); c.height = Math.round(H * k);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    var S = member.section, ctl = window.AbortController ? new AbortController() : null, timer = setTimeout(function () { if (ctl) ctl.abort(); }, 30000), token = align;
    $('alignMsg').textContent = 'AI 辨識中，大約要等幾秒…';
    fetch(VISION_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl ? ctl.signal : undefined,
      body: JSON.stringify({ code: cfg.code, image: c.toDataURL('image/jpeg', 0.8).split(',')[1], member: { H: S.H, B: S.B, tw: S.tw, tf: S.tf, L: S.L, studs: !!member.studs, lugs: !!member.lugs } }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (r) {
        clearTimeout(timer); if (align !== token) return;                       // 使用者已經離開或重來
        if (!r.ok) { localDetect((AI_ERR[r.j && r.j.error] || 'AI 辨識失敗。') + '先用手機本機偵測：'); return; }
        if (!r.j.found) { align.view = 'side'; align.pts = defaultPts('side'); align.conf = 'none'; $('alignMsg').textContent = 'AI 沒有在畫面裡找到鋼梁' + (r.j.note ? '（' + r.j.note + '）' : '') + '。請選側面或端面後手動拖圓點。'; refreshEnd(); solveAlign(); return; }
        var pts = r.j.points.map(function (p) { return { x: p[0] * W, y: p[1] * H }; });
        align = null; showProposal(r.j.view, pts, r.j.view === 'side' && !r.j.end_visible ? 'noend' : 'ok', 'AI：');
      })
      .catch(function () { clearTimeout(timer); if (align !== token) return; localDetect('連不上 AI 服務。先用手機本機偵測：'); });
  }
  function startAlign() {
    if (!W || !running) return;
    if (!frozen) setFrozen(true);
    openPanel(null);
    ov.width = W; ov.height = H; ov.hidden = false;
    $('alignBar').hidden = false; $('mainTools').hidden = true;
    align = null;
    if (VISION_URL && cfg.code) { align = { view: 'side', pts: defaultPts('side'), end: 'S', dx: 0, conf: 'none' }; refreshEnd(); poseG.visible = false; renderer.render(scene, camera); octx.clearRect(0, 0, W, H); aiDetect(); }
    else localDetect(VISION_URL ? '（還沒輸入 AI 通行碼，只用手機本機偵測。）' : '');
  }
  function endAlign() {
    align = null; ov.hidden = true; $('alignBar').hidden = true; $('mainTools').hidden = false;
    hasPose = false; poseG.visible = false; lastDet = null;
  }
  function refreshEnd() {
    [].forEach.call($('endSeg').children, function (b) { b.classList.toggle('on', b.dataset.end === align.end); });
    [].forEach.call($('viewSeg').children, function (b) { b.classList.toggle('on', b.dataset.view === align.view); });
    $('endLabel').textContent = align.view === 'end' ? '我站在梁的' : '紅線這一端是';
  }
  function solveAlign() {
    if (!align) return;
    var res = align.view === 'end' ? endPose(align.pts, align.end === 'N', align.dx) : linePose(align.pts, align.end === 'N', align.dx);
    if (res) { res.B.decompose(sPos, sQuat, ts); poseG.matrix.compose(sPos, sQuat, ONE); poseG.matrixWorldNeedsUpdate = true; poseG.visible = true; lastDist = res.dist; }
    else poseG.visible = false;
    renderer.render(scene, camera); drawOv();
    $('status').textContent = '半自動對位（' + (align.view === 'end' ? '端面' : '側面') + '）　距離約 ' + (lastDist / 1000).toFixed(1) + ' m'; $('status').className = 'status ok';
  }
  function ovScale() { var r = ov.getBoundingClientRect(), sc = Math.max(r.width / W, r.height / H); return { r: r, sc: sc, ox: (r.width - W * sc) / 2, oy: (r.height - H * sc) / 2 }; }
  function drawOv() {
    if (!align) return;
    var P = align.pts, s = 1 / ovScale().sc;
    octx.clearRect(0, 0, W, H); octx.lineCap = 'round';
    function seg(a, b, col, ext) {
      var dx = b.x - a.x, dy = b.y - a.y, e = ext ? 3 : 0;
      octx.strokeStyle = '#000a'; octx.lineWidth = 5 * s; octx.beginPath(); octx.moveTo(a.x - dx * e, a.y - dy * e); octx.lineTo(b.x + dx * e, b.y + dy * e); octx.stroke();
      octx.strokeStyle = col; octx.lineWidth = 2.5 * s; octx.stroke();
    }
    if (align.view === 'end') { seg(P[0], P[1], '#ffe14a', false); seg(P[1], P[2], '#ffffff', false); seg(P[2], P[3], '#ffffff', false); seg(P[3], P[0], '#ffffff', false); }
    else { seg(P[0], P[1], '#ffe14a', true); seg(P[3], P[2], '#ffe14a', true); seg(P[0], P[3], '#ff5a4a', false); }
    var lab = ['上', '上', '下', '下'];
    P.forEach(function (p, i) {
      octx.beginPath(); octx.arc(p.x, p.y, 15 * s, 0, 6.2832); octx.fillStyle = align.view === 'end' ? (i < 2 ? '#ffe14ae6' : '#ffffffe6') : ((i === 0 || i === 3) ? '#ff5a4ae6' : '#ffe14ae6'); octx.fill(); octx.lineWidth = 2 * s; octx.strokeStyle = '#000'; octx.stroke();
      octx.fillStyle = '#000'; octx.font = '600 ' + 15 * s + 'px sans-serif'; octx.textAlign = 'center'; octx.textBaseline = 'middle'; octx.fillText(lab[i], p.x, p.y + s);
    });
  }
  var dragI = -1;
  function ovPoint(e) { var t = e.touches ? e.touches[0] : e, m = ovScale(); return { x: (t.clientX - m.r.left - m.ox) / m.sc, y: (t.clientY - m.r.top - m.oy) / m.sc, sc: m.sc }; }
  function ovDown(e) {
    if (!align) return; e.preventDefault();
    var p = ovPoint(e), bd = 46 / p.sc; dragI = -1;
    align.pts.forEach(function (q, i) { var dd = Math.hypot(q.x - p.x, q.y - p.y); if (dd < bd) { bd = dd; dragI = i; } });
  }
  function ovMove(e) {
    if (!align || dragI < 0) return; e.preventDefault();
    var p = ovPoint(e); align.pts[dragI].x = p.x; align.pts[dragI].y = p.y; solveAlign();
  }
  function ovUp() { dragI = -1; }
  ov.addEventListener('touchstart', ovDown, { passive: false }); ov.addEventListener('touchmove', ovMove, { passive: false }); ov.addEventListener('touchend', ovUp); ov.addEventListener('touchcancel', ovUp);
  ov.addEventListener('mousedown', ovDown); window.addEventListener('mousemove', function (e) { if (dragI >= 0) ovMove(e); }); window.addEventListener('mouseup', ovUp);
  $('alignBtn').addEventListener('click', startAlign);
  $('alignRedo').addEventListener('click', startAlign);
  $('viewSeg').addEventListener('click', function (e) { var v = e.target.dataset.view; if (!v || !align || v === align.view) return; align.view = v; align.pts = defaultPts(v); align.conf = 'none'; $('alignMsg').textContent = ALIGN_MSG[v].none; refreshEnd(); solveAlign(); });
  $('alignShot').addEventListener('click', takeShot);
  $('alignDone').addEventListener('click', function () { setFrozen(false); });
  $('endSeg').addEventListener('click', function (e) { var v = e.target.dataset.end; if (!v || !align) return; align.end = v; refreshEnd(); solveAlign(); });

  // ---------- 拍照 ----------
  function takeShot() {
    if (!W) return;
    renderer.render(scene, camera);
    var c = document.createElement('canvas'); c.width = W; c.height = H;
    var x = c.getContext('2d'); x.drawImage(video, 0, 0, W, H); x.drawImage(glc, 0, 0, W, H);
    var d = new Date(), pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var stamp = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    var m = markerCfg(curId), txt = (member.name || '') + (member.drawing ? '　圖號 ' + member.drawing : '') + '　' + stamp + (align ? '　半自動對位' : '　標記 #' + curId + ' @ ' + m.x + ' mm');
    var fs = Math.round(Math.max(W, H) / 52), bh = fs * 2;
    x.fillStyle = 'rgba(0,0,0,.62)'; x.fillRect(0, H - bh, W, bh);
    x.fillStyle = '#fff'; x.font = fs + 'px -apple-system, "PingFang TC", sans-serif'; x.textBaseline = 'middle'; x.fillText(txt, fs * 0.7, H - bh / 2, W - fs * 1.4);
    var url = c.toDataURL('image/jpeg', 0.9);
    $('shotImg').src = url; $('shotLink').href = url; $('shotLink').download = (member.name || 'steel') + '_' + stamp.replace(/[: ]/g, '') + '.jpg';
    openPanel('shotPanel');
  }
  $('shotBtn').addEventListener('click', takeShot);

  // ---------- 啟動 ----------
  showMember(); rebuild(); refreshSet();
  window.__steelar = { endPose: endPose, linePose: linePose, detectBeam: detectBeam, get lastDet() { return lastDet; }, markerCorners: markerCorners, applyDetections: applyDetections, detector: detector, setDet: function (n) { DET_LONG = n; }, processFrame: processFrame, poseG: poseG, cfg: cfg, markerCfg: markerCfg, updateHolder: updateHolder, setProjection: setProjection, get focal() { return focal; }, glc: glc };
})();
