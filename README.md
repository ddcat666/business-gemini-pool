# Business Gemini Pool 管理系统

一个基于 Flask 的 Google Gemini Enterprise API 代理服务，支持多账号轮训、OpenAI 兼容接口和 Web 管理控制台。

## 项目结构

```
/
├── gemini.py                      # 后端服务主程序
├── index.html                     # Web 管理控制台前端
├── business_gemini_session.json   # 配置文件
└── README.md                      # 项目文档
```

## 快速请求

### 发送聊天请求

```bash
curl --location --request POST 'http://127.0.0.1:8000/v1/chat/completions' \
--header 'Content-Type: application/json' \
--data-raw '{
    "model": "gemini-enterprise-2",
    "messages": [
        {
            "role": "user",
            "content": "你好"
        }
    ],
    "safe_mode": false
}'
```

## 功能特性

### 核心功能
- **多账号轮训**: 支持配置多个 Gemini 账号，自动轮训使用
- **OpenAI 兼容接口**: 提供与 OpenAI API 兼容的接口格式
- **流式响应**: 支持 SSE (Server-Sent Events) 流式输出
- **代理支持**: 支持 HTTP/HTTPS 代理配置
- **JWT 自动管理**: 自动获取和刷新 JWT Token
- **System Instruction**: 支持 OpenAI 格式的 system 角色消息
- **对话隔离**: 每次请求独立的会话上下文，支持多轮对话历史

### 管理功能
- **Web 控制台**: 美观的 Web 管理界面，支持明暗主题切换
- **账号管理**: 添加、编辑、删除、启用/禁用账号
- **模型配置**: 自定义模型参数配置
- **代理测试**: 在线测试代理连接状态
- **配置导入/导出**: 支持配置文件的导入导出

## 文件说明

### gemini.py

后端服务主程序，基于 Flask 框架开发。

#### 主要类和函数

| 名称 | 类型 | 说明 |
|------|------|------|
| `AccountManager` | 类 | 账号管理器，负责账号加载、保存、状态管理和轮训选择 |
| `load_config()` | 方法 | 从配置文件加载账号和配置信息 |
| `save_config()` | 方法 | 保存配置到文件 |
| `get_next_account()` | 方法 | 轮训获取下一个可用账号 |
| `mark_account_unavailable()` | 方法 | 标记账号为不可用状态 |
| `create_jwt()` | 函数 | 创建 JWT Token |
| `create_chat_session()` | 函数 | 创建聊天会话 |
| `stream_chat()` | 函数 | 发送聊天请求并获取响应 |
| `check_proxy()` | 函数 | 检测代理是否可用 |

#### API 接口

**OpenAI 兼容接口**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/models` | 获取可用模型列表 |
| POST | `/v1/chat/completions` | 聊天对话接口（支持图片） |
| POST | `/v1/files` | 上传文件 |
| GET | `/v1/files` | 获取文件列表 |
| GET | `/v1/files/<id>` | 获取文件信息 |
| DELETE | `/v1/files/<id>` | 删除文件 |
| GET | `/v1/status` | 获取系统状态 |
| GET | `/health` | 健康检查 |
| GET | `/image/<filename>` | 获取缓存图片 |

**管理接口**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 返回管理页面 |
| GET | `/api/accounts` | 获取账号列表 |
| POST | `/api/accounts` | 添加账号 |
| PUT | `/api/accounts/<id>` | 更新账号 |
| DELETE | `/api/accounts/<id>` | 删除账号 |
| POST | `/api/accounts/<id>/toggle` | 切换账号状态 |
| POST | `/api/accounts/<id>/test` | 测试账号 JWT 获取 |
| GET | `/api/models` | 获取模型配置 |
| POST | `/api/models` | 添加模型 |
| PUT | `/api/models/<id>` | 更新模型 |
| DELETE | `/api/models/<id>` | 删除模型 |
| GET | `/api/config` | 获取完整配置 |
| PUT | `/api/config` | 更新配置 |
| POST | `/api/config/import` | 导入配置 |
| GET | `/api/config/export` | 导出配置 |
| POST | `/api/proxy/test` | 测试代理 |
| GET | `/api/proxy/status` | 获取代理状态 |

### business_gemini_session.json

配置文件，JSON 格式，包含以下字段：

```json
{
    "proxy": "http://127.0.0.1:7890",
    "proxy_enabled": false,
    "accounts": [
        {
            "team_id": "团队ID",
            "secure_c_ses": "安全会话Cookie",
            "host_c_oses": "主机Cookie",
            "csesidx": "会话索引",
            "user_agent": "浏览器UA",
            "available": true
        }
    ],
    "models": [
        {
            "id": "模型ID",
            "name": "模型名称",
            "description": "模型描述",
            "context_length": 32768,
            "max_tokens": 8192,
            "price_per_1k_tokens": 0.0015
        }
    ]
}
```

#### 配置字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `proxy` | string | HTTP 代理地址 |
| `proxy_enabled` | boolean | 代理开关，`true` 启用代理，`false` 禁用代理（默认 `false`） |
| `accounts` | array | 账号列表 |
| `accounts[].team_id` | string | Google Cloud 团队 ID |
| `accounts[].secure_c_ses` | string | 安全会话 Cookie |
| `accounts[].host_c_oses` | string | 主机 Cookie |
| `accounts[].csesidx` | string | 会话索引 |
| `accounts[].user_agent` | string | 浏览器 User-Agent |
| `accounts[].available` | boolean | 账号是否可用 |
| `models` | array | 模型配置列表 |
| `models[].id` | string | 模型唯一标识 |
| `models[].name` | string | 模型显示名称 |
| `models[].description` | string | 模型描述 |
| `models[].context_length` | number | 上下文长度限制 |
| `models[].max_tokens` | number | 最大输出 Token 数 |

### index.html

Web 管理控制台前端，单文件 HTML 应用。

#### 功能模块

1. **仪表盘**: 显示系统概览、账号统计、代理状态
2. **账号管理**: 账号的增删改查、状态切换、JWT 测试
3. **模型配置**: 模型的增删改查
4. **系统设置**: 代理配置、配置导入导出

#### 界面特性

- 响应式设计，适配不同屏幕尺寸
- 支持明暗主题切换
- Google Material Design 风格
- 实时状态更新

## 快速开始

### 环境要求

- Python 3.7+
- Flask
- requests

### 方式一：直接运行

#### 安装依赖

```bash
pip install flask requests flask-cors
```

#### 配置账号

编辑 `business_gemini_session.json` 文件，添加你的 Gemini 账号信息：

```json
{
    "proxy": "http://your-proxy:port",
    "proxy_enabled": true,
    "accounts": [
        {
            "team_id": "your-team-id",
            "secure_c_ses": "your-secure-c-ses",
            "host_c_oses": "your-host-c-oses",
            "csesidx": "your-csesidx",
            "user_agent": "Mozilla/5.0 ...",
            "available": true
        }
    ],
    "models": []
}
```

#### 启动服务

```bash
python gemini.py
```

服务将在 `http://127.0.0.1:8000` 启动。

