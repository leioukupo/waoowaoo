<p align="center">
  <a href="https://trendshift.io/repositories/22585?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-22585" target="_blank" rel="noopener noreferrer">
    <img src="https://trendshift.io/api/badge/trendshift/repositories/22585/daily" alt="waoowaoo | Trendshift" width="250" height="55"/>
  </a>
</p>

<p align="center">一款基于 AI 的图片与视频创作工作台：与右侧 Assistant 连续对话，在画布中上传、整理参考素材，生成并迭代你的作品。</p>

<p align="center"><a href="https://www.waoowaoo.com/">加入内测候补</a> · <a href="https://github.com/waooAI/waoowaoo/issues">反馈问题</a></p>

> [!IMPORTANT]
> ⚠️ **测试版声明**：本项目目前处于测试阶段，存在部分 bug 和不完善之处。我们正在快速迭代更新中，欢迎进群反馈问题和需求，及时关注项目更新！

微信公众号 / 社区交流

<img src="https://github.com/user-attachments/assets/0f4ff766-f059-4554-9193-caf34b081c7b" width="30%">

---

## ✨ 功能特性

waoowaoo 把对话、素材和生成结果放进同一个项目。你可以从一个创意开始，逐步制作角色设定图、品牌视觉或动画短片，无需先准备一整套小说或剧本。

- **用画布组织创作**：上传素材，查看图片与视频，在项目中整理和复用资源。
- **与 Assistant 连续协作**：描述目标，引用已有素材，让 Assistant 帮你生成或调整创作内容。
- **手动控制生成参数**：通过草稿卡选择模型支持的画幅、时长、分辨率和其他可用参数。
- **用参考图保持方向**：按模型能力使用参考图片、首帧或首尾帧，衔接连续镜头。
- **继续加工结果**：预览生成内容，再制作新版本，或合并视频片段。

可用参数和参考方式取决于所选模型；并非每个模型都支持所有功能。应用界面目前支持**中文和英文**。

---

## 📋 部署前提

- **Docker**：Docker Engine 或 Docker Desktop（Linux 容器模式），Compose v2 ≥ 2.24.4（需支持 `!reset` 合并标签）。
- **系统工具**：Git、POSIX shell；`flock`（Linux 一般由 `util-linux` 自带，macOS 需单独安装；Windows 请在 WSL2 内运行）。
- **外部服务**：MySQL、Redis、Temporal、S3 兼容对象存储（MinIO / RustFS 等）。全部可以部署在同一台机器上（用 1Panel 或独立 Docker 均可），也可以在局域网的其他机器上。
- **Docker socket**：Web 容器会挂载 Docker socket，用于按项目启动受控的 Codex runtime 容器，请确保是可信的本地环境。
- **网络**：首次构建镜像会下载依赖（含约 260MB 的 ffmpeg 与 apt 包）。内网受限时可在 `.env` 配置 `FFMPEG_FFPROBE_STATIC_BASE_URL`（本地 ffmpeg 镜像）和 `CODEX_APT_MIRROR`（apt 镜像源）。

默认部署（Web-only 模式）下 Compose **只启动 `app` 与 `worker` 两个容器**，不启动 MySQL/Redis/S3；Temporal 默认作为外部服务（在初始化页配置）。如需让 Compose 直接托管 Temporal，见部署方法里的「可选：Compose 直接托管 Temporal」。宿主机本身只需要 Docker。

---

## 🚀 部署方法（Web-only 模式，默认路径）

Compose 只启动两个容器：`app`（Web 应用）和 `worker`（Temporal Worker）。基础设施全部使用你自己准备的外部服务。首次启动时应用会在 `./data` 自动生成内部密钥，外部服务的连接信息通过初始化页面填写并加密保存，`.env` 本身保持极简。

### 方式一：让 AI 编程助手代劳（最快）

把下面这段提示词复制给能访问本机终端的 AI 编程助手（Cursor / Claude Code / Codex 等），它会检查你的机器、安装依赖并完成部署：

