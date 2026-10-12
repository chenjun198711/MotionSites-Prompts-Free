# MotionSites 宝塔面板部署指南（Cloudflare 域名，非 GitHub 方式）

> 适用范围：把本项目从 GitHub Pages / Cloudflare Pages 切换到**自建宝塔面板（Nginx）静态托管**，
> 域名继续使用你在 Cloudflare 上已有的域名。

---

## 0. 部署拓扑

```
用户浏览器
   │  HTTPS
   ▼
Cloudflare（DNS + 可选 CDN 代理，域名解析处）
   │  HTTP(S) 回源
   ▼
宝塔面板服务器  ── Nginx ──▶ /www/wwwroot/<域名>/   （纯静态文件）
                                   ├─ index.html
                                   ├─ ms_script.js
                                   ├─ data/          (~18 MB, 全部相对路径 JSON + txt)
                                   └─ assets/        (~1.14 GB, previews 媒体)
```

- 本项目是**纯静态站**：无后端、无构建、无 Node 运行时，Nginx 直接托管文件即可
- 前端全部用**相对路径**引用（`data/catalog-meta.json`、`assets/previews/*`），无需任何 rewrite
- 与 GitHub Pages 部署不冲突，可同时在线；切换 DNS 即可无缝迁移，随时可回滚

---

## 1. 本地打包（只传必要文件）

完整仓库 ~2.3 GB，其中 `.git/` 占 1.15 GB，**不要上传**。部署只需以下内容（合计约 **1.16 GB**）：

