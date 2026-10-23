# 代理与「走代理的域名」 / Proxy and the host list

浏览器自动化里最常被问的一件事：**哪些网站走代理，哪些直连**。这份文档把它写死成一份可以直接套用的列表，并说明两个容易踩的边界。

## 一句话

代理地址填 Clash / v2ray 这类本地端口（例如 `127.0.0.1:7897`），然后用**预设**把常用被墙域名一次填进去：

```
/browser hosts preset
```

等价的 HTTP 调用（面板和脚本用这条）：

```sh
curl -X POST http://127.0.0.1:<gui-port>/dsh-wechat-media/proxy-hosts \
     -H 'content-type: application/json' \
     -d '{"action":"preset"}'
```

## 预设列表（26 条）

| 分类 | 域名 |
|---|---|
| Google | `google.com` `googleapis.com` `gstatic.com` `googleusercontent.com` `googlevideo.com` |
| 视频 | `youtube.com` `ytimg.com` |
| 代码 / 包 | `github.com` `githubusercontent.com` `githubassets.com` `jsdelivr.net` `unpkg.com` |
| 社交 | `x.com` `twitter.com` `twimg.com` `telegram.org` `t.me` `reddit.com` `medium.com` |
| 知识 | `wikipedia.org` `duckduckgo.com` |
| AI | `openai.com` `chatgpt.com` `claude.ai` `anthropic.com` `huggingface.co` |

规则是**后缀匹配**：写 `google.com` 就同时涵盖 `www.google.com`、`maps.google.com`、`translate.google.com`，所以列表里不需要逐个主机名。

## 增删

```
/browser hosts list                 # 现在哪些域名走代理
/browser hosts add foo.com          # 追加（可一次给多个，空格或逗号分隔）
/browser hosts remove foo.com       # 删掉一条
/browser hosts set a.com b.com      # 整体替换
/browser hosts clear                # 清空 = 代理应用到全部网址
/browser hosts preset               # 恢复本文档这份列表
```

面板上也能改（插件卡片 → 浏览器自动化 → 代理域名），两者写的是同一份状态：`$DSH_HOME/dsh-wechat-media/proxy-hosts.json`。

## 两个边界

### 1. PAC 只对「插件自己开的浏览器」生效

主机列表非空时，插件拉起浏览器用的是 `--proxy-pac-url`，由 **浏览器**按 PAC 逐请求决定走不走代理。但如果浏览器是**你自己的 Chrome / Edge**（会话模式 `extension`，即通过浏览器扩展驱动），那它走的是 Chrome 自己的代理设置，**这份列表不参与** —— 那时候能不能通，取决于你系统代理（Clash）的规则。

### 2. 空列表 ≠ 关闭代理

- 有代理地址 + 空列表 → `--proxy-server`：**全部网址**都走代理；
- 有代理地址 + 非空列表 → PAC：**只有列表里的**走代理，其余直连；
- 没有代理地址 → 不设置代理，跟随系统。

想彻底关掉：`/browser proxy off`。

## 为什么预设不是默认值

一份没人要求过的列表会把流量悄悄导到代理上，「为什么变慢 / 为什么打不开」就成了第一次使用的印象；用户主动选择的预设是另一回事。所以代码里它是 `COMMON_PROXY_HOSTS`（`browser.js`），通过 `preset` 动作显式应用。

## 提示

- 改完列表**下次打开浏览器生效**，已经开着的窗口要重开（`--proxy-pac-url` 在启动参数里）。
- 代理端口没在监听时，插件会在 `/browser proxy` 里报 ❌，而不是假装成功。
- 域名写错（例如带路径 `https://x.com/home`）会被规范化成主机名；完全不是域名的输入会报错并保留原列表。
