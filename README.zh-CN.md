# DemoBox

[English](README.md) · **简体中文**

一组小巧、独立的 AI 服务浏览器演示，用于客户现场和内部演示。每个演示在一个 localhost 页面上展示一项服务的独特能力；中控台（hub）可以在同一个页面里启动、停止和打开所有演示。

填好密钥，运行 `npm start`，打开页面即可。

## 演示列表

| 演示 | 展示内容 | 端口 |
|---|---|---|
| [GPT-Live](gpt-live/) | Azure OpenAI 全双工语音：在模型说话时直接插话，并在实时三轨时间线上看它把推理和工具调用委派给后端模型 | 3000 |
| [决策模型](decision/) | 把同一段输入和带类型的问题（是/否、选择、评分）同时发给 Microsoft-Decision-1、GPT Decisions API 和 Jev，并排比较答案、概率、一致性和延迟 | 3001 |
| [图像模型](images/) | 同一个提示词发给 GPT-Image-2.5 Flare 与 Sunburst、MAI-Image-2.6 与 Flash，比较出图时间、指令遵循检查清单（手动勾选或由盲评模型判定）、画质和成本 | 3002 |
| [Web IQ](webiq/) | 同一个查询发给 Microsoft Web IQ 和另外六个搜索 API（通过 SerpApi 的 Google、Tavily、Exa、Brave、Perplexity、Parallel），比较延迟、盲评相关性、时效性、返回内容量和成本 | 3003 |

每个演示目录下的 README 包含配置步骤、"演示要点"脚本、设置项和故障排查。

## 快速开始

需要 **Node.js 18.17+**。大多数演示没有 npm 依赖；`gpt-live` 需要一个依赖（`ws`），中控台会在第一次启动它时自动安装。

```bash
git clone <本仓库地址> demobox && cd demobox

# 为每个要运行的演示创建自己的 .env，然后填入密钥
cp webiq/.env.example webiq/.env

./start.sh --open          # 中控台运行在 http://localhost:8000，并在浏览器中打开
```

其他启动方式：

```bash
npm start                  # 只启动中控台，在页面上启动各个演示
npm run start:all          # 中控台 + 全部演示一起启动
./start.sh --all --open    # 同上，先检查 Node 版本，再打开中控台
cd webiq && npm start      # 单独运行任意一个演示
```

中控台会把每个演示标记为**运行中**、**运行中 · 需要配置**（已启动但缺少密钥）或**已停止**。只配置了部分服务商的演示也能运行，未配置的会显示为*未配置*。页面支持中文和英文。

## 配置

每个演示读取自己目录下的 `.env`（所有设置项见对应的 `.env.example`）。端点地址可以直接粘贴门户上显示的形式：Azure 资源端点、Foundry 项目 URL 或完整路径都可以。对 Azure 主机会自动选择 `api-key` 或 `Bearer` 认证，也可以用 `*_AUTH_HEADER` 手动指定。

密钥只保存在服务器端。浏览器只与 `localhost` 通信，由各演示的服务器调用外部服务，且不会把密钥返回给页面。`.env` 文件已加入 git 忽略列表：只提交 `.env.example`，不要提交 `.env`。

## 目录结构

```
demobox/
├── start.sh        启动脚本，含 Node 版本检查（--all、--open）
├── demos.json      中控台读取的演示注册表
├── hub/            中控台页面，端口 8000
├── gpt-live/       每个演示：server.js、public/、.env.example、README.md
├── decision/
├── images/
└── webiq/
```

## 测试

Web IQ 演示带有相关性评分的回归测试。测试使用模拟响应，不需要密钥或网络：

```bash
cd webiq && node --test relevance.test.js
```

## 参与开发

开发约定（纯 Node、无构建步骤、服务器代码结构、必需的 `/api/config` 接口、统一的界面风格）、新增演示的步骤，以及提交前的检查项，请见 [AGENTS.md](AGENTS.md)（英文）。