```text
请帮我在本机安装 waoowaoo，公开仓库是：
https://github.com/waooAI/waoowaoo

先检查我的操作系统、CPU 架构、Docker 环境（Engine/Desktop 与 Compose 版本）和 flock，
缺什么用我系统的官方安装方式补上。把仓库按最新 Release tag 克隆到一个新的安装目录，
不要覆盖或清空任何已有安装、数据或卷。

使用默认的 web-only 部署路径：docker-compose.yml + docker-compose.web.yml，
只启动 app 和 worker 两个容器；不要加 infra profile，不要混用
docker-compose.self-hosted.yml，不要混用不同发布版本的文件。

复制 .env.example 为 .env（已有 .env 则绝不要覆盖），只改三处：
APP_HOST_PORT（Web 端口，默认 13000，选一个没占用的）、
APP_BIND_ADDRESS（只本机用 127.0.0.1，要局域网可访问用 0.0.0.0）、
NEXTAUTH_URL（与端口和 IP 保持一致）。
其他保持默认；不要打印、上传或写进对话任何密钥和 .env 内容。

然后执行：docker compose -f docker-compose.yml -f docker-compose.web.yml up -d
首次构建会下载依赖（含 ffmpeg），失败时帮我配置
FFMPEG_FFPROBE_STATIC_BASE_URL / CODEX_APT_MIRROR 后重试。

启动后，从 app 容器日志里找到以 "Waoowaoo setup URL token:" 开头的一行
（docker logs waoowaoo-app-1 2>&1 | grep "setup URL token"），
告诉我打开初始化页的完整地址：http://<ip>:<端口>/setup?token=<冒号后的一整串>。
初始化页上：先用"服务探测"填一个 IP 自动带出 MySQL/Redis/Temporal/S3，
再创建第一个管理员账号，保存后重启 Web 容器。

最后检查容器健康状态与页面能否打开，把访问地址和首次使用步骤告诉我。
指导我在网页的个人中心里配置我自己的 API Key（OpenRouter 等），
不要要求我把密钥发到聊天里；未经我同意不要触发任何付费生成。
```

### 方式二：手动部署

**1. 获取代码**

```sh
# 克隆最新 Release（预览版发布可能不出现在 "latest" 链接下）
git clone https://github.com/waooAI/waoowaoo.git
cd waoowaoo
git checkout <Release 标签>
```

**2. 配置 `.env`**

```sh
cp .env.example .env   # 仅全新安装时复制；已有 .env 绝不要覆盖
```

Web-only 模式默认"零环境"，只需要决定三处：

| 变量 | 说明 |
| --- | --- |
| `APP_HOST_PORT` | Web 端口（默认 13000） |
| `APP_BIND_ADDRESS` | `127.0.0.1` 仅本机 / `0.0.0.0` 对局域网开放 |
| `NEXTAUTH_URL` | 浏览器访问地址，须与上面两处同步，例如 `http://192.168.31.9:6099` |

其余全部保持默认：NextAuth/加密等内部密钥由 Web 容器首次启动时自动生成并存到 `./data`；MySQL/Redis/Temporal/S3 的连接信息在第 4 步的初始化页面填写。内网受限时可额外配置 `FFMPEG_FFPROBE_STATIC_BASE_URL` 与 `CODEX_APT_MIRROR`。

**3. 启动容器**

```sh
docker compose -f docker-compose.yml -f docker-compose.web.yml up -d
```

只启动 `app` 与 `worker` 两个容器（base 文件里的 MySQL/Redis 属于 `infra` profile，默认不启动；Temporal 作为外部服务在第 4 步初始化页配置——若想让 Compose 直接托管，见下节）。首次运行会本地构建 `waoowaoo-web:local` 与 Codex runtime 镜像，时间较长属正常。

**4. 首次初始化（/setup）**

1. 取一次性 token：

   ```sh
   docker logs waoowaoo-app-1 2>&1 | grep "setup URL token"
   # 输出形如：Waoowaoo setup URL token: nS3cqCdAC_EI0q...
   ```

2. 打开 `http://<你的IP>:<端口>/setup?token=<冒号后的一整串>`（也可以不带 `?token=`，在页面顶部粘贴）。
3. 页面上依次填写：
   - **服务探测（可选）**：输入一个 IP/域名，探测 MySQL(3306) / Redis(6379) / Temporal(7233) / S3(9000) 默认端口，发现服务后自动填入下方对应字段；
   - **MySQL**：主机 / 端口 / 用户 / 密码 / 数据库名（数据库不存在会自动创建）；
   - **Redis / Temporal / RustFS-S3 / Codex runtime 限制**：留空使用默认值；
   - 创建**第一个管理员账号**。
4. 保存后重启 Web 容器，然后用管理员账号登录：

   ```sh
   docker compose -f docker-compose.yml -f docker-compose.web.yml restart app
   ```

**5. 验证与使用**

