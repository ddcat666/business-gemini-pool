"""Business Gemini OpenAPI 兼容服务
整合JWT获取和聊天功能，提供OpenAPI接口
支持多账号轮训
支持图片输出（OpenAI格式）
"""

import json
import time
import hmac
import hashlib
import base64
import uuid
import threading
import os
import re
import requests
from pathlib import Path
from datetime import datetime
from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any
from flask import Flask, request, Response, jsonify, send_from_directory, abort
from flask_cors import CORS

# 禁用SSL警告
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# 配置
CONFIG_FILE = Path(__file__).parent / "business_gemini_session.json"

# 图片缓存配置
IMAGE_CACHE_DIR = Path(__file__).parent / "image"
IMAGE_CACHE_HOURS = 1  # 图片缓存时间（小时）
IMAGE_CACHE_DIR.mkdir(exist_ok=True)

# API endpoints
BASE_URL = "https://biz-discoveryengine.googleapis.com/v1alpha/locations/global"
CREATE_SESSION_URL = f"{BASE_URL}/widgetCreateSession"
STREAM_ASSIST_URL = f"{BASE_URL}/widgetStreamAssist"
LIST_FILE_METADATA_URL = f"{BASE_URL}/widgetListSessionFileMetadata"
GETOXSRF_URL = "https://business.gemini.google/auth/getoxsrf"

# Flask应用
app = Flask(__name__, static_folder='.')
CORS(app)


class AccountManager:
    """多账号管理器，支持轮训策略"""
    
    def __init__(self):
        self.config = None
        self.accounts = []  # 账号列表
        self.current_index = 0  # 当前轮训索引
        self.account_states = {}  # 账号状态: {index: {jwt, jwt_time, session, available}}
        self.lock = threading.Lock()
    
    def load_config(self):
        """加载配置"""
        if CONFIG_FILE.exists():
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                self.config = json.load(f)
                self.accounts = self.config.get("accounts", [])
                # 初始化账号状态
                for i, acc in enumerate(self.accounts):
                    available = acc.get("available", True)  # 默认可用
                    self.account_states[i] = {
                        "jwt": None,
                        "jwt_time": 0,
                        "session": None,
                        "available": available
                    }
        return self.config
    
    def save_config(self):
        """保存配置到文件"""
        if self.config and CONFIG_FILE.exists():
            with open(CONFIG_FILE, "w", encoding="utf-8") as f:
                json.dump(self.config, f, indent=4, ensure_ascii=False)
    
    def mark_account_unavailable(self, index: int, reason: str = ""):
        """标记账号不可用"""
        with self.lock:
            if 0 <= index < len(self.accounts):
                self.accounts[index]["available"] = False
                self.accounts[index]["unavailable_reason"] = reason
                self.accounts[index]["unavailable_time"] = datetime.now().isoformat()
                self.account_states[index]["available"] = False
                self.save_config()
                print(f"[!] 账号 {index} 已标记为不可用: {reason}")
    
    def get_available_accounts(self):
        """获取可用账号列表"""
        return [(i, acc) for i, acc in enumerate(self.accounts) 
                if self.account_states.get(i, {}).get("available", True)]
    
    def get_next_account(self):
        """轮训获取下一个可用账号"""
        with self.lock:
            available = self.get_available_accounts()
            if not available:
                raise Exception("没有可用的账号")
            
            # 轮训选择
            self.current_index = self.current_index % len(available)
            idx, account = available[self.current_index]
            self.current_index = (self.current_index + 1) % len(available)
            return idx, account
    
    def get_account_count(self):
        """获取账号数量统计"""
        total = len(self.accounts)
        available = len(self.get_available_accounts())
        return total, available


# 全局账号管理器
account_manager = AccountManager()


def check_proxy(proxy: str) -> bool:
    """检测代理是否可用"""
    if not proxy:
        return False
    try:
        proxies = {"http": proxy, "https": proxy}
        resp = requests.get("https://www.google.com", proxies=proxies, 
                          verify=False, timeout=10)
        return resp.status_code == 200
    except:
        return False


def url_safe_b64encode(data: bytes) -> str:
    """URL安全的Base64编码，不带padding"""
    return base64.urlsafe_b64encode(data).decode('utf-8').rstrip('=')


def kq_encode(s: str) -> str:
    """模拟JS的kQ函数"""
    byte_arr = bytearray()
    for char in s:
        val = ord(char)
        if val > 255:
            byte_arr.append(val & 255)
            byte_arr.append(val >> 8)
        else:
            byte_arr.append(val)
    return url_safe_b64encode(bytes(byte_arr))


def decode_xsrf_token(xsrf_token: str) -> bytes:
    """将 xsrfToken 解码为字节数组（用于HMAC签名）"""
    padding = 4 - len(xsrf_token) % 4
    if padding != 4:
        xsrf_token += '=' * padding
    return base64.urlsafe_b64decode(xsrf_token)


