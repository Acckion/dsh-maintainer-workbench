import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const decompressGzip = promisify(gunzip);

export class GitHubRequestError extends Error {
  constructor(public kind: 'network' | 'timeout' | 'auth' | 'permission' | 'rate_limit' | 'not_found' | 'server', message: string) {
    super(message);
    this.name = 'GitHubRequestError';
  }
}

function transportError(error: unknown, signal?: AbortSignal | null): GitHubRequestError {
  const value = error as { name?: string; code?: string; cause?: { code?: string } } | undefined;
  const code = value?.cause?.code ?? value?.code;
  if (signal?.aborted || value?.name === 'TimeoutError' || value?.name === 'AbortError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') {
    return new GitHubRequestError('timeout', 'GitHub 连接超时或请求已取消，请检查网络后重试。此错误不表示仓库权限不足。');
  }
  // Do not forward raw transport messages: proxy URLs can contain credentials.
  if (['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(String(code)))
    return new GitHubRequestError('network', '无法连接 GitHub：证书验证失败，请检查系统时间；本机若安装了拦截 HTTPS 的根证书，可用 NODE_OPTIONS=--use-system-ca 启动工作台，或设置 NODE_EXTRA_CA_CERTS 指向该根证书的 PEM 文件后重试。此错误不表示令牌无效。');
  const detail = code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? '域名解析失败' : code === 'ECONNREFUSED' ? '连接被拒绝' : code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' ? '连接中断' : '网络连接失败';
  return new GitHubRequestError('network', `无法连接 GitHub：${detail}。请检查网络或代理后重试，无需因此更换令牌。`);
}

/** Retry safe reads once, preserving identity and cancellation. Never retry writes. */
export async function githubRequest(fetcher: typeof fetch, url: string, init: RequestInit, beforeSend?: () => void): Promise<Response> {
  const safeRead = ['GET', 'HEAD'].includes((init.method ?? 'GET').toUpperCase());
  for (let attempt = 0; ; attempt++) {
    const attemptInit = init.signal ? init : { ...init, signal: AbortSignal.timeout(30000) };
    beforeSend?.();
    let response: Response;
    try {
      response = await fetcher(url, attemptInit);
      // Headers arriving is not completion: a socket may fail while reading JSON.
      // Buffer inside the same retry boundary so partial responses never escape.
      if (response.ok && response.body) {
        let body = Buffer.from(await response.arrayBuffer());
        // Fetch normally decompresses responses. Some transports leave gzip bytes
        // intact or omit the encoding header; inspect bytes to avoid double decoding.
        if (body[0] === 0x1f && body[1] === 0x8b && body[2] === 0x08)
          body = Buffer.from(await decompressGzip(body));
        const headers = new Headers(response.headers);
        headers.delete('content-encoding');
        headers.delete('content-length');
        response = new Response(body, { status: response.status, statusText: response.statusText, headers });
      }
    }
    catch (error) {
      const diagnosed = transportError(error, attemptInit.signal);
      if (safeRead && attempt === 0 && (diagnosed.kind === 'network' || (diagnosed.kind === 'timeout' && !init.signal)) && !init.signal?.aborted) continue;
      if (!safeRead) throw new GitHubRequestError(diagnosed.kind, `GitHub 写入结果尚未确认：${diagnosed.message} 重试发布前会先核查已有记录，避免重复发布。`);
      throw diagnosed;
    }
    if (response.ok) return response;
    if (safeRead && attempt === 0 && [502, 503, 504].includes(response.status) && !init.signal?.aborted) {
      await response.body?.cancel();
      continue;
    }
    const status = response.status;
    const limited = status === 429 || (status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')));
    if (limited) throw new GitHubRequestError('rate_limit', `GitHub ${status}：API 请求限流，请稍后重试。未登录读取的额度较低，可登录 GitHub CLI 提高额度。`);
    if (status === 401) throw new GitHubRequestError('auth', 'GitHub 401：登录或令牌已失效，请重新登录或更新令牌。');
    if (status === 403) throw new GitHubRequestError('permission', 'GitHub 403：当前账号无权执行此操作，请检查令牌权限和组织 SSO 授权。公开仓库读取不要求你是所有者。');
    if (status === 404) throw new GitHubRequestError('not_found', 'GitHub 404：仓库或资源不存在，或当前账号无法读取私有资源。请检查仓库地址；公开仓库无需拥有仓库。');
    throw new GitHubRequestError('server', `GitHub ${status}：服务请求失败，请稍后重试。`);
  }
}
