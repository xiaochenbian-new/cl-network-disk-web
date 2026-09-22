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
    renderContacts(data && data.contacts);
  }

  function contactHref(item) {
    var url = httpUrl(item.url);
    if (url) return url;
    if (item.type === "url") return httpUrl(item.value);
    if (item.type === "email" && item.value.indexOf("@") > 0) return "mailto:" + item.value;
    return "";
  }

  function renderContacts(list) {
    var section = document.getElementById("contact");
    var root = document.getElementById("contact-list");
    var footer = document.getElementById("footer-contacts");
    var nav = document.querySelector('.nav a[href="#contact"]');
    var items = (Array.isArray(list) ? list : [])
      .map(function (raw) {
        if (!raw || typeof raw !== "object") return null;
        var value = String(raw.value || "").trim();
        if (!value) return null;
        return {
          label: String(raw.label || raw.type || "联系方式").trim() || "联系方式",
          value: value,
          href: contactHref(raw),
          qrUrl: httpUrl(raw.qrUrl)
        };
      })
      .filter(Boolean);

    if (root) root.textContent = "";
    if (footer) footer.textContent = "";
    var visible = items.length > 0;
    if (section) section.hidden = !visible;
    if (footer) footer.hidden = !visible;
    if (nav) nav.hidden = !visible;
    if (!visible) return;

    items.forEach(function (item) {
      var card = document.createElement("article");
      card.className = "contact-card";

      var label = document.createElement("span");
      label.className = "contact-card-label";
      label.textContent = item.label;

      var value = document.createElement(item.href ? "a" : "span");
      value.className = "contact-card-value";
      value.textContent = item.value;
      if (item.href) {
        value.setAttribute("href", item.href);
        if (/^https?:\/\//i.test(item.href)) {
          value.setAttribute("target", "_blank");
          value.setAttribute("rel", "noopener noreferrer");
        }
      }

      card.appendChild(label);
      card.appendChild(value);
      if (item.qrUrl && root) {
        var img = document.createElement("img");
        img.src = item.qrUrl;
        img.alt = item.label + "二维码";
        card.appendChild(img);
      }
      if (root) root.appendChild(card);

      if (footer) {
        var foot = document.createElement(item.href ? "a" : "span");
        foot.textContent = item.label + "：" + item.value;
        if (item.href) {
          foot.setAttribute("href", item.href);
          if (/^https?:\/\//i.test(item.href)) {
            foot.setAttribute("target", "_blank");
            foot.setAttribute("rel", "noopener noreferrer");
          }
        }
        footer.appendChild(foot);
      }
    });
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
      renderContacts([]);
    });
})();
