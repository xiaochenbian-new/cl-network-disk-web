/**
 * 网兜 Web 版（阶段一）
 * 流程：登录核销系统 → 本机解密云端备份（PBKDF2 + AES-256-GCM）→ 浏览/操作网盘（走代理）。
 * 网盘凭证只保存在本页内存，刷新即失效，不写入任何存储。
 */
(function () {
  var cfg = window.WANGDOU_SITE || {};
  var licenseApi = String(cfg.licenseApi || "https://license.wangdou.win").replace(/\/+$/, "");
  var KDF_ITERATIONS = 120000;

  var state = {
    token: sessionStorage.getItem("wd_token") || "",
    email: sessionStorage.getItem("wd_email") || "",
    accounts: [], // 解密后的网盘账号（含凭证，仅内存）
    selectedId: null,
    crumbs: [], // [{id,name}]
    files: [],
    supported: { "123": "123", baidu: "百度", aliyun: "阿里" },
    providerNames: {
      "123": "123 网盘",
      aliyun: "阿里云盘",
      lanzou: "蓝奏云",
      baidu: "百度网盘",
      xiaomi: "小米云盘",
      quark: "夸克网盘",
      "115": "115 网盘",
    },
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function fmtSize(n) {
    n = Number(n) || 0;
    if (!n) return "-";
    var u = ["B", "KB", "MB", "GB", "TB"], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(1) + " " + u[i];
  }
  function setMsg(el, text, isErr) {
    el.textContent = text || "";
    el.className = "msg" + (isErr ? " is-error" : "");
  }

  /* ---------------- 网络与加解密 ---------------- */

  async function api(path, body, token) {
    var res = await fetch(licenseApi + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: JSON.stringify(body),
    });
    var json = await res.json().catch(function () { return { ok: false, message: "响应异常" }; });
    if (!res.ok || !json.ok) throw new Error(json.message || "请求失败 (" + res.status + ")");
    return json;
  }

  function b64ToBuf(s) {
    var pad = 4 - (s.length % 4);
    var b64 = s.replace(/-/g, "+").replace(/_/g, "/") + (pad > 0 && pad < 4 ? "=".repeat(pad) : "");
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  function bufToB64(buf) {
    var bytes = new Uint8Array(buf);
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  async function deriveKey(password, encSaltB64) {
    var enc = new TextEncoder();
    var keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
    var bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(b64ToBuf(encSaltB64)), iterations: KDF_ITERATIONS },
      keyMaterial,
      256
    );
    return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["decrypt", "encrypt"]);
  }

  async function decryptBlob(blob, key) {
    var parts = String(blob).split(":");
    if (parts[0] !== "wd1") throw new Error("备份格式不识别，请升级客户端");
    var raw = new Uint8Array(b64ToBuf(parts[1]));
    // blob 布局为 iv|tag|ct（Node 风格），WebCrypto 要求 ct||tag，需要重排
    var ct = raw.slice(28);
    var tag = raw.slice(12, 28);
    var combined = new Uint8Array(ct.length + tag.length);
    combined.set(ct, 0);
    combined.set(tag, ct.length);
    var plain;
    try {
      plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, key, combined);
    } catch (e) {
      throw new Error("解密失败：云端备份与当前密码不匹配。请确认使用与客户端相同的密码登录；若刚重置过密码，请在客户端退出登录后重新登录一次");
    }
    var parsed = JSON.parse(new TextDecoder().decode(plain));
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.accounts)) throw new Error("备份内容格式不识别");
    return parsed;
  }

  /* ---------------- 代理 ---------------- */

  function accountById(id) {
    for (var i = 0; i < state.accounts.length; i++) if (state.accounts[i].id === id) return state.accounts[i];
    return null;
  }

  async function proxy(action, params) {
    var acc = accountById(state.selectedId);
    if (!acc) throw new Error("请先选择账号");
    var auth = { accessToken: acc.accessToken, cookie: acc.cookie, driveId: acc.driveId };
    var res = await fetch("/api/app-proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + state.token },
      body: JSON.stringify({ provider: acc.provider, action: action, auth: auth, params: params }),
    });
    var json = await res.json().catch(function () { return { ok: false, message: "响应异常" }; });
    if (res.status === 401) {
      doLogout(true);
      throw new Error("登录已过期，请重新登录");
    }
    if (!res.ok || !json.ok) throw new Error(json.message || "代理请求失败 (" + res.status + ")");
    return json;
  }

  /* ---------------- 视图切换 ---------------- */

  function showLogin() {
    $("view-login").hidden = false;
    $("view-app").hidden = true;
    $("user-chip").hidden = true;
    $("btn-logout").hidden = true;
  }

  function showApp() {
    $("view-login").hidden = true;
    $("view-app").hidden = false;
    $("user-chip").hidden = false;
    $("user-chip").textContent = state.email;
    $("btn-logout").hidden = false;
    renderAccounts();
  }

  function doLogout(expired) {
    sessionStorage.removeItem("wd_token");
    sessionStorage.removeItem("wd_email");
    state.token = "";
    state.email = "";
    state.accounts = [];
    state.selectedId = null;
    state.crumbs = [];
    state.files = [];
    showLogin();
    setMsg($("login-msg"), expired ? "登录已过期，请重新登录" : "已退出登录", expired);
  }

  /* ---------------- 登录与解锁 ---------------- */

  async function doLogin() {
    var email = $("login-email").value.trim();
    var password = $("login-password").value;
    var msgEl = $("login-msg");
    var btn = $("btn-login");
    if (!email || !password) { setMsg(msgEl, "请输入邮箱和密码", true); return; }
    btn.disabled = true;
    btn.textContent = "登录中…";
    setMsg(msgEl, "", false);
    try {
      var r = await api("/api/user", { action: "login", email: email, password: password });
      state.token = r.token;
      state.email = r.email;
      sessionStorage.setItem("wd_token", r.token);
      sessionStorage.setItem("wd_email", r.email);

      var unlockMsg = "";
      if (r.cloud && r.encSalt) {
        try {
          var key = await deriveKey(password, r.encSalt);
          var payload = await decryptBlob(r.cloud, key);
          state.accounts = payload.accounts || [];
          unlockMsg = "已解密 " + state.accounts.length + " 个云端备份账号";
        } catch (err) {
          unlockMsg = "云端备份解密失败：" + (err instanceof Error ? err.message : String(err));
        }
      } else {
        unlockMsg = "云端暂无备份：请先在网兜客户端登录并开启「云端备份网盘账号」";
      }
      showApp();
      setMsg($("app-msg"), unlockMsg, !state.accounts.length);
    } catch (err) {
      setMsg(msgEl, err instanceof Error ? err.message : String(err), true);
    } finally {
      btn.disabled = false;
      btn.textContent = "登录";
    }
  }

  /* ---------------- 账号列表 ---------------- */

  function renderAccounts() {
    var ul = $("account-list");
    ul.textContent = "";
    var unsupported = 0;
    state.accounts.forEach(function (acc) {
      var li = document.createElement("li");
      var supported = state.supported[acc.provider];
      var tag = document.createElement("span");
      tag.className = "provider-tag";
      tag.textContent = state.providerNames[acc.provider] || acc.provider;
      var name = document.createElement("span");
      name.textContent = acc.label || acc.username || acc.nickname || "未命名账号";
      li.appendChild(tag);
      li.appendChild(name);
      if (supported) {
        li.dataset.accId = acc.id;
        if (acc.id === state.selectedId) li.className = "is-active";
        li.addEventListener("click", function () { selectAccount(acc.id); });
      } else {
        li.className = "is-unsupported";
        unsupported += 1;
        name.textContent += "（Web 端暂不支持）";
      }
      ul.appendChild(li);
    });
    $("account-hint").textContent = unsupported
      ? unsupported + " 个账号的网盘暂不支持 Web 端操作，请在客户端使用"
      : "";
  }

  async function selectAccount(id) {
    state.selectedId = id;
    state.crumbs = [{ id: "", name: "根目录" }];
    renderAccounts();
    await loadFiles("");
  }

  /* ---------------- 文件浏览与操作 ---------------- */

  function currentParentId() {
    return state.crumbs.length ? state.crumbs[state.crumbs.length - 1].id : "";
  }

  function renderCrumbs() {
    var el = $("crumbs");
    el.textContent = "";
    state.crumbs.forEach(function (c, i) {
      var span = document.createElement("span");
      var link = document.createElement("span");
      link.className = i === state.crumbs.length - 1 ? "crumb-current" : "crumb-link";
      link.textContent = c.name;
      if (i < state.crumbs.length - 1) {
        (function (idx) {
          link.addEventListener("click", function () {
            state.crumbs = state.crumbs.slice(0, idx + 1);
            loadFiles(state.crumbs[state.crumbs.length - 1].id);
          });
        })(i);
      }
      span.appendChild(link);
      el.appendChild(span);
      if (i < state.crumbs.length - 1) {
        var sep = document.createElement("span");
        sep.textContent = " / ";
        el.appendChild(sep);
      }
    });
  }

  function renderFiles() {
    var tbody = $("file-tbody");
    tbody.textContent = "";
    if (!state.files.length) {
      var er = document.createElement("tr");
      var td = document.createElement("td");
      td.colSpan = 5;
      td.className = "empty-cell";
      td.textContent = "空目录";
      er.appendChild(td);
      tbody.appendChild(er);
      return;
    }
    state.files.forEach(function (f) {
      var tr = document.createElement("tr");

      var tdCheck = document.createElement("td");
      tdCheck.className = "col-check";
      tr.appendChild(tdCheck);

      var tdName = document.createElement("td");
      tdName.className = "col-name";
      if (f.isFolder) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "name-click";
        btn.textContent = "📁 " + f.filename;
        btn.addEventListener("click", function () {
          state.crumbs.push({ id: f.fileId, name: f.filename });
          loadFiles(f.fileId);
        });
        tdName.appendChild(btn);
      } else {
        tdName.textContent = "📄 " + f.filename;
      }
      tr.appendChild(tdName);

      var tdSize = document.createElement("td");
      tdSize.className = "col-size";
      tdSize.textContent = f.isFolder ? "-" : fmtSize(f.size);
      tr.appendChild(tdSize);

      var tdTime = document.createElement("td");
      tdTime.className = "col-time";
      tdTime.textContent = f.updateAt || "-";
      tr.appendChild(tdTime);

      var tdOps = document.createElement("td");
      tdOps.className = "ops";
      if (!f.isFolder) {
        var dl = document.createElement("button");
        dl.type = "button";
        dl.className = "btn btn-sm";
        dl.textContent = "下载";
        dl.addEventListener("click", function () { downloadFile(f); });
        tdOps.appendChild(dl);
      }
      var rn = document.createElement("button");
      rn.type = "button";
      rn.className = "btn btn-sm";
      rn.textContent = "重命名";
      rn.addEventListener("click", function () { renameFile(f); });
      tdOps.appendChild(rn);
      var del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn-sm";
      del.textContent = "删除";
      del.addEventListener("click", function () { deleteFile(f); });
      tdOps.appendChild(del);
      tr.appendChild(tdOps);

      tbody.appendChild(tr);
    });
  }

  async function loadFiles(parentId) {
    var msgEl = $("app-msg");
    setMsg(msgEl, "加载中…", false);
    renderCrumbs();
    try {
      var r = await proxy("list", { parentFileId: parentId });
      state.files = (r.items || []).sort(function (a, b) {
        if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
        return a.filename.localeCompare(b.filename, "zh-CN");
      });
      renderCrumbs();
      renderFiles();
      setMsg(msgEl, "", false);
    } catch (err) {
      state.files = [];
      renderFiles();
      setMsg(msgEl, err instanceof Error ? err.message : String(err), true);
    }
  }

  function downloadFile(f) {
    setMsg($("app-msg"), "获取下载地址…", false);
    proxy("download", { item: f })
      .then(function (r) {
        if (!r.url) throw new Error("未获取到下载地址");
        var a = document.createElement("a");
        a.href = r.url;
        a.download = f.filename;
        a.target = "_blank";
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setMsg($("app-msg"), "已开始下载（若浏览器拦截弹窗请允许）", false);
      })
      .catch(function (err) {
        setMsg($("app-msg"), err instanceof Error ? err.message : String(err), true);
      });
  }

  function askModal(title, fields, onOk) {
    var root = $("modal-root");
    var mask = document.createElement("div");
    mask.className = "modal-mask";
    var box = document.createElement("div");
    box.className = "modal";
    var h = document.createElement("h3");
    h.textContent = title;
    box.appendChild(h);
    var inputs = {};
    fields.forEach(function (f) {
      var label = document.createElement("label");
      label.textContent = f.label;
      var input = document.createElement("input");
      input.type = f.type || "text";
      input.value = f.value || "";
      input.placeholder = f.placeholder || "";
      if (f.autofocus) input.autofocus = true;
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") okBtn.click(); });
      label.appendChild(input);
      box.appendChild(label);
      inputs[f.key] = input;
    });
    var actions = document.createElement("div");
    actions.className = "modal-actions";
    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn";
    cancel.textContent = "取消";
    cancel.addEventListener("click", function () { mask.remove(); });
    var okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.className = "btn btn-primary";
    okBtn.textContent = "确定";
    okBtn.addEventListener("click", function () {
      var vals = {};
      Object.keys(inputs).forEach(function (k) { vals[k] = inputs[k].value.trim(); });
      onOk(vals, function () { mask.remove(); });
    });
    actions.appendChild(cancel);
    actions.appendChild(okBtn);
    box.appendChild(actions);
    mask.appendChild(box);
    root.appendChild(mask);
  }

  function renameFile(f) {
    askModal("重命名", [{ key: "name", label: "新名称", value: f.filename }], function (vals, close) {
      proxy("rename", { fileId: f.fileId, name: vals.name, isFolder: f.isFolder, path: f.path, item: f })
        .then(function () { close(); loadFiles(currentParentId()); })
        .catch(function (err) { setMsg($("app-msg"), err instanceof Error ? err.message : String(err), true); });
    });
  }

  function deleteFile(f) {
    if (!window.confirm("确认删除「" + f.filename + "」？（删除后进入对应网盘回收站）")) return;
    proxy("delete", { items: [f] })
      .then(function () { loadFiles(currentParentId()); })
      .catch(function (err) { setMsg($("app-msg"), err instanceof Error ? err.message : String(err), true); });
  }

  function mkdir() {
    askModal("新建文件夹", [{ key: "name", label: "文件夹名称", autofocus: true }], function (vals, close) {
      if (!vals.name) return;
      proxy("mkdir", { parentFileId: currentParentId(), name: vals.name })
        .then(function () { close(); loadFiles(currentParentId()); })
        .catch(function (err) { setMsg($("app-msg"), err instanceof Error ? err.message : String(err), true); });
    });
  }

  /* ---------------- 初始化 ---------------- */

  $("btn-login").addEventListener("click", doLogin);
  $("login-password").addEventListener("keydown", function (e) { if (e.key === "Enter") doLogin(); });
  $("btn-logout").addEventListener("click", function () { doLogout(false); });
  $("btn-refresh").addEventListener("click", function () { loadFiles(currentParentId()); });
  $("btn-mkdir").addEventListener("click", mkdir);

  // 已有会话 token：刷新后凭证不在内存，回到登录视图要求重新输密码解密
  if (state.token && state.email) {
    $("login-email").value = state.email;
    showLogin();
    setMsg($("login-msg"), "会话仍有效，输入密码解锁云端备份（凭证只在内存，刷新后需重新解密）", false);
  } else {
    showLogin();
  }
})();