| 必须上传 | 说明 | 大小 |
|---|---|---|
| `index.html` | 入口页 | 33 KB |
| `ms_script.js` | 全部交互逻辑 | 42 KB |
| `data/` | catalog-*.json + catalog-text/*.txt (544个) | ~18 MB |
| `assets/` | previews 媒体 + superdesign 子目录 | ~1.14 GB |
| `LICENSE` | 可选 | 1 KB |

**不要上传**（无用或有害）：
- `.git/`、`.github/`、`.workbuddy/`、`scripts/`、`docs/`、`deploy/`、`templates/`、`examples/`、`prompts/`
- `_headers`、`_redirects`（Cloudflare Pages 语法，Nginx 不识别，需用 Nginx 配置等价替代）
- `data/*.json.gz`（前端请求的是 `.json` 原文件，压缩由 Nginx gzip 动态完成）
- `wrangler.toml`、`README.md`、`all_prompts*.md/csv`、`gumroad_*.txt`、`prompts_catalog.xlsx` 等

打包命令（PowerShell，在仓库根目录执行）：

```powershell
# 方案 A：zip 上传（文件多，推荐先打包）
Compress-Archive -Path index.html, ms_script.js, data, assets, LICENSE `
                 -DestinationPath deploy_bt.zip -CompressionLevel Optimal

# 方案 B：rsync 增量（适合后续更新，需服务器已装 rsync）
# rsync -av --delete --exclude={.git,.github,.workbuddy,scripts,docs,deploy,_headers,_redirects} ./ root@<服务器IP>:/www/wwwroot/<域名>/
```

---

## 2. 宝塔建站

1. 宝塔面板 → **网站** → **添加站点**
   - 域名：填你的 Cloudflare 域名（如 `example.com`，可加 `www`）
   - 类型：**纯静态**（PHP 版本选"纯静态"）
   - 根目录：默认 `/www/wwwroot/example.com/`
2. 站点创建后，先**用 IP 冒烟测试**（域名还没切过来时）：
   - 若服务器在国内：宝塔 → 安全 → 放行端口（如 8080）
   - 临时再添加一个同根目录的站点绑定 `http://服务器IP:8080`，或在 Nginx 配置里监听该端口
   - 浏览器访问 `http://服务器IP:8080` 应看到卡片页面（媒体走相对路径，无需域名）

> ⚠️ **国内服务器注意**：用域名提供 80/443 服务需 ICP 备案。未备案前可用 IP:端口
> 验证，或用 Cloudflare 代理（见 §6）——但回源仍需服务器能接受访问。
> 若服务器在境外则无此限制。

---

## 3. 上传并解压

1. 宝塔 → **文件** → 进入 `/www/wwwroot/<域名>/`
2. 上传 `deploy_bt.zip`（若太大可上传到 `/root/` 再移动）
3. 右键 zip → **解压**
4. 确认最终结构（**不要多套一层目录**）：

```
/www/wwwroot/<域名>/
├─ index.html
├─ ms_script.js
├─ LICENSE
├─ data/
│  ├─ catalog-lite.json
│  ├─ catalog-meta.json
│  ├─ catalog-text-index.json
│  ├─ catalog-text.json
│  └─ catalog-text/           # 544 个 .txt
└─ assets/
   ├─ previews/               # 529 个媒体
   └─ community/superdesign/  # 16 个子目录
```

5. 建议把站点目录 owner 设为 `www`：宝塔文件管理器 → 属性 → 权限，或
   `chown -R www:www /www/wwwroot/<域名>`

---

## 4. Nginx 配置（核心，替换 _headers 的等价效果）

宝塔 → 网站 → 设置 → **配置文件**，完整替换为：

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name example.com www.example.com;

    # 站点根目录
    root /www/wwwroot/example.com;
    index index.html;

    # 记录日志
    access_log /www/wwwlogs/example.com.log;
    error_log  /www/wwwlogs/example.com.error.log;

    # ===== 安全响应头（等价原 _headers）=====
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # ===== 压缩：data/catalog-text.json 达 5MB，必须 gzip =====
    gzip on;
    gzip_comp_level 6;
    gzip_min_length 1k;
    gzip_vary on;
    gzip_types
        text/plain text/css text/javascript
        application/json application/javascript
        application/xml image/svg+xml;

    # ===== 大数据 JSON 短缓存（1 小时）=====
    location /data/ {
        add_header Cache-Control "public, max-age=3600";
        add_header Content-Type "application/json; charset=utf-8" always;
    }

    # ===== 媒体长缓存 + 支持 Range 拖动（mp4/webm/gif/webp）=====
    # Nginx 静态文件默认支持 Range/Accept-Ranges，无需额外模块
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        add_header Accept-Ranges "bytes";
        expires 1y;
    }

    # ===== favicon / 根页面 =====
    location = / {
        try_files /index.html =404;
    }
    location ~* \.(html|js)$ {
        add_header Cache-Control "public, max-age=3600";
    }

    # ===== 静态文件 404 处理（无 SPA，直接 404 即可）=====
    error_page 404 /404.html;
    location = /404.html {
        internal;
        default_type text/html;
        return 404 "Not Found";
    }
}
```

验证配置：宝塔 → 网站 → 设置 → 配置文件底部点"保存"，或命令行
`nginx -t && nginx -s reload`。

---

## 5. HTTPS 证书（两种方式，按域名是否走 Cloudflare 代理选择）

### 方式 A：Cloudflare 代理（橙云），域名已在 CF
- Cloudflare SSL/TLS 设为 **Flexible**（浏览器→CF 用 HTTPS，CF→宝塔用 HTTP:80）
- 宝塔侧**不需要证书**，Nginx 保持监听 80 即可
- 优点：源站 IP 被隐藏；缺点：CF 边缘到访客延迟（国内访问 CF 边缘可能较慢）

### 方式 B：Cloudflare 仅 DNS（灰云），或域名未托管 CF
- 宝塔 → 网站 → **SSL** → Let's Encrypt → 勾选域名 → 申请并部署
- Cloudflare SSL/TLS 设为 **Full (Strict)**（若域名在 CF 且开灰云不需要）
- Nginx 自动生成 443 配置与 HTTP→HTTPS 跳转

> 推荐先用**方式 A（Flexible）**快速上线验证，后续再按需切换到 Full。

---

## 6. Cloudflare DNS 切换

在 Cloudflare 控制台把域名从 GitHub Pages/Cloudflare Pages **A/CNAME 记录**改指向宝塔服务器：

| 记录类型 | 名称 | 内容 | 代理状态 | TTL |
|---|---|---|---|---|
| A | `@` | 宝塔服务器公网 IP | 橙云(Proxied) 或 灰云(DNS only) | Auto |
| A | `www` | 宝塔服务器公网 IP | 同上 | Auto |

1. Cloudflare → 你的域名 → **DNS → Records**
2. 编辑原有指向 GitHub Pages 的记录，把内容改为 `你的服务器公网IP`（A 记录）
3. 保存后等待生效（橙云代理通常 1-2 分钟，灰云按 TTL）
4. 回滚：把内容改回原来的 GitHub Pages CNAME（`chenjun198711.github.io`）即可，1 分钟内恢复

> 若旧部署是 Cloudflare Pages 的 `pages.dev` / 自定义域记录，同样删除/改为 A 记录指向服务器。
> 若域名同时用于 GitHub Pages（`<user>.github.io/<repo>/`），那是另一条子域记录，互不影响。

---

## 7. Google Fonts 自托管（国内访问必需，代码改动项）

`index.html` 第 10-15 行外链 `fonts.googleapis.com`（Inter / Fraunces / JetBrains Mono）。
国内服务器与访客无法访问 Google Fonts，需改为自托管。**此步涉及本地代码修改，执行阶段完成。**

改动清单（执行时由我具体实现并验证）：
1. 新建 `assets/fonts/fonts.css`：用 `@font-face` 定义三个字体族（woff2 格式）
2. 下载字体文件到 `assets/fonts/`：
   - Inter: 400/500/600/700/800
   - Fraunces: 400/600/700 常规 + 500 斜体
   - JetBrains Mono: 400/500
3. 修改 `index.html`：删除 Google Fonts 的 preconnect / preload / stylesheet / noscript 行，
   替换为 `<link rel="stylesheet" href="assets/fonts/fonts.css">`
4. 保留 CSS 中 `font-family` 名称不变（Inter/Fraunces/JetBrains Mono），字体族内部自动匹配

---

## 8. 上线验证清单

| # | 检查项 | 方法 | 预期 |
|---|---|---|---|
| 1 | 首页可访问 | `curl -I http://IP或域名/` | 200 |
| 2 | JSON 加载 | `curl -I https://域名/data/catalog-meta.json` | 200，Content-Type: application/json |
| 3 | gzip 生效 | `curl -H "Accept-Encoding: gzip" -I https://域名/data/catalog-text.json` | Content-Encoding: gzip |
| 4 | 视频 Range | `curl -H "Range: bytes=0-1023" -I https://域名/assets/previews/*.mp4` | 206，Accept-Ranges: bytes |
| 5 | 图片长缓存 | `curl -I https://域名/assets/previews/*.webp` | Cache-Control: max-age=31536000 |
| 6 | 安全头 | 浏览器开发者工具 Network 响应头 | X-Content-Type-Options / Referrer-Policy |
| 7 | 字体 | 浏览器 Network 过滤 fonts | 全部来自本域 assets/fonts/，无 googleapis 请求 |
| 8 | 页面功能 | 浏览器打开 → 搜索 → 点卡片详情 → 视频播放 | 无控制台报错 |
| 9 | 卡片媒体 | 滚动加载若干页 | 无 broken image（自然宽>0） |

---

## 9. 后续更新流程（两种可选）

- **zip 覆盖**：本地重新打包 `data/` + `assets/` 变化部分 → 上传覆盖 → 无需改 Nginx
- **Git 同步**：服务器装 git，`git clone` 到站点目录（忽略 .git 外其余开发文件），
  更新时 `git pull`；或宝塔 → 网站 → Git 钩子自动拉取

---

## 10. 执行前需要你提供的信息

| 项 | 你的值 |
|---|---|
| 宝塔服务器公网 IP | |
| 服务器位置（国内/境外） | |
| 域名 | |
| 域名当前是否走 Cloudflare 代理（橙云/灰云） | |
| 旧解析记录当前指向（GitHub Pages CNAME 或 CF Pages） | |
