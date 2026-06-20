export default {
  async fetch(request, env, ctx) {
    const cors = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400',
    };

    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    const debug = url.searchParams.get('debug');
    if (!id || !/^\d+(,\d+)*$/.test(id)) {
      return new Response('Bad request', { status: 400 });
    }

    // Edge cache keyed by our own request URL. We populate it manually below so
    // that ONLY successful lookups are stored — a throttled/empty reply from
    // Apple must never get cached, or it poisons every request for 24h.
    const cache = caches.default;
    const cacheKey = new Request(`https://itunes-proxy/cache?id=${id}`);
    if (!debug) {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    }

    // Apple rate-limits Cloudflare's shared egress IPs, so a single attempt
    // often comes back empty. Retry a few times with backoff before giving up.
    const upstream = `https://itunes.apple.com/lookup?id=${id}&country=us`;
    let status = 0, text = '', data = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(upstream, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        cf: { cacheTtl: 0 }, // never cache Apple's reply at the edge — we cache results ourselves
      });
      status = res.status;
      text = await res.text();
      if (res.ok && text) {
        try { data = JSON.parse(text); } catch { data = null; }
        if (data && data.resultCount > 0) break;
      }
      data = null;
      if (attempt < 2) await new Promise(r => setTimeout(r, 350));
    }

    if (debug) {
      return new Response(JSON.stringify({
        upstreamStatus: status,
        bodyLength: text.length,
        resultCount: data ? data.resultCount : null,
        snippet: text.slice(0, 200),
      }, null, 2), { headers: cors });
    }

    if (!data) {
      // Degrade gracefully — but do NOT cache the failure.
      return new Response(JSON.stringify({ resultCount: 0, results: [] }), {
        status: 200,
        headers: { ...cors, 'Cache-Control': 'no-store' },
      });
    }

    const response = new Response(JSON.stringify(data), { headers: cors });
    // Cache only real results so the next visitor is served instantly.
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }
};
