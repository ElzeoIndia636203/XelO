interface AssetsEnv {
  ASSETS: {
    fetch: (input: Request | URL | string, init?: RequestInit) => Promise<Response>;
  };
}

export default {
  async fetch(request: Request, env: AssetsEnv): Promise<Response> {
    const url = new URL(request.url);
    const res = await env.ASSETS.fetch(request);
    if (res.status === 404 && (url.pathname === '/app' || url.pathname.startsWith('/app/'))) {
      return env.ASSETS.fetch(new Request(new URL('/app/index.html', url), request));
    }
    return res;
  },
};