def create_jwt(key_bytes: bytes, key_id: str, csesidx: str) -> str:
    """创建JWT token"""
    now = int(time.time())

    header = {
        "alg": "HS256",
        "typ": "JWT",
        "kid": key_id
    }

    payload = {
        "iss": "https://business.gemini.google",
        "aud": "https://biz-discoveryengine.googleapis.com",
        "sub": f"csesidx/{csesidx}",
        "iat": now,
        "exp": now + 300,
        "nbf": now
    }

    header_b64 = kq_encode(json.dumps(header, separators=(',', ':')))
    payload_b64 = kq_encode(json.dumps(payload, separators=(',', ':')))
    message = f"{header_b64}.{payload_b64}"

    signature = hmac.new(key_bytes, message.encode('utf-8'), hashlib.sha256).digest()
    signature_b64 = url_safe_b64encode(signature)

    return f"{message}.{signature_b64}"


def get_jwt_for_account(account: dict, proxy: str) -> str:
    """为指定账号获取JWT"""
    secure_c_ses = account.get("secure_c_ses")
    host_c_oses = account.get("host_c_oses")
    csesidx = account.get("csesidx")

    if not secure_c_ses or not csesidx:
        raise ValueError("缺少 secure_c_ses 或 csesidx")

    url = f"{GETOXSRF_URL}?csesidx={csesidx}"
    proxies = {"http": proxy, "https": proxy} if proxy else None

    headers = {
        "accept": "*/*",
        "user-agent": account.get('user_agent', 'Mozilla/5.0'),
        "cookie": f'__Secure-C_SES={secure_c_ses}; __Host-C_OSES={host_c_oses}',
    }

    resp = requests.get(url, headers=headers, proxies=proxies, verify=False, timeout=30)

    # 处理Google安全前缀
    text = resp.text
    if text.startswith(")]}'\n") or text.startswith(")]}'"): 
        text = text[4:].strip()

    data = json.loads(text)
    key_id = data["keyId"]
    print(f"账号: {account.get('csesidx')} 账号可用! key_id: {key_id}")
    xsrf_token = data["xsrfToken"]

    key_bytes = decode_xsrf_token(xsrf_token)

    return create_jwt(key_bytes, key_id, csesidx)


def get_headers(jwt: str) -> dict:
    """获取请求头"""
    return {
        "accept": "*/*",
        "accept-encoding": "gzip, deflate, br, zstd",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        "authorization": f"Bearer {jwt}",
        "content-type": "application/json",
        "origin": "https://business.gemini.google",
        "referer": "https://business.gemini.google/",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        "x-server-timeout": "1800",
    }


def ensure_jwt_for_account(account_idx: int, account: dict):
    """确保指定账号的JWT有效，必要时刷新"""
    with account_manager.lock:
        state = account_manager.account_states[account_idx]
        if state["jwt"] is None or time.time() - state["jwt_time"] > 240:
            proxy = account_manager.config.get("proxy")
            try:
                state["jwt"] = get_jwt_for_account(account, proxy)
                state["jwt_time"] = time.time()
            except Exception as e:
                # JWT获取失败，标记账号不可用
                account_manager.mark_account_unavailable(account_idx, str(e))
                raise
        return state["jwt"]


def create_chat_session(jwt: str, team_id: str, proxy: str) -> str:
    """创建会话，返回session ID"""
    session_id = uuid.uuid4().hex[:12]
    body = {
        "configId": team_id,
        "additionalParams": {"token": "-"},
        "createSessionRequest": {
            "session": {"name": session_id, "displayName": session_id}
        }
    }

    proxies = {"http": proxy, "https": proxy} if proxy else None
    resp = requests.post(
        CREATE_SESSION_URL,
        headers=get_headers(jwt),
        json=body,
        proxies=proxies,
        verify=False,
        timeout=30
    )

    if resp.status_code != 200:
        if resp.status_code == 401:
            print(f"账号: {account.get('csesidx')} 一般情况下都是team_id填错了～")
        raise Exception(f"创建会话失败: {resp.status_code}")

    data = resp.json()
    return data.get("session", {}).get("name")


def ensure_session_for_account(account_idx: int, account: dict):
    """确保指定账号的会话有效"""
    jwt = ensure_jwt_for_account(account_idx, account)
    with account_manager.lock:
        state = account_manager.account_states[account_idx]
        if state["session"] is None:
            proxy = account_manager.config.get("proxy")
            team_id = account.get("team_id")
            state["session"] = create_chat_session(jwt, team_id, proxy)
        return state["session"], jwt, account.get("team_id")


# ==================== 图片处理功能 ====================

@dataclass
class ChatImage:
    """表示生成的图片"""
    url: Optional[str] = None
    base64_data: Optional[str] = None
    mime_type: str = "image/png"
    local_path: Optional[str] = None
    file_id: Optional[str] = None
    file_name: Optional[str] = None


@dataclass
class ChatResponse:
    """聊天响应，包含文本和图片"""
    text: str = ""
    images: List[ChatImage] = field(default_factory=list)
    thoughts: List[str] = field(default_factory=list)


