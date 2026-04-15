/**
 * 跆拳道詳細姿態偵測管理模組
 * 負責處理跆拳道詳細分析頁面的前端邏輯
 */

class TaekwondoDetailManager {
    constructor() {
        this.socket = null;
        this.isDetectionActive = false;
        this.angleChart = null;
        this.velocityChart = null;
        // 視窗與抽樣（1秒取樣）
        this.windowSec = 10; // 將依總時長自動調整
        this._autoFollow = true;
                this._isTimeSliderDragging = false;
this._angleTimes = [];
        this._velocityTimes = [];
        this._lastAngleSecond = -1;
        this._lastVelocitySecond = -1;
        this.chartData = {
            angles: {
                labels: [],
                datasets: {
                    leftElbow: [],
                    rightElbow: [],
                    leftKnee: [],
                    rightKnee: []
                }
            },
            velocities: {
                labels: [],
                datasets: {
                    leftElbow: [],
                    rightElbow: [],
                    leftKnee: [],
                    rightKnee: []
                }
            }
        };
        this.maxDataPoints = -1;
        this.selectedCameraIndex = 0;
        this.availableCameras = [];

        // 攝像頭相關
        this.stream = null;
        this.videoElement = null;
        this.frameInterval = null;

        // 錄製相關
        this.isRecording = false;
        this.recordingStartTime = null;
        this.recordingTimer = null;
        this.lastRecordingData = null;

        // 檢測時間追蹤
        this.detectionStartTime = null;
        this.currentDetectionTime = 0;
        this.cameraReady = false;
        this.waitingForCamera = false;

        // 回放影片播放器（用於和時間滑桿、圖表連動）
        this.playbackPlayer = null;
        this._onPlaybackLoadedMeta = null;
        this._onPlaybackTimeUpdate = null;

        // 只綁一次的 video error handler
        this._playbackDiagBound = false;

        this.init();
    }

    init() {
        console.log('初始化跆拳道詳細姿態偵測管理器...');
        this.initSocket();
        this.bindUIEvents();
        this.initCharts();
        this.initUIState();
        console.log('跆拳道詳細姿態偵測管理器初始化完成');
    }

    initSocket() {
        try {
            this.socket = io('/exercise', {
                reconnection: true,
                reconnectionAttempts: 5,
                reconnectionDelay: 1000,
                timeout: 10000
            });

            this.bindSocketEvents();
            console.log('Socket 連接已初始化');
        } catch (error) {
            console.error('初始化 Socket 連接失敗:', error);
            this.showError('無法連接到服務器，請刷新頁面重試');
        }
    }

    bindSocketEvents() {
        this.socket.on('connect', () => {
            console.log('Socket 已連接，ID:', this.socket.id);
            this.updateConnectionStatus(true);
        });

        this.socket.on('disconnect', () => {
            console.log('Socket 已斷開連接');
            this.updateConnectionStatus(false);
        });

        // 注意：你原本有 socket.on('video_frame') 但後端並沒有 emit 'video_frame' 給前端
        // 保留不影響，但真正畫面更新是 'processed_frame'
        this.socket.on('video_frame', (data) => {
            this.updateVideoFrame(data.frame);
            if (this.waitingForCamera && !this.cameraReady) {
                this.handleCameraReady();
            }
        });

        this.socket.on('processed_frame', (data) => {
            this.updateVideoFrame(data.image);
        });

        this.socket.on('taekwondo_angles', (data) => this.updateAngles(data.angles));
        this.socket.on('taekwondo_velocities', (data) => this.updateVelocities(data.velocities));
        this.socket.on('taekwondo_accelerations', (data) => this.updateAccelerations(data.accelerations));
        this.socket.on('taekwondo_action', (data) => this.updateActionRecognition(data));
        this.socket.on('exercise_started', (data) => this.handleStartDetectionResponse(data));
        this.socket.on('exercise_stopped', (data) => this.handleStopDetectionResponse(data));
        this.socket.on('reset_response', (data) => this.handleResetResponse(data));
        this.socket.on('camera_detection_response', (data) => this.handleCameraDetectionResponse(data));
        this.socket.on('recording_started', (data) => this.handleRecordingStarted(data));
        this.socket.on('recording_stopped', (data) => this.handleRecordingStopped(data));
        this.socket.on('recording_deleted', (data) => this.handleRecordingDeleted(data));
        this.socket.on('recording_status', (data) => this.updateRecordingStatus(data));

        this.socket.on('error', (data) => {
            console.error('Socket 錯誤:', data);
            this.showError(data.message || '發生未知錯誤');
        });
    }

