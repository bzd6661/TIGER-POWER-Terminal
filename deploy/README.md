# 部署公开网页版(tigerpower.online)

公开网页版只提供数据:扫链、代币页(K 线 / 成交 / 多空对决)、追踪。**服务器上没有任何钱包,也没有下单代码**,被攻破也动不了任何人的钱。下单仍然用本地版。

```
访客浏览器 ──https──► Cloudflare(防刷 / CDN) ──► Caddy(HTTPS 证书) ──► 数据服务 public-server.mjs(Docker)
```

## 需要准备

- 一台 Linux 服务器(Ubuntu 22.04 / 24.04),2 核 4G 足够。例如 Hetzner 最低档(每月约 4–6 欧元,亚洲用户选新加坡机房),或 Oracle Cloud 免费 ARM 主机。
- 域名 tigerpower.online,托管在 Cloudflare(免费版)。
- 可选:NodeReal 免费套餐的 BSC 节点(人多时公共节点会限流,见下面「容量」)。

## 步骤

### 1. 装 Docker

```bash
curl -fsSL https://get.docker.com | sh
```

### 2. 拉代码

```bash
git clone https://github.com/bzd6661/TIGER-POWER-Terminal.git
```

```bash
cd TIGER-POWER-Terminal
```

### 3.(可选)填自己的节点

```bash
cp deploy/.env.example deploy/.env
```

用编辑器打开 `deploy/.env`,填 `BSC_RPC` / `BSC_LOG_RPC`。不填也能跑。

### 4. 域名解析(Cloudflare)

1. 在 Cloudflare 添加站点 tigerpower.online,按提示把域名注册商那里的 NS 改成 Cloudflare 给的两个。
2. DNS 里加两条 A 记录:`@` 和 `www` 都指向服务器 IP。**先设成灰色云朵(仅 DNS)**,等第 5 步证书申请成功后再改成橙色云朵(代理)。
3. SSL/TLS 模式选 **Full (strict)**。

### 5. 启动

```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

第一次启动要 1–2 分钟扫链。检查:

```bash
curl -s https://tigerpower.online/health
```

返回 `"ok":true` 就好了。然后把 Cloudflare 的两条 A 记录改成橙色云朵。

### 6.(建议)Cloudflare 缓存扫链结果

扫链结果所有人都一样,让 Cloudflare 缓存 5 秒能挡掉大部分请求:
Cloudflare → Caching → Cache Rules → 新建规则:URI 路径等于 `/api/scan` → 「符合缓存条件」,边缘 TTL 选「使用源站的 Cache-Control」。

### 7.(建议)防火墙

```bash
ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw enable
```

## 日常

更新到最新版:

```bash
git pull && docker compose -f deploy/docker-compose.yml up -d --build
```

看日志:

```bash
docker compose -f deploy/docker-compose.yml logs -f --tail 100 tp
```

扫链缓存、成交缓存(SQLite)、代币图标存在 Docker 卷 `tpdata` 里,重启和升级都不会丢。

## 容量(本机压测)

| 场景 | 结果 |
|---|---|
| 500 人同时在看代币页 + 2000 个实时推送连接(缓存已热) | 每秒约 400 次请求,K 线 p95 10ms、代币信息 p95 0.3 秒,内存约 330MB |
| 300 人同时打开 60 个从没看过的币(冷启动) | 前几十秒公共节点和 gang.fun 接口会限流,部分请求慢到 10 秒;之后恢复正常 |

服务器本身不是瓶颈,瓶颈是**所有人共用服务器这一个 IP 去请求的外部接口**:

- 公共 BSC 节点:人多时识别新币会被限流 → 填 `BSC_RPC`(NodeReal)基本解决。
- gang.fun 接口:已经排队(同时最多 3 个)、被限流自动退避重试,失败时先用上一次的数据。
- GeckoTerminal(外盘 K 线):每分钟约 30 次,很多人同时看不同的已毕业币时 K 线会慢一点出来;结果有缓存(SQLite)。

每个访客 IP 有限速(每秒约 8 次请求、实时推送最多 4 个连接),页面本身的刷新节奏远低于这个值。

## 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `PUBLIC_ORIGINS` | 允许发请求的网址 | `https://tigerpower.online,https://www.tigerpower.online` |
| `TRUST_PROXY` | 按 Caddy 填的 `X-Real-IP` 识别访客 IP | 镜像里是 `1` |
| `AGENTBUY_DATA_DIR` | 缓存目录 | 镜像里是 `/data` |
| `MAX_STREAMS` | 实时推送最大连接数 | 3000 |
| `BSC_RPC` / `BSC_LOG_RPC` / `BSC_WSS` / `BSC_POLL_RPC` | 自己的节点 | 公共节点 |