def cleanup_expired_images():
    """清理过期的缓存图片"""
    if not IMAGE_CACHE_DIR.exists():
        return
    
    now = time.time()
    max_age_seconds = IMAGE_CACHE_HOURS * 3600
    
    for filepath in IMAGE_CACHE_DIR.iterdir():
        if filepath.is_file():
            try:
                file_age = now - filepath.stat().st_mtime
                if file_age > max_age_seconds:
                    filepath.unlink()
                    print(f"[图片缓存] 已删除过期图片: {filepath.name}")
            except Exception as e:
                print(f"[图片缓存] 删除失败: {filepath.name}, 错误: {e}")


def save_image_to_cache(image_data: bytes, mime_type: str = "image/png", filename: Optional[str] = None) -> str:
    """保存图片到缓存目录，返回文件名"""
    IMAGE_CACHE_DIR.mkdir(exist_ok=True)
    
    # 确定文件扩展名
    ext_map = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/gif": ".gif",
        "image/webp": ".webp",
    }
    ext = ext_map.get(mime_type, ".png")
    
    if filename:
        # 确保有正确的扩展名
        if not any(filename.endswith(e) for e in ext_map.values()):
            filename = f"{filename}{ext}"
    else:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"gemini_{timestamp}_{uuid.uuid4().hex[:8]}{ext}"
    
    filepath = IMAGE_CACHE_DIR / filename
    with open(filepath, "wb") as f:
        f.write(image_data)
    
    return filename


def extract_images_from_openai_content(content: Any) -> tuple[str, List[Dict]]:
    """从OpenAI格式的content中提取文本和图片
    
    返回: (文本内容, 图片列表[{type: 'base64'|'url', data: ...}])
    """
    if isinstance(content, str):
        return content, []
    
    if not isinstance(content, list):
        return str(content), []
    
    text_parts = []
    images = []
    
    for item in content:
        if not isinstance(item, dict):
            continue
        
        item_type = item.get("type", "")
        
        if item_type == "text":
            text_parts.append(item.get("text", ""))
        
        elif item_type == "image_url":
            image_url_obj = item.get("image_url", {})
            if isinstance(image_url_obj, str):
                url = image_url_obj
            else:
                url = image_url_obj.get("url", "")
            
            if url.startswith("data:"):
                # base64格式: data:image/png;base64,xxxxx
                match = re.match(r"data:([^;]+);base64,(.+)", url)
                if match:
                    mime_type = match.group(1)
                    base64_data = match.group(2)
                    images.append({
                        "type": "base64",
                        "mime_type": mime_type,
                        "data": base64_data
                    })
            else:
                # 普通URL
                images.append({
                    "type": "url",
                    "url": url
                })
    
    return "\n".join(text_parts), images


def download_image_from_url(url: str, proxy: Optional[str] = None) -> tuple[bytes, str]:
    """从URL下载图片，返回(图片数据, mime_type)"""
    proxies = {"http": proxy, "https": proxy} if proxy else None
    resp = requests.get(url, proxies=proxies, verify=False, timeout=60)
    resp.raise_for_status()
    
    content_type = resp.headers.get("Content-Type", "image/png")
    # 提取主mime类型
    mime_type = content_type.split(";")[0].strip()
    
    return resp.content, mime_type


def get_session_file_metadata(jwt: str, session_name: str, team_id: str, proxy: Optional[str] = None) -> Dict:
    """获取会话中的文件元数据（AI生成的图片）"""
    body = {
        "configId": team_id,
        "additionalParams": {"token": "-"},
        "listSessionFileMetadataRequest": {
            "name": session_name,
            "filter": "file_origin_type = AI_GENERATED"
        }
    }
    
    proxies = {"http": proxy, "https": proxy} if proxy else None
    resp = requests.post(
        LIST_FILE_METADATA_URL,
        headers=get_headers(jwt),
        json=body,
        proxies=proxies,
        verify=False,
        timeout=30
    )
    
    if resp.status_code != 200:
        print(f"[图片] 获取文件元数据失败: {resp.status_code}")
        return {}
    
    data = resp.json()
    # 返回 fileId -> metadata 的映射
    result = {}
    file_metadata_list = data.get("listSessionFileMetadataResponse", {}).get("fileMetadata", [])
    for meta in file_metadata_list:
        file_id = meta.get("fileId")
        if file_id:
            result[file_id] = meta
    return result


def build_download_url(session_name: str, file_id: str) -> str:
    """构造正确的下载URL"""
    return f"https://biz-discoveryengine.googleapis.com/v1alpha/{session_name}:downloadFile?fileId={file_id}&alt=media"


