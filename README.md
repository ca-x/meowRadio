<p align="center"><img src="web/public/branding/logo-256.webp" width="128" alt="meowRadio Logo"></p>

# 阿喵收音机 · meowRadio

把世界，调到喜欢的频道。Rust 编写的自托管网络收音机，React 界面直接嵌入二进制，使用 SQLite 保存账号与个人收藏。

- **九套主题**：胡桃木拟物收音机、琉璃夜色玻璃播放器、光阵立方 LED 播放器（2D / 3D）、云白拟态圆盘收音机，以及弧光调谐、奶油白、黑白刻度、银色复古和红屏像素。每套外观均有独立浅色/暗色配色；切换不打断播放，偏好保存在当前浏览器。
- **语言**：简体中文 / English，首页顶栏切换，控件、提示、登录页与筛选面板同步更新。电台名称保留目录原文。
- **定时关闭**：拖动时针、分针选择时长，也可输入数字或使用 15/30/60/120 分钟预设。支持取消、重新设定；换台、切换外观和进入登录页不会重置计时。可设置关闭前 10 秒、30 秒、1 分钟或 5 分钟显示强调倒计时，也可关闭提示。
- **录制与录音库**：浏览器通过服务端播放时可点击开始/停止录制；换台、暂停或定时结束会自动停止并上传。用户菜单内独立管理个人录音，支持应用内试听、重命名、下载和删除。系统设置提供浏览器支持的格式、目标码率和最长时长。
- **个人资料**：用户菜单 → 个人选项，分为“个人资料”（昵称、头像）与“修改密码”两个页签；头像转换为 256×256 WebP 并覆盖旧文件。改密码需验证当前密码，保留当前登录并撤销其他设备会话。
- **个人电台源**：网络地址或 JSON 文件导入，按用户保存；独立管理、分类筛选、多地址备用，与系统电台合并收藏并标注来源。检测失败地址需确认后清理，有效线路及收藏保留。
- **多用户**：独立 `/login` 页面完成用户名/密码登录与注册，独立收藏；Argon2id 密码、HttpOnly 会话 Cookie、过期与退出撤销。
- **首次初始化**：环境变量创建首个管理员，或首次访问时使用设置向导。初始化只运行一次，不会因重启重置密码。
- **世界电台**：基于 `radiobrowser` crate 和 Radio Browser API，支持名称、类型、国家筛选及分页。首页只保留筛选入口，点击后可按国家、语言、节目类型、排序及音质组合浏览，无需关键词。中文输入法选词完成后再搜索，支持 Enter 立即搜索和空结果恢复。`FM 104.2` / 全角频率写法会转换为电台名称中的频率关键词。
- **收听**：播放、暂停、换台、音量；HLS 按需加载；HTTP/HTTPS/SOCKS5 出站代理和可选的服务端音频中转。断流后按 2/4/8/16/30/30 秒重试，恢复网络或回到前台时检查播放；手动暂停、定时关闭不会触发自动恢复。
- **状态保留**：点击首页、切换语言/配色不会打断收听；关键词、筛选、页码和默认播放方式保存在当前浏览器，设置内显示版本。
- **懒猫集成**：仅检测到 LazyCat WebShell 时启用原生控制栏适配；Android 同步播放状态、元数据及播放/暂停/换台，iOS 适配状态栏与安全区域。普通浏览器跳过 SDK 加载与宿主调用。
- **交付**：Linux / macOS / Windows 二进制，amd64/arm64 Docker，GitHub Actions 自动测试和发布。

## 界面

九套外观均支持浅色/暗色；语言与深浅色在首页顶栏切换，外观主题在用户菜单的系统设置中，筛选条件在面板中展开。宣传文字首次进入可见区域时淡入，停留约 1.5 秒后淡出，不影响页面布局。

### PC 端

| 弧光调谐 | 个人源管理 | 无效地址确认 |
| --- | --- | --- |
| ![PC 弧光调谐暗色](docs/screenshots/pc-arc.png) | ![PC 个人源管理](docs/screenshots/pc-sources.png) | ![PC 无效地址确认](docs/screenshots/pc-source-cleanup.png) |

