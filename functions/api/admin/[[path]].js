import { handleAdmin } from '../../_lib/admin.js';

export async function onRequest(context) {
  const requestId = crypto.randomUUID();
  const { request } = context;
  const endpoint = new URL(request.url).pathname;
  try {
    const response = await handleAdmin(request, context.env);
    if (response.status >= 400) {
      let reason = `HTTP ${response.status}`;
      try {
        reason = (await response.clone().json()).error || reason;
      } catch {
        reason = 'The admin endpoint returned a non-JSON error response.';
      }
      console.error(JSON.stringify({
        requestId,
        timestamp: new Date().toISOString(),
        method: request.method,
        endpoint,
        status: response.status,
        reason,
      }));
    }
    const headers = new Headers(response.headers);
    headers.set('X-Request-Id', requestId);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch (error) {
    const status = error.status || (error instanceof URIError ? 400 : 500);
    console.error(JSON.stringify({
      requestId,
      timestamp: new Date().toISOString(),
      method: request.method,
      endpoint,
      status,
      reason: error.message || 'Unknown admin service failure.',
    }));
    return new Response(JSON.stringify({
      error: status < 500 ? error.message : 'The admin service could not complete this request.',
      requestId,
    }), {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'X-Request-Id': requestId,
      },
    });
  }
}