def download_file_with_jwt(jwt: str, session_name: str, file_id: str, proxy: Optional[str] = None) -> bytes:
    """使用JWT认证下载文件"""
    url = build_download_url(session_name, file_id)
    proxies = {"http": proxy, "https": proxy} if proxy else None
    
    resp = requests.get(
        url,
        headers=get_headers(jwt),
        proxies=proxies,
        verify=False,
        timeout=120,
        allow_redirects=True
    )
    
    resp.raise_for_status()
    content = resp.content
    
    # 检测是否为base64编码的内容
    try:
        text_content = content.decode("utf-8", errors="ignore").strip()
        if text_content.startswith("iVBORw0KGgo") or text_content.startswith("/9j/"):
            # 是base64编码，需要解码
            return base64.b64decode(text_content)
    except Exception:
        pass
    
    return content


def stream_chat_with_images(jwt: str, sess_name: str, message: str, images: List[Dict], 
                            proxy: str, team_id: str) -> ChatResponse:
    """发送消息并流式接收响应，支持图片输入输出
    
    Args:
        jwt: JWT token
        sess_name: 会话名称
        message: 用户消息文本
        images: 图片列表 [{type: 'base64'|'url', ...}]
        proxy: 代理地址
        team_id: 团队ID
    
    Returns:
        ChatResponse 包含文本和图片
    """
    # 构建查询parts
    query_parts = [{"text": message}]
    
    # 如果有输入图片，添加到parts中
    for img in images:
        if img.get("type") == "base64":
            query_parts.append({
                "inlineData": {
                    "mimeType": img.get("mime_type", "image/png"),
                    "data": img.get("data")
                }
            })
        elif img.get("type") == "url":
            # 先下载图片再转base64
            try:
                img_data, mime_type = download_image_from_url(img.get("url"), proxy)
                query_parts.append({
                    "inlineData": {
                        "mimeType": mime_type,
                        "data": base64.b64encode(img_data).decode("utf-8")
                    }
                })
            except Exception as e:
                print(f"[图片] 下载输入图片失败: {e}")
    
    body = {
        "configId": team_id,
        "additionalParams": {"token": "-"},
        "streamAssistRequest": {
            "session": sess_name,
            "query": {"parts": query_parts},
            "filter": "",
            "fileIds": [],
            "answerGenerationMode": "NORMAL",
            "toolsSpec": {
                "webGroundingSpec": {},
                "toolRegistry": "default_tool_registry",
                "imageGenerationSpec": {},
                "videoGenerationSpec": {}
            },
            "languageCode": "zh-CN",
            "userMetadata": {"timeZone": "Etc/GMT-8"},
            "assistSkippingMode": "REQUEST_ASSIST"
        }
    }

    proxies = {"http": proxy, "https": proxy} if proxy else None
    resp = requests.post(
        STREAM_ASSIST_URL,
        headers=get_headers(jwt),
        json=body,
        proxies=proxies,
        verify=False,
        timeout=120,
        stream=True
    )

    if resp.status_code != 200:
        raise Exception(f"请求失败: {resp.status_code}")

    # 收集完整响应
    full_response = ""
    for line in resp.iter_lines():
        if line:
            full_response += line.decode('utf-8') + "\n"

    # 解析响应
    result = ChatResponse()
    texts = []
    file_ids = []  # 收集需要下载的文件 {fileId, mimeType}
    current_session = None
    
    try:
        data_list = json.loads(full_response)
        for data in data_list:
            sar = data.get("streamAssistResponse")
            if not sar:
                continue
            
            # 获取session信息
            session_info = sar.get("sessionInfo", {})
            if session_info.get("session"):
                current_session = session_info["session"]
            
            # 检查顶层的generatedImages
            for gen_img in sar.get("generatedImages", []):
                parse_generated_image(gen_img, result, proxy)
            
            answer = sar.get("answer") or {}
            
            # 检查answer级别的generatedImages
            for gen_img in answer.get("generatedImages", []):
                parse_generated_image(gen_img, result, proxy)
            
            for reply in answer.get("replies", []):
                # 检查reply级别的generatedImages
                for gen_img in reply.get("generatedImages", []):
                    parse_generated_image(gen_img, result, proxy)
                
                gc = reply.get("groundedContent", {})
                content = gc.get("content", {})
                text = content.get("text", "")
                thought = content.get("thought", False)
                
                # 检查file字段（图片生成的关键）
                file_info = content.get("file")
                if file_info and file_info.get("fileId"):
                    file_ids.append({
                        "fileId": file_info["fileId"],
                        "mimeType": file_info.get("mimeType", "image/png"),
                        "fileName": file_info.get("name")
                    })
                
                # 解析图片数据
                parse_image_from_content(content, result, proxy)
                parse_image_from_content(gc, result, proxy)
                
                # 检查attachments
                for att in reply.get("attachments", []) + gc.get("attachments", []) + content.get("attachments", []):
                    parse_attachment(att, result, proxy)
                
                if text and not thought:
                    texts.append(text)
        
        # 处理通过fileId引用的图片
        if file_ids and current_session:
            try:
                file_metadata = get_session_file_metadata(jwt, current_session, team_id, proxy)
                for finfo in file_ids:
                    fid = finfo["fileId"]
                    mime = finfo["mimeType"]
                    fname = finfo.get("fileName")
                    meta = file_metadata.get(fid)
                    
                    if meta:
                        fname = fname or meta.get("name")
                        session_path = meta.get("session") or current_session
                    else:
                        session_path = current_session
                    
                    try:
                        image_data = download_file_with_jwt(jwt, session_path, fid, proxy)
                        filename = save_image_to_cache(image_data, mime, fname)
                        img = ChatImage(
                            file_id=fid,
                            file_name=filename,
                            mime_type=mime,
                            local_path=str(IMAGE_CACHE_DIR / filename)
                        )
                        result.images.append(img)
                        print(f"[图片] 已保存: {filename}")
                    except Exception as e:
                        print(f"[图片] 下载失败 (fileId={fid}): {e}")
            except Exception as e:
                print(f"[图片] 获取文件元数据失败: {e}")
                
    except json.JSONDecodeError:
        pass

    result.text = "".join(texts)
    return result


