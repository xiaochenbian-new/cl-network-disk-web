/**
 * 网兜 Web 版
 * 登录核销系统 → 本机解密云端备份（PBKDF2 + AES-GCM）→ 文件管理 / 音乐视频（走代理）。
 * 网盘凭证只保存在本页内存，刷新即失效，不写入任何存储。
 */
(function () {
  var cfg = window.WANGDOU_SITE || {};
  // Web 端固定连生产核销系统：测试/生产环境账号与云端备份保持一致（应用端也同步到生产）
  var licenseApi = "https://license.wangdou.win";
  var KDF_ITERATIONS = 120000;
  var publicCfg = null; // { turnstileSiteKey, turnstileRequired }

  var PROVIDER_ICONS = {
    "123": "assets/providers/p-123.png",
    baidu: "assets/providers/p-baidu.png",
    aliyun: "assets/providers/p-aliyun.svg",
    lanzou: "assets/providers/p-lanzou.svg",
    xiaomi: "assets/providers/p-xiaomi.png",
    quark: "assets/providers/p-quark.png",
    "115": "assets/providers/p-115.svg",
  };

  var AUDIO_EXTS = [".mp3", ".flac", ".m4a", ".aac", ".wav", ".ogg", ".wma"];
  var VIDEO_EXTS = [".mp4", ".mkv", ".mov", ".webm", ".avi"];
  var SCAN_MAX_FOLDERS = 150;

  var state = {
    authMode: "login", // login | register
    captchaId: "",
    encKey: null, // 派生密钥（内存），用于把账号变更重新加密上传云端备份
    encSalt: null,
    supported: { "123": "123", baidu: "百度", aliyun: "阿里", quark: "夸克", "115": "115" },
    providerNames: {
      "123": "123 网盘",
      aliyun: "阿里云盘",
      lanzou: "蓝奏云",
      baidu: "百度网盘",
      xiaomi: "小米云盘",
      quark: "夸克网盘",
      "115": "115 网盘",
    },
    token: sessionStorage.getItem("wd_token") || "",
    email: sessionStorage.getItem("wd_email") || "",
    accounts: [], // 解密后的网盘账号（含凭证，仅内存）
    spaceInfo: {}, // accountId -> {usedBytes,totalBytes}
    selectedId: null,
    crumbs: [],
    files: [],
    page: "files", // files | media
    mediaKind: "music", // music | video
    mediaItems: [],
    scanning: false,
    scanAbort: false,
    playlist: [],
    plIndex: -1,
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
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var m = Math.floor(sec / 60), s2 = sec % 60;
    return (m < 10 ? "0" : "") + m + ":" + (s2 < 10 ? "0" : "") + s2;
  }
  function extOf(name) {
    var i = String(name || "").lastIndexOf(".");
    return i < 0 ? "" : String(name).slice(i).toLowerCase();
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

  async function deriveKeyBits(password, encSaltB64) {
    var enc = new TextEncoder();
    var keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
    return crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(b64ToBuf(encSaltB64)), iterations: KDF_ITERATIONS },
      keyMaterial,
      256
    );
  }

  async function deriveKey(password, encSaltB64) {
    var bits = await deriveKeyBits(password, encSaltB64);
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

  function proxyFor(acc, action, params) {
    var auth = { accessToken: acc.accessToken, cookie: acc.cookie, driveId: acc.driveId };
    return fetch("/api/app-proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + state.token },
      body: JSON.stringify({ provider: acc.provider, action: action, auth: auth, params: params }),
    }).then(function (res) {
      return res.json().then(function (json) {
        if (res.status === 401) { doLogout(true); throw new Error("登录已过期，请重新登录"); }
        if (!res.ok || !json.ok) throw new Error(json.message || "代理请求失败 (" + res.status + ")");
        return json;
      });
    });
  }

  function proxy(action, params) {
    var acc = accountById(state.selectedId);
    if (!acc) return Promise.reject(new Error("请先选择账号"));
    return proxyFor(acc, action, params);
  }

  /* ---------------- Turnstile（iframe 引托管页） ---------------- */

  function fetchPublicConfig() {
    if (publicCfg) return Promise.resolve(publicCfg);
    return fetch(licenseApi + "/api/user?action=public")
      .then(function (r) { return r.json(); })
      .then(function (j) {
        publicCfg = { turnstileSiteKey: j.turnstileSiteKey || "", turnstileRequired: Boolean(j.turnstileRequired) };
        return publicCfg;
      })
      .catch(function () { return { turnstileSiteKey: "", turnstileRequired: false }; });
  }

  function mountTurnstile(container) {
    return fetchPublicConfig().then(function (pc) {
      if (!pc.turnstileRequired) return "";
      return new Promise(function (resolve, reject) {
        var f = document.createElement("iframe");
        f.src = "https://wangdou.win/turnstile.html?sitekey=" + encodeURIComponent(pc.turnstileSiteKey);
        f.width = "310";
        f.height = "70";
        f.style.border = "none";
        container.appendChild(f);
        var handler = function (e) {
          if (e.origin !== "https://wangdou.win") return;
          if (e.data && e.data.type === "TURNSTILE_TOKEN") {
            window.removeEventListener("message", handler);
            resolve(e.data.token || "");
          } else if (e.data && e.data.type === "TURNSTILE_ERROR") {
            window.removeEventListener("message", handler);
            reject(new Error("人机验证失败，请重试"));
          }
        };
        window.addEventListener("message", handler);
      });
    });
  }

  /* ---------------- 图形验证码 ---------------- */

  function loadCaptcha() {
    return fetch(licenseApi + "/api/user?action=captcha")
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) throw new Error(j.message || "验证码加载失败");
        state.captchaId = j.captchaId;
        $("captcha-img").innerHTML = j.svg;
      })
      .catch(function (err) {
        $("captcha-img").textContent = "加载失败，点击刷新";
        setMsg($("login-msg"), err instanceof Error ? err.message : String(err), true);
      });
  }

  /* ---------------- 视图切换 ---------------- */

  function showLogin() {
    $("view-login").hidden = false;
    $("view-app").hidden = true;
    $("user-chip").hidden = true;
    $("btn-logout").hidden = true;
    $("tab-files").hidden = true;
    $("tab-media").hidden = true;
  }

  function showApp() {
    $("view-login").hidden = true;
    $("view-app").hidden = false;
    $("user-chip").hidden = false;
    $("user-chip").textContent = state.email;
    $("btn-logout").hidden = false;
    $("tab-files").hidden = false;
    $("tab-media").hidden = false;
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
    state.mediaItems = [];
    state.spaceInfo = {};
    state.encKey = null;
    state.encSalt = null;
    sessionStorage.removeItem("wd_enckey");
    sessionStorage.removeItem("wd_ensalt");
    stopPlayer();
    $("player").hidden = true;
    renderMedia();
    showLogin();
    setMsg($("login-msg"), expired ? "登录已过期，请重新登录" : "已退出登录", expired);
  }

  /* ---------------- 登录 / 注册 / 验证码 ---------------- */

  async function doLogin() {
    var email = $("login-email").value.trim();
    var password = $("login-password").value;
    var captchaCode = ($("login-captcha") ? $("login-captcha").value : "").trim();
    var msgEl = $("login-msg");
    var btn = $("btn-login");
    if (!email || !password) { setMsg(msgEl, "请输入邮箱和密码", true); return; }
    if (!captchaCode) { setMsg(msgEl, "请输入图形验证码", true); return; }
    btn.disabled = true;
    btn.textContent = "登录中…";
    setMsg(msgEl, "", false);
    try {
      var r = await api("/api/user", {
        action: "login",
        email: email,
        password: password,
        client: "web",
        captchaId: state.captchaId,
        captchaCode: captchaCode,
      });
      state.token = r.token;
      state.email = r.email;
      sessionStorage.setItem("wd_token", r.token);
      sessionStorage.setItem("wd_email", r.email);

      var unlockMsg = "";
      console.log("[网兜Web] 登录成功；云端备份长度 =", (r.cloud || "").length, "；盐 =", r.encSalt);
      if (r.cloud && r.encSalt) {
        try {
          var bits = await deriveKeyBits(password, r.encSalt);
          var key = await crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["decrypt", "encrypt"]);
          var payload = await decryptBlob(r.cloud, key);
          state.accounts = payload.accounts || [];
          state.encKey = key;
          state.encSalt = r.encSalt;
          // 密钥存 sessionStorage：刷新本标签页可自动恢复，关标签页即失效，服务器不可见
          sessionStorage.setItem("wd_enckey", bufToB64(bits));
          sessionStorage.setItem("wd_ensalt", r.encSalt);
          console.log("[网兜Web] 解密成功，账号数 =", state.accounts.length);
          unlockMsg = "已解密 " + state.accounts.length + " 个云端备份账号";
        } catch (err) {
          console.error("[网兜Web] 解密失败", err);
          unlockMsg = "云端备份解密失败：" + (err instanceof Error ? err.message : String(err));
        }
      } else {
        unlockMsg = "云端暂无备份：请先在网兜客户端登录并开启「云端备份网盘账号」";
      }
      showApp();
      setMsg($("app-msg"), unlockMsg, !state.accounts.length);
      // 侧栏也放一份错误横幅，避免被忽略
      var banner = $("account-banner");
      if (banner) {
        banner.hidden = !unlockMsg || state.accounts.length > 0;
        banner.textContent = unlockMsg || "";
        banner.className = "account-banner" + (state.accounts.length ? "" : " is-error");
      }
    } catch (err) {
      setMsg(msgEl, err instanceof Error ? err.message : String(err), true);
    } finally {
      btn.disabled = false;
      btn.textContent = "登录";
      loadCaptcha();
    }
  }

  function switchAuthMode(mode) {
    state.authMode = mode;
    var isLogin = mode === "login";
    $("login-title").textContent = isLogin ? "登录网兜 Web" : "注册网兜账号";
    $("login-hint").textContent = isLogin
      ? "使用网兜账号（邮箱 + 密码）登录。登录后将在本机解密云端备份的网盘账号，凭证不经服务器存储。"
      : "注册后可在任何设备登录网盘。需邮箱验证码 + 人机验证；密码经单向哈希校验，云备份以密码派生密钥端到端加密。";
    $("register-fields").hidden = isLogin;
    $("captcha-row").hidden = !isLogin;
    $("btn-login").textContent = isLogin ? "登录" : "注册";
    $("switch-mode").textContent = isLogin ? "没有账号？注册" : "已有账号？登录";
    $("login-msg").textContent = "";
    if (!isLogin) {
      mountTurnstile($("turnstile-row")).catch(function (err) {
        setMsg($("login-msg"), err instanceof Error ? err.message : String(err), true);
      });
    }
  }

  async function doRegister() {
    var email = $("login-email").value.trim();
    var password = $("login-password").value;
    var code = ($("register-code") ? $("register-code").value : "").trim();
    var msgEl = $("login-msg");
    var btn = $("btn-login");
    if (!email || password.length < 8) { setMsg(msgEl, "请输入邮箱和至少 8 位密码", true); return; }
    if (!/^\d{6}$/.test(code)) { setMsg(msgEl, "请输入 6 位邮箱验证码", true); return; }
    btn.disabled = true;
    btn.textContent = "注册中…";
    setMsg(msgEl, "", false);
    try {
      var r = await api("/api/user", { action: "register", email: email, password: password, code: code });
      state.token = r.token;
      state.email = r.email;
      sessionStorage.setItem("wd_token", r.token);
      sessionStorage.setItem("wd_email", r.email);
      state.accounts = [];
      showApp();
      setMsg($("app-msg"), "注册成功。请先在网兜客户端登录并开启「云端备份」，之后 Web 端即可浏览网盘", false);
    } catch (err) {
      setMsg(msgEl, err instanceof Error ? err.message : String(err), true);
      loadCaptcha();
    } finally {
      btn.disabled = false;
      btn.textContent = "注册";
    }
  }

  async function doSendRegisterCode() {
    var email = $("login-email").value.trim();
    var sendBtn = $("btn-send-code");
    if (sendBtn.disabled) return;
    if (!email) { setMsg($("login-msg"), "请先输入邮箱", true); return; }
    sendBtn.disabled = true;
    sendBtn.textContent = "发送中…";
    setMsg($("login-msg"), "", false);
    try {
      var turnstileToken = await mountTurnstile($("turnstile-row"));
      var r = await api("/api/user", { action: "requestVerifyCode", email: email, turnstileToken: turnstileToken });
      setMsg($("login-msg"), r.message || "验证码已发送，请查收邮件", false);
      var left = 60;
      sendBtn.textContent = left + "s 后重发";
      var timer = setInterval(function () {
        left -= 1;
        if (left <= 0) { clearInterval(timer); sendBtn.textContent = "重新发送"; sendBtn.disabled = false; }
        else { sendBtn.textContent = left + "s 后重发"; }
      }, 1000);
    } catch (err) {
      setMsg($("login-msg"), err instanceof Error ? err.message : String(err), true);
      sendBtn.disabled = false;
      sendBtn.textContent = "获取验证码";
    }
  }

  /* ---------------- 添加账号（保存到云端备份，应用端同步可见） ---------------- */

  var ADDABLE = [
    { provider: "123", label: "123 网盘（账号密码）", fields: [
      { key: "username", label: "账号（手机号/邮箱）", autofocus: true },
      { key: "password", label: "密码", type: "password" },
    ] },
    { provider: "aliyun", label: "阿里云盘（扫码登录）", qr: true, fields: [] },
    { provider: "quark", label: "夸克网盘（Cookie / 扫码）", qr: true, fields: [
      { key: "cookie", label: "夸克 Cookie（浏览器 DevTools 复制整段）", type: "textarea", autofocus: true },
    ] },
    { provider: "115", label: "115 网盘（粘贴 Cookie）", fields: [
      { key: "cookie", label: "115 Cookie", type: "textarea", autofocus: true },
    ] },
    { provider: "xiaomi", label: "小米云盘（粘贴 Cookie）", fields: [
      { key: "cookie", label: "小米 Cookie", type: "textarea", autofocus: true },
    ] },
    { provider: "lanzou", label: "蓝奏云（粘贴 Cookie）", fields: [
      { key: "cookie", label: "蓝奏云 Cookie", type: "textarea", autofocus: true },
    ] },
  ];

  function bufToB64(buf) {
    var bytes = new Uint8Array(buf);
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function saveAccountsToCloud() {
    if (!state.encKey || !state.encSalt) return Promise.resolve();
    var payload = { v: 1, savedAt: Date.now(), accounts: state.accounts };
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv },
      state.encKey,
      new TextEncoder().encode(JSON.stringify(payload))
    ).then(function (ctBuf) {
      // 与客户端 blob 布局一致：wd1:base64(iv|tag|ct)
      var ct = new Uint8Array(ctBuf);
      var tag = ct.slice(ct.length - 16);
      var body = ct.slice(0, ct.length - 16);
      var out = new Uint8Array(12 + 16 + body.length);
      out.set(iv, 0);
      out.set(tag, 12);
      out.set(body, 28);
      var blob = "wd1:" + bufToB64(out.buffer);
      return api("/api/user", { action: "sync", blob: blob, encSalt: state.encSalt }, state.token);
    });
  }

  function openAddAccount() {
    if (!state.encKey) {
      setMsg($("app-msg"), "添加账号需要先登录并解锁云端备份（刷新后请重新登录）", true);
      return;
    }
    var fieldBox = null;
    var fields = [];
    var mask = document.createElement("div");
    mask.className = "modal-mask";
    var box = document.createElement("div");
    box.className = "modal";
    var h = document.createElement("h3");
    h.textContent = "添加网盘账号";
    box.appendChild(h);
    var hint = document.createElement("p");
    hint.className = "hint tight";
    hint.textContent = "添加后加密同步到云端备份，客户端/Web 端均可见。百度/阿里需 OAuth 授权，请在客户端添加。";
    box.appendChild(hint);
    var selLabel = document.createElement("label");
    selLabel.textContent = "选择网盘";
    var providerSel = document.createElement("select");
    ADDABLE.forEach(function (a, i) {
      var opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = a.label;
      providerSel.appendChild(opt);
    });
    selLabel.appendChild(providerSel);
    box.appendChild(selLabel);
    fieldBox = document.createElement("div");
    box.appendChild(fieldBox);
    var msgP = document.createElement("p");
    msgP.className = "msg";
    box.appendChild(msgP);

    function finishAdd(acc) {
      state.accounts.push(acc);
      saveAccountsToCloud()
        .then(function () {
          mask.remove();
          renderAccounts();
          setMsg($("app-msg"), "已添加「" + acc.label + "」并加密同步到云端备份", false);
        })
        .catch(function (err) {
          msgP.textContent = err instanceof Error ? err.message : String(err);
          msgP.className = "msg is-error";
        });
    }

    var pollTimer = null;
    var pollGen = 0;

    function renderFields(def) {
      fieldBox.textContent = "";
      fields = def.fields;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      pollGen += 1;
      var oldScan = box.querySelector(".scan-area");
      if (oldScan) oldScan.remove();
      // 无表单字段（纯扫码）时隐藏确定按钮（ok 可能尚未创建，先判空）
      if (ok) ok.style.display = fields.length ? "" : "none";
      fields.forEach(function (f) {
        var label = document.createElement("label");
        label.textContent = f.label;
        var input = document.createElement(f.type === "textarea" ? "textarea" : "input");
        if (f.type === "textarea") {
          input.rows = 3;
          input.style.width = "100%";
          input.style.boxSizing = "border-box";
        } else {
          input.type = f.type || "text";
        }
        if (f.autofocus) input.autofocus = true;
        input.dataset.key = f.key;
        label.appendChild(input);
        fieldBox.appendChild(label);
      });
      if (def.qr) {
        var scanArea = document.createElement("div");
        scanArea.className = "scan-area";
        var scanBtn = document.createElement("button");
        scanBtn.type = "button";
        scanBtn.className = "btn btn-primary";
        scanBtn.textContent = "扫码登录";
        var qrBox = document.createElement("div");
        qrBox.className = "scan-qr";
        var scanStatus = document.createElement("p");
        scanStatus.className = "hint tight";
        scanArea.appendChild(scanBtn);
        scanArea.appendChild(qrBox);
        scanArea.appendChild(scanStatus);
        box.appendChild(scanArea);
        var myGen = pollGen;
        scanBtn.addEventListener("click", function () {
          if (pollTimer) clearInterval(pollTimer);
          var thisGen = pollGen;
          scanBtn.disabled = true;
          qrBox.textContent = "";
          scanStatus.textContent = "正在生成二维码…";
          var createP =
            def.provider === "aliyun"
              ? proxyFor({ provider: "aliyun", accessToken: "" }, "qr-create", {})
              : proxyFor({ provider: "quark", accessToken: "" }, "qr-create", {});
          createP.then(function (r) {
            if (thisGen !== pollGen) return;
            if (def.provider === "aliyun") {
              var img = document.createElement("img");
              img.src = r.qrDataUrl;
              img.width = 190;
              qrBox.appendChild(img);
            } else {
              var qr = window.qrcode(0, "M");
              qr.addData(r.payloadUrl);
              qr.make();
              qrBox.innerHTML = qr.createImgTag(4, 8);
            }
            scanStatus.textContent = "请用对应网盘 App 扫码确认";
            var tries = 0;
            pollTimer = setInterval(function () {
              if (thisGen !== pollGen || mask.isConnected === false) { clearInterval(pollTimer); return; }
              tries += 1;
              if (tries > 90) {
                clearInterval(pollTimer);
                scanStatus.textContent = "二维码已超时，请重新点击「扫码登录」";
                return;
              }
              var pr =
                def.provider === "aliyun"
                  ? proxyFor({ provider: "aliyun", accessToken: "" }, "qr-poll", { sid: r.sid, cookie: r.cookie })
                  : proxyFor({ provider: "quark", accessToken: "" }, "qr-poll", { token: r.token, requestId: r.requestId });
              pr.then(function (p) {
                if (thisGen !== pollGen) return;
                if (!p.done) return;
                clearInterval(pollTimer);
                if (def.provider === "aliyun") {
                  proxyFor({ provider: "aliyun", accessToken: p.accessToken }, "drive-id", {})
                    .then(function (d) {
                      finishAdd({
                        id: "web-" + crypto.randomUUID(),
                        provider: "aliyun",
                        label: "阿里云盘",
                        accessToken: p.accessToken,
                        refreshToken: p.refreshToken,
                        driveId: d.driveId,
                        status: "online",
                        defaultParentId: "",
                        defaultParentPath: "/",
                      });
                      mask.remove();
                    })
                    .catch(function (err) {
                      scanStatus.textContent = err.message;
                      scanBtn.disabled = false;
                    });
                } else {
                  finishAdd({
                    id: "web-" + crypto.randomUUID(),
                    provider: "quark",
                    label: "夸克网盘",
                    cookie: p.cookie,
                    status: "online",
                    defaultParentId: "",
                    defaultParentPath: "/",
                  });
                  mask.remove();
                }
              }).catch(function (err) {
                scanStatus.textContent = err.message;
              });
            }, 2000);
          }).catch(function (err) {
            scanStatus.textContent = err instanceof Error ? err.message : String(err);
            scanBtn.disabled = false;
          });
        });
      }
    }
    providerSel.addEventListener("change", function () {
      renderFields(ADDABLE[Number(providerSel.value)]);
    });
    renderFields(ADDABLE[0]);

    var actions = document.createElement("div");
    actions.className = "modal-actions";
    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn";
    cancel.textContent = "取消";
    cancel.addEventListener("click", function () { mask.remove(); });
    var ok = document.createElement("button");
    ok.type = "button";
    ok.className = "btn btn-primary";
    ok.textContent = "添加";
    ok.addEventListener("click", function () {
      var def = ADDABLE[Number(providerSel.value)];
      var vals = {};
      fields.forEach(function (f) {
        var el = fieldBox.querySelector('[data-key="' + f.key + '"]');
        vals[f.key] = el ? el.value.trim() : "";
      });
      ok.disabled = true;
      msgP.textContent = "正在添加…";
      var acc = {
        id: "web-" + crypto.randomUUID(),
        provider: def.provider,
        label: def.provider === "123" ? vals.username : state.providerNames[def.provider],
        username: def.provider === "123" ? vals.username : "",
        status: "online",
        defaultParentId: "",
        defaultParentPath: "/",
      };
      var authReady;
      if (def.provider === "123") {
        if (!vals.username || !vals.password) { msgP.textContent = "请输入账号和密码"; ok.disabled = false; return; }
        acc.label = vals.username;
        authReady = proxyFor({ provider: "123", accessToken: "" }, "login", vals).then(function (r) {
          acc.accessToken = r.accessToken;
        });
      } else {
        if (!vals.cookie) { msgP.textContent = "请粘贴 Cookie"; ok.disabled = false; return; }
        acc.cookie = vals.cookie;
        authReady = Promise.resolve();
      }
      authReady.then(function () {
        state.accounts.push(acc);
        return saveAccountsToCloud();
      }).then(function () {
        mask.remove();
        renderAccounts();
        setMsg($("app-msg"), "已添加「" + acc.label + "」并加密同步到云端备份", false);
      }).catch(function (err) {
        var msg = err instanceof Error ? err.message : String(err);
        // 123 官方对数据中心 IP 有境外登录风控：引导用户去客户端添加
        if (/境外|风险|短信验证码/.test(msg)) {
          msg = msg + "\n解决办法：请在网兜客户端「添加账号」登录该网盘（本机登录无风控），并开启云端备份，Web 端即可使用。";
        }
        msgP.textContent = msg;
        msgP.className = "msg is-error";
        msgP.style.whiteSpace = "pre-line";
        ok.disabled = false;
      });
    });
    actions.appendChild(cancel);
    actions.appendChild(ok);
    box.appendChild(actions);
    mask.appendChild(box);
    $("modal-root").appendChild(mask);
  }

  /* ---------------- 账号列表（应用端同款卡片） ---------------- */

  function renderAccounts() {
    var ul = $("account-list");
    ul.textContent = "";
    var unsupported = 0;
    var supportedMap = state.supported || { "123": "123", baidu: "百度", aliyun: "阿里" };
    try {
    state.accounts.forEach(function (acc) {
      var li = document.createElement("li");
      var supported = !!supportedMap[acc.provider];
      if (supported) {
        li.dataset.accId = acc.id;
        if (acc.id === state.selectedId) li.className = "is-active";
        li.addEventListener("click", function () { selectAccount(acc.id); });
      } else {
        li.className = "is-unsupported";
        unsupported += 1;
      }

      var line1 = document.createElement("div");
      line1.className = "acc-line1";
      var icon = document.createElement("img");
      icon.className = "acc-icon";
      icon.src = PROVIDER_ICONS[acc.provider] || "";
      icon.alt = "";
      line1.appendChild(icon);
      var tag = document.createElement("span");
      tag.className = "provider-tag";
      tag.textContent = state.providerNames[acc.provider] || acc.provider;
      line1.appendChild(tag);
      var name = document.createElement("span");
      name.className = "acc-name";
      name.textContent = acc.label || acc.username || acc.nickname || "未命名账号";
      line1.appendChild(name);
      li.appendChild(line1);

      var line2 = document.createElement("div");
      line2.className = "acc-line2";
      line2.textContent = "账号：" + (acc.username || acc.label || "-");
      li.appendChild(line2);

      var sp = state.spaceInfo[acc.id];
      var line3 = document.createElement("div");
      line3.className = "acc-line3";
      if (sp && sp.totalBytes) {
        var bar = document.createElement("div");
        bar.className = "acc-bar";
        var fill = document.createElement("div");
        fill.className = "acc-bar-fill";
        var pct = Math.min(100, Math.round((sp.usedBytes / sp.totalBytes) * 100));
        fill.style.width = pct + "%";
        bar.appendChild(fill);
        line3.appendChild(bar);
        var line4 = document.createElement("div");
        line4.className = "acc-line4";
        line4.textContent = fmtSize(sp.usedBytes) + " / " + fmtSize(sp.totalBytes);
        li.appendChild(line4);
      } else if (supported) {
        line3.textContent = "空间信息加载中…";
      } else {
        line3.textContent = "Web 端暂不支持";
      }
      li.appendChild(line3);

      ul.appendChild(li);
    });
    } catch (err) {
      // 渲染异常必须可见：之前异常被吞导致列表空白且无提示
      console.error("[网兜Web] 账号渲染失败", err);
      $("account-hint").textContent = "账号渲染失败：" + (err instanceof Error ? err.message : String(err));
    }
    $("account-hint").textContent = unsupported
      ? unsupported + " 个账号的网盘暂不支持 Web 端操作，请在客户端使用"
      : $("account-hint").textContent;
  }

  async function loadSpace(acc) {
    if (state.spaceInfo[acc.id] || !state.supported || !state.supported[acc.provider]) return;
    try {
      var r = await proxyFor(acc, "space", {});
      state.spaceInfo[acc.id] = r;
      if (acc.id === state.selectedId) renderAccounts();
    } catch {
      state.spaceInfo[acc.id] = {};
    }
  }

  async function selectAccount(id) {
    state.selectedId = id;
    state.crumbs = [{ id: "", name: "根目录" }];
    state.mediaItems = [];
    renderAccounts();
    renderMedia();
    var acc = accountById(id);
    if (acc) void loadSpace(acc);
    setPage(state.page);
    if (state.page === "files") await loadFiles("");
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

  function utf8ToB64url(s) {
    var bytes = new TextEncoder().encode(s);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  var downloadUrlFor = (f, accOverride) => {
    var a = accOverride || accountById(state.selectedId);
    if (!a) throw new Error("请先选择账号");
    var d = utf8ToB64url(JSON.stringify({
      provider: a.provider,
      auth: { accessToken: a.accessToken, cookie: a.cookie, driveId: a.driveId },
      item: f,
    }));
    return "/api/app-download?token=" + encodeURIComponent(state.token) + "&d=" + d;
  };

  function downloadFile(f) {
    try {
      var a = document.createElement("a");
      a.href = downloadUrlFor(f);
      a.download = f.filename;
      a.target = "_blank";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setMsg($("app-msg"), "已开始下载（大文件由服务器流式转发）", false);
    } catch (err) {
      setMsg($("app-msg"), err instanceof Error ? err.message : String(err), true);
    }
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

  /* ---------------- 页面切换 ---------------- */

  function setPage(page) {
    state.page = page;
    $("page-files").hidden = page !== "files";
    $("page-media").hidden = page !== "media";
    $("tab-files").className = "btn btn-sm topbar-btn" + (page === "files" ? " is-active" : "");
    $("tab-media").className = "btn btn-sm topbar-btn" + (page === "media" ? " is-active" : "");
  }

  /* ---------------- 音乐视频：扫描 ---------------- */

  function setMediaTab(kind) {
    state.mediaKind = kind;
    $("media-tab-music").className = "btn btn-sm" + (kind === "music" ? " is-active" : "");
    $("media-tab-video").className = "btn btn-sm" + (kind === "video" ? " is-active" : "");
  }

  function renderMedia() {
    var tbody = $("media-tbody");
    tbody.textContent = "";
    var items = state.mediaItems;
    if (!items.length) {
      var er = document.createElement("tr");
      var td = document.createElement("td");
      td.colSpan = 4;
      td.className = "empty-cell";
      td.textContent = state.scanning
        ? "扫描中…"
        : state.mediaKind === "music"
          ? "还没有音乐扫描结果，点击上方「扫描音乐」开始"
          : "还没有视频扫描结果，点击上方「扫描视频」开始";
      er.appendChild(td);
      tbody.appendChild(er);
      return;
    }
    items.forEach(function (it, idx) {
      var tr = document.createElement("tr");
      var tdName = document.createElement("td");
      tdName.className = "col-name";
      tdName.textContent = it.filename;
      tr.appendChild(tdName);
      var tdSize = document.createElement("td");
      tdSize.className = "col-size";
      tdSize.textContent = fmtSize(it.size);
      tr.appendChild(tdSize);
      var tdPath = document.createElement("td");
      tdPath.className = "col-time";
      tdPath.textContent = it.path || "-";
      tr.appendChild(tdPath);
      var tdOps = document.createElement("td");
      tdOps.className = "ops";
      if (state.mediaKind === "music") {
        var play = document.createElement("button");
        play.type = "button";
        play.className = "btn btn-sm btn-primary";
        play.textContent = "播放";
        play.addEventListener("click", function () { playTrack(idx); });
        tdOps.appendChild(play);
      }
      var dl = document.createElement("button");
      dl.type = "button";
      dl.className = "btn btn-sm";
      dl.textContent = "下载";
      dl.addEventListener("click", function () { downloadFile(it); });
      tdOps.appendChild(dl);
      tr.appendChild(tdOps);
      tbody.appendChild(tr);
    });
  }

  async function scanMedia(kind) {
    if (state.scanning) return;
    if (!state.selectedId) {
      setMsg($("media-msg"), "请先在左侧选择账号", true);
      return;
    }
    state.scanning = true;
    state.scanAbort = false;
    state.mediaKind = kind;
    state.mediaItems = [];
    renderMedia();
    setMediaTab(kind);
    $("btn-scan-music").disabled = true;
    $("btn-scan-video").disabled = true;
    $("btn-scan-stop").hidden = false;
    var msgEl = $("media-msg");
    setMsg(msgEl, "扫描中：已扫 0 个目录，找到 0 个", false);

    var exts = kind === "music" ? AUDIO_EXTS : VIDEO_EXTS;
    var queue = [""];
    var scanned = 0;
    var found = [];
    var inFlight = 0;

    function isTarget(name) {
      return exts.indexOf(extOf(name)) !== -1;
    }

    await new Promise(function (resolve) {
      function maybeDone() {
        if (!queue.length && !inFlight) resolve();
      }
      function launchNext() {
        if (state.scanAbort) { resolve(); return; }
        if (!queue.length || scanned >= SCAN_MAX_FOLDERS) { maybeDone(); return; }
        var dir = queue.shift();
        scanned += 1;
        inFlight += 1;
        setMsg(msgEl, "扫描中：已扫 " + scanned + " 个目录，找到 " + found.length + " 个", false);
        proxy("list", { parentFileId: dir })
          .then(function (r) {
            (r.items || []).forEach(function (f) {
              if (f.isFolder) {
                if (queue.length + inFlight < SCAN_MAX_FOLDERS) queue.push(f.fileId);
              } else if (isTarget(f.filename)) {
                var copy = Object.assign({}, f, { path: f.filename });
                found.push(copy);
              }
            });
            inFlight -= 1;
            maybeDone();
            launchNext();
          })
          .catch(function () {
            inFlight -= 1;
            maybeDone();
            launchNext();
          });
      }
      launchNext();
      launchNext();
    });

    state.scanning = false;
    $("btn-scan-music").disabled = false;
    $("btn-scan-video").disabled = false;
    $("btn-scan-stop").hidden = true;
    state.mediaItems = found;
    renderMedia();
    setMsg(
      msgEl,
      (state.scanAbort ? "已停止。" : "扫描完成。") +
        "共扫 " + scanned + " 个目录，找到 " + found.length + " 个" + (kind === "music" ? "音乐" : "视频"),
      false
    );
  }

  /* ---------------- 播放器 ---------------- */

  function plAudio() { return $("pl-audio"); }

  async function playTrack(idx) {
    var track = state.mediaItems[idx];
    if (!track) return;
    state.playlist = state.mediaItems.filter(function (f) {
      return AUDIO_EXTS.indexOf(extOf(f.filename)) !== -1;
    });
    state.plIndex = state.playlist.indexOf(track);
    if (state.plIndex < 0) { state.playlist.unshift(track); state.plIndex = 0; }
    await startCurrentTrack();
  }

  async function startCurrentTrack() {
    var track = state.playlist[state.plIndex];
    if (!track) return;
    $("player").hidden = false;
    $("player-title").textContent = track.filename;
    var audio = plAudio();
    audio.src = downloadUrlFor(track);
    audio.play().then(function () {
      $("pl-play").textContent = "⏸";
      $("player-disc").className = "player-disc is-playing";
    }).catch(function () { /* 自动播放被拦截时由用户点播放 */ });
    renderPlaylist();
  }

  function plToggle() {
    var audio = plAudio();
    if (!audio.src) {
      if (state.playlist.length) startCurrentTrack();
      return;
    }
    if (audio.paused) {
      audio.play();
      $("pl-play").textContent = "⏸";
      $("player-disc").className = "player-disc is-playing";
    } else {
      audio.pause();
      $("pl-play").textContent = "▶";
      $("player-disc").className = "player-disc";
    }
  }

  function plPrev() {
    if (!state.playlist.length) return;
    state.plIndex = (state.plIndex - 1 + state.playlist.length) % state.playlist.length;
    startCurrentTrack();
  }

  function plNext() {
    if (!state.playlist.length) return;
    state.plIndex = (state.plIndex + 1) % state.playlist.length;
    startCurrentTrack();
  }

  function stopPlayer() {
    var audio = plAudio();
    try { audio.pause(); audio.removeAttribute("src"); audio.load(); } catch { /* ignore */ }
    $("pl-play").textContent = "▶";
  }

  function renderPlaylist() {
    var box = $("pl-playlist");
    box.textContent = "";
    state.playlist.forEach(function (t, i) {
      var row = document.createElement("div");
      row.className = "pl-track" + (i === state.plIndex ? " is-active" : "");
      row.textContent = t.filename;
      row.addEventListener("click", function () {
        state.plIndex = i;
        startCurrentTrack();
      });
      box.appendChild(row);
    });
  }

  /* ---------------- 初始化 ---------------- */

  $("btn-login").addEventListener("click", function () {
    if (state.authMode === "login") doLogin();
    else doRegister();
  });
  $("btn-send-code").addEventListener("click", doSendRegisterCode);
  $("switch-mode").addEventListener("click", function () {
    switchAuthMode(state.authMode === "login" ? "register" : "login");
  });
  $("captcha-img").addEventListener("click", loadCaptcha);
  $("login-password").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { if (state.authMode === "login") doLogin(); else doRegister(); }
  });
  loadCaptcha();

  $("btn-add-account").addEventListener("click", openAddAccount);

  // 侧栏宽度拖动（对齐应用端：左侧列表与右侧内容可调）
  (function initSideResize() {
    var saved = Number(localStorage.getItem("wd_side_w"));
    if (saved >= 200 && saved <= 480) $("view-app").querySelector(".side").style.flex = "0 0 " + saved + "px";
    var resizer = document.createElement("div");
    resizer.className = "side-resizer";
    resizer.title = "拖动调整宽度";
    var side = $("view-app").querySelector(".side");
    side.parentNode.insertBefore(resizer, side.nextSibling);
    var dragging = false;
    resizer.addEventListener("mousedown", function (e) {
      dragging = true;
      e.preventDefault();
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    });
    document.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      // 侧栏是 flex 项，flex-basis 优先于 width，必须改 flex
      var w = Math.min(480, Math.max(200, e.clientX));
      side.style.flex = "0 0 " + w + "px";
    });
    document.addEventListener("mouseup", function () {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      var w = parseInt(side.style.flex.replace(/[^0-9]/g, ""), 10);
      if (w) localStorage.setItem("wd_side_w", String(w));
    });
  })();
  $("btn-refresh").addEventListener("click", function () { loadFiles(currentParentId()); });
  $("btn-mkdir").addEventListener("click", mkdir);
  $("btn-logout").addEventListener("click", function () { doLogout(false); });

  $("tab-files").addEventListener("click", function () { setPage("files"); });
  $("tab-media").addEventListener("click", function () { setPage("media"); });
  $("btn-scan-music").addEventListener("click", function () { scanMedia("music"); });
  $("btn-scan-video").addEventListener("click", function () { scanMedia("video"); });
  $("btn-scan-stop").addEventListener("click", function () { state.scanAbort = true; });
  $("media-tab-music").addEventListener("click", function () { setMediaTab("music"); renderMedia(); });
  $("media-tab-video").addEventListener("click", function () { setMediaTab("video"); renderMedia(); });

  // 播放器
  $("pl-play").addEventListener("click", plToggle);
  $("pl-prev").addEventListener("click", plPrev);
  $("pl-next").addEventListener("click", plNext);
  $("pl-list").addEventListener("click", function () {
    var box = $("pl-playlist");
    box.hidden = !box.hidden;
    if (!box.hidden) renderPlaylist();
  });
  var audio = plAudio();
  audio.addEventListener("timeupdate", function () {
    $("pl-time").textContent = fmtTime(audio.currentTime) + " / " + fmtTime(audio.duration || 0);
    if (audio.duration > 0) $("pl-seek").value = String(Math.round((audio.currentTime / audio.duration) * 1000));
  });
  $("pl-seek").addEventListener("input", function (e) {
    if (audio.duration > 0) audio.currentTime = (Number(e.target.value) / 1000) * audio.duration;
  });
  audio.addEventListener("ended", plNext);

  // 侧栏底部:支持的网盘(与客户端一致的 7 家,Web 可操作的标绿)
  (function renderSupportedGrid() {
    var grid = $("supported-grid");
    var providers = [
      { id: "123", name: "123 网盘" },
      { id: "baidu", name: "百度网盘" },
      { id: "aliyun", name: "阿里云盘" },
      { id: "quark", name: "夸克网盘" },
      { id: "115", name: "115 网盘" },
      { id: "xiaomi", name: "小米云盘" },
      { id: "lanzou", name: "蓝奏云" },
    ];
    providers.forEach(function (p) {
      var span = document.createElement("span");
      span.className = "supported-chip" + (state.supported[p.id] ? " is-web" : "");
      var img = document.createElement("img");
      img.src = PROVIDER_ICONS[p.id] || "";
      img.alt = "";
      span.appendChild(img);
      span.appendChild(document.createTextNode(p.name));
      grid.appendChild(span);
    });
  })();

  // 刷新自动恢复：token + sessionStorage 里的派生密钥都还在时，直接解密进入
  (async function tryRestore() {
    var storedKey = sessionStorage.getItem("wd_enckey");
    var storedSalt = sessionStorage.getItem("wd_ensalt");
    if (!state.token || !state.email || !storedKey || !storedSalt) { showLogin(); return; }
    showLogin();
    setMsg($("login-msg"), "正在恢复会话…", false);
    try {
      var cloud = await api("/api/user", { action: "session", token: state.token }, state.token);
      if (!cloud.cloud) { sessionStorage.removeItem("wd_enckey"); showLogin(); setMsg($("login-msg"), "云端暂无备份", false); return; }
      var key = await crypto.subtle.importKey(
        "raw",
        b64ToBuf(storedKey),
        { name: "AES-GCM" },
        false,
        ["decrypt", "encrypt"]
      );
      var payload = await decryptBlob(cloud.cloud, key);
      state.accounts = payload.accounts || [];
      state.encKey = key;
      state.encSalt = storedSalt;
      showApp();
      setMsg($("app-msg"), "已恢复 " + state.accounts.length + " 个云端备份账号", false);
    } catch (err) {
      sessionStorage.removeItem("wd_enckey");
      showLogin();
      setMsg($("login-msg"), "会话恢复失败，请重新登录：" + (err instanceof Error ? err.message : String(err)), true);
    }
  })();
})();
