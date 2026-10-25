// 从客户端 legal.ts 生成官网 agreement.html / privacy.html。
// 用法：node scripts/generate-legal-pages.mjs [cl-network-disk-management 路径]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const clientDir = process.argv[2] || "../cl-network-disk-management";
const src = readFileSync(join(clientDir, "src/renderer/src/legal.ts"), "utf8");
const CONTACT = "微信：xiaochenbian21（官网 https://wangdou.win ）";
const EFFECTIVE = "2026年10月14日";

const reAll = /export const (EULA_TEXT|PRIVACY_TEXT) = `([\s\S]*?)`\s*;?/g;
const texts = {};
for (const m of src.matchAll(reAll)) {
  texts[m[1]] = m[2]
    .replace(/\$\{EULA_EFFECTIVE_DATE\}/g, EFFECTIVE)
    .replace(/（请补充：微信号 \/ QQ \/ 邮箱）/g, CONTACT);
}
if (!texts.EULA_TEXT || !texts.PRIVACY_TEXT) {
  throw new Error("EULA_TEXT / PRIVACY_TEXT 未找到: " + Object.keys(texts).join(","));
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function page(title, desc, body) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="${desc}" />
    <title>${title} - 网兜</title>
    <link rel="icon" href="assets/app-icon.png" type="image/png" />
    <link rel="stylesheet" href="styles.css" />
    <style>
      .legal-main { max-width: 780px; margin: 0 auto; padding: 48px 20px 64px; }
      .legal-main h1 { font-size: 1.7rem; margin-bottom: 4px; }
      .legal-meta { color: #6b7a77; font-size: 0.9rem; margin-bottom: 28px; }
      .legal-body p { margin: 0 0 10px; line-height: 1.85; }
      .legal-body h2 { font-size: 1.12rem; margin: 26px 0 10px; }
    </style>
  </head>
  <body>
    <header class="site-header">
      <a class="brand" href="/"><img src="assets/app-icon.png" alt="网兜" width="30" height="30" /><span>网兜</span></a>
      <nav class="nav" aria-label="导航">
        <a href="/">首页</a>
        <a href="/#download">下载</a>
      </nav>
    </header>
    <main class="legal-main">
      ${body}
    </main>
    <footer class="site-footer">
      <p class="footer-meta">© <span id="year"></span> 网兜</p>
    </footer>
    <script>document.getElementById("year").textContent = String(new Date().getFullYear());</script>
  </body>
</html>
`;
}

function render(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const parts = [];
  let open = false;
  for (const line of lines) {
    const m = line.match(/^([一二三四五六七八九十]+)、(.+)$/);
    if (m) {
      if (open) parts.push("</div>");
      parts.push(`<h2>${esc(m[1])}、${esc(m[2])}</h2>`);
      parts.push('<div class="legal-body">');
      open = true;
      continue;
    }
    parts.push(`<p>${esc(line)}</p>`);
  }
  if (open) parts.push("</div>");
  return parts.join("\n      ");
}

const eula = texts.EULA_TEXT;
const privacy = texts.PRIVACY_TEXT;
writeFileSync(
  "agreement.html",
  page("用户协议", "网兜用户协议：软件说明、激活码与 VIP、退款政策、行为规范与免责声明。", `<h1>${esc(eula.split("\n")[0].trim())}</h1><p class="legal-meta">生效日期：${EFFECTIVE}</p>${render(eula)}`)
);
writeFileSync(
  "privacy.html",
  page("隐私政策", "网兜隐私政策：凭证仅存本机、核销服务收到的匿名信息、WebDAV 端到端加密备份说明。", `<h1>${esc(privacy.split("\n")[0].trim())}</h1><p class="legal-meta">生效日期：${EFFECTIVE}</p>${render(privacy)}`)
);
console.log("agreement.html / privacy.html generated");
