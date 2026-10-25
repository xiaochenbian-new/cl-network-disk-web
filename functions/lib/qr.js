/**
 * 扫码添加（阿里 / 夸克）——从客户端 oauth.ts 移植，服务端无状态：
 * 创建时把会话 cookie 返回给客户端，轮询时由客户端回传。
 */

const ALI_OPEN_QR_REQUESTS = [
  "https://api.oplist.org/alicloud/requests?driver=alicloud&server_use=true&client_uid=&client_key=&driver_txt=alicloud_qr&server_set=true&secret_key=",
  "https://api.alistgo.com/alist/ali_open/qr",
];
const ALI_OPEN_TOKEN_EXCHANGE = [
  "https://api.oplist.org/alicloud/callback",
  "https://api.alistgo.com/alist/ali_open/token",
];

const QUARK_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

async function readJsonOrThrow(res, label) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}响应异常: ${text.slice(0, 120)}`);
  }
}

/** 创建阿里扫码会话：返回 sid + 二维码图片 dataURL + cookie（客户端轮询时回传） */
export async function aliyunQrCreate() {
  const errors = [];
  for (const endpoint of ALI_OPEN_QR_REQUESTS) {
    try {
      const isOplist = /oplist\.org/i.test(endpoint);
      const res = await fetch(endpoint, {
        method: isOplist ? "GET" : "POST",
        headers: isOplist
          ? { Accept: "application/json" }
          : { "content-type": "application/json", Accept: "application/json" },
        body: isOplist ? undefined : "{}",
      });
      const json = await readJsonOrThrow(res, "创建二维码");
      const sid = String(json.sid || "").trim();
      const qrCodeUrl = String(json.qrCodeUrl || json.text || "").trim();
      if (!sid || !qrCodeUrl) {
        errors.push(json.message || json.text || `${endpoint} 未返回 sid`);
        continue;
      }
      const cookie =
        res.headers.getSetCookie?.().map((c) => c.split(";")[0]).filter(Boolean).join("; ") || "";
      let dataUrl = qrCodeUrl;
      if (!qrCodeUrl.startsWith("data:")) {
        const imgRes = await fetch(qrCodeUrl);
        if (!imgRes.ok) throw new Error(`拉取二维码图片失败（HTTP ${imgRes.status}）`);
        const contentType = imgRes.headers.get("content-type") || "image/jpeg";
        const buf = new Uint8Array(await imgRes.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
        dataUrl = `data:${contentType.split(";")[0]};base64,${btoa(bin)}`;
      }
      return { sid, qrDataUrl: dataUrl, cookie };
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  throw new Error(errors[0] || "创建阿里云盘登录二维码失败");
}

/** 轮询阿里扫码：成功返回 token 对 */
export async function aliyunQrPoll(auth, params) {
  const sid = String(params.sid || "");
  const cookie = String(params.cookie || "");
  const res = await fetch(`https://openapi.alipan.com/oauth/qrcode/${encodeURIComponent(sid)}/status`, {
    headers: { Accept: "application/json" },
  });
  const json = await readJsonOrThrow(res, "查询扫码状态");
  const status = String(json.status || "WaitLogin");
  if (status !== "LoginSuccess") {
    return { status, done: false };
  }
  const authCode = String(json.authCode || "").trim();
  const errors = [];
  // 1) OpenList callback：sid + 创建时的 cookie 换票
  if (cookie) {
    try {
      const q = new URLSearchParams({
        driver: "alicloud",
        code: sid,
        server_use: "true",
        grant_type: "authorization_code",
      });
      const res2 = await fetch(`${ALI_OPEN_TOKEN_EXCHANGE[0]}?${q}`, {
        headers: { Accept: "application/json", Cookie: cookie },
      });
      const j2 = await readJsonOrThrow(res2, "换取 token");
      const access = String(j2.access_token || "").trim();
      const refresh = String(j2.refresh_token || "").trim();
      if (access && refresh) {
        return { status: "LoginSuccess", done: true, accessToken: access, refreshToken: refresh };
      }
      errors.push(j2.text || j2.message || "OpenList 换票未返回 token");
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  // 2) authCode POST 换票
  if (authCode) {
    for (const endpoint of ALI_OPEN_TOKEN_EXCHANGE) {
      if (/callback$/i.test(endpoint)) continue;
      try {
        const res3 = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ grant_type: "authorization_code", code: authCode }),
        });
        const j3 = await readJsonOrThrow(res3, "换取 token");
        const access = String(j3.access_token || "").trim();
        const refresh = String(j3.refresh_token || "").trim();
        if (access && refresh) {
          return { status: "LoginSuccess", done: true, accessToken: access, refreshToken: refresh };
        }
        errors.push(j3.text || j3.message || j3.error || `${endpoint} 换票失败`);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
  }
  throw new Error(errors[0] || "换取阿里云盘 token 失败");
}

