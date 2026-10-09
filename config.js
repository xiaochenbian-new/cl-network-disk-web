/**
 * 官网链接配置
 * Cloudflare Pages：https://cl-network-disk-web.pages.dev/
 * GitHub Pages：https://xiaochenbian-new.github.io/cl-network-disk-web/
 *
 * 核销 API：生产 → license.wangdou.win；测试（GitHub Pages / main.* Preview）→ main.cl-license.pages.dev
 */
(function () {
  function isTestHost(hostname) {
    var h = String(hostname || "").toLowerCase();
    if (!h) return false;
    if (h === "localhost" || h === "127.0.0.1") return true;
    if (h.indexOf("github.io") !== -1) return true;
    if (h.indexOf("main.") === 0) return true;
    return false;
  }

  var test = typeof location !== "undefined" && isTestHost(location.hostname);
  window.WANGDOU_SITE = {
    licenseApi: test
      ? "https://main.cl-license.pages.dev"
      : "https://license.wangdou.win",
    appId: "wangdou",
    downloads: [],
    githubUrl: "https://github.com/xiaochenbian-new/cl-network-disk-web",
    giteeUrl: "https://gitee.com/xiaochenbian/cl-network-disk-web",
    cloudflareUrl: "https://cl-network-disk-web.pages.dev/"
  };
})();