### 方式二：使用 docker-compose 启动服务

在项目目录下手动创建 business_gemini_session.json 后

使用命令启动：

```bash
docker-compose up -d
```

### 访问管理控制台

- 直接运行：`http://127.0.0.1:8000/`
- Docker 部署：`http://127.0.0.1:8000/`

## API 使用示例

### 获取模型列表

```bash
curl http://127.0.0.1:8000/v1/models
```

### 聊天对话

```bash
curl -X POST http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-enterprise",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ],
    "stream": false
  }'
```

### 流式对话

```bash
curl -X POST http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-enterprise",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ],
    "stream": true
  }'
```

### System Instruction（系统设定）

支持 OpenAI 标准的 system 角色消息，用于设定 AI 的行为：

```bash
curl -X POST http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-enterprise",
    "messages": [
      {"role": "system", "content": "你是一只可爱的猫咪，每句话结尾都要加喵~"},
      {"role": "user", "content": "你好"}
    ]
  }'
```

### 多轮对话（对话历史）

支持发送完整的对话历史，AI 会理解上下文：

```bash
curl -X POST http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-enterprise",
    "messages": [
      {"role": "system", "content": "你是一个友好的助手"},
      {"role": "user", "content": "我的名字是小明"},
      {"role": "assistant", "content": "你好小明！很高兴认识你！"},
      {"role": "user", "content": "我的名字是什么？"}
    ]
  }'
```

> **说明**: 每次 API 请求都会创建新的会话，不同请求之间互不影响。同一请求内的所有消息会作为完整对话发送给 AI。

### 带图片对话

支持两种图片发送方式：

#### 方式1：先上传文件，再引用 file_id

```bash
# 1. 上传图片
curl -X POST http://127.0.0.1:8000/v1/files \
  -F "file=@image.png" \
  -F "purpose=assistants"
# 返回: {"id": "file-xxx", ...}

# 2. 引用 file_id 发送消息
curl -X POST http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-enterprise",
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "text", "text": "描述这张图片"},
          {"type": "file", "file_id": "file-xxx"}
        ]
      }
    ]
  }'
```

#### 方式2：内联 base64 图片（自动上传）

**OpenAI 标准格式**

```bash
curl -X POST http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-enterprise",
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "text", "text": "描述这张图片"},
          {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
        ]
      }
    ]
  }'
```

**prompts 格式（files 数组）**

```bash
curl -X POST http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-enterprise",
    "prompts": [
      {
        "role": "user",
        "text": "描述这张图片",
        "files": [
          {
            "data": "data:image/png;base64,...",
            "type": "image"
          }
        ]
      }
    ]
  }'
```

> **注意**: 内联 base64 图片会自动上传到 Gemini 获取 fileId，然后发送请求。

## 注意事项

1. **安全性**: 配置文件中包含敏感信息，请妥善保管，不要提交到公开仓库
2. **代理**: 如果需要访问 Google 服务，可能需要配置代理
3. **账号限制**: 请遵守 Google 的使用条款，合理使用 API
4. **JWT 有效期**: JWT Token 有效期有限，系统会自动刷新

## 许可证

MIT License