### 移动端

| 黑白刻度 | 个人源管理 | 无效地址确认 |
| --- | --- | --- |
| ![移动端黑白刻度](docs/screenshots/mobile-mono.png) | ![移动端个人源管理](docs/screenshots/mobile-sources.png) | ![移动端无效地址确认](docs/screenshots/mobile-source-cleanup.png) |

## Docker

```sh
docker run -d --name meowradio \
  -p 3000:3000 \
  -v meowradio-data:/data \
  ghcr.io/ca-x/meowradio:latest
```

打开 `http://localhost:3000`，按向导创建管理员。也可在仓库中运行 `docker compose up -d --build` 从源码构建。

自动初始化示例（生产环境请用部署平台的 secret 注入密码）：

```sh
docker run -d --name meowradio \
  -p 3000:3000 -v meowradio-data:/data \
  -e MEOW_INIT_USERNAME=admin \
  -e MEOW_INIT_PASSWORD \
  ghcr.io/ca-x/meowradio:latest
```

运行前在当前 shell 中设置 `MEOW_INIT_PASSWORD`。两项都未设置时启用向导；首次启动仅设置其中一项会报错退出。安装已初始化后忽略这两个变量。Compose 中需要取消 `compose.yaml` 对应两行的注释。

## 二进制

从 [Releases](https://github.com/ca-x/meowRadio/releases) 下载对应平台文件，验证 `SHA256SUMS` 后解压运行：

```sh
./meowradio
# 或环境变量初始化
MEOW_INIT_USERNAME=admin MEOW_INIT_PASSWORD="$RADIO_ADMIN_PASSWORD" ./meowradio
```

无需 Node.js 或外部数据库。个人源播放及检测需要安装 FFmpeg（包含 MP3 编码器及所需协议），或用 `MEOW_FFMPEG` 指定路径；Docker 镜像已包含。默认监听 `0.0.0.0:3000`，自动创建 `data/meowradio.db`。Windows 使用 `meowradio.exe`；Linux GNU 二进制面向 Ubuntu 24.04 / glibc 2.39 或更高版本，旧发行版建议 Docker。`--version` 显示版本。

## 浏览与筛选

在首页点击“筛选”打开面板。国家/地区、语言、节目类型和排序在面板中选择；编码和最低码率放在“音频格式与音质”折叠区。点击“应用筛选”更新列表，关闭面板会丢弃未应用的修改。入口仅显示已启用条件数量，首页不铺开筛选项。目录选项按需加载，括号中的数量是整个目录的收录量，并非组合筛选结果总数。

## 收藏分页

“我的收藏”每页显示 24 个电台，显示匹配总数和页码。搜索覆盖全部收藏（名称、国家和标签），修改关键词后回到第一页；翻页不会中断当前电台。取消末页最后一项收藏时自动退回有效页。“系统电台”“个人电台”和“我的收藏”保留各自的页码。

列表由服务端分页返回；收藏标记与银色复古的快捷频道使用单独的轻量摘要，不需要下载全部电台详情。原有 `/api/favorites` 数组接口继续兼容。

## 个人电台源

用户菜单 → **个人电台源**，或访问 `/sources`。可添加 JSON 订阅网址、单个音频地址或电台播放页，也可直接上传 JSON 文件；页面提供格式说明和示例下载，详见 [个人源格式](docs/PERSONAL-SOURCES.md)。网络源手动点击更新，文件源重新上传替换；更新失败保留原内容。

首页分为“系统电台”“个人电台”“我的收藏”。个人电台可按源与分类筛选，收藏可与系统电台放在一起，并显示“个人源”标记。进入源管理页面不会中断正在收听的电台。

导入或更新后检查每个地址，仅在对话框列出失败线路，由用户确认清理；也可关闭、重新检测或取消选择。例如 A 有 b、c、d 三个地址，清理失效的 c、d 后仍保留 A、b 及 A 的收藏；只有清空全部线路才删除电台及对应收藏。源管理还支持删除单个电台、单个源或全部个人源，系统源收藏不受影响。

支持 HTTP(S) 连续音频、HLS、FLV、RTMP(S)、RTSP(S)、MMS/MMST/MMSH，以及包含可提取媒体链接的 HTML、JSON、JSONP 接口；央广播放页按 `cf` 选择频道。通过服务端解析并转为同源 MP3（128 kbps），按顺序尝试备用地址，可使用现有录制与定时功能。过期、离线、地域限制、需要登录或只能执行网页脚本获得流地址的链接可能无法播放。

个人源仅允许公共网络目标，拒绝 URL 中的账号密码；每次跳转及媒体子资源都检查目标地址。支持端口 80、82、322、443、554 和 1024–65535；请求头仅允许 User-Agent、Referer、Origin、Accept。每用户最多 32 个源，每次导入最多 5 MiB、5000 个条目；转码最多全局 4 个、每用户 2 个并发任务，地址检测与播放共享转码额度。

## 定时关闭

点击播放器旁的时钟入口，拖动两根指针设置小时和分钟；也支持键盘方向键、数字输入及快捷预设。点击“开始计时”后按实际截止时间停止播放，重新设置会替换上次计时。

“关闭前倒计时”决定何时显示更醒目的提示：关闭、10 秒、30 秒、1 分钟、5 分钟。提示跟随当前材质与配色，数字保持稳定，仅光晕有轻微呼吸效果；系统启用减少动态效果时保持静态。取消定时或计时结束后提示清除。提前提示偏好会保存，正在运行的定时仅属于当前页面会话，刷新/关闭页面会结束该会话；设备休眠时浏览器无法执行计时，恢复执行后会按已过的截止时间立即停止。

## 用户菜单与个人数据

用户菜单包含 **个人选项、系统设置、录音管理、个人电台源、退出登录**。个人选项只有两个页签：“个人资料”编辑昵称、头像；“修改密码”修改账号密码。系统设置单独提供九套主题、默认播放方式、代理诊断、录制参数和版本。主题样式按文件拆分，布局与公共控件分别维护，见 `web/src/receiverThemes.ts` 和各主题 CSS。

登录用户名保持不变，昵称只用于显示。支持 PNG/JPEG/WebP 头像，最大 5 MiB、每边不超过 4096 像素；服务端裁剪为 256×256 WebP 后原子替换。Docker 默认文件布局：

```text
/data/
├── meowradio.db
├── avatar/
│   └── alice.webp
└── record/
    └── alice/
        └── <UUID>.webm
```

本地二进制默认使用 `data/`；头像和录音目录默认位于数据库同级。录音元数据与归属保存在 SQLite，文件不通过公共静态目录暴露。头像和录音 API 需要登录，用户只能操作自己的数据。

## 录制与录音管理

先通过电台旁或播放器下方的中转图标启用服务端播放，再点击播放器的圆形录制按钮；点击停止图标结束。换台、暂停、定时关闭或播放中断会自动结束当前录制，保存旧电台的信息。重连后需手动开始新的录制，不会把不同播放段悄悄合并。

停止后自动上传至个人录音库，并保留本机下载入口。上传失败可重试或先下载；切换账号时禁止将之前的录音上传到新账号。录音管理可直接试听、重命名、下载、确认删除，试听时暂停直播，关闭管理窗口会停止试听。

系统设置中的录制参数在下一次录制时生效：

- 格式：按浏览器能力显示 WebM/Opus、Ogg/Opus 或 MP4/AAC；没有伪装为 MP3 的转码选项。
- 目标码率：64、128、192、256 kbps，实际编码由浏览器决定。
- 最长时长：5、15、30、60 分钟；每条最大 100 MiB，每用户总空间最大 1 GiB。

录制使用浏览器 `captureStream` 和 `MediaRecorder`，不请求麦克风权限。仅对服务端中转音源启用；不支持这些 API 的浏览器会说明限制。页面关闭前请确认上传完成或下载；移动系统挂起网页时无法保证后台录制或播放持续运行，回到前台后播放器会检查是否需要重连。

## 配置

程序从进程环境读取配置，**不会自动加载 `.env`**。`.env.example` 是示例；Compose 自动读取 `.env`，但仅将 `compose.yaml` 声明的项目传给容器。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `MEOW_LISTEN` | `0.0.0.0:3000` | 监听地址 |
| `MEOW_DATABASE` | `data/meowradio.db` | SQLite 文件，Docker 默认 `/data/meowradio.db` |
| `MEOW_RECORDINGS_DIR` | 数据库同级的 `record` 目录 | 私人录音文件目录，Docker 默认 `/data/record/<用户名>/`；录音名称等信息保存在 SQLite |
| `MEOW_INIT_USERNAME` | 未设置 | 首次初始化管理员用户名 |
| `MEOW_INIT_PASSWORD` | 未设置 | 首次初始化管理员密码，10–128 字节 |
| `MEOW_REGISTRATION` | `true` | 是否允许其他用户注册 |
| `MEOW_SECURE_COOKIE` | `false` | HTTPS 部署设为 `true` |
| `MEOW_FFMPEG` | `ffmpeg` | 个人源转码及地址检测使用的 FFmpeg 可执行文件路径，修改后重启 |
| `MEOW_RELAY` | `true` | 是否允许登录用户使用音频中转 |
| `MEOW_PROXY` | 未设置 | 出站 `http://`、`https://`、`socks5://` 代理，可含认证 |
| `MEOW_CATALOG_URL` | 公共 Radio Browser 服务 | 自托管 API 根地址，不包含 `/json` |
| `RUST_LOG` | `meowradio=info,tower_http=info` | 日志级别 |

首次初始化前应先在可信网络完成向导，或直接用环境变量设置管理员。对外部署使用 HTTPS 反向代理并开启 Secure Cookie。修改环境配置后重启服务。界面语言、配色、外观、音量、搜索筛选、页码、默认播放方式及倒计时提示提前量保存在当前浏览器，不会修改其他账号的服务端数据。

### 代理和收听方式

点击右上角用户菜单 → “系统设置”，在“主题”和“设置”页签中选择外观、收听方式与录制参数，并用测试按钮检查连接。测试仅请求固定的外网 Radio Browser 状态接口，返回是否成功及耗时，不会返回代理凭据。

电台列表中，点击电台名称按保存的默认方式播放；点击电台旁的中转图标只让本次播放经过服务器（需要登录），不会改写默认偏好。播放器下方的纯图标切换按钮表示中转开关，悬停或聚焦显示说明；系统设置中的“默认播放方式”会保存到浏览器，并用于后续选择的电台，不打断当前收听。HTTPS 页面遇到 HTTP 音源时自动使用中转。配置 `MEOW_PROXY` 后使用该出站代理，否则通过服务器自身网络中转。

- **目录代理**：设置 `MEOW_PROXY` 后，搜索、频道解析和收听计数通过代理请求。代理地址和凭据不会下发到浏览器。
- **浏览器直连**：音频由浏览器直接请求，不使用服务端代理；支持普通流和 HLS。电台须支持当前浏览器的编码；HLS 还需电台允许跨域请求。
- **服务端中转**：需要登录，支持连续音频与 HLS，包括主/子播放列表、密钥、初始化片段、音频分片和字节范围。HTTPS 页面可用它收听 HTTP 电台。HLS 子资源使用绑定当前用户与电台的签名链接，仍需登录会话。
- **系统源中转安全边界**：只接受 Radio Browser 电台 UUID，每次重定向重新检查公共 IP 并固定解析结果。支持端口 80、443、8000–9999，最多 32 个并发中转。
- **出站代理**：HTTP/HTTPS 代理通过 CONNECT 连接已验证的目标 IP，代理须允许目标端口的 CONNECT；HTTP 请求保留原始 Host，HTTPS 保留原始 SNI 与证书校验。SOCKS5 同样传递已验证 IP，不启用远程 DNS。`socks5h` 未启用。
- **HLS 边界**：支持常见直播与低延迟 HLS 资源；不支持带未展开变量的 URI 或非 HTTP(S) DRM 资源。每个播放列表上限 1 MiB，每个分片上限 64 MiB，签名链接 24 小时有效；服务重启后重新选台即可。

Radio Browser 是社区维护目录，部分电台可能离线、地域受限或编码不被浏览器支持。页面会显示连接失败和重试入口。各套外观的电平/波形是随实际播放状态变化的装饰，暂停、缓冲、静音和页面隐藏时停止动态；减少动态效果下显示静态形状。这些装饰，不代表真实音频频谱，也不显示虚构 FM 频率。

### 数据和备份

SQLite 启用 WAL、外键和自动迁移。完整备份应同时保留数据库、`record/` 和 `avatar/` 目录。可停止服务后复制数据卷；在线备份应使用 SQLite `.backup`，不要只复制正在写入的 `.db` 文件。数据卷应仅由服务用户访问。当前定位为单实例自托管服务。登录限流使用连接来源 IP，每分钟 12 次；反向代理后的用户会共享代理 IP 的额度。

## 本地开发

Rust 1.94+、Node.js 24+，npm。仓库锁定 Rust 1.94.0。

```sh
npm --prefix web ci --ignore-scripts
npm --prefix web run build
cargo run
```

需要热更新时另开终端运行 `npm --prefix web run dev`，Vite 默认将 `/api` 转发到 `127.0.0.1:3000`。

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
npm --prefix web test
npm --prefix web run build
npm --prefix web audit --audit-level=high
npm --prefix web audit signatures --omit=dev
cargo audit
```

前端构建完成后才能编译 Rust，release 模式将 `web/dist` 和字体授权文件完整嵌入二进制。HLS 播放器按需加载，不影响普通电台的首屏资源。

## 发布

CI 检查格式、Clippy、前后端测试、依赖审计、嵌入式二进制及非 root Docker 启动。推送与 `Cargo.toml` 版本一致的 `v*` 标签触发 Release：

```sh
git tag v0.3.0
git push origin v0.3.0
```

所有验证通过后，分别构建 Linux amd64/arm64、macOS amd64/arm64、Windows amd64，上传压缩包和 SHA256SUMS，并发布 `ghcr.io/ca-x/meowradio:<tag>`。正式版本同时更新 `latest`；预发布不覆盖 `latest`。本项目 GHCR 镜像已验证允许匿名拉取。仅需仓库内置 `GITHUB_TOKEN` 的 contents/packages 写权限。

## API

所有修改请求需 `X-Meow-Request: 1`；普通 JSON 请求体限制 8 KiB，个人源文件上限 5 MiB、地址清理请求上限 12 MiB，头像和录音使用各自的流式/二进制上限。录音上传另需 `X-Meow-Owner: <用户 ID>`，并用查询参数传递 `title`、`station_id`、`station_name`、`duration_seconds`；资料修改也接受此归属标头以防跨标签页账号切换误操作。个人源修改及个人电台收藏请求必须带 `X-Meow-Owner`，所有读取与播放按登录用户隔离。浏览器 Cookie 会话不使用 localStorage token。

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/api/health` | GET | 服务及数据库健康 |
| `/api/setup` | GET / POST | 初始化状态 / 创建首个管理员 |
| `/api/auth/register` | POST | 注册 `{username,password}` |
| `/api/auth/login` | POST | 登录 `{username,password}` |
| `/api/auth/logout` | POST | 撤销当前会话 |
| `/api/auth/me` | GET | 当前账号 |
| `/api/stations` | GET | `q`、`tag`、`country`、`language`、`sort`、`codec`、`bitrate_min`、`offset`，24 条/页；关键词可为空 |
| `/api/directory` | GET | 国家、语言和常见类型目录，缓存一小时 |
| `/api/proxy/test` | POST | 登录用户测试服务端代理/直连到外网的联通性 |
| `/api/favorites` | GET | 当前用户的收藏 |
| `/api/favorites/page` | GET | 当前用户收藏分页，`q`、从 0 开始的 `page`，固定 24 条/页并返回总数 |
| `/api/favorites/summary` | GET | 收藏 UUID 与最近 4 个快捷频道 |
| `/api/favorites/{uuid}` | PUT / DELETE | 收藏 / 取消收藏 |
| `/api/stream/{uuid}` | GET | 登录用户音频中转 |
| `/api/personal-sources` | GET / POST / DELETE | 列出 / 从网络导入 / 清空当前用户源 |
| `/api/personal-sources/upload` | POST | 原始 JSON 文件上传；`label`、可选 `source_id` 查询参数 |
| `/api/personal-sources/{id}` | DELETE | 删除源及对应个人收藏 |
| `/api/personal-sources/{id}/refresh` | POST | 手动更新网络源 |
| `/api/personal-sources/{id}/validation` | POST / GET / DELETE | 开始 / 查询 / 取消地址检测，取消需 `job_id` 查询参数 |
| `/api/personal-sources/{id}/validation/clear` | POST | 确认清理选中失败地址，校验检测任务及当前地址 |
| `/api/personal-sources/capabilities` | GET | 当前 FFmpeg 与协议支持情况 |
| `/api/personal-stations` | GET | 当前用户电台，支持 `q`、`page`、`source_id`、`category` |
| `/api/personal-stations/{id}` | GET / DELETE | 读取 / 删除个人电台及其收藏 |
| `/api/personal-stations/{id}/stream` | GET | 当前用户个人电台音频，MP3 |
| `/api/settings` | GET | 非敏感部署状态 |
| `/api/profile` | GET / PATCH | 当前资料 / 更新 `{nickname}` |
| `/api/profile/avatar` | GET / POST / DELETE | 私有头像读取 / 原始图片上传 / 删除 |
| `/api/profile/password` | POST | `{current_password,new_password}`，撤销其他会话 |
| `/api/recordings` | GET / POST | 私人录音列表 / 原始音频上传 |
| `/api/recordings/{uuid}` | PATCH / DELETE | 重命名 `{title}` / 删除 |
| `/api/recordings/{uuid}/audio` | GET | 播放并支持 Range；`?download=true` 下载 |

## 来源与授权

项目 MIT。API 行为参考 `radiobrowser-api-rust`，嵌入式前端和交付流程参考 [ca-x/raindrop](https://github.com/ca-x/raindrop)。

`radiobrowser` 0.6.1 的旧 HTTP/TLS/DNS 依赖存在已知安全问题，因此本仓库保留上游源码和 API，使用本地安全补丁更新依赖；详情见 [PATCHES.md](vendor/radiobrowser/PATCHES.md)。`cargo audit` 唯一忽略项是未编译、未分发的 SQLx MySQL 可选 RSA 依赖，依据及复查时间在 `.cargo/audit.toml`。

琉璃夜色依据用户提供的玻璃播放器示例实现。光阵立方参考用户提供的 CSS LED Challenge：原作 [Ben Evans](https://codepen.io/editor/ivorjetski/pen/01a07dcf-a1e8-7ab6-aea1-aa98135803b3)，fork [Agustin Capeletto](https://bsky.app/profile/lowpoly.gg)；本项目将其视觉方向重新实现为作用域隔离的 React/CSS 播放器。字体 Outfit、Space Mono 使用 SIL Open Font License，授权随前端嵌入 `/licenses/`。

云白拟态的视觉参考：[Radio Player App — Neumorphic concept](https://dribbble.com/shots/11629433-Radio-Player-App-Neumorphic-concept)，Oleksandr Plyuto for heartbeat。圆盘、浅绿显示窗和冰蓝白软阴影由 CSS 重新实现，调谐和音量控件连接实际功能；未使用原作图片或品牌标志。

应用 Logo 由用户通过 [Issue #1](https://github.com/ca-x/meowRadio/issues/1) 提供，原图保存于 `assets/brand/logo-original.png`。页面 Logo、favicon 和主屏幕图标均由该原图缩放生成。

弧光调谐参考 [FM Radio](https://dribbble.com/shots/24101705-FM-Radio)，Slava Kornilov for Geex Arts。奶油白、黑白刻度、银色复古和红屏像素依据用户提供图片重新实现；使用真实频道序号与功能，不展示虚构的 FM 频率或原设计的订阅/节目元数据。参考图片和视频不作为应用资源分发。
