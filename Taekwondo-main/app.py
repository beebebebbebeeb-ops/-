from flask import Flask, jsonify, render_template, request, send_file, Response
from flask_socketio import SocketIO, emit
import cv2
import base64
import numpy as np
import logging
import os
import glob
import mimetypes

from services.taekwondo_service import get_taekwondo_service

# 配置日誌（強制顯示）
logging.basicConfig(level=logging.INFO, format='[%(asctime)s] %(levelname)s %(name)s: %(message)s')
logger = logging.getLogger(__name__)

# 創建 Flask 應用
app = Flask(__name__)
app.config['SECRET_KEY'] = 'taekwondo_secret_key_2024'

# ✅ 指定 async_mode=threading，避免 eventlet/gevent 造成怪問題
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# 全域變數
taekwondo_detail_active = False
taekwondo_detail_session_id = None


@app.route('/')
def index():
    return render_template('taekwondo_detail.html')


@app.route('/taekwondo_detail')
def taekwondo_detail():
    return render_template('taekwondo_detail.html')


@socketio.on('connect', namespace='/exercise')
def handle_connect():
    logger.info('客戶端已連接到跆拳道檢測服務')
    emit('status', {'message': '已連接到跆拳道檢測服務'})


@socketio.on('disconnect', namespace='/exercise')
def handle_disconnect():
    global taekwondo_detail_active, taekwondo_detail_session_id
    logger.info('客戶端已斷開連接')

    if taekwondo_detail_active and taekwondo_detail_session_id:
        try:
            taekwondo_service = get_taekwondo_service()
            if taekwondo_service.is_recording:
                recording_data = taekwondo_service.stop_recording()
                logger.info(
                    f"錄製已停止，檔案：{recording_data.get('files', []) if isinstance(recording_data, dict) else recording_data}"
                )

            taekwondo_service.reset()
            logger.info("跆拳道檢測資源已清理")
        except Exception as e:
            logger.error(f"清理跆拳道檢測資源時出錯: {e}", exc_info=True)
        finally:
            taekwondo_detail_active = False
            taekwondo_detail_session_id = None


