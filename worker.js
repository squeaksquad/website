export default {
  async fetch(request) {
    const cors = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400',
    };

    const id = new URL(request.url).searchParams.get('id');
    if (!id || !/^\d+(,\d+)*$/.test(id)) {
      return new Response('Bad request', { status: 400 });
    }

    const res = await fetch(`https://itunes.apple.com/lookup?id=${id}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (itunes-proxy)' },
      cf: { cacheTtl: 86400, cacheEverything: true }, // cache upstream at the edge
    });

    const text = await res.text();
    if (!res.ok || !text) {
      // throttled / empty body — degrade instead of throwing a 500
      return new Response(JSON.stringify({ resultCount: 0, results: [] }), {
        status: 200,
        headers: cors,
      });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return new Response(JSON.stringify({ resultCount: 0, results: [] }), {
        status: 200,
        headers: cors,
      });
    }

    return new Response(JSON.stringify(data), { headers: cors });
  }
};