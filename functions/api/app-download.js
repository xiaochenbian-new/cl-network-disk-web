/**
 * GET /api/app-download —— 网兜 Web 版流式下载/在线播放
 *
 * 查询参数：
 *   token  核销系统会话 token
 *   d      base64url(JSON { provider, auth, item })
 *
 * 服务端解析直链并带着必要 Cookie/Referer 拉流回传（支持 Range 透传，供音频拖动），
 * 凭证只在此刻用于内存转发，不落盘不缓存。
 */
import { checkSession, proxyAction } from "../lib/providers.js";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function b64urlToBuf(s) {
  const pad = 4 - (s.length % 4);
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + (pad > 0 && pad < 4 ? "=".repeat(pad) : "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const licenseApi = String(env.LICENSE_API || "https://license.wangdou.win");
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || "";
  if (!(await checkSession(licenseApi, token))) {
    return json({ ok: false, message: "登录已过期，请重新登录" }, 401);
  }
  const dRaw = url.searchParams.get("d") || "";
  let d;
  try {
    d = JSON.parse(new TextDecoder().decode(b64urlToBuf(dRaw)));
  } catch {
    return json({ ok: false, message: "参数不合法" }, 400);
  }
  if (!d.provider || !d.item) return json({ ok: false, message: "缺少参数" }, 400);

  try {
    const resolved = await proxyAction(d.provider, "download", { item: d.item }, d.auth);
    const range = request.headers.get("Range") || request.headers.get("range");
    const upstream = await fetch(resolved.url, {
      headers: { ...(resolved.fetchHeaders || {}), ...(range ? { Range: range } : {}) },
    });
    if (!upstream.ok && upstream.status !== 206) {
      return json({ ok: false, message: `下载失败 HTTP ${upstream.status}` }, 502);
    }
    const headers = new Headers();
    const ct = upstream.headers.get("Content-Type");
    if (ct) headers.set("Content-Type", ct);
    else headers.set("Content-Type", "application/octet-stream");
    const cl = upstream.headers.get("Content-Length");
    if (cl) headers.set("Content-Length", cl);
    const cr = upstream.headers.get("Content-Range");
    if (cr) headers.set("Content-Range", cr);
    headers.set("Accept-Ranges", "bytes");
    headers.set("Cache-Control", "no-store");
    headers.set(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(d.item.filename || "file")}`
    );
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (err) {
    return json(
      { ok: false, message: err instanceof Error ? err.message : String(err) },
      502
    );
  }
}
