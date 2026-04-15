import cv2
import numpy as np
import time
import logging
from collections import deque
from services.pose_detection import get_pose_angles
from ultralytics import YOLO
import os
import threading
from datetime import datetime
import shutil
import subprocess

logger = logging.getLogger(__name__)


class TaekwondoDetailService:
    """跆拳道詳細姿態偵測服務"""

    def __init__(self):
        self.pose_model = None
        self.angle_history = {}
        self.velocity_history = {}
        self.acceleration_history = {}
        self.last_angles = {}
        self.last_velocities = {}
        self.last_timestamp = None
        self.action_count = 0
        self.current_action = "待檢測"
        self.action_confidence = 0.0

        # 歷史緩衝
        self.history_size = 30
        self.angle_joints = [
            'left_elbow', 'right_elbow',
            'left_knee', 'right_knee',
            'left_shoulder', 'right_shoulder',
            'left_hip', 'right_hip'
        ]

        # 影片錄製
        self.is_recording = False
        self.original_video_writer = None
        self.skeleton_video_writer = None
        self.recording_start_time = None
        self.recording_fps = 15
        self.recording_lock = threading.Lock()
        self.frame_timestamps = []
        self.recording_label = None
        self.frame_count = 0

        self.original_video_path = None
        self.skeleton_video_path = None
        self._writer_codec = None  # 記錄實際使用 codec

        # 軌跡追蹤
        self.joint_trajectories = {}
        self.trajectory_max_length = 15

        # 速度顏色映射
        self.velocity_color_map = {
            'low': (0, 255, 0),
            'medium': (0, 255, 255),
            'high': (0, 165, 255),
            'very_high': (0, 0, 255)
        }

        for joint in self.angle_joints:
            self.angle_history[joint] = deque(maxlen=self.history_size)
            self.velocity_history[joint] = deque(maxlen=self.history_size)
            self.acceleration_history[joint] = deque(maxlen=self.history_size)

        self.load_pose_model()

    def load_pose_model(self):
        """載入姿態檢測模型"""
        try:
            candidates = [
                os.path.join('static', 'models', 'YOLO_MODEL', 'pose', 'yolov8n-pose.pt'),
                os.path.join('static', 'models', 'YOLO_MODLE', 'pose', 'yolov8n-pose.pt'),
                'yolov8n-pose.pt'
            ]
            model_path = None
            for c in candidates:
                if os.path.exists(c):
                    model_path = c
                    break
            if model_path is None:
                model_path = 'yolov8n-pose.pt'

            self.pose_model = YOLO(model_path)
            logger.info(f"已載入姿態檢測模型: {model_path}")
        except Exception as e:
            logger.error(f"載入姿態檢測模型失敗: {e}", exc_info=True)
            raise

    def calculate_velocity(self, current_angle, previous_angle, time_delta):
        if time_delta <= 0:
            return 0.0
        return float((current_angle - previous_angle) / time_delta)

    def calculate_acceleration(self, current_velocity, previous_velocity, time_delta):
        if time_delta <= 0:
            return 0.0
        return float((current_velocity - previous_velocity) / time_delta)

    def smooth_data(self, data_history, window_size=5):
        if len(data_history) < window_size:
            return float(list(data_history)[-1]) if data_history else 0.0
        recent = list(data_history)[-window_size:]
        return float(sum(recent) / len(recent))

    def detect_taekwondo_action(self, angles, velocities):
        if angles.get('left_knee', 0) < 90 or angles.get('right_knee', 0) < 90:
            if abs(velocities.get('left_knee', 0)) > 50 or abs(velocities.get('right_knee', 0)) > 50:
                return "踢腿", 0.8

        if angles.get('left_elbow', 0) < 120 or angles.get('right_elbow', 0) < 120:
            if abs(velocities.get('left_elbow', 0)) > 80 or abs(velocities.get('right_elbow', 0)) > 80:
                return "出拳", 0.7

        if (angles.get('left_elbow', 0) > 90 and angles.get('right_elbow', 0) > 90 and
            angles.get('left_knee', 0) > 120 and angles.get('right_knee', 0) > 120):
            return "防守姿勢", 0.6

        return "基本姿勢", 0.5

    def process_frame(self, frame):
        current_time = time.time()

        try:
            results = self.pose_model(frame, conf=0.3, verbose=False)

            if len(results) > 0 and hasattr(results[0], 'keypoints') and results[0].keypoints is not None:
                keypoints = results[0].keypoints.xy[0].cpu().numpy()
                angles = get_pose_angles(keypoints)

                time_delta = 0.033
                if self.last_timestamp:
                    time_delta = current_time - self.last_timestamp

                velocities = {}
                accelerations = {}

                for joint in self.angle_joints:
                    cur = angles.get(joint, 0)

                    if joint in self.last_angles:
                        v = self.calculate_velocity(cur, self.last_angles[joint], time_delta)
                        velocities[joint] = v
                        if joint in self.last_velocities:
                            a = self.calculate_acceleration(v, self.last_velocities[joint], time_delta)
                            accelerations[joint] = a
                        else:
                            accelerations[joint] = 0.0
                    else:
                        velocities[joint] = 0.0
                        accelerations[joint] = 0.0

                    self.angle_history[joint].append(cur)
                    self.velocity_history[joint].append(velocities[joint])
                    self.acceleration_history[joint].append(accelerations[joint])

                smoothed_velocities = {j: self.smooth_data(self.velocity_history[j]) for j in self.angle_joints}
                smoothed_accelerations = {j: self.smooth_data(self.acceleration_history[j]) for j in self.angle_joints}

                action, confidence = self.detect_taekwondo_action(angles, smoothed_velocities)
                self.current_action = action
                self.action_confidence = confidence

                self.last_angles = angles.copy()
                self.last_velocities = velocities.copy()
                self.last_timestamp = current_time

                original_annotated_frame = self.draw_pose_landmarks(frame.copy(), keypoints)
                enhanced_frame = self.draw_enhanced_pose_landmarks(frame.copy(), keypoints, smoothed_velocities, angles)

                if self.is_recording:
                    self.save_recording_frames(original_annotated_frame, enhanced_frame)

                return {
                    'success': True,
                    'frame': enhanced_frame,
                    'original_frame': original_annotated_frame,
                    'angles': angles,
                    'velocities': smoothed_velocities,
                    'accelerations': smoothed_accelerations,
                    'action': action,
                    'confidence': confidence,
                    'count': self.action_count
                }

            # 即使沒檢測到姿態，也要把畫面寫進錄影，避免 stop 後「本次未產生影片」
            # （使用者站位/遮擋或模型瞬間失敗時，仍希望能回放原始畫面）
            if self.is_recording:
                try:
                    self.save_recording_frames(frame.copy(), frame.copy())
                except Exception:
                    pass

            return {'success': False, 'frame': frame, 'message': '未檢測到姿態'}

        except Exception as e:
            logger.error(f"處理幀時出錯: {e}", exc_info=True)
            return {'success': False, 'frame': frame, 'message': f'處理錯誤: {str(e)}'}

    def get_velocity_color(self, velocity):
        a = abs(velocity)
        if a < 20:
            return self.velocity_color_map['low']
        if a < 50:
            return self.velocity_color_map['medium']
        if a < 100:
            return self.velocity_color_map['high']
        return self.velocity_color_map['very_high']

    def draw_enhanced_pose_landmarks(self, frame, keypoints, velocities, angles=None):
        if len(keypoints) < 17:
            return frame
        if angles is None:
            angles = self.last_angles

        skeleton_connections = [
            ([5, 7], 'left_shoulder'), ([7, 9], 'left_elbow'),
            ([6, 8], 'right_shoulder'), ([8, 10], 'right_elbow'),
            ([5, 6], None),
            ([11, 12], None),
            ([5, 11], None), ([6, 12], None),
            ([11, 13], 'left_hip'), ([13, 15], 'left_knee'),
            ([12, 14], 'right_hip'), ([14, 16], 'right_knee')
        ]

        for connection, joint_name in skeleton_connections:
            if len(keypoints) > max(connection):
                pt1 = tuple(map(int, keypoints[connection[0]]))
                pt2 = tuple(map(int, keypoints[connection[1]]))

                if joint_name and joint_name in velocities:
                    color = self.get_velocity_color(velocities[joint_name])
                    thickness = max(2, min(8, int(abs(velocities[joint_name]) / 20) + 2))
                else:
                    color = (0, 255, 0)
                    thickness = 2
                cv2.line(frame, pt1, pt2, color, thickness)

        for point in keypoints:
            if len(point) >= 2:
                cv2.circle(frame, tuple(map(int, point)), 5, (0, 0, 255), -1)

        return frame

    def draw_pose_landmarks(self, frame, keypoints):
        if len(keypoints) < 17:
            return frame

        skeleton = [
            [5, 6], [5, 7], [7, 9], [6, 8], [8, 10],
            [5, 11], [6, 12], [11, 12],
            [11, 13], [13, 15], [12, 14], [14, 16]
        ]

        for connection in skeleton:
            if len(keypoints) > max(connection):
                pt1 = tuple(map(int, keypoints[connection[0]]))
                pt2 = tuple(map(int, keypoints[connection[1]]))
                cv2.line(frame, pt1, pt2, (0, 255, 0), 2)

        for point in keypoints:
            if len(point) >= 2:
                cv2.circle(frame, tuple(map(int, point)), 5, (0, 0, 255), -1)

        return frame

    def _open_writers_mp4(self, original_path: str, skeleton_path: str, fps: float, frame_size: tuple) -> bool:
        """
        重點：只要 codec/encoder 不可用，就不要假裝成功。
        優先 H264/avc1，其次 mp4v。
        """
        # 常見可用順序：H264/avc1 > mp4v
        codec_candidates = ['avc1', 'H264', 'mp4v']

        for c in codec_candidates:
            try:
                fourcc = cv2.VideoWriter_fourcc(*c)
                ow = cv2.VideoWriter(original_path, fourcc, fps, frame_size)
                sw = cv2.VideoWriter(skeleton_path, fourcc, fps, frame_size)

                if ow.isOpened() and sw.isOpened():
                    self.original_video_writer = ow
                    self.skeleton_video_writer = sw
                    self._writer_codec = c
                    logger.info(f"VideoWriter 開啟成功，codec={c}")
                    return True

                try:
                    ow.release()
                except Exception:
                    pass
                try:
                    sw.release()
                except Exception:
                    pass

            except Exception:
                continue

        self._writer_codec = None
        return False

    # -------------------------
    # ffmpeg (H.264 + faststart)
    # -------------------------
    def _find_ffmpeg(self) -> str | None:
        """Find ffmpeg executable.

        Priority:
        1) PATH via shutil.which
        2) Common WinGet install path (Gyan FFmpeg)
        """
        p = shutil.which('ffmpeg') or shutil.which('ffmpeg.exe')
        if p:
            return p

        # WinGet (Gyan) typical path under user profile
        try:
            home = os.path.expanduser('~')
            guess = os.path.join(
                home,
                'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages',
            )
            if os.path.isdir(guess):
                # Find newest ffmpeg.exe under Packages
                candidates = []
                for root, _, files in os.walk(guess):
                    if 'ffmpeg.exe' in files:
                        candidates.append(os.path.join(root, 'ffmpeg.exe'))
                if candidates:
                    candidates.sort(key=lambda x: os.path.getmtime(x), reverse=True)
                    return candidates[0]
        except Exception:
            pass

        return None

    def _convert_to_h264_faststart(self, in_path: str) -> str | None:
        """Convert mp4 to H.264 baseline (browser-friendly) and relocate moov atom to the head.

        Returns output path if success, else None.
        """
        ffmpeg = self._find_ffmpeg()
        if not ffmpeg:
            logger.warning("找不到 ffmpeg，略過轉檔")
            return None

        if not in_path or (not os.path.exists(in_path)):
            return None

        base, ext = os.path.splitext(in_path)
        out_path = f"{base}_h264.mp4"

        # 轉成瀏覽器普遍可播放的 H.264 (Baseline) + faststart
        cmd = [
            ffmpeg,
            '-y',
            '-i', in_path,
            '-c:v', 'libx264',
            '-profile:v', 'baseline',
            '-level', '3.0',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            '-an',
            out_path
        ]

        try:
            logger.info(f"開始 ffmpeg 轉檔: {' '.join(cmd)}")
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            if r.returncode != 0:
                logger.warning(f"ffmpeg 轉檔失敗 (code={r.returncode})\nstdout=\n{r.stdout[-4000:]}\nstderr=\n{r.stderr[-4000:]}")
                return None
            if os.path.exists(out_path) and os.path.getsize(out_path) > 1024:
                return out_path
            return None
        except Exception as e:
            logger.warning(f"ffmpeg 轉檔發生例外: {e}")
            return None

    def start_recording(self, output_dir="recordings"):
        try:
            with self.recording_lock:
                if self.is_recording:
                    logger.warning("錄製已在進行中")
                    return False

                abs_output_dir = os.path.abspath(output_dir)
                os.makedirs(abs_output_dir, exist_ok=True)

                self.recording_label = datetime.now().strftime("%Y%m%d_%H%M%S")
                original_filename = f"taekwondo_original_{self.recording_label}.mp4"
                skeleton_filename = f"taekwondo_analysis_{self.recording_label}.mp4"

                self.original_video_path = os.path.abspath(os.path.join(abs_output_dir, original_filename))
                self.skeleton_video_path = os.path.abspath(os.path.join(abs_output_dir, skeleton_filename))

                frame_size = (720, 720)

                ok = self._open_writers_mp4(
                    self.original_video_path,
                    self.skeleton_video_path,
                    float(self.recording_fps),
                    frame_size
                )
                if not ok:
                    logger.error("無法初始化 MP4 VideoWriter（你的 OpenCV/FFmpeg 不支援 H264/mp4v 輸出）")
                    self.original_video_writer = None
                    self.skeleton_video_writer = None
                    return False

                self.is_recording = True
                self.recording_start_time = time.time()
                self.frame_count = 0
                self.frame_timestamps = []

                # 某些 Windows/OpenCV 組合下，VideoWriter 只有在寫入第一幀後才會真正建立檔案。
                # 若使用者很快停止（或偵測不到姿態導致沒寫入任何幀），檔案可能是 0 bytes，
                # 前端就會顯示「本次未產生影片」。先寫入一張黑底占位幀，
                # 確保檔案 header 與 moov 結構能被建立。
                try:
                    w, h = frame_size
                    dummy = np.zeros((h, w, 3), dtype=np.uint8)
                    self.original_video_writer.write(dummy)
                    self.skeleton_video_writer.write(dummy)
                    self.frame_count = 1
                except Exception:
                    # 寫入占位幀失敗不致命，至少維持錄製流程
                    pass

                logger.info(f"開始錄製：codec={self._writer_codec} 原始={self.original_video_path} 分析={self.skeleton_video_path}")
                return True

        except Exception as e:
            logger.error(f"開始錄製失敗: {e}", exc_info=True)
            return False

    def save_recording_frames(self, original_frame, skeleton_frame):
        try:
            if not self.is_recording:
                return

            target_size = (720, 720)
            original_resized = cv2.resize(original_frame, target_size)
            skeleton_resized = cv2.resize(skeleton_frame, target_size)

            if self.original_video_writer and self.original_video_writer.isOpened():
                self.original_video_writer.write(original_resized)
            else:
                logger.warning("原始影片寫入器未開啟")

            if self.skeleton_video_writer and self.skeleton_video_writer.isOpened():
                self.skeleton_video_writer.write(skeleton_resized)
            else:
                logger.warning("分析影片寫入器未開啟")

            self.frame_count += 1
            self.frame_timestamps.append(time.time())

        except Exception as e:
            logger.error(f"保存錄製幀失敗: {e}", exc_info=True)

    def stop_recording(self):
        try:
            with self.recording_lock:
                if not self.is_recording:
                    logger.warning("沒有正在進行的錄製")
                    return None

                self.is_recording = False

                try:
                    if self.original_video_writer:
                        self.original_video_writer.release()
                except Exception:
                    pass
                try:
                    if self.skeleton_video_writer:
                        self.skeleton_video_writer.release()
                except Exception:
                    pass

                self.original_video_writer = None
                self.skeleton_video_writer = None

                duration = time.time() - self.recording_start_time if self.recording_start_time else 0.0

                # 檔案檢查：存在且非空（避免 0 bytes）。
                # 之前用 >1024 bytes 的門檻在「短錄影」時太嚴格，會讓前端誤判為「本次未產生影片」。
                def ok_file(p: str) -> bool:
                    try:
                        return bool(p) and os.path.exists(p) and os.path.getsize(p) > 0
                    except Exception:
                        return False

                original_ok = ok_file(self.original_video_path)
                skeleton_ok = ok_file(self.skeleton_video_path)

                logger.info(f"停止錄製：frames={self.frame_count} duration={duration:.2f}s codec={self._writer_codec}")
                logger.info(f"原始檔 OK={original_ok} path={self.original_video_path}")
                logger.info(f"分析檔 OK={skeleton_ok} path={self.skeleton_video_path}")

                if not original_ok or not skeleton_ok:
                    logger.error("錄影檔產出失敗或檔案過小（通常是 codec/encoder 不支援導致）")
                    return None

                # 重要：Chrome/Edge 對 MP4 容器通常只保證支援 H.264(AAC)。
                # OpenCV 的 mp4v (MPEG-4 Part 2) 很常造成 <video> 直接報 code=4。
                # 因此這裡盡量轉成 H.264 + faststart 版本，讓瀏覽器可順利播放。
                original_h264 = self._convert_to_h264_faststart(self.original_video_path)
                skeleton_h264 = self._convert_to_h264_faststart(self.skeleton_video_path)

                # 若轉檔成功，優先回傳轉檔後的檔案路徑
                if original_h264 and ok_file(original_h264):
                    logger.info(f"原始影片已轉成 H.264: {original_h264}")
                    original_path_for_play = os.path.abspath(original_h264)
                else:
                    logger.warning("原始影片未轉成 H.264（可能 ffmpeg 不可用或轉檔失敗）")
                    original_path_for_play = os.path.abspath(self.original_video_path)

                if skeleton_h264 and ok_file(skeleton_h264):
                    logger.info(f"分析影片已轉成 H.264: {skeleton_h264}")
                    skeleton_path_for_play = os.path.abspath(skeleton_h264)
                else:
                    logger.warning("分析影片未轉成 H.264（可能 ffmpeg 不可用或轉檔失敗）")
                    skeleton_path_for_play = os.path.abspath(self.skeleton_video_path)

                data = {
                    # 前端播放請用這兩個
                    'original_video': original_path_for_play,
                    'skeleton_video': skeleton_path_for_play,
                    # 供除錯/備用
                    'original_video_raw': os.path.abspath(self.original_video_path),
                    'skeleton_video_raw': os.path.abspath(self.skeleton_video_path),
                    'original_video_h264': os.path.abspath(original_h264) if original_h264 else None,
                    'skeleton_video_h264': os.path.abspath(skeleton_h264) if skeleton_h264 else None,
                    'duration': float(duration),
                    'fps': float(self.recording_fps),
                    'codec': self._writer_codec
                }
                if self.recording_label:
                    data['started_at'] = self.recording_label
                return data

        except Exception as e:
            logger.error(f"停止錄製失敗: {e}", exc_info=True)
            return None
        finally:
            self.recording_label = None
            self._writer_codec = None

    def reset(self):
        if self.is_recording:
            self.stop_recording()

        self.angle_history.clear()
        self.velocity_history.clear()
        self.acceleration_history.clear()
        self.last_angles.clear()
        self.last_velocities.clear()
        self.last_timestamp = None
        self.action_count = 0
        self.current_action = "待檢測"
        self.action_confidence = 0.0

        for joint in self.angle_joints:
            self.angle_history[joint] = deque(maxlen=self.history_size)
            self.velocity_history[joint] = deque(maxlen=self.history_size)
            self.acceleration_history[joint] = deque(maxlen=self.history_size)

        logger.info("跆拳道檢測狀態已重置")


# 單例
_taekwondo_service = None


def get_taekwondo_service():
    global _taekwondo_service
    if _taekwondo_service is None:
        _taekwondo_service = TaekwondoDetailService()
    return _taekwondo_service