def parse_generated_image(gen_img: Dict, result: ChatResponse, proxy: Optional[str] = None):
    """解析generatedImages中的图片"""
    image_data = gen_img.get("image")
    if not image_data:
        return
    
    # 检查base64数据
    b64_data = image_data.get("bytesBase64Encoded")
    if b64_data:
        try:
            decoded = base64.b64decode(b64_data)
            mime_type = image_data.get("mimeType", "image/png")
            filename = save_image_to_cache(decoded, mime_type)
            img = ChatImage(
                base64_data=b64_data,
                mime_type=mime_type,
                file_name=filename,
                local_path=str(IMAGE_CACHE_DIR / filename)
            )
            result.images.append(img)
            print(f"[图片] 已保存: {filename}")
        except Exception as e:
            print(f"[图片] 解析base64失败: {e}")


def parse_image_from_content(content: Dict, result: ChatResponse, proxy: Optional[str] = None):
    """从content中解析图片"""
    # 检查inlineData
    inline_data = content.get("inlineData")
    if inline_data:
        b64_data = inline_data.get("data")
        if b64_data:
            try:
                decoded = base64.b64decode(b64_data)
                mime_type = inline_data.get("mimeType", "image/png")
                filename = save_image_to_cache(decoded, mime_type)
                img = ChatImage(
                    base64_data=b64_data,
                    mime_type=mime_type,
                    file_name=filename,
                    local_path=str(IMAGE_CACHE_DIR / filename)
                )
                result.images.append(img)
                print(f"[图片] 已保存: {filename}")
            except Exception as e:
                print(f"[图片] 解析inlineData失败: {e}")


def parse_attachment(att: Dict, result: ChatResponse, proxy: Optional[str] = None):
    """解析attachment中的图片"""
    # 检查是否是图片类型
    mime_type = att.get("mimeType", "")
    if not mime_type.startswith("image/"):
        return
    
    # 检查base64数据
    b64_data = att.get("data") or att.get("bytesBase64Encoded")
    if b64_data:
        try:
            decoded = base64.b64decode(b64_data)
            filename = att.get("name") or None
            filename = save_image_to_cache(decoded, mime_type, filename)
            img = ChatImage(
                base64_data=b64_data,
                mime_type=mime_type,
                file_name=filename,
                local_path=str(IMAGE_CACHE_DIR / filename)
            )
            result.images.append(img)
            print(f"[图片] 已保存: {filename}")
        except Exception as e:
            print(f"[图片] 解析attachment失败: {e}")


# ==================== OpenAPI 接口 ====================

@app.route('/v1/models', methods=['GET'])
def list_models():
    """获取模型列表"""
    models_config = account_manager.config.get("models", [])
    models_data = []
    
    for model in models_config:
        models_data.append({
            "id": model.get("id", "gemini-enterprise"),
            "object": "model",
            "created": int(time.time()),
            "owned_by": "google",
            "permission": [],
            "root": model.get("id", "gemini-enterprise"),
            "parent": None
        })
    
    # 如果没有配置模型，返回默认模型
    if not models_data:
        models_data.append({
            "id": "gemini-enterprise",
            "object": "model",
            "created": int(time.time()),
            "owned_by": "google",
            "permission": [],
            "root": "gemini-enterprise",
            "parent": None
        })
    
    return jsonify({"object": "list", "data": models_data})