- 打开 `http://<你的IP>:<端口>`，能看到登录页即部署成功；
- **个人中心 → API 配置**：添加模型服务商的 API Key（当前可见 OpenRouter，也支持 openai-compat 渠道）。模型调用费用由你自己的服务商账户承担，本地实例默认不计量（`BILLING_MODE=OFF`）；
- 然后即可创建项目，开始使用 Assistant 和画布。

> 源码开发（改代码迭代）：安装 Node.js 22+ 后 `npm ci && npm run dev`，开发环境使用 `http://localhost:3001`；请使用独立的项目和数据库，不要接入 Release 版本的 Temporal namespace。

---

## ⚙️ 可选：Compose 直接托管 Temporal 服务器

默认路径里 Temporal 是外部服务（在 `/setup` 页填连接信息）。如果你的 Temporal 已经用**外部存储**（例如 1Panel 的 Postgres 做主存储、独立 Elasticsearch 做可见性），不想再单独 `docker run` 一个 Temporal 容器，可以让 Compose 把它作为第 3 个容器接管：

```sh
# .env 增加：
COMPOSE_PROFILES=temporal-in-compose        # 开启该 profile
TEMPORAL_PG_SEEDS=<Postgres 主机>          # Temporal 主存储
TEMPORAL_PG_USER=<用户>
TEMPORAL_PG_PWD=***
TEMPORAL_ES_SEEDS=<Elasticsearch 主机>     # 可见性
INFRA_BIND_ADDRESS=0.0.0.0                 # 端口对外（默认 127.0.0.1）
TEMPORAL_HOST_PORT=7233                    # 与外部/独立 Temporal 保持一致
```

然后照常 `wao up -d`。Compose 会额外起 `temporal`（服务器）、`temporal-elasticsearch`（可见性，命名卷存数据）与 `temporal-config`（写一个 2 行动态配置的一次性容器）。三个前提：① Temporal 容器所在网络要能路由到 Postgres 与 Elasticsearch（web-only overlay 默认把 `temporal` 挂到 `1panel-network` 与 `temporal-network` 两个外部网络，`temporal-elasticsearch` 挂在 `temporal-network`，按你的实际网络调整）；② 发布端口沿用 7233，所以应用/Worker 侧的 Temporal 地址无需改动；③ `TEMPORAL_PG_SEEDS` / `TEMPORAL_ES_SEEDS` 都写**容器名**（`1Panel-postgresql-Uy1Y` / `temporal-elasticsearch`）——Temporal 容器挂在对应网络上，走 Docker DNS 解析，主机重启导致 IP 漂移不用管；若 1Panel 里重建了 Postgres 服务（容器名变化），才需要更新 seed。不想要这些容器时，把 `COMPOSE_PROFILES` 去掉即可回到 2 容器默认路径。

---

## 🔄 重启与日常运维

所有命令在安装目录下执行；web-only 路径下两个 Compose 文件要同时带上（建议先设一个别名）：

```sh
alias wao='docker compose -f docker-compose.yml -f docker-compose.web.yml'
```

> ⚠️ 只用 `docker-compose.web.yml` 一个文件执行 `up`（不带基础文件）会把 app 重建成**没有端口映射**的容器（web overlay 里不定义 `ports`，端口映射来自基础文件），表现为站点突然打不开、容器却显示 Up。遇到这种情况执行 `wao up -d app` 重建即可恢复。

**常用命令**

| 操作 | 命令 |
| --- | --- |
| 重启 Web 容器 | `wao restart app` |
| 重启 Worker | `wao restart worker` |
| 重启全部 | `wao restart` |
| 启动（含补建被删除的容器） | `wao up -d` |
| 停止（数据全部保留） | `wao down` |
| 查看状态 | `wao ps` |
| 看日志 | `docker logs -f waoowaoo-app-1`；落盘文件在 `./docker-logs/` |

**改了什么、要重启什么**

| 场景 | 处理 |
| --- | --- |
| 改了 `.env`（端口、计费模式等） | `wao up -d`。`restart` **不会**读取新的环境变量，必须重建容器 |
| `/setup` 初始化页刚保存 | `wao restart app` |
| 个人中心里改了 **MySQL** 连接信息 | `wao restart app` |
| 个人中心里改了 Redis / Temporal / S3 | 不需要重启（热生效） |
| 代码改动、镜像重新构建 | `wao up -d app` + `sh scripts/worker-redeploy.sh`（见下） |
| 机器重启 / Docker 守护进程重启后 | `wao up -d`（容器带 `unless-stopped`，多数情况会自动回来） |

**镜像重建后的标准流程（代码有改动时）**

