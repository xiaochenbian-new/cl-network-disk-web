# 网兜官网（cl-network-disk-web）

静态介绍站。环境约定：

| 环境 | 分支 | 托管 |
|------|------|------|
| **测试** | `main` | GitHub Pages（Actions）+ CF Preview |
| **生产** | `production` | Cloudflare Pages（自定义域 wangdou.win） |

代码源以 **GitHub** 为准；Gitee `origin` 仅作镜像。

## 本地预览

用任意静态服务器打开本目录即可，例如：

```bash
npx --yes serve .
```

或直接用浏览器打开 `index.html`。

## 配置下载 / 仓库链接

下载地址在 **cl-license** 管理后台配置，不写死在官网里。

1. 打开 `https://cl-license.pages.dev/admin.html`
2. 左侧切到对应应用（网兜为 `wangdou`）
3. 打开 **下载配置**，可添加多个地址（名称、链接、说明）
4. 保存后，官网请求 `GET /api/plans?appId=wangdou`，使用返回的 `downloads`

`config.js` 只保留核销站地址；`downloads` 仅在接口不可用时作为备用：

```js
window.WANGDOU_SITE = {
  licenseApi: "https://cl-license.pages.dev",
  appId: "wangdou",
  downloads: [],
  githubUrl: "https://github.com/<user>/<repo>",
  giteeUrl: "https://gitee.com/<user>/<repo>"
};
```

## 部署到 Cloudflare Pages（生产）

```bash
npm install
npm run deploy          # → production 分支
npm run deploy:preview  # → main 预览
```

生产：https://wangdou.win/ · https://cl-network-disk-web.pages.dev/

Cloudflare Dashboard 建议连接 GitHub，**Production branch = `production`**。

## 部署到 GitHub Pages（测试）

推送 `main` 后由 `.github/workflows/deploy-pages.yml` 自动发布。

1. 仓库 **Settings → Pages** → Source 选 **GitHub Actions**
2. 测试地址：`https://xiaochenbian-new.github.io/cl-network-disk-web/`

## 部署到 Gitee Pages

1. 推送到 Gitee 仓库
2. 服务 → Gitee Pages → 选择分支与目录 → 启动

## 页面结构

| 文件 | 说明 |
|------|------|
| `index.html` | 首页（品牌 / 功能 / 网盘 / VIP / 下载） |
| `styles.css` | 样式 |
| `config.js` | 外链配置 |
| `main.js` | 应用配置与页脚年份 |
| `assets/app-icon.png` | 应用图标 |