@app.route('/v1/chat/completions', methods=['POST'])
def chat_completions():
    """聊天对话接口（支持图片输入输出）"""
    try:
        # 每次请求时清理过期图片
        cleanup_expired_images()
        
        data = request.json
        messages = data.get('messages', [])
        stream = data.get('stream', False)

        # 提取用户消息和图片
        user_message = ""
        input_images = []
        
        for msg in messages:
            if msg.get('role') == 'user':
                content = msg.get('content', '')
                text, images = extract_images_from_openai_content(content)
                if text:
                    user_message = text
                input_images.extend(images)

        if not user_message and not input_images:
            return jsonify({"error": "No user message found"}), 400
        
        # 轮训获取账号
        max_retries = len(account_manager.accounts)
        last_error = None
        chat_response = None
        
        for _ in range(max_retries):
            try:
                account_idx, account = account_manager.get_next_account()
                csesidx = account.get("csesidx", "unknown")
                print(f"[调度] 当前使用账号CSESIDX: {csesidx}")
                session, jwt, team_id = ensure_session_for_account(account_idx, account)
                proxy = account_manager.config.get("proxy")
                
                # 发送请求（支持图片）
                chat_response = stream_chat_with_images(jwt, session, user_message, input_images, proxy, team_id)
                break
            except Exception as e:
                last_error = e
                continue
        else:
            # 所有账号都失败
            return jsonify({"error": f"所有账号请求失败: {last_error}"}), 500

        # 构建响应内容（包含图片）
        response_content = build_openai_response_content(chat_response, request.host_url)

        if stream:
            # 流式响应
            def generate():
                chunk_id = f"chatcmpl-{uuid.uuid4().hex[:8]}"
                chunk = {
                    "id": chunk_id,
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": "gemini-enterprise",
                    "choices": [{
                        "index": 0,
                        "delta": {"content": response_content},
                        "finish_reason": None
                    }]
                }
                yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                
                # 结束标记
                end_chunk = {
                    "id": chunk_id,
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": "gemini-enterprise",
                    "choices": [{
                        "index": 0,
                        "delta": {},
                        "finish_reason": "stop"
                    }]
                }
                yield f"data: {json.dumps(end_chunk, ensure_ascii=False)}\n\n"
                yield "data: [DONE]\n\n"

            return Response(generate(), mimetype='text/event-stream')
        else:
            # 非流式响应
            response = {
                "id": f"chatcmpl-{uuid.uuid4().hex[:8]}",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": "gemini-enterprise",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": response_content
                    },
                    "finish_reason": "stop"
                }],
                "usage": {
                    "prompt_tokens": len(user_message),
                    "completion_tokens": len(chat_response.text),
                    "total_tokens": len(user_message) + len(chat_response.text)
                }
            }
            return jsonify(response)

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


def get_image_base_url(fallback_host_url: str) -> str:
    """获取图片基础URL
    
    优先使用配置文件中的 image_base_url，否则使用请求的 host_url
    """
    configured_url = account_manager.config.get("image_base_url", "").strip()
    if configured_url:
        # 确保以 / 结尾
        if not configured_url.endswith("/"):
            configured_url += "/"
        return configured_url
    return fallback_host_url


def build_openai_response_content(chat_response: ChatResponse, host_url: str) -> str:
    """构建OpenAI格式的响应内容
    
    返回纯文本，如果有图片则将图片URL追加到文本末尾
    """
    result_text = chat_response.text
    
    # 如果有图片，将图片URL追加到文本中
    if chat_response.images:
        base_url = get_image_base_url(host_url)
        image_urls = []
        
        for img in chat_response.images:
            if img.file_name:
                image_url = f"{base_url}image/{img.file_name}"
                image_urls.append(image_url)
        
        if image_urls:
            # 在文本末尾添加图片URL
            if result_text:
                result_text += "\n\n"
            result_text += "\n".join(image_urls)
    
    return result_text


# ==================== 图片服务接口 ====================

@app.route('/image/<path:filename>')
def serve_image(filename):
    """提供缓存图片的访问"""
    # 安全检查：防止路径遍历
    if '..' in filename or filename.startswith('/'):
        abort(404)
    
    filepath = IMAGE_CACHE_DIR / filename
    if not filepath.exists():
        abort(404)
    
    # 确定Content-Type
    ext = filepath.suffix.lower()
    mime_types = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
    }
    mime_type = mime_types.get(ext, 'application/octet-stream')
    
    return send_from_directory(IMAGE_CACHE_DIR, filename, mimetype=mime_type)


@app.route('/health', methods=['GET'])
def health_check():
    """健康检查"""
    return jsonify({"status": "ok", "timestamp": datetime.now().isoformat()})


@app.route('/v1/status', methods=['GET'])
def system_status():
    """获取系统状态"""
    total, available = account_manager.get_account_count()
    proxy = account_manager.config.get("proxy")
    
    return jsonify({
        "status": "ok",
        "timestamp": datetime.now().isoformat(),
        "accounts": {
            "total": total,
            "available": available
        },
        "proxy": {
            "url": proxy,
            "available": check_proxy(proxy) if proxy else False
        },
        "models": account_manager.config.get("models", [])
    })


# ==================== 管理接口 ====================

@app.route('/')
def index():
    """返回管理页面"""
    return send_from_directory('.', 'index.html')


