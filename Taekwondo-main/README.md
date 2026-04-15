# 跆拳道姿態檢測系統

本專案提供即時人體姿態偵測與跆拳道動作分析，採用 Flask 與 Flask-SocketIO 作為後端，搭配 Ultralytics YOLOv8 姿態模型（pose）推論，並使用 OpenCV 進行影像處理與視覺化。

## 目錄結構

```
.
├── app.py                       # 應用程式進入點（Flask + Socket.IO）
├── requirements.txt             # Python 依賴清單
├── README.md                    # 專案說明文件
├── yolov8n-pose.pt              # YOLOv8 pose 模型（根目錄）
│
├── models/
│   └── yolov8n-pose.pt          # YOLOv8 pose 模型（備用位置）
│
├── services/
│   ├── pose_detection.py        # 角度計算工具與輔助方法
│   └── taekwondo_service.py     # 跆拳道分析、骨架繪製、錄影管理
│
├── templates/
│   └── taekwondo_detail.html    # 主畫面（預設路由對應）
│
├── static/
│   ├── css/
│   │   └── taekwondo_detail.css
│   ├── js/
│   │   └── taekwondo_detail_manager.js
│   └── img/
│
└── recordings/                  # 錄影輸出資料夾（啟動時自動建立）
    └── .gitkeep
```

## 環境需求

- Python 3.8 以上
- 套件（見 requirements.txt）：
  - Flask>=2.3.0
  - Flask-SocketIO>=5.3.0
  - opencv-python>=4.8.0
  - numpy>=1.24.0
  - ultralytics>=8.0.0
  - torch>=2.0.0
  - torchvision>=0.15.0
- GPU（選用）：如需 GPU 推論，請依環境安裝相容之 PyTorch CUDA 版本（參考官方網站）。

## 安裝與執行

1. 安裝依賴

```
pip install -r requirements.txt
```

2. 啟動服務

```
python app.py
```

- 預設監聽位址與連接埠：`0.0.0.0:8080`（程式內已設定 `port=8080`）。
- 首次啟動會自動建立 `recordings/` 目錄。

3. 瀏覽器存取

- 於瀏覽器開啟 `http://localhost:8080`。
- 首次使用時，瀏覽器可能會要求相機存取權限。

## 系統行為與通訊流程

- 前端透過 Socket.IO（namespace：`/exercise`）傳送影像畫面（base64 編碼）至後端事件 `video_frame`。
- 後端使用 YOLOv8 姿態模型進行關鍵點偵測，計算關節角度、角速度、角加速度，並回傳處理後影像與量測資料。
- 支援錄影功能（原始畫面與增強分析畫面），輸出 MP4 檔案至 `recordings/` 目錄。

### Socket.IO 事件（namespace: /exercise）

- 客戶端 -> 伺服器
  - `video_frame`：送出單張畫面（base64）。
  - `start_exercise`：開始檢測；支援參數 `exercise_type="taekwondo-detail"`，`auto_record`（布林）。
  - `stop_exercise`：停止檢測；支援參數 `keep_video`（布林，預設 true）。
  - `start_recording`：開始錄影。
  - `stop_recording`：停止錄影。
  - `reset_taekwondo_detail`：重置狀態。

- 伺服器 -> 客戶端
  - `processed_frame`：回傳經視覺化處理之畫面（base64）。
  - `taekwondo_angles`：回傳角度資料與時間戳。
  - `taekwondo_velocities`：回傳角速度資料與時間戳。
  - `taekwondo_accelerations`：回傳角加速度資料與時間戳。
  - `taekwondo_action`：回傳動作識別結果與信心值、計數。
  - `exercise_started`、`exercise_stopped`、`recording_started`、`recording_stopped`、`reset_response`、`error` 等狀態事件。

### HTTP 端點

- `GET /download_video?path=<檔案路徑>`：下載錄影檔。
  - 僅允許 `recordings/` 目錄內之檔案（伺服器端會檢查路徑安全性）。
  - 回傳為附件（attachment）。

## 模型檔與載入邏輯

- 主要使用 YOLOv8 姿態模型（`yolov8n-pose.pt`）。
- `services/taekwondo_service.py` 中之載入規則：
  1. 優先嘗試 `static/models/YOLO_MODLE/pose/yolov8n-pose.pt`。
  2. 若不存在，退回使用當前工作目錄下的 `yolov8n-pose.pt`。
- 本倉庫提供 `yolov8n-pose.pt`（根目錄與 `models/` 各有一份）。若上述路徑皆無檔案，Ultralytics 可能會嘗試下載（需具備網路連線）。

## 錄影輸出

- 影片格式：MP4（XVID 編碼）。
- 畫面大小：720x720。
- 幀率：15 FPS。
- 檔案位置：`recordings/` 目錄，包含「原始畫面」與「增強分析畫面」兩個檔案。

## 疑難排解

- 相依套件安裝問題：
  ```
  python -m pip install --upgrade pip
  pip install -r requirements.txt --force-reinstall
  ```
- 模型載入失敗：確認 `yolov8n-pose.pt` 檔案存在於根目錄或 `models/`，或依需求放置於 `static/models/YOLO_MODLE/pose/`。
- 影片下載失敗：確認查詢參數 `path` 指向 `recordings/` 目錄內之檔案，且路徑通過伺服器端檢查。

## 開發說明

- 核心服務：
  - `services/taekwondo_service.py`：關鍵點視覺化、角度/速度/加速度計算整合、動作偵測、錄影管理。
  - `services/pose_detection.py`：角度計算與姿態相關工具函式。
- 前端：
  - `templates/taekwondo_detail.html`：主頁面範本。
  - `static/js/taekwondo_detail_manager.js`：前端互動與 Socket.IO 客戶端邏輯。