    bindUIEvents() {
        const startBtn = document.getElementById('start-detection-btn');
        if (startBtn) startBtn.addEventListener('click', () => this.startDetection());

        // 時間瀏覽滑塊
        const timeSlider = document.getElementById('time-start');
        const timeLabel = document.getElementById('time-window-label');
        if (timeSlider && timeLabel) {
            // 避免上下滑桿互相拉扯：拖曳上方滑桿時暫停 video->slider 的回推
            const _setDragging = (v) => { this._isTimeSliderDragging = v; };
            timeSlider.addEventListener('mousedown', () => _setDragging(true));
            timeSlider.addEventListener('mouseup', () => _setDragging(false));
            timeSlider.addEventListener('mouseleave', () => _setDragging(false));
            timeSlider.addEventListener('touchstart', () => _setDragging(true), { passive: true });
            timeSlider.addEventListener('touchend', () => _setDragging(false));
            timeSlider.addEventListener('change', () => _setDragging(false));
            timeSlider.addEventListener('input', () => {
                const start = parseFloat(timeSlider.value);
                const end = Math.min(start + this.windowSec, parseFloat(timeSlider.max) || start);
                timeLabel.textContent = `${start.toFixed(0)}s ~ ${end.toFixed(0)}s`;
                if (this._autoFollow) {
                        this._applyWindow(start, end);
                    }

                // 同時控制回放影片時間
                if (this.playbackPlayer && !isNaN(start)) {
                    try {
                        this.playbackPlayer.currentTime = start;
                    } catch (e) {
                        console.error(e);
                    }
                }
            });
        }

        const stopBtn = document.getElementById('stop-detection-btn');
        if (stopBtn) stopBtn.addEventListener('click', () => this.stopDetection());

        const resetBtn = document.getElementById('reset-detection-btn');
        if (resetBtn) resetBtn.addEventListener('click', () => this.resetDetection());

        const detectCamerasBtn = document.getElementById('detect-cameras-btn');
        if (detectCamerasBtn) detectCamerasBtn.addEventListener('click', () => this.detectAvailableCameras());

        const cameraSelect = document.getElementById('camera-select');
        if (cameraSelect) cameraSelect.addEventListener('change', (e) => this.onCameraSelectionChange(e.target.value));

        // 回放按鈕
        const playOriginalBtn = document.getElementById('btn-play-original');
        const playAnalysisBtn = document.getElementById('btn-play-analysis');
        const player = document.getElementById('recorded-player');

        if (player) {
            this.attachPlaybackPlayer(player);
            this.attachPlaybackDiagnostics(player);
        }

        if (playOriginalBtn) {
            playOriginalBtn.addEventListener('click', () => {
                if (!this.lastRecordingData || !this.lastRecordingData.original_video) {
                    this.showError('目前沒有原始影片可以播放');
                    return;
                }
                const src = `/download_video?path=${encodeURIComponent(this.lastRecordingData.original_video)}`;
                if (player) {
                    player.src = src;
                    player.load();
                    player.play().catch((e) => {
                        console.warn('player.play() 被瀏覽器阻擋或失敗:', e);
                    });
                    this._autoFollow = true;
                    this.attachPlaybackPlayer(player);
                    this.attachPlaybackDiagnostics(player);
                    const hint = document.getElementById('playback-hint');
                    if (hint) hint.textContent = '正在播放最新原始影片';
                }
            });
        }

        if (playAnalysisBtn) {
            playAnalysisBtn.addEventListener('click', () => {
                if (!this.lastRecordingData || !this.lastRecordingData.skeleton_video) {
                    this.showError('目前沒有分析影片可以播放');
                    return;
                }
                const src = `/download_video?path=${encodeURIComponent(this.lastRecordingData.skeleton_video)}`;
                if (player) {
                    player.src = src;
                    player.load();
                    player.play().catch((e) => {
                        console.warn('player.play() 被瀏覽器阻擋或失敗:', e);
                    });
                    this._autoFollow = true;
                    this.attachPlaybackPlayer(player);
                    this.attachPlaybackDiagnostics(player);
                    const hint = document.getElementById('playback-hint');
                    if (hint) hint.textContent = '正在播放最新分析影片';
                }
            });
        }
    }

    attachPlaybackDiagnostics(videoElement) {
        if (!videoElement || this._playbackDiagBound) return;
        this._playbackDiagBound = true;

        const hint = document.getElementById('playback-hint');

        const stateText = () => {
            // networkState: 0 EMPTY, 1 IDLE, 2 LOADING, 3 NO_SOURCE
            // readyState: 0 HAVE_NOTHING, 1 HAVE_METADATA, 2 HAVE_CURRENT_DATA, 3 HAVE_FUTURE_DATA, 4 HAVE_ENOUGH_DATA
            return `networkState=${videoElement.networkState}, readyState=${videoElement.readyState}, src=${videoElement.currentSrc || videoElement.src || ''}`;
        };

        videoElement.addEventListener('error', () => {
            const err = videoElement.error;
            let msg = '影片播放失敗';
            if (err) {
                // 1 MEDIA_ERR_ABORTED, 2 MEDIA_ERR_NETWORK, 3 MEDIA_ERR_DECODE, 4 MEDIA_ERR_SRC_NOT_SUPPORTED
                msg += ` (code=${err.code})`;
            }
            msg += `；${stateText()}`;
            console.error(msg, err);
            if (hint) hint.textContent = msg;
            alert(msg);
        });

        videoElement.addEventListener('loadedmetadata', () => {
            const msg = `影片 metadata 已載入：duration=${(videoElement.duration || 0).toFixed(2)}s；${stateText()}`;
            console.log(msg);
            if (hint) hint.textContent = `已載入影片（${Math.floor(videoElement.duration || 0)}s）`;
        });

        videoElement.addEventListener('canplay', () => {
            console.log('影片 canplay', stateText());
        });

        videoElement.addEventListener('stalled', () => {
            const msg = `影片 stalled；${stateText()}`;
            console.warn(msg);
            if (hint) hint.textContent = msg;
        });

        videoElement.addEventListener('waiting', () => {
            const msg = `影片 waiting (buffering)；${stateText()}`;
            console.warn(msg);
            if (hint) hint.textContent = msg;
        });
    }

