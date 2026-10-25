/**
 * 网盘代理公共库（Web 版阶段一：123 / 百度 / 阿里）
 *
 * 设计约束：
 * - 浏览器登录核销系统后在本机解密云端备份，网盘凭证随每次代理请求传给本函数，
 *   函数只做转发、不落盘不缓存凭证，保持"服务端零知识"。
 * - 会话校验：Authorization Bearer（核销系统 /api/user 的 token），
 *   向核销系统回源校验并在 isolate 内缓存 5 分钟，避免代理被白嫖。
 */

export function json(obj, status = 200, request) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

import { aliyunQrCreate, aliyunQrPoll, aliyunDriveId, quarkQrCreate, quarkQrPoll } from "./qr.js";

const PAN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/* ---------------- 会话校验 ---------------- */

const sessionCache = new Map(); // token -> { until, ok }

export async function checkSession(licenseApi, token) {
  if (!token) return false;
  const cached = sessionCache.get(token);
  if (cached && cached.until > Date.now()) return cached.ok;
  let ok = false;
  try {
    const res = await fetch(`${licenseApi.replace(/\/+$/, "")}/api/user`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "session", token }),
    });
    const j = await res.json();
    ok = Boolean(j && j.ok);
  } catch {
    ok = false;
  }
  sessionCache.set(token, { until: Date.now() + 5 * 60 * 1000, ok });
  if (sessionCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of sessionCache) if (v.until < now) sessionCache.delete(k);
  }
  return ok;
}

/* ---------------- 123 网盘 ---------------- */

const SIGN_TABLE = "adefghlmyijnopkqrstubcvwsz";

function crc32(input) {
  let crc = 0xffffffff;
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i);
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function signUrl(rawUrl) {
  const u = new URL(rawUrl);
  const random = String(Math.round(1e7 * Math.random()));
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const nowStr = `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}`;
  const mapped = Array.from(nowStr, (ch) => SIGN_TABLE[Number(ch)]).join("");
  const timeSign = String(crc32(mapped));
  const dataSign = String(
    crc32([String(Math.floor(Date.now() / 1000)), random, u.pathname, "web", "3", timeSign].join("|"))
  );
  u.searchParams.set(timeSign, `${Math.floor(Date.now() / 1000)}-${random}-${dataSign}`);
  return u.toString();
}

const B_API = "https://yun.123pan.com/b/api";

function p123Headers(auth, url) {
  const host = new URL(url).origin;
  const refererOrigin = host.includes("yun.") ? "https://yun.123pan.com" : "https://www.123pan.com";
  return {
    origin: refererOrigin,
    referer: `${refererOrigin}/`,
    authorization: `Bearer ${auth.accessToken}`,
    platform: "web",
    "app-version": "3",
    "user-agent": PAN_UA,
    "content-type": "application/json",
  };
}

async function p123Request(auth, method, url, body) {
  const res = await fetch(signUrl(url), {
    method,
    headers: p123Headers(auth, url),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`123 响应异常: ${text.slice(0, 120)}`);
  }
  if (json.code !== 200 && json.code !== 0) {
    throw new Error(json.message || `123 接口错误 code=${json.code}`);
  }
  return json.data || json;
}

