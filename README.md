# 鋼構 AR 檢查（原型）

用手機相機對著貼了定位標記的鋼梁，把二次加工（螺栓孔、加勁板、剪力釘、吊耳等）照實際比例疊在畫面上，用來檢查有沒有組錯或漏組。

- `index.html`：檢查頁（需要 https 與相機權限）
- `markers.html` / `markers.pdf`：定位標記（ArUco MIP 36h12，#0–#5，黑框 160 mm）
- `model.js`：構件參數 → 3D 模型
- `app.js`：相機、標記偵測、姿態計算、疊圖

這個專案只包含工具和一支虛構的範例梁。真實構件的資料是另外的 JSON 檔，在手機上載入後只存在該手機裡，不放在這裡。

## 使用的開源元件

- [three.js](https://threejs.org/)（MIT）
- [js-aruco2](https://github.com/damianofalcioni/js-aruco2)（MIT）
