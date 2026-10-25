/**
 * POST /api/app-proxy —— 网兜 Web 版网盘代理
 *
 * body: { provider, action, auth: {accessToken / cookie / driveId}, params }
 * 鉴权：Authorization: Bearer <核销系统会话 token>（回源 license 校验，isolate 缓存 5 分钟）
 * 凭证只随请求转发，不落盘不缓存。
 */
import { checkSession, json, proxyAction } from "../lib/providers.js";

export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const licenseApi = String(env.LICENSE_API || "https://license.wangdou.win");
  const authHeader = String(request.headers.get("Authorization") || "");
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!(await checkSession(licenseApi, token))) {
    return json({ ok: false, message: "登录已过期，请重新登录" }, 401, request);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, message: "无效 JSON" }, 400, request);
  }
  const provider = String(body.provider || "").trim();
  const action = String(body.action || "").trim();
  const auth = body.auth || {};
  const params = body.params || {};
  if (!provider || !action) return json({ ok: false, message: "缺少 provider/action" }, 400, request);

  try {
    const result = await proxyAction(provider, action, auth, params);
    return json({ ok: true, ...result });
  } catch (err) {
    return json(
      { ok: false, message: err instanceof Error ? err.message : String(err) },
      502,
      request
    );
  }
}