```sh
# 1. 重建镜像
docker compose -f docker-compose.yml -f docker-compose.web.yml build app
# 2. 用新镜像重建 Web 容器
docker compose -f docker-compose.yml -f docker-compose.web.yml up -d app
# 3. 同步 Worker：从镜像推导新的 build ID、更新 .env、
#    重建 worker 容器，并把新版本提升为 Temporal 部署的当前版本
sh scripts/worker-redeploy.sh
```

Worker 走的是 Temporal 版本化部署：**每次重建镜像后 build ID 必须变化**，否则新版本代码不会生效；`worker-redeploy.sh` 会把这三件事一次做完，不要手动跳过。

**停止与备份**

- 整体停止用 `wao down`。**永远不要加 `-v`**——那会删除命名卷（数据库、Caddy 证书等），数据无法找回。
- 升级或做大改动前，备份以下四样：
  1. MySQL 数据库（`/setup` 里配置的那个）；
  2. S3 桶（全部媒体文件）；
  3. `./data` 目录（加密的运行时配置、引导密钥、setup 状态）；
  4. `.env`。

**完整发布版（Caddy + 自带 MinIO + 蓝绿 Worker）**

不想自己准备外部服务时，可以用 Release 的一体化路径：

```sh
# .env 中改为：COMPOSE_FILE=docker-compose.yml:docker-compose.self-hosted.yml
docker compose -f docker-compose.yml -f docker-compose.self-hosted.yml up -d
```

该路径额外启动 Caddy（本地 HTTPS `https://localhost:1443`，`13000` 端口只做 HTTP 重定向）、自带 MinIO 和蓝/绿两个 Worker slot，并可用 `infra` profile 一并启动内置 MySQL/Redis/Temporal。首次启动后需要在宿主系统信任 Caddy 自签证书（只导出 `root.crt`，**绝不导出 `root.key`**；Windows 与 WSL2 的信任库相互独立），然后同样通过 `/setup` 完成初始化。Worker 升级走蓝绿流程：

```sh
sh scripts/temporal/worker-rollout.sh promote green   # 先只启动候选 slot，等新 poller 就绪后提升为当前版本
# 成功后把 .env 中的镜像换成新 digest，再 docker compose up -d
sh scripts/temporal/worker-rollout.sh status          # 等旧版本 drained
sh scripts/temporal/worker-rollout.sh retire blue     # 旧 slot 确认排空后才可退役
```

---

## 🔧 API 配置

启动后在**个人中心 → API 配置**中添加服务商。当前可见 **OpenRouter**（GPT Image 2、Nano Banana 系列、Seedance 系列、MiniMax H3 / H3 Max 等，可用模型与费用取决于服务商），也支持 **openai-compat 渠道**（DeepSeek 等 OpenAI 兼容 API，可为每个模型设置思考强度）。调用费用由你的服务商账户承担，不要把 Key 发到聊天或支持日志里。

项目数据与媒体存于本地数据库和私有对象存储；提示词与参考内容只在请求的 AI 任务中发送给服务商。

---

## 📦 技术栈

- **框架**：Next.js 16 + React 19
- **数据库**：MySQL + Prisma ORM
- **持久执行**：Temporal（版本化部署 + 蓝绿切换）
- **传输与缓存**：Redis
- **媒体存储**：私有 S3 对象存储（MinIO / RustFS）
- **样式**：Tailwind CSS v4
- **认证**：NextAuth.js

---

## 🤝 参与方式

本项目由核心团队独立维护。欢迎你通过以下方式参与：

- 🐛 提交 [Issue](https://github.com/waooAI/waoowaoo/issues) 反馈 Bug
- 💡 提交 [Issue](https://github.com/waooAI/waoowaoo/issues) 提出功能建议
- 🔧 提交 Pull Request 供参考 —— 我们会认真审阅每一个 PR 的思路，但最终由团队自行实现，不会直接合并外部 PR

---

## 许可证

从 v0.5.0-beta.1 起，本发行版采用 [Elastic License 2.0](LICENSE)。在遵守条款的前提下，允许个人使用、企业内部商用、修改和分发；向第三方提供本软件主要功能的托管或代管服务，需要另行取得授权。旧版本保留其原许可证，第三方组件保留各自许可。这是源码可用软件，不属于 OSI 定义的开源软件。

---

**Made with ❤️ by waoowaoo team**

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=saturndec/waoowaoo&type=date&legend=top-left)](https://www.star-history.com/#saturndec/waoowaoo&type=date&legend=top-left)