@app.route('/api/accounts', methods=['GET'])
def get_accounts():
    """获取账号列表"""
    accounts_data = []
    for i, acc in enumerate(account_manager.accounts):
        state = account_manager.account_states.get(i, {})
        # 返回完整值用于编辑，前端显示时再截断
        accounts_data.append({
            "id": i,
            "team_id": acc.get("team_id", ""),
            "secure_c_ses": acc.get("secure_c_ses", ""),
            "host_c_oses": acc.get("host_c_oses", ""),
            "csesidx": acc.get("csesidx", ""),
            "user_agent": acc.get("user_agent", ""),
            "available": state.get("available", True),
            "unavailable_reason": acc.get("unavailable_reason", ""),
            "has_jwt": state.get("jwt") is not None
        })
    return jsonify({"accounts": accounts_data})


@app.route('/api/accounts', methods=['POST'])
def add_account():
    """添加账号"""
    data = request.json
    new_account = {
        "team_id": data.get("team_id", ""),
        "secure_c_ses": data.get("secure_c_ses", ""),
        "host_c_oses": data.get("host_c_oses", ""),
        "csesidx": data.get("csesidx", ""),
        "user_agent": data.get("user_agent", "Mozilla/5.0"),
        "available": True
    }
    
    account_manager.accounts.append(new_account)
    idx = len(account_manager.accounts) - 1
    account_manager.account_states[idx] = {
        "jwt": None,
        "jwt_time": 0,
        "session": None,
        "available": True
    }
    account_manager.config["accounts"] = account_manager.accounts
    account_manager.save_config()
    
    return jsonify({"success": True, "id": idx})


@app.route('/api/accounts/<int:account_id>', methods=['PUT'])
def update_account(account_id):
    """更新账号"""
    if account_id < 0 or account_id >= len(account_manager.accounts):
        return jsonify({"error": "账号不存在"}), 404
    
    data = request.json
    acc = account_manager.accounts[account_id]
    
    if "team_id" in data:
        acc["team_id"] = data["team_id"]
    if "secure_c_ses" in data:
        acc["secure_c_ses"] = data["secure_c_ses"]
    if "host_c_oses" in data:
        acc["host_c_oses"] = data["host_c_oses"]
    if "csesidx" in data:
        acc["csesidx"] = data["csesidx"]
    if "user_agent" in data:
        acc["user_agent"] = data["user_agent"]
    
    # 同步更新config中的accounts
    account_manager.config["accounts"] = account_manager.accounts
    account_manager.save_config()
    return jsonify({"success": True})


@app.route('/api/accounts/<int:account_id>', methods=['DELETE'])
def delete_account(account_id):
    """删除账号"""
    if account_id < 0 or account_id >= len(account_manager.accounts):
        return jsonify({"error": "账号不存在"}), 404
    
    account_manager.accounts.pop(account_id)
    # 重建状态映射
    new_states = {}
    for i in range(len(account_manager.accounts)):
        if i < account_id:
            new_states[i] = account_manager.account_states.get(i, {})
        else:
            new_states[i] = account_manager.account_states.get(i + 1, {})
    account_manager.account_states = new_states
    account_manager.config["accounts"] = account_manager.accounts
    account_manager.save_config()
    
    return jsonify({"success": True})


@app.route('/api/accounts/<int:account_id>/toggle', methods=['POST'])
def toggle_account(account_id):
    """切换账号状态"""
    if account_id < 0 or account_id >= len(account_manager.accounts):
        return jsonify({"error": "账号不存在"}), 404
    
    state = account_manager.account_states.get(account_id, {})
    current = state.get("available", True)
    state["available"] = not current
    account_manager.accounts[account_id]["available"] = not current
    
    if not current:
        # 重新启用时清除错误信息
        account_manager.accounts[account_id].pop("unavailable_reason", None)
        account_manager.accounts[account_id].pop("unavailable_time", None)
    
    account_manager.save_config()
    return jsonify({"success": True, "available": not current})


@app.route('/api/accounts/<int:account_id>/test', methods=['POST'])
def test_account(account_id):
    """测试账号JWT获取"""
    if account_id < 0 or account_id >= len(account_manager.accounts):
        return jsonify({"error": "账号不存在"}), 404
    
    account = account_manager.accounts[account_id]
    proxy = account_manager.config.get("proxy")
    
    try:
        jwt = get_jwt_for_account(account, proxy)
        return jsonify({"success": True, "message": "JWT获取成功"})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})


@app.route('/api/models', methods=['GET'])
def get_models_config():
    """获取模型配置"""
    models = account_manager.config.get("models", [])
    return jsonify({"models": models})


@app.route('/api/models', methods=['POST'])
def add_model():
    """添加模型"""
    data = request.json
    new_model = {
        "id": data.get("id", ""),
        "name": data.get("name", ""),
        "description": data.get("description", ""),
        "context_length": data.get("context_length", 32768),
        "max_tokens": data.get("max_tokens", 8192),
        "enabled": data.get("enabled", True)
    }
    
    if "models" not in account_manager.config:
        account_manager.config["models"] = []
    
    account_manager.config["models"].append(new_model)
    account_manager.save_config()
    
    return jsonify({"success": True})