async function p123Login(params) {
  const username = String(params.username || "").trim();
  const password = String(params.password || "");
  if (!username || !password) throw new Error("请输入 123 网盘账号和密码");
  const body = username.includes("@")
    ? { mail: username, password, type: 2 }
    : { passport: username, password, type: 1, remember: true };
  const res = await fetch("https://login.123pan.com/api/user/sign_in", {
    method: "POST",
    headers: {
      origin: "https://yun.123pan.com",
      referer: "https://yun.123pan.com/",
      platform: "web",
      "app-version": "3",
      "content-type": "application/json",
      "user-agent": PAN_UA,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("123 登录响应异常");
  }
  if ((json.code !== 200 && json.code !== 0) || !json.data?.token) {
    throw new Error(json.message || "123 登录失败，请检查账号密码");
  }
  return { accessToken: json.data.token };
}

async function p123List(auth, parentFileId) {
  const items = [];
  let next = "0";
  for (let page = 0; page < 40; page++) {
    const q = new URLSearchParams({
      driveId: "0",
      limit: "100",
      next,
      orderBy: "file_id",
      orderDirection: "desc",
      parentFileId: String(parentFileId || 0),
      trashed: "false",
      SearchData: "",
      Page: String(page + 1),
      OnlyLookAbnormalFile: "0",
      event: "homeListFile",
      operateType: "4",
      inDirectSpace: "false",
    });
    const data = await p123Request(auth, "GET", `${B_API}/file/list/new?${q.toString()}`);
    for (const f of data.InfoList || []) {
      items.push({
        fileId: String(f.FileId),
        filename: f.FileName,
        isFolder: f.Type === 1,
        size: f.Size || 0,
        updateAt: f.UpdateAt || undefined,
        etag: f.Etag || f.etag,
        s3KeyFlag: f.S3KeyFlag || f.s3keyFlag,
      });
    }
    next = String(data.Next ?? "-1");
    if (!data.InfoList?.length || data.Next === "-1") break;
  }
  return items;
}

async function p123Mkdir(auth, parentFileId, name) {
  const data = await p123Request(auth, "POST", `${B_API}/file/upload_request`, {
    driveId: 0,
    etag: "",
    fileName: name,
    parentFileId: Number(parentFileId || 0),
    size: 0,
    type: 1,
    duplicate: 1,
    NotReuse: true,
    event: "newCreateFolder",
    operateType: 1,
  });
  return { fileId: String(data.FileId ?? data.fileId ?? "") };
}

async function p123Rename(auth, fileId, name) {
  await p123Request(auth, "POST", `${B_API}/file/rename`, {
    driveId: 0,
    fileId: Number(fileId),
    fileName: name,
  });
  return { ok: true };
}

async function p123Delete(auth, items) {
  await p123Request(auth, "POST", `${B_API}/file/trash`, {
    driveId: 0,
    operation: true,
    fileTrashInfoList: items.map((i) => ({ FileId: Number(i.fileId) })),
  });
  return { ok: true };
}

async function p123Space(auth) {
  const data = await p123Request(auth, "GET", B_API + "/user/info");
  return {
    usedBytes: Number(data.usedCapacity || data.UsedCapacity || 0),
    totalBytes: Number(data.capacity || data.Capacity || 0) || undefined,
  };
}

async function p123Download(auth, item) {
  const payload = {
    driveId: 0,
    etag: item.etag || "",
    fileId: Number(item.fileId),
    s3keyFlag: item.s3KeyFlag || item.s3keyFlag || "",
    type: item.isFolder ? 1 : 0,
    fileName: item.filename,
    size: item.size || 0,
  };
  const urls = [
    `${B_API}/file/download_info`,
    "https://www.123pan.com/b/api/file/download_info",
    "https://yun.123pan.com/a/api/file/download_info",
  ];
  let lastErr = "123 未返回下载地址";
  for (const url of urls) {
    try {
      const data = await p123Request(auth, "POST", url, payload);
      const raw = data.DownloadUrl || data.downloadUrl || "";
      if (!raw) continue;
      // DownloadUrl 常是 base64 后的 CDN 地址
      let direct = "";
      try {
        const decoded = atob(raw.replace(/^https?%3A%2F%2F/i, "").includes("%") ? raw : raw);
        direct = /^https?:\/\//.test(decoded) ? decoded : "";
      } catch {
        direct = "";
      }
      if (!direct && /^https?:\/\//.test(raw)) direct = raw;
      if (!direct && data.InfoList?.[0]?.DownloadUrl) direct = data.InfoList[0].DownloadUrl;
      if (direct) return { url: direct };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(lastErr);
}

/* ---------------- 百度网盘 ---------------- */

const BAIDU_BASE = "https://pan.baidu.com/rest/2.0";

function baiduUrl(method, extra, accessToken) {
  const q = new URLSearchParams({ method, ...extra, access_token: accessToken });
  return `${BAIDU_BASE}${method === "filemetas" && extra.fsids ? "/xpan/multimedia" : "/xpan/file"}?${q.toString()}`;
}

async function baiduRequest(url, form) {
  const res = await fetch(url, {
    method: form ? "POST" : "GET",
    headers: {
      "user-agent": PAN_UA,
      ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const json = await res.json();
  if (json.errno && json.errno !== 0) {
    throw new Error(`百度接口错误 errno=${json.errno}`);
  }
  return json;
}

async function baiduList(auth, parentFileId) {
  const dir = parentFileId || "/";
  const items = [];
  let start = 0;
  const limit = 200;
  for (let page = 0; page < 40; page++) {
    const url = baiduUrl(
      "list",
      { dir, start: String(start), limit: String(limit), web: "web", order: "name" },
      auth.accessToken
    );
    const data = await baiduRequest(url);
    const list = data.list || [];
    for (const f of list) {
      items.push({
        fileId: f.isdir === 1 ? f.path : String(f.fs_id),
        filename: f.server_filename,
        isFolder: f.isdir === 1,
        size: f.size || 0,
        path: f.path,
        updateAt: f.server_mtime ? new Date(f.server_mtime * 1000).toISOString() : undefined,
      });
    }
    if (list.length < limit) break;
    start += limit;
  }
  return items;
}

async function baiduMkdir(auth, parentFileId, name) {
  const parent = parentFileId || "/";
  const path = parent.endsWith("/") ? `${parent}${name}` : `${parent}/${name}`;
  await baiduRequest(
    baiduUrl("create", {}, auth.accessToken),
    { path, isdir: "1", rtype: "1" }
  );
  return { fileId: path };
}

async function baiduRename(auth, item, name) {
  const path = item.path || item.fileId;
  const url = baiduUrl("filemanager", { opera: "rename", async: "0" }, auth.accessToken);
  await baiduRequest(url, { filelist: JSON.stringify([{ path, newname: name }]) });
  return { ok: true };
}

async function baiduDelete(auth, items) {
  const filelist = items.map((i) => i.path || i.fileId);
  const url = baiduUrl("filemanager", { opera: "delete", async: "0" }, auth.accessToken);
  await baiduRequest(url, { filelist: JSON.stringify(filelist) });
  return { ok: true };
}

async function baiduSpace(auth) {
  const url = "https://pan.baidu.com/api/quota?checkexpire=1&checkfree=1&access_token=" + auth.accessToken;
  const res = await fetch(url, { headers: { "user-agent": PAN_UA } });
  const json = await res.json();
  if (json.errno && json.errno !== 0) throw new Error("获取百度空间失败 errno=" + json.errno);
  return { usedBytes: Number(json.used || 0), totalBytes: Number(json.total || 0) || undefined };
}

async function baiduDownload(auth, item) {
  const fsId = Number(item.fileId);
  const url = baiduUrl(
    "filemetas",
    { fsids: JSON.stringify([fsId]), dlink: "1" },
    auth.accessToken
  );
  const meta = await baiduRequest(url);
  const dlink = meta.list?.[0]?.dlink;
  if (!dlink) throw new Error("百度网盘未返回下载链接");
  const u = new URL(dlink);
  u.searchParams.set("access_token", auth.accessToken);
  return { url: u.toString() };
}

/* ---------------- 阿里云盘 ---------------- */

const ALIYUN_API = "https://openapi.alipan.com";

async function aliyunRequest(auth, path, body) {
  const res = await fetch(`${ALIYUN_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`阿里云盘响应异常: ${text.slice(0, 120)}`);
  }
  if (!res.ok) {
    throw new Error(json.message || `阿里云盘接口错误 (${res.status})`);
  }
  return json;
}

function aliyunParent(v) {
  return !v || v === "0" ? "root" : v;
}

async function aliyunList(auth, parentFileId) {
  const driveId = auth.driveId;
  if (!driveId) throw new Error("缺少阿里云盘 drive_id，请在客户端重新授权网页会话/账号");
  const items = [];
  let marker = "";
  for (let page = 0; page < 40; page++) {
    const data = await aliyunRequest(auth, "/adrive/v1.0/openFile/list", {
      drive_id: driveId,
      parent_file_id: aliyunParent(parentFileId),
      limit: 100,
      marker,
      order_by: "name",
      order_direction: "ASC",
    });
    for (const f of data.items || []) {
      items.push({
        fileId: f.file_id,
        filename: f.name,
        isFolder: f.type === "folder",
        size: f.size || 0,
        updateAt: f.updated_at,
      });
    }
    if (!data.items?.length || !data.next_marker) break;
    marker = data.next_marker;
  }
  return items;
}

async function aliyunMkdir(auth, parentFileId, name) {
  const driveId = auth.driveId;
  const data = await aliyunRequest(auth, "/adrive/v1.0/openFile/create", {
    drive_id: driveId,
    parent_file_id: aliyunParent(parentFileId),
    name,
    type: "folder",
    check_name_mode: "refuse",
  });
  return { fileId: data.file_id };
}

async function aliyunRename(auth, item, name) {
  await aliyunRequest(auth, "/adrive/v1.0/openFile/rename", {
    drive_id: auth.driveId,
    file_id: item.fileId,
    name,
  });
  return { ok: true };
}

async function aliyunDelete(auth, items) {
  for (const i of items) {
    await aliyunRequest(auth, "/adrive/v1.0/openFile/recyclebin/trash", {
      drive_id: auth.driveId,
      file_id: i.fileId,
    });
  }
  return { ok: true };
}

async function aliyunSpace(auth) {
  const data = await aliyunRequest(auth, "/adrive/v1.0/users/getDriveInfo", {});
  const di = (data.default_drive_id || auth.driveId || "") && (data.drive_infos || data.personal_space_info || []);
  let used = 0, total = 0;
  const pick = (info) => {
    if (!info) return;
    used = Number(info.used_size || used) || used;
    total = Number(info.total_size || total) || total;
  };
  if (Array.isArray(data.drive_infos)) {
    for (const d of data.drive_infos) if (d.drive_id === auth.driveId) pick(d);
  } else if (data.personal_space_info) {
    pick(data.personal_space_info);
  }
  void di;
  return { usedBytes: used, totalBytes: total || undefined };
}

async function aliyunDownload(auth, item) {
  const data = await aliyunRequest(auth, "/adrive/v1.0/openFile/get_download_url", {
    drive_id: auth.driveId,
    file_id: item.fileId,
  });
  if (!data.url) throw new Error("阿里云盘未返回下载链接");
  return { url: data.url };
}


/* ---------------- 夸克网盘（列表/空间/下载） ---------------- */

const QUARK_API = "https://drive-pc.quark.cn/1/clouddrive";

function quarkHeaders(auth) {
  return {
    Cookie: auth.cookie,
    "user-agent": PAN_UA + " QuarkPC/2.5.56",
    referer: "https://pan.quark.cn/",
    "content-type": "application/json",
  };
}

async function quarkRequest(auth, method, url, body) {
  const hasBody = body !== undefined && method !== "GET";
  const res = await fetch(url, {
    method,
    headers: quarkHeaders(auth),
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (json.status >= 400 || (json.code !== undefined && json.code !== 0)) {
    throw new Error(json.message || `夸克请求失败 code=${json.code}`);
  }
  return json;
}

async function quarkList(auth, parentFileId) {
  const items = [];
  let page = 1;
  const size = 100;
  for (let i = 0; i < 40; i++) {
    const q = new URLSearchParams({
      pr: "ucpro",
      fr: "pc",
      pdir_fid: String(parentFileId || "0"),
      _page: String(page),
      _size: String(size),
      _fetch_total: "1",
      _fetch_sub_dirs: "0",
      _sort: "file_type:asc,updated_at:desc",
    });
    const json = await quarkRequest(auth, "GET", `${QUARK_API}/file/sort?${q.toString()}`);
    const list = json.data?.list || [];
    for (const f of list) {
      if (!f.fid || !f.file_name) continue;
      items.push({
        fileId: f.fid,
        filename: f.file_name,
        isFolder: f.file === false,
        size: Number(f.size || 0),
        updateAt: f.updated_at || f.l_updated_at ? new Date(f.updated_at || f.l_updated_at).toISOString() : undefined,
      });
    }
    const total = Number(json.metadata?._total || 0);
    if (page * size >= total || list.length < size) break;
    page += 1;
  }
  return items;
}

async function quarkSpace(auth) {
  const json = await quarkRequest(auth, "GET", `${QUARK_API}/member?pr=ucpro&fr=pc&uc_param_str=`);
  const data = json.data || {};
  const used = Number(data.use_capacity ?? data.used_capacity ?? data.used ?? 0);
  const total = Number(data.total_capacity ?? data.total_capacity ?? data.capacity ?? 0);
  return { usedBytes: used, totalBytes: total || undefined };
}

async function quarkDownload(auth, item) {
  const json = await quarkRequest(
    auth,
    "POST",
    `${QUARK_API}/file/download?pr=ucpro&fr=pc&sys=win32&ve=2.5.56`,
    { fids: [item.fileId] }
  );
  const url = String(json.data?.[0]?.download_url || "");
  if (!url) throw new Error("获取夸克下载地址失败");
  return { url, fetchHeaders: { Cookie: auth.cookie, referer: "https://pan.quark.cn/", "user-agent": PAN_UA } };
}

/* ---------------- 115 网盘（列表/空间/下载） ---------------- */

const W115 = "https://webapi.115.com";

function p115Headers(auth) {
  return {
    Cookie: auth.cookie,
    "User-Agent": PAN_UA,
    Referer: "https://115.com/",
    Origin: "https://115.com",
    Accept: "application/json, text/javascript, */*; q=0.01",
  };
}

async function p115Request(auth, url) {
  const res = await fetch(url, { headers: p115Headers(auth) });
  const json = await res.json();
  if (json.state === false) throw new Error(json.error || json.message || "115 请求失败，Cookie 可能已失效");
  return json;
}

async function p115List(auth, parentFileId) {
  const cid = String(parentFileId || "0");
  const items = [];
  let offset = 0;
  const limit = 100;
  for (let i = 0; i < 40; i++) {
    const q = new URLSearchParams({
      aid: "1",
      cid,
      o: "user_ptime",
      asc: "0",
      offset: String(offset),
      show_dir: "1",
      limit: String(limit),
      snap: "0",
      natsort: "1",
      format: "json",
    });
    const json = await p115Request(auth, `${W115}/files?${q.toString()}`);
    const list = json.data || [];
    for (const f of list) {
      const folder = !String(f.fid || "").trim() || String(f.fid || "") === "0" || String(f.fc) === "1";
      const fileId = folder ? String(f.cid || "") : String(f.fid || "");
      const name = String(f.n || "").trim();
      if (!fileId || !name) continue;
      items.push({
        fileId,
        filename: name,
        isFolder: folder,
        size: Number(f.s || 0),
        etag: f.pc || undefined,
      });
    }
    const count = Number(json.count || 0);
    offset += list.length;
    if (!list.length || offset >= count) break;
  }
  return items;
}

async function p115Space(auth) {
  const json = await p115Request(auth, `${W115}/files/index_info`);
  const data = json.data || {};
  const space = data.space_info || data.space || data;
  const used = Number(space.all_use?.size ?? space.used ?? space.use_size ?? 0);
  const total = Number(space.all_total?.size ?? space.total ?? space.total_size ?? 0);
  return { usedBytes: used, totalBytes: total || undefined };
}

async function p115Download(auth, item) {
  const pickcode = item.etag || "";
  if (!pickcode) throw new Error("115 下载需要 pickcode，请重新扫描后再试");
  const q = new URLSearchParams({ pickcode, _: String(Date.now()) });
  const json = await p115Request(auth, `${W115}/files/download?${q.toString()}`);
  const url = String(json.file_url || json.data?.file_url || json.url || "").trim();
  if (!url) throw new Error("115 未返回下载链接");
  return {
    url,
    fetchHeaders: { Cookie: auth.cookie, Referer: "https://115.com/", "User-Agent": PAN_UA },
  };
}


/* ---------------- 分发 ---------------- */

export const WEB_SUPPORTED = new Set(["123", "baidu", "aliyun"]);

export async function proxyAction(provider, action, auth, params) {
  switch (`${provider}:${action}`) {
    case "123:list":
      return { items: await p123List(auth, params.parentFileId) };
    case "123:mkdir":
      return await p123Mkdir(auth, params.parentFileId, params.name);
    case "123:rename":
      return await p123Rename(auth, params.fileId, params.name);
    case "123:delete":
      return await p123Delete(auth, params.items || []);
    case "123:download":
      return await p123Download(auth, params.item);
    case "baidu:list":
      return { items: await baiduList(auth, params.parentFileId) };
    case "baidu:mkdir":
      return await baiduMkdir(auth, params.parentFileId, params.name);
    case "baidu:rename":
      return await baiduRename(auth, params.item, params.name);
    case "baidu:delete":
      return await baiduDelete(auth, params.items || []);
    case "baidu:download":
      return await baiduDownload(auth, params.item);
    case "baidu:move": {
      const filelist = (params.items || []).map((i) => ({
        path: i.path || i.fileId,
        dest: params.targetParentId || "/",
        newname: i.filename,
      }));
      await baiduRequest(
        baiduUrl("filemanager", { opera: "move", async: "0" }, auth.accessToken),
        { filelist: JSON.stringify(filelist) }
      );
      return { ok: true };
    }
    case "baidu:copy": {
      const filelist2 = (params.items || []).map((i) => ({
        path: i.path || i.fileId,
        dest: params.targetParentId || "/",
        newname: i.filename,
      }));
      await baiduRequest(
        baiduUrl("filemanager", { opera: "copy", async: "0" }, auth.accessToken),
        { filelist: JSON.stringify(filelist2) }
      );
      return { ok: true };
    }
    case "aliyun:list":
      return { items: await aliyunList(auth, params.parentFileId) };
    case "aliyun:mkdir":
      return await aliyunMkdir(auth, params.parentFileId, params.name);
    case "aliyun:rename":
      return await aliyunRename(auth, params.item, params.name);
    case "aliyun:delete":
      return await aliyunDelete(auth, params.items || []);
    case "aliyun:download":
      return await aliyunDownload(auth, params.item);
    case "aliyun:move":
      for (const i of params.items || []) {
        await aliyunRequest(auth, "/adrive/v1.0/openFile/move", {
          drive_id: auth.driveId,
          file_id: i.fileId,
          to_parent_file_id: aliyunParent(params.targetParentId),
          check_name_mode: "auto_rename",
        });
      }
      return { ok: true };
    case "aliyun:copy":
      for (const i of params.items || []) {
        await aliyunRequest(auth, "/adrive/v1.0/openFile/copy", {
          drive_id: auth.driveId,
          file_id: i.fileId,
          to_parent_file_id: aliyunParent(params.targetParentId),
          auto_rename: true,
        });
      }
      return { ok: true };
    case "123:space":
      return await p123Space(auth);
    case "123:move":
      await p123Request(auth, "POST", `${B_API}/file/mod_pid`, {
        fileIdList: (params.items || []).map((i) => ({ FileId: Number(i.fileId) })),
        parentFileId: Number(params.targetParentId || 0),
      });
      return { ok: true };
    case "123:login":
      return await p123Login(params);
    case "aliyun:qr-create":
      return await aliyunQrCreate();
    case "aliyun:qr-poll":
      return await aliyunQrPoll(auth, params);
    case "aliyun:drive-id":
      return await aliyunDriveId(auth);
    case "quark:qr-create":
      return await quarkQrCreate();
    case "quark:qr-poll":
      return await quarkQrPoll(params);
    case "quark:list":
      return { items: await quarkList(auth, params.parentFileId) };
    case "quark:space":
      return await quarkSpace(auth);
    case "quark:download":
      return await quarkDownload(auth, params.item);
    case "115:list":
      return { items: await p115List(auth, params.parentFileId) };
    case "115:space":
      return await p115Space(auth);
    case "115:download":
      return await p115Download(auth, params.item);
    case "baidu:space":
      return await baiduSpace(auth);
    case "aliyun:space":
      return await aliyunSpace(auth);
    default:
      throw new Error(`该网盘暂不支持 ${action} 操作，请在客户端使用`);
  }
}
