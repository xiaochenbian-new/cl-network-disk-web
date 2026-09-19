(function () {
  var cfg = window.WANGDOU_SITE || {};
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  function httpUrl(url) {
    var href = String(url || "").trim();
    if (!/^https?:\/\//i.test(href)) return "";
    if (href === "https://github.com/" || href === "https://gitee.com/") return "";
    return href;
  }

  function setHref(id, url, hideIfEmpty) {
    var el = document.getElementById(id);
    if (!el) return;
    var href = httpUrl(url);
    if (!href) {
      if (hideIfEmpty) {
        el.style.display = "none";
      } else {
        el.setAttribute("href", "#download");
        el.removeAttribute("target");
      }
      return;
    }
    el.setAttribute("href", href);
    el.setAttribute("target", "_blank");
    el.setAttribute("rel", "noopener noreferrer");
    el.style.display = "";
  }

  function collectDownloads(site) {
    var raw = Array.isArray(site && site.downloads) ? site.downloads : [];
    var list = [];
    raw.forEach(function (item) {
      if (!item) return;
      var url = httpUrl(typeof item === "string" ? item : item.url);
      if (!url) return;
      var name = "";
      var note = "";
      if (item && typeof item === "object") {
        name = String(item.name || "").trim();
        note = String(item.note || "").trim();
      }
      list.push({
        name: name || "下载",
        url: url,
        note: note
      });
    });
    return list;
  }

  function renderDownloads(list) {
    var root = document.getElementById("download-list");
    if (!root) return;
    root.textContent = "";
    list.forEach(function (item, index) {
      var link = document.createElement("a");
      link.className = "download-card" + (index === 0 ? " is-primary" : "");
      link.href = item.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";

      var text = document.createElement("span");
      var name = document.createElement("span");
      name.className = "download-card-name";
      name.textContent = item.name;
      text.appendChild(name);
      if (item.note) {
        var note = document.createElement("span");
        note.className = "download-card-note";
        note.textContent = item.note;
        text.appendChild(note);
      }

      var action = document.createElement("span");
      action.className = "download-card-action";
      action.textContent = "下载";

      link.appendChild(text);
      link.appendChild(action);
      root.appendChild(link);
    });
  }

  function applyDownloads(list) {
    renderDownloads(list);
    var primary = list[0];
    setHref("btn-download", primary ? primary.url : "", false);
    var hint = document.getElementById("download-hint");
    if (!hint) return;
    if (list.length > 1) {
      hint.textContent = "可任选一个地址下载。若某个链接打不开，请换用其他地址。安装后可在应用内开通 VIP。";
    } else if (list.length === 1) {
      hint.textContent = "安装后可在应用内开通 VIP。";
    } else {
      hint.textContent = "安装包准备中，请稍后再来。";
    }
  }

  function renderProviders(list) {
    var root = document.getElementById("provider-grid");
    if (!root || !Array.isArray(list)) return;
    var items = list
      .map(function (name) {
        return String(name || "").trim();
      })
      .filter(Boolean);
    root.textContent = "";
    items.forEach(function (name) {
      var li = document.createElement("li");
      li.textContent = name;
      root.appendChild(li);
    });
  }

  function renderBenefits(list) {
    var root = document.getElementById("vip-compare");
    if (!root || !Array.isArray(list)) return;
    Array.prototype.forEach.call(root.querySelectorAll(".vip-row:not(.vip-head)"), function (el) {
      el.remove();
    });
    list.forEach(function (item) {
      if (!item) return;
      var label = String(item.label || "").trim();
      var free = String(item.free || "").trim();
      var vip = String(item.vip || "").trim();
      if (!label && !free && !vip) return;
      var row = document.createElement("div");
      row.className = "vip-row";
      row.setAttribute("role", "row");
      [label || "—", free || "—", vip || "—"].forEach(function (text) {
        var span = document.createElement("span");
        span.textContent = text;
        row.appendChild(span);
      });
      root.appendChild(row);
    });
  }

  function applyShop(data) {
    applyDownloads(collectDownloads(data));
    var about = data && data.about;
    if (about && Array.isArray(about.providers)) renderProviders(about.providers);
    if (data && Array.isArray(data.benefits)) renderBenefits(data.benefits);
  }

  var hint = document.getElementById("download-hint");
  if (hint) hint.textContent = "正在读取下载地址…";

  var api = String(cfg.licenseApi || "https://cl-license.pages.dev").replace(/\/+$/, "");
  var appId = String(cfg.appId || "wangdou").trim() || "wangdou";

  fetch(api + "/api/plans?appId=" + encodeURIComponent(appId))
    .then(function (res) {
      if (!res.ok) throw new Error("plans " + res.status);
      return res.json();
    })
    .then(function (data) {
      if (!data || !data.ok) throw new Error("plans");
      applyShop(data);
    })
    .catch(function () {
      applyDownloads(collectDownloads(cfg));
    });
})();