/** 新阿里账号的 drive_id */
export async function aliyunDriveId(auth) {
  const res = await fetch("https://openapi.alipan.com/adrive/v1.0/user/getDriveInfo", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `获取阿里云盘信息失败 (${res.status})`);
  const driveId = String(json.default_drive_id || json.resource_drive_id || "");
  if (!driveId) throw new Error("未获取到阿里云盘 drive_id");
  return { driveId };
}

export async function quarkQrCreate() {
  const requestId = crypto.randomUUID();
  const q = new URLSearchParams({ client_id: "532", v: "1.2", request_id: requestId });
  const res = await fetch(`https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin?${q}`, {
    headers: {
      "user-agent": QUARK_UA,
      referer: "https://pan.quark.cn/",
      origin: "https://pan.quark.cn",
      accept: "application/json, text/plain, */*",
    },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`获取夸克登录二维码失败：${text.slice(0, 120)}`);
  }
  const token = json.data?.members?.token;
  if (json.status !== 2000000 || !token) throw new Error(json.message || "获取夸克登录二维码失败");
  return { token, requestId, payloadUrl: `https://su.quark.cn/4_eMHBJ?token=${token}` };
}

export async function quarkQrPoll(params) {
  const token = String(params.token || "");
  const requestId = String(params.requestId || "");
  const q = new URLSearchParams({ client_id: "532", v: "1.2", token, request_id: requestId });
  const res = await fetch(`https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken?${q}`, {
    headers: {
      "user-agent": QUARK_UA,
      referer: "https://pan.quark.cn/",
      origin: "https://pan.quark.cn",
      accept: "application/json, text/plain, */*",
    },
  });
  const json = await res.json();
  if (json.status !== 2000000) {
    const msg = String(json.message || "");
    if (json.status === 50004001 || /empty|wait|scan|confirm|未|等待|扫码/i.test(msg) || !msg) {
      return { status: "WaitLogin", done: false };
    }
    return { status: msg || "WaitLogin", done: false };
  }
  const st = json.data?.members?.service_ticket;
  if (!st) return { status: "WaitLogin", done: false };

  const infoRes = await fetch(`https://pan.quark.cn/account/info?st=${encodeURIComponent(st)}&lw=scan`, {
    headers: { "user-agent": QUARK_UA, referer: "https://pan.quark.cn/" },
    redirect: "manual",
  });
  const setCookie = infoRes.headers.getSetCookie?.() || [];
  let cookie = setCookie.map((c) => c.split(";")[0]).filter(Boolean).join("; ");

  const again = await fetch("https://pan.quark.cn/account/info?fr=pc&platform=pc", {
    headers: { cookie, "user-agent": QUARK_UA, referer: "https://pan.quark.cn/" },
  });
  const more = again.headers.getSetCookie?.() || [];
  const merged = new Map();
  for (const c of (cookie ? cookie.split("; ") : []).concat(more.map((m) => m.split(";")[0]))) {
    if (!c) continue;
    const eq = c.indexOf("=");
    if (eq > 0) merged.set(c.slice(0, eq), c.slice(eq + 1));
  }
  cookie = Array.from(merged.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
  if (!cookie) throw new Error("夸克扫码成功但未获取到 Cookie");
  return { status: "LoginSuccess", done: true, cookie };
}
