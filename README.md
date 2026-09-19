# 网兜官网（cl-network-disk-web）

静态介绍站，适合部署到 **GitHub Pages** 或 **Gitee Pages**。

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

## 部署到 Cloudflare Pages

本目录已配置 `wrangler.toml`，账号需已 `wrangler login`。

```bash
npm install
npm run deploy
# 等价：npx wrangler pages deploy . --project-name=cl-network-disk-web
```

线上地址：https://cl-network-disk-web.pages.dev/

## 部署到 GitHub Pages

1. 将本目录推送到 GitHub 仓库（可为独立仓库，或 monorepo 子目录）。
2. 仓库 **Settings → Pages**：
   - Source 选 `Deploy from a branch`
   - Branch 选 `main`（或 `gh-pages`），文件夹选 `/`（根目录）
3. 若仓库名不是 `username.github.io`，访问地址一般为：
   `https://<user>.github.io/<repo>/`
4. 已包含 `.nojekyll`，避免 Jekyll 忽略部分静态资源。

### 作为 monorepo 子目录发布

可用 GitHub Action 只发布 `cl-network-disk-web/` 内容到 `gh-pages` 分支，或把本目录单独拆成仓库。

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