@app.route('/api/models/<model_id>', methods=['PUT'])
def update_model(model_id):
    """更新模型"""
    models = account_manager.config.get("models", [])
    for model in models:
        if model.get("id") == model_id:
            data = request.json
            if "name" in data:
                model["name"] = data["name"]
            if "description" in data:
                model["description"] = data["description"]
            if "context_length" in data:
                model["context_length"] = data["context_length"]
            if "max_tokens" in data:
                model["max_tokens"] = data["max_tokens"]
            if "enabled" in data:
                model["enabled"] = data["enabled"]
            account_manager.save_config()
            return jsonify({"success": True})
    
    return jsonify({"error": "模型不存在"}), 404


@app.route('/api/models/<model_id>', methods=['DELETE'])
def delete_model(model_id):
    """删除模型"""
    models = account_manager.config.get("models", [])
    for i, model in enumerate(models):
        if model.get("id") == model_id:
            models.pop(i)
            account_manager.save_config()
            return jsonify({"success": True})
    
    return jsonify({"error": "模型不存在"}), 404


@app.route('/api/config', methods=['GET'])
def get_config():
    """获取完整配置"""
    return jsonify(account_manager.config)


@app.route('/api/config', methods=['PUT'])
def update_config():
    """更新配置"""
    data = request.json
    if "proxy" in data:
        account_manager.config["proxy"] = data["proxy"]
    account_manager.save_config()
    return jsonify({"success": True})


@app.route('/api/config/import', methods=['POST'])
def import_config():
    """导入配置"""
    try:
        data = request.json
        account_manager.config = data
        account_manager.accounts = data.get("accounts", [])
        # 重建账号状态
        account_manager.account_states = {}
        for i, acc in enumerate(account_manager.accounts):
            available = acc.get("available", True)
            account_manager.account_states[i] = {
                "jwt": None,
                "jwt_time": 0,
                "session": None,
                "available": available
            }
        account_manager.save_config()
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route('/api/proxy/test', methods=['POST'])
def test_proxy():
    """测试代理"""
    data = request.json
    proxy_url = data.get("proxy") or account_manager.config.get("proxy")
    
    if not proxy_url:
        return jsonify({"success": False, "message": "未配置代理地址"})
    
    available = check_proxy(proxy_url)
    return jsonify({
        "success": available,
        "message": "代理可用" if available else "代理不可用或连接超时"
    })


@app.route('/api/proxy/status', methods=['GET'])
def get_proxy_status():
    """获取代理状态"""
    proxy = account_manager.config.get("proxy")
    if not proxy:
        return jsonify({"enabled": False, "url": None, "available": False})
    
    available = check_proxy(proxy)
    return jsonify({
        "enabled": True,
        "url": proxy,
        "available": available
    })


@app.route('/api/config/export', methods=['GET'])
def export_config():
    """导出配置"""
    return jsonify(account_manager.config)


def print_startup_info():
    """打印启动信息"""
    print("="*60)
    print("Business Gemini OpenAPI 服务 (多账号轮训版)")
    print("支持图片输入输出 (OpenAI格式)")
    print("="*60)
    
    # 加载配置
    account_manager.load_config()
    
    # 代理信息
    proxy = account_manager.config.get("proxy")
    print(f"\n[代理配置]")
    print(f"  地址: {proxy or '未配置'}")
    if proxy:
        proxy_available = check_proxy(proxy)
        print(f"  状态: {'✓ 可用' if proxy_available else '✗ 不可用'}")
    
    # 图片缓存信息
    print(f"\n[图片缓存]")
    print(f"  目录: {IMAGE_CACHE_DIR}")
    print(f"  缓存时间: {IMAGE_CACHE_HOURS} 小时")
    
    # 账号信息
    total, available = account_manager.get_account_count()
    print(f"\n[账号配置]")
    print(f"  总数量: {total}")
    print(f"  可用数量: {available}")
    
    for i, acc in enumerate(account_manager.accounts):
        status = "✓" if account_manager.account_states.get(i, {}).get("available", True) else "✗"
        team_id = acc.get("team_id", "未知") + "..."
        print(f"  [{i}] {status} team_id: {team_id}")
    
    # 模型信息
    models = account_manager.config.get("models", [])
    print(f"\n[模型配置]")
    if models:
        for model in models:
            print(f"  - {model.get('id')}: {model.get('name', '')}")
    else:
        print("  - gemini-enterprise (默认)")
    
    print(f"\n[接口列表]")
    print("  GET  /v1/models           - 获取模型列表")
    print("  POST /v1/chat/completions - 聊天对话 (支持图片)")
    print("  GET  /v1/status           - 系统状态")
    print("  GET  /health              - 健康检查")
    print("  GET  /image/<filename>    - 获取缓存图片")
    print("\n" + "="*60)
    print("启动服务...")


if __name__ == '__main__':
    print_startup_info()
    
    if not account_manager.accounts:
        print("[!] 警告: 没有配置任何账号")
    
    app.run(host='0.0.0.0', port=8000, debug=False)
