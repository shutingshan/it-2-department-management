# 部署到阿里云 ECS

本项目部署后**只需要跑一个 Node 进程**：后端会把前端构建产物一并托管（见 `backend/src/index.ts`
末尾的 `express.static`），所以不强制需要 Nginx。

---

## 一、部署前必须先决定：TAPD 用哪种取数方式

这直接决定服务器上能不能跑通，先看清楚再动手。

| | 当曲云抓取 | TAPD 抓取 |
| --- | --- | --- |
| 是否支持无头模式 | ✅ 支持（`headless: !DANGQUYUN_DEBUG`） | ❌ 代码里写死 `headless: false` |
| 无桌面服务器上能否运行 | 可以 | **不行** |

TAPD 浏览器模式必须弹出真实窗口（无头访问 tapd.cn 会被腾讯云 WAF 拦截），而且扫码登录需要人
能看见那个窗口——无桌面的 ECS 上做不到。所以服务器上 TAPD 只能二选一：

1. **推荐：改用开放平台 API**（`TAPD_FETCH_MODE=api`）
   需要公司 TAPD 管理员在「公司管理 → 开放平台」开通 API 账号口令，跟登录 TAPD 的账号密码不是一回事。
2. **备选：装 Xvfb 虚拟显示器**，并在本机扫码后把 `backend/.auth/tapd-state.json` 上传到服务器同路径。
   登录态过期后要重新上传，比较折腾。

> 当曲云不受影响：它用账号密码自动登录，无头模式可以正常跑。

---

## 二、服务器环境准备

```bash
# Node.js（用 nvm 装 LTS，需要 v18+）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install --lts

# 拉代码
cd /opt
git clone https://github.com/shutingshan/it-2-department-management.git
cd it-2-department-management
```

**阿里云安全组**要放行端口（控制台 → ECS → 安全组 → 入方向）：直接暴露就开 `4000`，
打算用 Nginx 转发就开 `80`/`443`。

---

## 三、安装依赖并构建

```bash
cd /opt/it-2-department-management/backend
npm install
npm run build          # tsc -> dist/

cd ../frontend
npm install
npm run build          # -> frontend/dist/，后端会自动托管
```

---

## 四、配置 backend/.env

```bash
cd /opt/it-2-department-management/backend
cp .env.example .env
vim .env
```

服务器上需要改动的项：

```bash
# 当曲云账号（必填）
DANGQUYUN_USERNAME=xxx
DANGQUYUN_PASSWORD=xxx

# 服务器一般没装 Chrome，留空即可回退到 Playwright 自带内核
DANGQUYUN_BROWSER_CHANNEL=

# 服务器上必须用 api 模式（除非走 Xvfb 方案）
TAPD_FETCH_MODE=api
TAPD_API_USER=xxx
TAPD_API_PASSWORD=xxx
```

安装无头浏览器内核与系统依赖（当曲云抓取要用）：

```bash
npx playwright install chromium
npx playwright install-deps chromium   # 需要 root，装字体/图形库依赖
```

---

## 五、迁移已有数据（可选但通常需要）

真实工单数据在 `backend/data/store.json`，这个文件被 gitignore、**不在仓库里**，
换机器不会自动带过去。把本机那份传到服务器同路径即可：

```bash
# 在本机执行
scp backend/data/store.json root@<服务器IP>:/opt/it-2-department-management/backend/data/
```

不迁移的话系统是空的，需要在页面上用「更新工单 → 全量获取」重新抓一遍。

---

## 六、用 pm2 常驻运行

```bash
npm install -g pm2
cd /opt/it-2-department-management/backend
pm2 start dist/index.js --name it2-ticket
pm2 save
pm2 startup            # 按提示执行它输出的那条命令，实现开机自启
```

常用命令：

```bash
pm2 logs it2-ticket    # 看日志
pm2 restart it2-ticket # 重启
pm2 status
```

此时浏览器访问 `http://<服务器IP>:4000` 即可使用。

---

## 七、（可选）Nginx 转 80 端口 / 绑域名

```nginx
server {
    listen 80;
    server_name your.domain.com;
    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # 同步任务耗时很长，超时必须放宽，否则页面会先断开
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

`proxy_read_timeout` 这项别省——「全量获取」整份抓当曲云可能跑几十分钟，Nginx 默认 60 秒会直接断开。

---

## 八、每日定时同步

后端启动后会自动注册定时任务（`backend/src/scheduler.ts`）：

- **每天北京时间 18:30**，依次执行：获取新工单 → 更新工单 → 获取TAPD信息
- "今天是否已跑过"的标记随数据一起落盘，重启不会重复触发
- 三步各自记录「数据同步」类型的变更日志，可在页面上查看成败与失败原因

如果 TAPD 用的是浏览器模式而服务器没有图形环境，这条链路的第三步每天都会失败并记录日志——
这也是上面强烈建议服务器用 API 模式的原因。

---

## 九、数据备份（重要）

工单数据只存在 `backend/data/store.json` 这一个文件里，建议加定时备份：

```bash
mkdir -p /opt/backup
crontab -e
# 每天凌晨 3 点备份，保留最近 30 天
0 3 * * * cp /opt/it-2-department-management/backend/data/store.json /opt/backup/store-$(date +\%F).json && find /opt/backup -name 'store-*.json' -mtime +30 -delete
```

另外，页面上「勾选删除工单」在删除前会自动生成 `backend/data/store-backup-<时间>.json`，
误删时停掉服务、把该文件改名回 `store.json` 覆盖即可回滚。

---

## 十、后续更新代码

```bash
cd /opt/it-2-department-management
git pull origin main

cd backend  && npm install && npm run build
cd ../frontend && npm install && npm run build

pm2 restart it2-ticket
```

`.env` 和 `data/` 都在 gitignore 里，`git pull` 不会覆盖它们。

> ⚠️ 前端改动必须重新 `npm run build`，否则后端托管的还是旧的构建产物。

---

## 常见问题

**页面打不开 / 卡片消失 / 数据像是丢了**
先确认后端在跑：

```bash
curl http://localhost:4000/api/health    # 正常返回 {"ok":true}
pm2 status
```

前端连不上后端时，页面框架能显示但所有数据都是空的，看起来很像"数据丢了"，其实数据还在。

**当曲云抓取报"页面最终停留的地址与配置不符"**
登录态过期。代码已能自动识别并重新登录；若仍失败，删掉 `backend/.auth/dangquyun-state.json`
后重试，并检查 `.env` 里的账号密码。

**抓取报"未能识别当曲云工单列表页面结构"**
当曲云页面改版导致选择器失效。`backend/.auth/debug/` 下有失败时的截图与 HTML，可据此调整选择器。