    initCharts() {
        const angleCanvas = document.getElementById('angle-chart');
        if (angleCanvas) {
            this.angleChart = new Chart(angleCanvas, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [
                        { label: '左手肘', data: [], borderColor: 'rgb(255, 99, 132)', backgroundColor: 'rgba(255, 99, 132, 0.1)', tension: 0.1 },
                        { label: '右手肘', data: [], borderColor: 'rgb(54, 162, 235)', backgroundColor: 'rgba(54, 162, 235, 0.1)', tension: 0.1 },
                        { label: '左膝蓋', data: [], borderColor: 'rgb(255, 205, 86)', backgroundColor: 'rgba(255, 205, 86, 0.1)', tension: 0.1 },
                        { label: '右膝蓋', data: [], borderColor: 'rgb(75, 192, 192)', backgroundColor: 'rgba(75, 192, 192, 0.1)', tension: 0.1 },
                        { label: '左肩膀', data: [], borderColor: 'rgb(153, 102, 255)', backgroundColor: 'rgba(153, 102, 255, 0.1)', tension: 0.1 },
                        { label: '右肩膀', data: [], borderColor: 'rgb(255, 159, 64)', backgroundColor: 'rgba(255, 159, 64, 0.1)', tension: 0.1 },
                        { label: '左髖部', data: [], borderColor: 'rgb(199, 199, 199)', backgroundColor: 'rgba(199, 199, 199, 0.1)', tension: 0.1 },
                        { label: '右髖部', data: [], borderColor: 'rgb(83, 102, 255)', backgroundColor: 'rgba(83, 102, 255, 0.1)', tension: 0.1 }
                    ]
                },
                options: {
                    responsive: true,
                    scales: {
                        y: { beginAtZero: true, max: 180, title: { display: true, text: '角度 (度)' } },
                        x: {
                            type: 'linear',
                            title: { display: true, text: '檢測時間 (秒)' },
                            ticks: { maxTicksLimit: 15, callback: function (value) { return value; } }
                        }
                    },
                    plugins: { title: { display: true, text: '關節角度變化趨勢' } }
                }
            });
        }

        const velocityCanvas = document.getElementById('velocity-chart');
        if (velocityCanvas) {
            this.velocityChart = new Chart(velocityCanvas, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [
                        { label: '左手肘角速度', data: [], borderColor: 'rgb(255, 99, 132)', backgroundColor: 'rgba(255, 99, 132, 0.1)', tension: 0.1 },
                        { label: '右手肘角速度', data: [], borderColor: 'rgb(54, 162, 235)', backgroundColor: 'rgba(54, 162, 235, 0.1)', tension: 0.1 },
                        { label: '左膝蓋角速度', data: [], borderColor: 'rgb(255, 205, 86)', backgroundColor: 'rgba(255, 205, 86, 0.1)', tension: 0.1 },
                        { label: '右膝蓋角速度', data: [], borderColor: 'rgb(75, 192, 192)', backgroundColor: 'rgba(75, 192, 192, 0.1)', tension: 0.1 },
                        { label: '左肩膀角速度', data: [], borderColor: 'rgb(153, 102, 255)', backgroundColor: 'rgba(153, 102, 255, 0.1)', tension: 0.1 },
                        { label: '右肩膀角速度', data: [], borderColor: 'rgb(255, 159, 64)', backgroundColor: 'rgba(255, 159, 64, 0.1)', tension: 0.1 },
                        { label: '左髖部角速度', data: [], borderColor: 'rgb(199, 199, 199)', backgroundColor: 'rgba(199, 199, 199, 0.1)', tension: 0.1 },
                        { label: '右髖部角速度', data: [], borderColor: 'rgb(83, 102, 255)', backgroundColor: 'rgba(83, 102, 255, 0.1)', tension: 0.1 }
                    ]
                },
                options: {
                    responsive: true,
                    scales: {
                        y: { title: { display: true, text: '角速度 (度/秒)' } },
                        x: {
                            type: 'linear',
                            title: { display: true, text: '檢測時間 (秒)' },
                            ticks: { maxTicksLimit: 15, callback: function (value) { return value; } }
                        }
                    },
                    plugins: { title: { display: true, text: '關節角速度變化' } }
                }
            });
        }
    }

    _applyWindow(start, end) {
        if (this.angleChart) {
            this.angleChart.options.scales.x.min = start;
            this.angleChart.options.scales.x.max = end;
            this.angleChart.update('none');
        }
        if (this.velocityChart) {
            this.velocityChart.options.scales.x.min = start;
            this.velocityChart.options.scales.x.max = end;
            this.velocityChart.update('none');
        }
    }

    attachPlaybackPlayer(videoElement) {
        if (!videoElement) return;
        this.playbackPlayer = videoElement;

        const slider = document.getElementById('time-start');
        const label = document.getElementById('time-window-label');
        if (!slider || !label) return;

        if (!this._onPlaybackLoadedMeta) {
            this._onPlaybackLoadedMeta = () => {
                try {
                    const total = Math.max(0, Math.floor(videoElement.duration || 0));
                    if (!total) return;
                    slider.min = '0';
                    slider.max = String(total);
                    this.windowSec = Math.max(5, Math.min(30, total * 0.10));
                    const start = 0;
                    const end = Math.min(start + this.windowSec, total);
                    slider.value = String(start);
                    label.textContent = `${start.toFixed(0)}s ~ ${end.toFixed(0)}s`;
                    this._applyWindow(start, end);
                } catch (e) {
                    console.error(e);
                }
            };
        }

        if (!this._onPlaybackTimeUpdate) {
            this._onPlaybackTimeUpdate = () => {
                if (this._isTimeSliderDragging) return;
                try {
                    const t = Math.floor(videoElement.currentTime || 0);
                    const total = Math.max(t, parseFloat(slider.max) || 0);
                    slider.max = String(total);
                    slider.value = String(t);
                    const start = t;
                    const end = Math.min(start + this.windowSec, total);
                    label.textContent = `${start.toFixed(0)}s ~ ${end.toFixed(0)}s`;
                    this._applyWindow(start, end);
                } catch (e) {
                    console.error(e);
                }
            };
        }

        videoElement.removeEventListener('loadedmetadata', this._onPlaybackLoadedMeta);
        videoElement.removeEventListener('timeupdate', this._onPlaybackTimeUpdate);
        videoElement.addEventListener('loadedmetadata', this._onPlaybackLoadedMeta);
        videoElement.addEventListener('timeupdate', this._onPlaybackTimeUpdate);
    }

    initUIState() {
        this.updateButtonStates(false);
        const indicator = document.getElementById('recording-indicator');
        if (indicator) indicator.style.display = 'none';
    }

    startDetection() {
        if (!this.socket || !this.socket.connected) {
            this.showError('Socket 未連接，請刷新頁面重試');
            return;
        }

        console.log('開始跆拳道詳細檢測，等待攝像頭就緒...');

        this.cameraReady = false;
        this.waitingForCamera = true;
        this.detectionStartTime = null;
        this.currentDetectionTime = 0;

        const statusText = document.querySelector('.status-text');
        if (statusText) statusText.textContent = '等待攝像頭啟動...';

        this.startCamera();

        const requestData = {
            exercise_type: 'taekwondo-detail',
            camera_index: this.selectedCameraIndex,
            auto_start_recording: false
        };

        this.socket.emit('start_exercise', requestData);
        this.updateButtonStates(true);
        this.showRecordingIndicator(true);
    }

    stopDetection() {
        if (!this.socket || !this.socket.connected) {
            this.showError('Socket 未連接');
            return;
        }

        console.log('停止跆拳道詳細檢測和錄製...');

        this.stopCamera();
        this.stopRecordingTimer();
        this.isRecording = false;

        const keepVideo = true;
        const requestData = { keep_video: keepVideo };

        this.socket.emit('stop_exercise', requestData);
        this.updateButtonStates(false);
        this.showRecordingIndicator(false);
    }

    resetDetection() {
        if (!this.socket || !this.socket.connected) {
            this.showError('Socket 未連接');
            return;
        }

        console.log('重置跆拳道詳細檢測...');

        this.stopCamera();
        this.socket.emit('reset_taekwondo_detail');

        this.detectionStartTime = null;
        this.currentDetectionTime = 0;
        this.cameraReady = false;
        this.waitingForCamera = false;

        const statusText = document.querySelector('.status-text');
        if (statusText) statusText.textContent = '未開始';

        this.resetChartData();
        this.resetUIDisplay();
    }

    async startCamera() {
        try {
            console.log('正在啟動攝像頭...');
            this.stopCamera();

            const constraints = {
                video: { width: { ideal: 720 }, height: { ideal: 720 } },
                audio: false
            };

            if (this.selectedCameraIndex >= 0) {
                try {
                    const devices = await navigator.mediaDevices.enumerateDevices();
                    const videoDevices = devices.filter(device => device.kind === 'videoinput');
                    console.log('可用攝像頭設備:', videoDevices.map((d, i) => `${i}: ${d.label || '未知設備'}`));
                    console.log('選擇的攝像頭索引:', this.selectedCameraIndex);

                    if (videoDevices[this.selectedCameraIndex]) {
                        constraints.video.deviceId = { exact: videoDevices[this.selectedCameraIndex].deviceId };
                        console.log('使用攝像頭:', videoDevices[this.selectedCameraIndex].label || '未知設備');
                    } else {
                        console.warn(`攝像頭索引 ${this.selectedCameraIndex} 不存在，使用默認攝像頭`);
                    }
                } catch (error) {
                    console.warn('無法枚舉設備，使用默認攝像頭:', error);
                }
            }

            this.stream = await navigator.mediaDevices.getUserMedia(constraints);

            if (!this.videoElement) {
                this.videoElement = document.createElement('video');
                this.videoElement.autoplay = true;
                this.videoElement.muted = true;
                this.videoElement.playsInline = true;
            }

            this.videoElement.srcObject = this.stream;

            await new Promise((resolve) => {
                this.videoElement.onloadedmetadata = () => {
                    this.videoElement.play();
                    resolve();
                };
            });

            console.log('攝像頭啟動成功');

            this.startFrameCapture();

            setTimeout(() => {
                this.handleCameraReady();
            }, 1000);

        } catch (error) {
            console.error('攝像頭啟動失敗:', error);
            this.showError('攝像頭啟動失敗: ' + error.message);
        }
    }

    stopCamera() {
        console.log('停止攝像頭...');
        this.stopFrameCapture();
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }
        if (this.videoElement) {
            this.videoElement.srcObject = null;
        }
        console.log('攝像頭已停止');
    }

    startFrameCapture() {
        if (this.frameInterval) clearInterval(this.frameInterval);
        this.frameInterval = setInterval(() => this.captureAndSendFrame(), 100);
        console.log('開始幀捕獲');
    }

    stopFrameCapture() {
        if (this.frameInterval) {
            clearInterval(this.frameInterval);
            this.frameInterval = null;
        }
        console.log('停止幀捕獲');
    }

    captureAndSendFrame() {
        if (!this.videoElement || !this.socket || !this.socket.connected) return;

        try {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');

            canvas.width = this.videoElement.videoWidth || 720;
            canvas.height = this.videoElement.videoHeight || 720;

            ctx.drawImage(this.videoElement, 0, 0, canvas.width, canvas.height);

            const imageData = canvas.toDataURL('image/jpeg', 0.8);

            this.socket.emit('video_frame', {
                image: imageData,
                timestamp: Date.now()
            });

        } catch (error) {
            console.error('捕獲幀失敗:', error);
        }
    }

    updateVideoFrame(frameData) {
        const canvas = document.getElementById('video-canvas');
        if (canvas && frameData) {
            const ctx = canvas.getContext('2d');
            const img = new Image();
            img.onload = function () {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            };

            if (typeof frameData === 'string' && frameData.startsWith('data:')) {
                img.src = frameData;
            } else {
                img.src = 'data:image/jpeg;base64,' + frameData;
            }
        }
    }

    updateAngles(angles) {
        if (!angles) return;

        this.updateAngleElement('left-elbow-angle', angles.left_elbow);
        this.updateAngleElement('right-elbow-angle', angles.right_elbow);
        this.updateAngleElement('left-knee-angle', angles.left_knee);
        this.updateAngleElement('right-knee-angle', angles.right_knee);
        this.updateAngleElement('left-shoulder-angle', angles.left_shoulder);
        this.updateAngleElement('right-shoulder-angle', angles.right_shoulder);
        this.updateAngleElement('left-hip-angle', angles.left_hip);
        this.updateAngleElement('right-hip-angle', angles.right_hip);

        this.updateAngleChart(angles);
    }

    updateVelocities(velocities) {
        if (!velocities) return;

        this.updatePhysicsElement('left-elbow-velocity', velocities.left_elbow, '°/s');
        this.updatePhysicsElement('right-elbow-velocity', velocities.right_elbow, '°/s');
        this.updatePhysicsElement('left-knee-velocity', velocities.left_knee, '°/s');
        this.updatePhysicsElement('right-knee-velocity', velocities.right_knee, '°/s');

        this.updateVelocityChart(velocities);
    }

    updateAccelerations(accelerations) {
        if (!accelerations) return;

        this.updatePhysicsElement('left-elbow-acceleration', accelerations.left_elbow, '°/s²');
        this.updatePhysicsElement('right-elbow-acceleration', accelerations.right_elbow, '°/s²');
        this.updatePhysicsElement('left-knee-acceleration', accelerations.left_knee, '°/s²');
        this.updatePhysicsElement('right-knee-acceleration', accelerations.right_knee, '°/s²');
    }

    updateActionRecognition(data) {
        const actionElement = document.getElementById('current-action');
        const confidenceElement = document.getElementById('action-confidence');
        const countElement = document.getElementById('action-count');

        if (actionElement) actionElement.textContent = data.action || '待檢測';
        if (confidenceElement) confidenceElement.textContent = `${data.confidence || 0}%`;
        if (countElement) countElement.textContent = data.count || 0;
    }

    updateAngleElement(elementId, value) {
        const element = document.getElementById(elementId);
        if (element && value !== undefined) element.textContent = `${Math.round(value)}°`;
    }

    updatePhysicsElement(elementId, value, unit) {
        const element = document.getElementById(elementId);
        if (element && value !== undefined) element.textContent = `${Math.round(value)} ${unit}`;
    }

    updateAngleChart(angles) {
        if (!this.angleChart) return;
        if (!this.cameraReady) return;

        if (this.detectionStartTime) {
            this.currentDetectionTime = (Date.now() - this.detectionStartTime) / 1000;
        }
        const tSec = Math.floor(this.currentDetectionTime);

        if (tSec !== this._lastAngleSecond) {
            this._lastAngleSecond = tSec;
            this.angleChart.data.labels.push(tSec);
            this._angleTimes.push(tSec);
            this.angleChart.data.datasets[0].data.push({ x: tSec, y: angles.left_elbow || 0 });
            this.angleChart.data.datasets[1].data.push({ x: tSec, y: angles.right_elbow || 0 });
            this.angleChart.data.datasets[2].data.push({ x: tSec, y: angles.left_knee || 0 });
            this.angleChart.data.datasets[3].data.push({ x: tSec, y: angles.right_knee || 0 });
            this.angleChart.data.datasets[4].data.push({ x: tSec, y: angles.left_shoulder || 0 });
            this.angleChart.data.datasets[5].data.push({ x: tSec, y: angles.right_shoulder || 0 });
            this.angleChart.data.datasets[6].data.push({ x: tSec, y: angles.left_hip || 0 });
            this.angleChart.data.datasets[7].data.push({ x: tSec, y: angles.right_hip || 0 });

            if (this.maxDataPoints > 0 && this.angleChart.data.labels.length > this.maxDataPoints) {
                this.angleChart.data.labels.shift();
                this.angleChart.data.datasets.forEach(dataset => dataset.data.shift());
            }
        }
        this.angleChart.update('none');

        const slider = document.getElementById('time-start');
        const label = document.getElementById('time-window-label');
        if (slider && label) {
            const total = Math.max(0, tSec);
            slider.max = String(total);
            this.windowSec = Math.max(5, Math.min(30, total * 0.10));
            if (this._autoFollow) {
                const startW = Math.max(0, total - this.windowSec);
                slider.value = String(startW);
                const endW = Math.min(total, startW + this.windowSec);
                label.textContent = `${Math.round(startW)}s ~ ${Math.round(endW)}s`;
                this._applyWindow(startW, endW);
            }
        }
    }

    updateVelocityChart(velocities) {
        if (!this.velocityChart) return;
        if (!this.cameraReady) return;

        if (this.detectionStartTime) {
            this.currentDetectionTime = (Date.now() - this.detectionStartTime) / 1000;
        }
        const tSec = Math.floor(this.currentDetectionTime);

        if (tSec !== this._lastVelocitySecond) {
            this._lastVelocitySecond = tSec;
            this.velocityChart.data.labels.push(tSec);
            this._velocityTimes.push(tSec);
            this.velocityChart.data.datasets[0].data.push({ x: tSec, y: velocities.left_elbow || 0 });
            this.velocityChart.data.datasets[1].data.push({ x: tSec, y: velocities.right_elbow || 0 });
            this.velocityChart.data.datasets[2].data.push({ x: tSec, y: velocities.left_knee || 0 });
            this.velocityChart.data.datasets[3].data.push({ x: tSec, y: velocities.right_knee || 0 });
            this.velocityChart.data.datasets[4].data.push({ x: tSec, y: velocities.left_shoulder || 0 });
            this.velocityChart.data.datasets[5].data.push({ x: tSec, y: velocities.right_shoulder || 0 });
            this.velocityChart.data.datasets[6].data.push({ x: tSec, y: velocities.left_hip || 0 });
            this.velocityChart.data.datasets[7].data.push({ x: tSec, y: velocities.right_hip || 0 });

            if (this.maxDataPoints > 0 && this.velocityChart.data.labels.length > this.maxDataPoints) {
                this.velocityChart.data.labels.shift();
                this.velocityChart.data.datasets.forEach(dataset => dataset.data.shift());
            }
        }
        this.velocityChart.update('none');

        const slider = document.getElementById('time-start');
        const label = document.getElementById('time-window-label');
        if (slider && label) {
            const total = Math.max(0, tSec);
            slider.max = String(total);
            this.windowSec = Math.max(5, Math.min(30, total * 0.10));
            if (this._autoFollow) {
                const startW = Math.max(0, total - this.windowSec);
                slider.value = String(startW);
                const endW = Math.min(total, startW + this.windowSec);
                label.textContent = `${Math.round(startW)}s ~ ${Math.round(endW)}s`;
                this._applyWindow(startW, endW);
            }
        }
    }

    resetChartData() {
        if (this.angleChart) {
            this.angleChart.data.labels = [];
            this.angleChart.data.datasets.forEach(dataset => { dataset.data = []; });
            this.angleChart.update();
        }
        if (this.velocityChart) {
            this.velocityChart.data.labels = [];
            this.velocityChart.data.datasets.forEach(dataset => { dataset.data = []; });
            this.velocityChart.update();
        }
    }

    resetUIDisplay() {
        const angleElements = [
            'left-elbow-angle', 'right-elbow-angle', 'left-knee-angle', 'right-knee-angle',
            'left-shoulder-angle', 'right-shoulder-angle', 'left-hip-angle', 'right-hip-angle'
        ];
        angleElements.forEach(id => {
            const element = document.getElementById(id);
            if (element) element.textContent = '0°';
        });

        const physicsElements = [
            'left-elbow-velocity', 'right-elbow-velocity', 'left-knee-velocity', 'right-knee-velocity',
            'left-elbow-acceleration', 'right-elbow-acceleration', 'left-knee-acceleration', 'right-knee-acceleration'
        ];
        physicsElements.forEach(id => {
            const element = document.getElementById(id);
            if (element) element.textContent = id.includes('velocity') ? '0 °/s' : '0 °/s²';
        });

        const actionElement = document.getElementById('current-action');
        const confidenceElement = document.getElementById('action-confidence');
        const countElement = document.getElementById('action-count');

        if (actionElement) actionElement.textContent = '待檢測';
        if (confidenceElement) confidenceElement.textContent = '0%';
        if (countElement) countElement.textContent = '0';
    }

    updateButtonStates(isDetecting) {
        const startBtn = document.getElementById('start-detection-btn');
        const stopBtn = document.getElementById('stop-detection-btn');
        const resetBtn = document.getElementById('reset-detection-btn');

        if (startBtn) startBtn.disabled = isDetecting;
        if (stopBtn) stopBtn.disabled = !isDetecting;
        if (resetBtn) resetBtn.disabled = isDetecting;

        this.isDetectionActive = isDetecting;
        this.updateRecordingButtonStates(isDetecting, this.isRecording);
    }

    showRecordingIndicator(show) {
        const indicator = document.getElementById('recording-indicator');
        if (indicator) indicator.style.display = show ? 'flex' : 'none';
    }

    updateConnectionStatus(connected) {
        console.log('連接狀態:', connected ? '已連接' : '已斷開');
    }

    handleStartDetectionResponse(data) {
        if (data.status === 'success') {
            console.log('檢測已成功啟動');
        } else {
            console.error('啟動檢測失敗:', data.message);
            this.showError(data.message || '啟動檢測失敗');
            this.updateButtonStates(false);
            this.showRecordingIndicator(false);
        }
    }

    handleStopDetectionResponse(data) {
        this.stopRecordingTimer();
        this.isRecording = false;
        this.detectionStartTime = null;

        if (data.status === 'success') {
            console.log('檢測已成功停止');
            if (data.message) this.showSuccess(data.message);

            if (data.keep_video && data.recording_data) {
                console.log('影片已保存:', data.recording_data);
                this.lastRecordingData = data.recording_data;
                this.updateDownloadLinks(data.recording_data);
            }
        } else {
            console.error('停止檢測失敗:', data.message);
            this.showError(data.message || '停止檢測失敗');
        }
    }

    handleResetResponse(data) {
        if (data.status === 'success') {
            console.log('檢測已成功重置');
        } else {
            console.error('重置檢測失敗:', data.message);
            this.showError(data.message || '重置檢測失敗');
        }
    }

    detectAvailableCameras() {
        if (!this.socket || !this.socket.connected) {
            this.showError('Socket 未連接，請刷新頁面重試');
            return;
        }

        console.log('檢測可用攝像頭...');

        const detectBtn = document.getElementById('detect-cameras-btn');
        if (detectBtn) {
            detectBtn.disabled = true;
            detectBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 檢測中...';
        }

        this.socket.emit('detect_cameras');
    }

    handleCameraDetectionResponse(data) {
        const detectBtn = document.getElementById('detect-cameras-btn');

        if (detectBtn) {
            detectBtn.disabled = false;
            detectBtn.innerHTML = '<i class="fas fa-search"></i> 檢測攝像頭';
        }

        if (data.status === 'success') {
            this.availableCameras = data.cameras || [];
            this.updateCameraOptions();
            console.log('檢測到攝像頭:', this.availableCameras);

            if (this.availableCameras.length === 0) {
                this.showError('未檢測到可用的攝像頭');
            } else {
                this.showSuccess(`檢測到 ${this.availableCameras.length} 個攝像頭`);
            }
        } else {
            console.error('攝像頭檢測失敗:', data.message);
            this.showError(data.message || '攝像頭檢測失敗');
        }
    }

    updateCameraOptions() {
        const cameraSelect = document.getElementById('camera-select');
        if (!cameraSelect) return;

        cameraSelect.innerHTML = '';

        if (this.availableCameras.length === 0) {
            for (let i = 0; i < 4; i++) {
                const option = document.createElement('option');
                option.value = i;
                option.textContent = `攝像頭 ${i}${i === 0 ? ' (預設)' : ''}`;
                cameraSelect.appendChild(option);
            }
        } else {
            this.availableCameras.forEach((camera) => {
                const option = document.createElement('option');
                option.value = camera.index;
                option.textContent = `攝像頭 ${camera.index} - ${camera.name || '未知設備'}`;
                cameraSelect.appendChild(option);
            });
        }

        cameraSelect.value = this.selectedCameraIndex;
    }

    handleCameraReady() {
        if (this.cameraReady) return;

        this.cameraReady = true;
        this.waitingForCamera = false;

        console.log('攝像頭已就緒，開始同步錄製和數據記錄...');

        this.detectionStartTime = Date.now();
        this.currentDetectionTime = 0;

        const statusText = document.querySelector('.status-text');
        if (statusText) statusText.textContent = '檢測和錄製中';

        this.socket.emit('start_recording');
        this.resetChartData();

        console.log('同步開始：攝像頭畫面 + 影片錄製 + 圖表記錄');
    }

    onCameraSelectionChange(cameraIndex) {
        const newIndex = parseInt(cameraIndex);
        if (newIndex !== this.selectedCameraIndex) {
            this.selectedCameraIndex = newIndex;
            console.log('攝像頭索引已變更為:', this.selectedCameraIndex);
            if (this.isDetectionActive) {
                this.showInfo('攝像頭已變更，請停止並重新開始檢測以使用新的攝像頭');
            }
        }
    }

    startRecording() {
        if (!this.socket || !this.socket.connected) {
            this.showError('Socket 未連接，請刷新頁面重試');
            return;
        }
        if (!this.isDetectionActive) {
            this.showError('請先開始檢測再進行錄製');
            return;
        }
        console.log('開始錄製影片...');
        this.socket.emit('start_recording');
    }

    stopRecording() {
        if (!this.socket || !this.socket.connected) {
            this.showError('Socket 未連接');
            return;
        }
        console.log('停止錄製影片...');
        this.socket.emit('stop_recording');
    }

    handleRecordingStarted(data) {
        if (data.status === 'success') {
            this.isRecording = true;
            this.recordingStartTime = Date.now();
            this.updateRecordingButtonStates(true, true);
            this.startRecordingTimer();
            console.log('錄製已開始');
        } else {
            console.error('開始錄製失敗:', data.message);
            this.showError(data.message || '開始錄製失敗');
        }
    }

    handleRecordingStopped(data) {
        if (data.status === 'success') {
            this.isRecording = false;
            this.stopRecordingTimer();
            this.lastRecordingData = data;
            this.updateDownloadLinks(data);
            console.log('錄製已停止，影片已保留');
        } else {
            console.error('停止錄製失敗:', data.message);
            this.showError(data.message || '停止錄製失敗');
        }
    }

    handleRecordingDeleted(data) {
        if (data.status === 'success') {
            this.isRecording = false;
            this.stopRecordingTimer();
            this.lastRecordingData = null;
            console.log('錄製已停止，影片已刪除');
            this.showInfo('影片已刪除');
        } else {
            console.error('刪除錄製失敗:', data.message);
            this.showError(data.message || '刪除錄製失敗');
        }
    }

    updateRecordingStatus(data) {
        if (data.is_recording) {
            const duration = Math.floor(data.duration);
            this.updateRecordingTime(duration);
        }
    }

    startRecordingTimer() {
        const statusText = document.querySelector('.status-text');
        const recordingTime = document.getElementById('recording-time');

        if (statusText) statusText.textContent = '檢測和錄製中';
        if (recordingTime) recordingTime.classList.add('active');

        this.recordingTimer = setInterval(() => {
            if (this.recordingStartTime) {
                const elapsed = Math.floor((Date.now() - this.recordingStartTime) / 1000);
                this.updateRecordingTime(elapsed);
            }
        }, 1000);
    }

    stopRecordingTimer() {
        if (this.recordingTimer) {
            clearInterval(this.recordingTimer);
            this.recordingTimer = null;
        }

        const statusText = document.querySelector('.status-text');
        const recordingTime = document.getElementById('recording-time');

        if (statusText) statusText.textContent = '檢測完成';
        if (recordingTime) recordingTime.classList.remove('active');
    }

    updateRecordingTime(seconds) {
        const recordingTime = document.getElementById('recording-time');
        if (recordingTime) {
            const minutes = Math.floor(seconds / 60);
            const secs = seconds % 60;
            recordingTime.textContent = `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        }
    }

    updateRecordingButtonStates(isDetecting, isRecording) {
        // 保留空實作以避免錯誤
    }

    showError(message) {
        console.error('錯誤:', message);
        alert('錯誤: ' + message);
    }

    showSuccess(message) {
        console.log('成功:', message);
        alert('成功: ' + message);
    }

    showInfo(message) {
        console.info('信息:', message);
        alert('提示: ' + message);
    }

    destroy() {
        if (this.socket) this.socket.disconnect();
        if (this.angleChart) this.angleChart.destroy();
        if (this.velocityChart) this.velocityChart.destroy();
        console.log('跆拳道詳細姿態偵測管理器已銷毀');
    }

    /**
     * 更新下載鏈接（現在改為：設定回放影片來源與按鈕）
     */
    updateDownloadLinks(recordingData) {
        if (!recordingData) return;
        this.lastRecordingData = recordingData;

        const player = document.getElementById('recorded-player');
        const hint = document.getElementById('playback-hint');
        const btnOriginal = document.getElementById('btn-play-original');
        const btnAnalysis = document.getElementById('btn-play-analysis');

        if (player) {
            this.attachPlaybackPlayer(player);
            this.attachPlaybackDiagnostics(player);

            let initialSrc = null;
            if (recordingData.original_video) {
                initialSrc = `/download_video?path=${encodeURIComponent(recordingData.original_video)}`;
                if (hint) hint.textContent = '已載入最新原始影片';
            } else if (recordingData.skeleton_video) {
                initialSrc = `/download_video?path=${encodeURIComponent(recordingData.skeleton_video)}`;
                if (hint) hint.textContent = '已載入最新分析影片';
            }

            if (initialSrc) {
                player.src = initialSrc;
                player.load();

                // 自動嘗試播放（失敗就由使用者按播放鍵）
                player.play().catch((e) => {
                    console.warn('updateDownloadLinks: 自動播放失敗(通常是瀏覽器策略)，可忽略:', e);
                });

                this._autoFollow = true;
            }
        }

        if (btnOriginal) btnOriginal.disabled = !recordingData.original_video;
        if (btnAnalysis) btnAnalysis.disabled = !recordingData.skeleton_video;
    }
}

// 全局實例
let taekwondoDetailManager = null;

document.addEventListener('DOMContentLoaded', function () {
    console.log('頁面載入完成，初始化跆拳道詳細姿態偵測管理器...');
    taekwondoDetailManager = new TaekwondoDetailManager();
    window.taekwondoDetailManager = taekwondoDetailManager;
});

window.addEventListener('beforeunload', function () {
    if (taekwondoDetailManager) taekwondoDetailManager.destroy();
});

if (typeof module !== 'undefined' && module.exports) {
    module.exports = TaekwondoDetailManager;
}