@socketio.on('video_frame', namespace='/exercise')
def handle_video_frame(data):
    global taekwondo_detail_active, taekwondo_detail_session_id

    try:
        if not taekwondo_detail_active:
            return

        image_data = base64.b64decode(data['image'].split(',')[1])
        nparr = np.frombuffer(image_data, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if frame is None:
            logger.error("無法解碼視頻幀")
            return

        taekwondo_service = get_taekwondo_service()
        result = taekwondo_service.process_frame(frame)

        if result and 'frame' in result:
            _, buffer = cv2.imencode('.jpg', result['frame'])
            processed_image = base64.b64encode(buffer).decode('utf-8')

            emit('processed_frame', {'image': f'data:image/jpeg;base64,{processed_image}'})

            if 'angles' in result:
                emit('taekwondo_angles', {'angles': result['angles'], 'timestamp': result.get('timestamp', 0)})

            if 'velocities' in result:
                emit('taekwondo_velocities', {'velocities': result['velocities'], 'timestamp': result.get('timestamp', 0)})

            if 'accelerations' in result:
                emit('taekwondo_accelerations', {'accelerations': result['accelerations'], 'timestamp': result.get('timestamp', 0)})

            if 'action' in result:
                emit('taekwondo_action', {
                    'action': result['action'],
                    'confidence': result.get('confidence', 0),
                    'count': result.get('count', 0)
                })

    except Exception as e:
        logger.error(f"處理視頻幀時出錯: {e}", exc_info=True)
        emit('error', {'message': f'處理視頻幀失敗: {str(e)}'})


@socketio.on('start_exercise', namespace='/exercise')
def handle_start_exercise(data):
    global taekwondo_detail_active, taekwondo_detail_session_id

    try:
        exercise_type = data.get('exercise_type')

        if exercise_type == 'taekwondo-detail':
            taekwondo_detail_active = True
            taekwondo_detail_session_id = str(__import__('uuid').uuid4())

            taekwondo_service = get_taekwondo_service()
            taekwondo_service.reset()

            # 需求：固定產生影片並提供播放/下載。
            # 因此「開始檢測」時一律自動開始錄製，不再依前端參數決定。
            auto_record = True
            recording_success = taekwondo_service.start_recording()
            if recording_success:
                logger.info('跆拳道詳細檢測已啟動，自動開始錄製')
                emit('recording_started', {'status': 'success'})
            else:
                # 若錄製啟動失敗，仍允許檢測進行，但會回報錯誤供前端提示。
                logger.warning('跆拳道詳細檢測已啟動，但錄製啟動失敗')
                emit('error', {'message': '錄製啟動失敗（檢測仍會繼續）'})

            emit('taekwondo_angles', {'angles': {}, 'timestamp': 0})
            emit('taekwondo_velocities', {'velocities': {}, 'timestamp': 0})
            emit('taekwondo_accelerations', {'accelerations': {}, 'timestamp': 0})
            emit('taekwondo_action', {'action': '待檢測', 'confidence': 0, 'count': 0})

            emit('exercise_started', {
                'status': 'success',
                'exercise_type': exercise_type,
                'session_id': taekwondo_detail_session_id,
                'recording': auto_record
            })
        else:
            emit('error', {'message': f'不支援的運動類型: {exercise_type}'})

    except Exception as e:
        logger.error(f"啟動運動檢測失敗: {e}", exc_info=True)
        emit('error', {'message': f'啟動運動檢測失敗: {str(e)}'})


@socketio.on('stop_exercise', namespace='/exercise')
def handle_stop_exercise(data=None):
    global taekwondo_detail_active, taekwondo_detail_session_id

    try:
        if taekwondo_detail_active and taekwondo_detail_session_id:
            # 固定保留影片：移除「停止即刪除」的行為，避免誤刪與前端狀態不一致。
            keep_video = True
            logger.info("停止檢測：固定保留影片（keep_video=True）")

            taekwondo_service = get_taekwondo_service()
            recording_data = None

            if taekwondo_service.is_recording:
                recording_data = taekwondo_service.stop_recording()
                logger.info(f"錄製已停止，檔案：{recording_data}")

                # 不再提供刪除影片邏輯

            taekwondo_service.reset()
            taekwondo_detail_active = False
            taekwondo_detail_session_id = None

            response_data = {'status': 'success', 'keep_video': True}
            if recording_data:
                response_data['recording_data'] = recording_data
                response_data['message'] = '檢測已停止，影片已保存'
            else:
                response_data['message'] = '檢測已停止（本次未產生影片）'

            emit('exercise_stopped', response_data)
        else:
            emit('error', {'message': '沒有正在進行的檢測會話'})

    except Exception as e:
        logger.error(f"停止運動檢測失敗: {e}", exc_info=True)
        emit('error', {'message': f'停止運動檢測失敗: {str(e)}'})


@socketio.on('reset_taekwondo_detail', namespace='/exercise')
def handle_reset_taekwondo_detail():
    global taekwondo_detail_session_id

    try:
        logger.info('收到重置跆拳道詳細檢測請求')

        if taekwondo_detail_session_id:
            taekwondo_service = get_taekwondo_service()
            taekwondo_service.reset()

            emit('taekwondo_angles', {'angles': {}, 'timestamp': 0})
            emit('taekwondo_velocities', {'velocities': {}, 'timestamp': 0})
            emit('taekwondo_accelerations', {'accelerations': {}, 'timestamp': 0})
            emit('taekwondo_action', {'action': '待檢測', 'confidence': 0, 'count': 0})

            emit('reset_response', {'status': 'success', 'message': '跆拳道檢測已重置'})
        else:
            emit('error', {'message': '沒有活動的跆拳道檢測會話'})

    except Exception as e:
        logger.error(f"重置跆拳道詳細檢測失敗: {e}", exc_info=True)
        emit('error', {'message': f'重置跆拳道詳細檢測失敗: {str(e)}'})


@socketio.on('start_recording', namespace='/exercise')
def handle_start_recording():
    try:
        taekwondo_service = get_taekwondo_service()
        if taekwondo_service.is_recording:
            emit('recording_started', {'status': 'success', 'message': '錄製已在進行中'})
            return
        success = taekwondo_service.start_recording()
        if success:
            emit('recording_started', {'status': 'success'})
        else:
            emit('error', {'message': '開始錄製失敗'})
    except Exception as e:
        logger.error(f"開始錄製失敗: {e}", exc_info=True)
        emit('error', {'message': f'開始錄製失敗: {str(e)}'})


@socketio.on('stop_recording', namespace='/exercise')
def handle_stop_recording():
    try:
        taekwondo_service = get_taekwondo_service()
        data = taekwondo_service.stop_recording()
        if data:
            emit('recording_stopped', {'status': 'success', **data})
        else:
            emit('error', {'message': '目前沒有錄製或檔案生成失敗'})
    except Exception as e:
        logger.error(f"停止錄製失敗: {e}", exc_info=True)
        emit('error', {'message': f'停止錄製失敗: {str(e)}'})


def _recordings_dir_abs() -> str:
    return os.path.abspath('recordings')


def _is_allowed_path(p: str) -> bool:
    """只允許 recordings/ 下面的檔案，避免任意檔案讀取。"""
    if not p:
        return False
    rec_dir = _recordings_dir_abs()
    ap = os.path.abspath(p)
    return ap.startswith(rec_dir + os.sep) or ap == rec_dir


def _range_stream(file_path: str):
    """支援 HTML5 video Range Request。"""
    file_size = os.path.getsize(file_path)
    range_header = request.headers.get('Range', None)

    mime, _ = mimetypes.guess_type(file_path)
    if not mime:
        mime = 'video/mp4'

    if not range_header:
        return send_file(file_path, mimetype=mime, as_attachment=False, conditional=True)

    try:
        units, rng = range_header.split('=', 1)
        if units.strip().lower() != 'bytes':
            raise ValueError("Only 'bytes' range supported")

        start_str, end_str = rng.split('-', 1)
        start = int(start_str) if start_str else 0
        end = int(end_str) if end_str else file_size - 1

        start = max(0, start)
        end = min(end, file_size - 1)
        if start > end:
            start = 0
            end = file_size - 1

        length = end - start + 1

        def generate():
            with open(file_path, 'rb') as f:
                f.seek(start)
                remaining = length
                chunk_size = 1024 * 512
                while remaining > 0:
                    chunk = f.read(min(chunk_size, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk

        rv = Response(generate(), status=206, mimetype=mime, direct_passthrough=True)
        rv.headers.add('Content-Range', f'bytes {start}-{end}/{file_size}')
        rv.headers.add('Accept-Ranges', 'bytes')
        rv.headers.add('Content-Length', str(length))
        return rv

    except Exception as e:
        logger.error(f"解析 Range 失敗: {e}，Range={range_header}", exc_info=True)
        return send_file(file_path, mimetype=mime, as_attachment=False, conditional=True)


@app.route('/download_video')
def download_video():
    """串流錄製的影片給 <video> 播放（支援 Range）"""
    try:
        video_path = request.args.get('path')
        if not video_path:
            return jsonify({'error': '缺少影片路徑參數'}), 400

        if not os.path.exists(video_path):
            logger.error(f"影片檔案不存在: {video_path}")
            return jsonify({'error': '影片檔案不存在'}), 404

        if not _is_allowed_path(video_path):
            logger.error(f"不允許下載此路徑的檔案: {video_path}")
            return jsonify({'error': '不允許下載此檔案'}), 403

        logger.info(f"串流影片: {video_path}  Range={request.headers.get('Range')}")
        return _range_stream(video_path)

    except Exception as e:
        logger.error(f"串流影片失敗: {e}", exc_info=True)
        return jsonify({'error': f'下載失敗: {str(e)}'}), 500


def _scan_latest_recordings():
    """Scan `recordings/` for the latest pair of videos (original/analysis)."""
    rec_dir = _recordings_dir_abs()
    os.makedirs(rec_dir, exist_ok=True)
    # 優先選擇已轉成 H.264 的檔案（*_h264.mp4），避免瀏覽器播放 code=4
    mp4s = sorted(glob.glob(os.path.join(rec_dir, '*.mp4')), key=os.path.getmtime, reverse=True)
    if not mp4s:
        return None

    def is_h264(path: str) -> bool:
        return os.path.basename(path).lower().endswith('_h264.mp4')

    # 如果有 h264 檔，先以 h264 裡的最新檔為主
    h264s = [p for p in mp4s if is_h264(p)]
    latest = h264s[0] if h264s else mp4s[0]

    def is_analysis(path: str) -> bool:
        b = os.path.basename(path).lower()
        return ('skeleton' in b) or ('analysis' in b)

    mtime0 = os.path.getmtime(latest)
    pair = None
    for p in mp4s[1:12]:
        try:
            if abs(os.path.getmtime(p) - mtime0) <= 60:
                pair = p
                break
        except Exception:
            continue

    original = latest if not is_analysis(latest) else (pair or latest)
    analysis = pair if not is_analysis(latest) else latest

    def mk(path):
        if not path:
            return None
        try:
            return {
                "path": os.path.abspath(path),
                "filename": os.path.basename(path),
                "mtime": os.path.getmtime(path)
            }
        except Exception:
            return None

    return {
        "original": mk(original),
        "analysis": mk(analysis),
    }


@app.route('/recordings/latest')
def recordings_latest():
    data = _scan_latest_recordings()
    if not data:
        return jsonify({"error": "no_recordings"}), 404
    mtimes = [v["mtime"] for v in data.values() if v and v.get("mtime")]
    mtime = max(mtimes) if mtimes else None
    return jsonify({
        "original_video": data["original"]["path"] if data.get("original") else None,
        "skeleton_video": data["analysis"]["path"] if data.get("analysis") else None,
        "mtime": mtime
    })


if __name__ == '__main__':
    # ✅ 啟動時先明確印出來，避免你以為沒跑
    os.makedirs('recordings', exist_ok=True)
    print("Starting Taekwondo server: http://127.0.0.1:8080")
    logger.info("啟動跆拳道詳細姿態偵測應用...")

    # ✅ 關鍵：關掉 reloader，避免父行程秒退讓你看起來像沒跑
    socketio.run(
        app,
        debug=True,
        use_reloader=False,
        host='0.0.0.0',
        port=8080,
        allow_unsafe_werkzeug=True
    )
