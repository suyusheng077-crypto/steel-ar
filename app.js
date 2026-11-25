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
  function refreshSet() { $('fov').value = cfg.fov; $('fovVal').textContent = cfg.fov; $('opacity').value = cfg.opacity; $('opVal').textContent = cfg.opacity; $('msVal').textContent = cfg.ms; }
  [].forEach.call(document.querySelectorAll('.nudge'), function (row) {
    row.addEventListener('click', function (e) {
      var d = parseFloat(e.target.dataset.d); if (!d) return;
      var key = row.dataset.key;
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
  $('fov').addEventListener('input', function () { cfg.fov = parseFloat(this.value); $('fovVal').textContent = cfg.fov; save('steelar.cfg', cfg); setProjection(); updateHolder(); redraw(); });
  $('opacity').addEventListener('input', function () { cfg.opacity = parseFloat(this.value); $('opVal').textContent = cfg.opacity; save('steelar.cfg', cfg); applyOpacity(); redraw(); });

  // ---------- 拍照 ----------
  $('shotBtn').addEventListener('click', function () {
    if (!W) return;
    renderer.render(scene, camera);
    var c = document.createElement('canvas'); c.width = W; c.height = H;
    var x = c.getContext('2d'); x.drawImage(video, 0, 0, W, H); x.drawImage(glc, 0, 0, W, H);
    var d = new Date(), pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var stamp = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    var m = markerCfg(curId), txt = (member.name || '') + (member.drawing ? '　圖號 ' + member.drawing : '') + '　' + stamp + '　標記 #' + curId + ' @ ' + m.x + ' mm';
    var fs = Math.round(Math.max(W, H) / 52), bh = fs * 2;
    x.fillStyle = 'rgba(0,0,0,.62)'; x.fillRect(0, H - bh, W, bh);
    x.fillStyle = '#fff'; x.font = fs + 'px -apple-system, "PingFang TC", sans-serif'; x.textBaseline = 'middle'; x.fillText(txt, fs * 0.7, H - bh / 2, W - fs * 1.4);
    var url = c.toDataURL('image/jpeg', 0.9);
    $('shotImg').src = url; $('shotLink').href = url; $('shotLink').download = (member.name || 'steel') + '_' + stamp.replace(/[: ]/g, '') + '.jpg';
    openPanel('shotPanel');
  });

  // ---------- 啟動 ----------
  showMember(); rebuild(); refreshSet();
  window.__steelar = { get lastDet() { return lastDet; }, markerCorners: markerCorners, applyDetections: applyDetections, detector: detector, setDet: function (n) { DET_LONG = n; }, processFrame: processFrame, poseG: poseG, cfg: cfg, markerCfg: markerCfg, updateHolder: updateHolder, setProjection: setProjection, get focal() { return focal; }, glc: glc };
})();
