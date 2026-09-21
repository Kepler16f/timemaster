import { http, socket } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';

interface HttpReqOpts {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface HttpOut {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
}

function stdMethod(m: string): http.RequestMethod | null {
  if (m === 'GET') return http.RequestMethod.GET;
  if (m === 'POST') return http.RequestMethod.POST;
  if (m === 'PUT') return http.RequestMethod.PUT;
  if (m === 'DELETE') return http.RequestMethod.DELETE;
  if (m === 'HEAD') return http.RequestMethod.HEAD;
  if (m === 'OPTIONS') return http.RequestMethod.OPTIONS;
  return null;
}

export function b64(s: string): string {
  const bytes: Uint8Array = new util.TextEncoder().encodeInto(s);
  return new util.Base64Helper().encodeToStringSync(bytes);
}

function normHeaders(raw: Object): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === null || raw === undefined) return out;
  const src = raw as Record<string, string>;
  for (const k of Object.keys(src)) {
    out[k] = String(src[k]);
  }
  return out;
}

export class HarmonyHttp {
  static async request(optsJson: string): Promise<string> {
    const o = JSON.parse(optsJson) as HttpReqOpts;
    const method = (o.method || 'GET').toUpperCase();
    const url = o.url || '';
    const headers: Record<string, string> = o.headers || {};
    const body: string = o.body == null ? '' : o.body;
    const std = stdMethod(method);
    if (std !== null) {
      const h = http.createHttp();
      try {
        const options: http.HttpRequestOptions = {
          method: std,
          header: headers,
          expectDataType: http.HttpDataType.STRING,
          connectTimeout: 15000,
          readTimeout: 60000,
        };
        if (body.length > 0) {
          options.extraData = body;
        }
        const res = await h.request(url, options);
        const text: string = typeof res.result === 'string' ? res.result as string : '';
        const out: HttpOut = { status: res.responseCode, headers: normHeaders(res.header), bodyBase64: b64(text) };
        return JSON.stringify(out);
      } finally {
        h.destroy();
      }
    }
    const out2: HttpOut = await HarmonyHttp.rawRequest(method, url, headers, body);
    return JSON.stringify(out2);
  }

  /* PROPFIND/MKCOL 等 WebDAV 方法不在 http 模块枚举内，走 TLS 裸 socket 手写 HTTP/1.1 */
  private static async rawRequest(method: string, urlStr: string, headers: Record<string, string>, body: string): Promise<HttpOut> {
    const m = /^https:\/\/([^\/?]+)([^?#]*)(\?[^#]*)?/i.exec(urlStr);
    if (!m) {
      throw new Error('地址需为 https');
    }
    const hostPort = m[1];
    const path = (m[2] || '/') + (m[3] || '');
    const host = hostPort.split(':')[0];
    let request = method + ' ' + path + ' HTTP/1.1\r\n' + 'Host: ' + hostPort + '\r\n';
    const hs = Object.keys(headers);
    for (const k of hs) {
      request += k + ': ' + headers[k] + '\r\n';
    }
    if (body.length > 0) {
      request += 'Content-Length: ' + new util.TextEncoder().encodeInto(body).length + '\r\n';
    }
    request += 'Connection: close\r\n\r\n' + body;

    const tls = socket.constructSSLSocketInstance();
    try {
      await tls.connect({ url: 'https://' + hostPort, timeout: 15000 });
      await tls.send({ data: request });
      const decoder = util.TextDecoder.create('utf-8');
      let buf = '';
      for (let i = 0; i < 100; i++) {
        try {
          const chunk: ArrayBuffer = await tls.recv({ length: 8192, timeout: 3000 });
          buf += decoder.decodeToString(new Uint8Array(chunk));
          if (buf.indexOf('\r\n\r\n') >= 0) {
            break;
          }
        } catch (e) {
          break;
        }
      }
      const headEnd = buf.indexOf('\r\n\r\n');
      const head = headEnd >= 0 ? buf.substring(0, headEnd) : buf;
      const rest = headEnd >= 0 ? buf.substring(headEnd + 4) : '';
      const lines = head.split('\r\n');
      const sm = /HTTP\/\d(?:\.\d)? (\d{3})/.exec(lines.length > 0 ? lines[0] : '');
      const outHeaders: Record<string, string> = {};
      for (let i = 1; i < lines.length; i++) {
        const idx = lines[i].indexOf(':');
        if (idx > 0) {
          outHeaders[lines[i].substring(0, idx).trim().toLowerCase()] = lines[i].substring(idx + 1).trim();
        }
      }
      return { status: sm ? Number(sm[1]) : 0, headers: outHeaders, bodyBase64: b64(rest) };
    } finally {
      tls.close();
    }
  }
}
