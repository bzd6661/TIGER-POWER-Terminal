# TIGER POWER Terminal · BSC 内盘交易终端

作者:[@tiger_web3](https://x.com/tiger_web3) · 觉得好用可以在面板右上角「☕ 打赏作者」

用 **币安 Agentic Wallet**(`baw` 命令行)在 BSC 上买卖各家 Agent ID 内盘的本地工具:一个网页交易面板 + 一组命令行脚本。

支持的平台:

| 平台 | 内盘买 | 内盘卖 | 毕业后(外盘) |
|---|---|---|---|
| four.meme · Binance Agent ID 模式 | ✓(按 BNB / 买 1%) | ✓ | ✓ |
| Gang V1(BNB 计价) | ✓(买 1% / 0.5%) | ✓ * | ✓ |
| Gang V2(GANG / BNCB 等底池) | ✓(买 1% / 0.5%) | ✓ * | ✓ |
| Flap 内盘 | ✓(按 BNB) | ✓ | ✓ |
| 其他任何已上 DEX 的币 | — | — | ✓(币安钱包兑换) |

\* Gang 内盘卖出会被币安钱包风控标成「中风险」,面板里「需要时去 Binance App 确认」开关默认打开,卖出后到 App 里确认就行(不想要可以关掉)。

> **所有东西都只在你自己电脑上跑。** 不要把面板放到公网服务器上:谁能访问它,谁就能用你的钱包下单。

---

## 一、快速开始(Windows)

1. **装 Node.js 20 以上**:<https://nodejs.org>(一路下一步)
2. **下载这个仓库**(`git clone https://github.com/bzd6661/TIGER-POWER-Terminal.git`,或者在 GitHub 页面点 Code → Download ZIP 解压),**双击根目录的 `start.cmd`**。
   第一次会自动:检查 Node 版本 → 安装依赖(`npm install`)→ 没装币安钱包命令行(baw)就问你要不要装 → 启动面板 → 打开 <http://127.0.0.1:4400>。
3. 网页上点 **扫码登录**,用 Binance App 扫码、在 App 里确认,就能用了。

登录前,Binance App 里要准备好(登录页上也有提示):

- 开通 Agentic Wallet,并**绑定 Agent ID**(four Agent 模式 / Gang / Flap 内盘都要求钱包有 Agent ID)
- 钱包设置里打开**开发者模式**(合约调用要用,开一次大约 7 天后要重开)和**允许交易所有代币**
- 「异常交易处理」建议设成 **需要确认**(Gang 内盘卖出、被标风险的转账要用;设成自动拒绝的话这类交易会直接被拒)

**买 Gang V2 内盘** 还要装 Gang 官方命令行(其他平台不用):

```bash
npm i -g @gangfun/cli
```

登录信息只保存在本机(账号 1 存在 Windows 凭据管理器里),登录最长 48 小时,过期了面板上再扫一次就行。

面板在后台常驻(没有窗口):代码改了自动重启,崩了自动拉起,日志在 `panel/panel.log`。启动不起来时 `start.cmd` 会把日志最后几行打印出来。
想开机自动启动:按 `Win+R` 输入 `shell:startup`,在打开的文件夹里新建 `agentbuy-panel.vbs`,内容一行(路径换成你的):

```vbs
CreateObject("WScript.Shell").Run "wscript ""D:\agentbuy\panel\daemon.vbs""", 0, False
```

### 登录报 Connect Timeout / 连不上币安(中国大陆网络)

登录、下单都要连 `www.binance.com`。中国大陆的普通 DNS 会把它解析到假地址(比如 156.233.67.243),扫码登录就会报 `Connect Timeout Error`——浏览器能打开币安是因为走了代理或「安全 DNS」,而命令行程序默认两样都不用。

**面板已经自动处理 DNS 污染**:币安的域名改用阿里 / 腾讯的加密 DNS(DoH)解析,多数情况直接就能登录。如果还是连不上(说明连真实地址也被拦了),再开代理:

- **最简单**:打开 Clash / v2rayN 等代理软件的 **「系统代理」**,面板 30 秒内会自动用上,不用重启。
- **或者手动指定**:在项目根目录的 `.env` 里加一行 `HTTPS_PROXY=http://127.0.0.1:端口`(Clash 一般是 7890,v2rayN 一般是 10809),然后重新双击 `start.cmd`。

双击 `start.cmd` 时会自动测一次能不能连上币安,并告诉你现在走没走代理。

### 可选:`.env`(推荐配一个自己的节点)

把 `.env.example` 复制成 `.env` 再填(`.env` 不会提交到 git),改完重新双击 `start.cmd` 或等面板自动重启:

- `BSC_LOG_RPC`:查链上历史(扫链、K 线、成交记录、钱包追踪补历史)用的节点。**不填只能查最近约 1 小时**(公共节点的限制)。推荐去 [NodeReal](https://nodereal.io) 免费注册一个 BSC key,填 `https://bsc-mainnet.nodereal.io/v1/<你的key>`。
- `TG_BOT_TOKEN` / `TG_CHAT_ID`:Telegram 推送(发射后自动转出、自动领取、掉线提醒、Gang V3 监控)。不填就只在面板里提示。


### 面板怎么用

- **查币**:在页面任何地方 `Ctrl+V` 粘贴 CA,或按 `/` 到搜索框。自动识别平台和内/外盘。
- **中间**:GMGN 的 K 线(默认 1 分钟)+ 最近成交(你自己的成交会标出来)。
- **右边下单**:选账号 → 买入 / 卖出 → 点金额。默认会弹确认框(回车确认、Esc 取消);打开「一键交易」就点了直接下单。
- **左边**:持仓列表(按平台切换,显示成本和涨跌),点一下切到那个币;下面是钱包状态和「退出」。
- **没选币时**:中间是账户总览(两个号的余额、登录剩余、开发者额度、全部持仓和盈亏),点左上角「内盘终端」随时回来。
- **滑点 / 报价**:右边可以选滑点(默认按平台、3–35% 或自定义);下单确认框里会显示预计获得、最少获得和手续费。
- **我的仓位**:每个号的盈亏、累计买入 / 卖回,带「回本」按钮(只卖出成本那部分,留下利润仓)。
- **快捷键**:按住空格 + W 买 1%,空格 + F 清仓(默认仍会确认)。
- **发射后自动转出**(可选):先在账户总览的「设置」里填目标地址(输两遍、必须是你自己的),再到代币的「我的仓位」里逐个打开开关。检测到发射(毕业 / 开盘)就把每个号里这个币的全部持仓转过去,Flap 内盘 会先领取份额再转;结果推 Telegram(设 `TG_BOT_TOKEN` / `TG_CHAT_ID`)。改地址会自动关掉所有已打开的开关并推送通知。**转出无法撤回**,默认关闭。
- **转账**:账户总览里的「转账」卡片,选账号、资产(BNB / 持有的代币 / 粘贴任意 CA)、数量(25% / 50% / 全部)和收款地址,确认后执行。代币先预览再提交;**BNB 走币安钱包转账,收款地址要先加进 Binance App 的地址簿**(App 里手动转不受这个限制)。
- **剪贴板识别**:复制 CA 回到面板,顶栏会显示这个币,点一下打开(第一次要允许浏览器读剪贴板)。
- **收藏栏**:代币页点「☆ 收藏」,顶部收藏栏显示头像、市值和 24 小时涨跌,可分组。
- **钱包追踪**(顶部「追踪」):填地址或 .ai / .bnb 名字关注别人的钱包,自动补出最近 24 小时的内盘买卖,之后实时显示 four / Gang / Flap 内盘的建仓、加仓、减仓、清仓,可分组、写备注,有提示音。关注列表和动态只存在本机。补 24 小时历史需要在 .env 配 `BSC_LOG_RPC`(不配只能补约 1 小时)。
- **登录锁定**:每个账号第一次登录时记下钱包地址,以后扫码扫错了账号会自动退出;确实要换钱包,在登录弹窗里点「解除锁定」。已登录的号掉线会弹窗、响提示音、发浏览器通知和 TG。
- **底池币流动性门槛**:BNB 换成底池币(或卖出后换回 BNB)之前,先查这个币最深的池子;低于 2 万美元就不换(.env 里 `QUOTE_MIN_LIQ_USD` 可改)。
- **扫链简易版**:交易页最左边一列,可选 four / Gang / Flap 内盘 和 发射 / 待发射 / 已毕业,点一行打开;右上角 « 可隐藏(窗口窄于 1440 像素时自动隐藏)。
- **代币页转出**:外盘币在「我的仓位」每个账号下有「转出到地址…」,默认填自动转出地址;「需要时去 Binance App 确认」默认打开。
- **Ondo 类底池币**(FXIon 等代币化股票):币安只允许它和稳定币兑换,买卖 / 换回 BNB 时自动走 USDT 中转;价格 / 市值用 DexScreener 补。
- **K 线去水印**:点图表右下角 ⚙ → More settings… → Canvas → 取消 Watermark,只需设一次。
- **扫链**(顶部「扫链」):「盯新盘」三列(新盘 / 快打满 / 已开盘);「全部」是完整列表,可按平台、状态(含「我持有的」)筛选,点表头按市值、进度、成交额、持有人、创建时间等排序。GMGN 数据需要你自己的 GMGN API key(放在 `~/.config/gmgn/.env`),没有也能用,只是少这部分数据。

### 第二个账号(可选)

想同时用两个币安账号,需要给账号 2 单独装一份 baw(凭证存在 `baw2/.baw`,和账号 1 互不影响):

```bash
cd baw2
npm install
```

然后刷新面板,顶部会出现「+ 登录账号2」。登录后右边可以选「账号 2」或「两个号」同时下单。

---

## 二、命令行脚本(可选)

面板就是在调这些脚本,也可以直接在终端用。大部分脚本支持 `--acct 1|2|both` 和 `--dry`(只预览不下单)。

| 用途 | 命令 |
|---|---|
| Flap 内盘买 | `node fast.mjs <CA> <BNB> [--slip 30] [--wait]` |
| Flap 内盘卖 | `node sell.mjs <CA> <百分比>` |
| four.meme Agent 模式买 | `node fourbuy.mjs <CA> <BNB>` |
| four.meme 卖 | `node foursell.mjs <CA> <百分比>` |
| Gang V1 内盘买满 1% | `node gang/gangv1buy.mjs <CA>` |
| Gang V1 内盘卖 | `node gang/gangv1sell.mjs <CA> --pct 100 [--app-confirm]` |
| Gang V2 内盘买满 1% | `node gang/gangbuy.mjs <CA>`(Windows 上 gang CLI 用 `gang/gangw.cmd` 调) |
| Gang V2 内盘卖 | `node gang/gangv2sell.mjs <CA> <百分比> [--app-confirm]` |
| 外盘买(任何币) | `node dexbuy.mjs <CA> <BNB>` |
| 外盘卖(任何币) | `node dexsell.mjs <CA> <百分比>` |
| 转账(代币 / BNB) | `node transfer.mjs <CA 或 BNB> --to <地址> [--amount <数量 或 max>] [--app-confirm]` |
| Gang 持仓涨跌提醒 | `node gang/gangwatch.mjs`(持仓写在 `gang/positions.json`;设 `TG_BOT_TOKEN` / `TG_CHAT_ID` 环境变量会推 Telegram) |

four 脚本没有 `--acct`,账号 2 用 `four2.cmd fourbuy <CA> <BNB>` / `four2.cmd foursell <CA> <百分比>`。

### Gang V3 监控(可选)

双击 `gang/v3watch-run.cmd`(或 `node gang/v3watch.mjs`)**只监控、不下单**:Gang 部署钱包部署新合约、陌生合约发出 Gang 建币事件、gang.fun 接口 / 前端 / 官方 CLI 出现新发射台时推 Telegram。

`gang/v3watch-autobuy.cmd` 额外开启**自动买入**:新发射台上的前 3 个币,两个号各买 1%(每个号每个币折合超过 0.2 BNB 就不买)。每一笔照样先模拟 + 过币安风控,有风险提示或要去 App 批准的不会提交。注意:Gang 新版合约(V3 / 打新)的买入方式和 V2 不同,自动买入目前按 V2 方式下单,新版上线后可能买不进,请以 Telegram 推送为准、必要时手动买。

## 三、安全规则(脚本里写死的)

- 每笔交易先走 baw 的 **preview**(链上模拟 + 币安风控),模拟不过或有风险提示就**不执行**。
- 需要去 App 批准的交易默认不提交;只有 Gang 内盘卖出(面板开关默认打开)、自动转出(设置里打开)/ 命令行加 `--app-confirm` 时才提交,而且只放行「中风险」提示,高风险照样拦。
- 授权只授权这一笔要用的精确数量,不做无限授权。
- 面板只监听 `127.0.0.1`,校验 Host / Origin,下单要带页面里的随机令牌,别的网页没法替你下单。
- 面板里**已经登录的账号不会再发起登录**,不会误把现有会话顶掉。

## 四、哪些文件不要发给别人

这些都已经写在 `.gitignore` 里,**用 git 分享(或者 `git archive` 打包)不会带上**;直接复制整个文件夹给别人时要手动删掉:

- **登录凭证(最要紧)**:`baw2/.baw/`(账号 2)。账号 1 的凭证在 Windows 凭据管理器里,不在文件夹中
- **钱包信息**:`.wallet`、`.wallet2`(地址缓存)、`panel/wallet-pins.json`(登录锁定的地址)、`panel/txcache-*.json`(交易记录缓存)
- **你的设置和数据**:`.env`、`panel/autotransfer*.json`、`panel/lists.json`(收藏 / 屏蔽)、`panel/settings.json`、`panel/track.json`、`panel/track-feed.jsonl`(钱包追踪)、`gang/positions.json`、`gang/v3-state.json`、`auto-state.json`
- **缓存和日志**:`panel/.panel-token`、`panel/img-cache/`、`panel/scan-cache.json`、`panel/latency.jsonl`、`.liq-cache.json`、`.quote-routes.json`、`gang/cli-latest/`、`*.log`、`node_modules/`

---

本工具只是帮你调用自己钱包的下单接口,不构成任何投资建议。内盘币风险极高,自己判断。
