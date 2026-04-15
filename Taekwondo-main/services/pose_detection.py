import cv2
import numpy as np
import logging
import torch
from ultralytics import YOLO
import os

logger = logging.getLogger(__name__)

# 全局變量
models = {}  # 這個字典只用於存其他輔助模型
pose_model = None  # 專門用於姿態檢測的模型
pose_model_loaded = False  # 姿態檢測模型載入標誌

# 修改 setup_models 函數，不依賴 current_app
def setup_models():
    """設置模型"""
    global models
    
    try:
        # 使用本地模型路徑
        model_paths = {
            'pose': 'models/yolov8n-pose.pt',
            # 其他模型...
        }
        
        # 檢查本地模型文件
        for model_name, model_path in model_paths.items():
            # 嘗試加載本地模型文件
            local_path = os.path.join(os.path.dirname(__file__), '..', model_path)
            if os.path.exists(local_path):
                models[model_name] = YOLO(local_path)
                logger.info(f"已加載本地模型: {model_name} 從 {local_path}")
            else:
                # 如果本地文件不存在，從網絡下載
                models[model_name] = YOLO(model_path)
                logger.info(f"已從網絡加載模型: {model_name}")
        
        return True
    except Exception as e:
        logger.error(f"設置模型時出錯: {e}", exc_info=True)
        return False

def calculate_angle(a, b, c):
    """計算三點之間的角度"""
    # 將 a, b, c 轉換為 numpy 數組
    a, b, c = np.array(a), np.array(b), np.array(c)

    # 計算向量 BA 和 BC（即從 b 到 a 以及從 b 到 c 的向量）
    ba = a - b
    bc = c - b

    # 計算向量的點積
    dot_product = np.dot(ba, bc)

    # 計算向量的長度
    norm_ba = np.linalg.norm(ba)
    norm_bc = np.linalg.norm(bc)

    # 防止除以 0 的情況（如果某向量長度為 0，就直接返回 0 度）
    if norm_ba == 0 or norm_bc == 0:
        return 0.0

    # 計算夾角的 cosine 值，並利用 clip 限制範圍在 [-1, 1]
    cos_theta = np.clip(dot_product / (norm_ba * norm_bc), -1.0, 1.0)

    # 利用 arccos 求出角度，再轉換為度數
    angle = np.degrees(np.arccos(cos_theta))

    # 轉換為 Python 原生 float 類型以避免 JSON 序列化錯誤
    return float(angle)

def get_pose_angles(keypoints):
    """計算姿態關鍵點的角度"""
    angles = {}
    try:
        # Check if enough keypoints are detected
        if len(keypoints) < 17:
            # logger.debug("Not enough keypoints detected to calculate angles.")
            return angles  # Return empty dictionary if not enough keypoints

        left_shoulder = keypoints[5][:2]
        right_shoulder = keypoints[6][:2]
        left_elbow = keypoints[7][:2]
        right_elbow = keypoints[8][:2]
        left_wrist = keypoints[9][:2]
        right_wrist = keypoints[10][:2]
        left_hip = keypoints[11][:2]
        right_hip = keypoints[12][:2]
        left_knee = keypoints[13][:2]
        right_knee = keypoints[14][:2]
        left_ankle = keypoints[15][:2]
        right_ankle = keypoints[16][:2]

        # 檢查關鍵點坐標是否有效
        if any(np.isnan(kp).any() for kp in [left_shoulder, right_shoulder, left_elbow, right_elbow, left_wrist, right_wrist, left_hip, right_hip, left_knee, right_knee, left_ankle, right_ankle]):
            # logger.debug("Invalid keypoint coordinates detected.")
            return angles

        # 計算基本角度 (使用英文鍵名以匹配前端期望格式)
        try:
            angles['left_elbow'] = calculate_angle(left_shoulder, left_elbow, left_wrist)
            angles['right_elbow'] = calculate_angle(right_shoulder, right_elbow, right_wrist)
            angles['left_knee'] = calculate_angle(left_hip, left_knee, left_ankle)
            angles['right_knee'] = calculate_angle(right_hip, right_knee, right_ankle)
            angles['left_shoulder'] = calculate_angle(left_hip, left_shoulder, left_elbow)
            angles['right_shoulder'] = calculate_angle(right_hip, right_shoulder, right_elbow)
            angles['left_hip'] = calculate_angle(left_shoulder, left_hip, left_knee)
            angles['right_hip'] = calculate_angle(right_shoulder, right_hip, right_knee)
        except Exception as e:
            logger.error(f"Error calculating angles: {e}")

    except Exception as e:
        logger.error(f"Error in get_pose_angles: {e}")
    return angles

def load_models():
    """加載姿態檢測模型"""
    global pose_model, pose_model_loaded
    
    # 如果模型已經載入，直接返回
    if pose_model_loaded and pose_model is not None:
        logger.info("姿態檢測模型已載入，跳過重複載入")
        return
    
    try:
        # 從配置獲取模型路徑
        base_dir = current_app.config['BASE_DIR']
        
        # 加載姿態檢測模型模型
        logger.info("正在加載姿態檢測模型...")
        pose_path = os.path.join(base_dir, 'static', 'models', 'YOLO_MODLE', 'pose', 'yolov8n-pose.pt')
        
        # 如果文件不存在，使用默認路徑
        if not os.path.exists(pose_path):
            logger.warning(f"姿態檢測模型文件不存在: {pose_path}，使用默認模型")
            pose_model = YOLO('yolov8n-pose.pt')
        else:
            pose_model = YOLO(pose_path)
        
        # 設置載入標誌
        pose_model_loaded = True
        logger.info("姿態檢測模型加載完成")
        
    except Exception as e:
        logger.error(f"加載模型時出錯: {e}", exc_info=True)
        raise