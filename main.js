(function () {
  var cfg = window.WANGDOU_SITE || {};
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  function setHref(id, url, hideIfEmpty) {
    var el = document.getElementById(id);
    if (!el) return;
    var href = String(url || "").trim();
    if (!href || href === "#" || href === "https://github.com/" || href === "https://gitee.com/") {
      if (hideIfEmpty) {
        el.style.display = "none";
      } else {
        el.setAttribute("href", "#download");
      }
      return;
    }
    el.setAttribute("href", href);
    el.setAttribute("target", "_blank");
    el.style.display = "";
  }

  var release =
    cfg.releaseUrl ||
    cfg.githubReleasesUrl ||
    "";

  setHref("link-release", release || "#download", false);
  setHref("btn-download", release ? release : "#download", false);
  setHref("link-github", cfg.githubUrl, true);
  setHref("link-gitee", cfg.giteeUrl, true);

  var hint = document.getElementById("download-hint");
  if (hint && release) {
    hint.textContent = "下载来自 Releases；安装后可在应用内开通 VIP。";
  }
})();
