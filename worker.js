export default {
  async fetch(request, env) {
    const reqUrl = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    if (reqUrl.pathname === '/upload' && request.method === 'POST') {
      const auth = request.headers.get('Authorization') || '';
      const expectedToken = String(env.UPLOAD_TOKEN || '').trim();
      const receivedToken = auth.replace(/^Bearer\s+/i, '').trim();

      if (!expectedToken) {
        return json({ error: 'UPLOAD_TOKEN fehlt im Cloudflare Worker. Settings → Variables → Secret hinzufügen.' }, 500, cors);
      }

      if (!receivedToken || receivedToken !== expectedToken) {
        return json({
          error: 'Falsches Upload-Passwort.',
          debug: {
            receivedPasswordLength: receivedToken.length,
            savedPasswordLength: expectedToken.length,
            hint: 'Das eingegebene Passwort muss exakt gleich sein wie das Secret UPLOAD_TOKEN im Worker.'
          }
        }, 401, cors);
      }

      const form = await request.formData();
      const file = form.get('file');
      if (!file || typeof file === 'string') return json({ error: 'Keine Datei erhalten.' }, 400, cors);

      const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
      if (!allowed.includes(file.type)) return json({ error: 'Nur JPG, PNG, WebP oder GIF erlaubt.' }, 400, cors);
      if (file.size > 8 * 1024 * 1024) return json({ error: 'Bild ist zu gross. Maximal 8 MB.' }, 400, cors);

      const owner = env.GITHUB_OWNER;
      const repo = env.GITHUB_REPO;
      const branch = env.GITHUB_BRANCH || 'main';
      const folder = (env.GITHUB_FOLDER || 'uploads').replace(/^\/+|\/+$/g, '');
      if (!owner || !repo || !env.GITHUB_TOKEN) {
        return json({ error: 'Worker ist noch nicht korrekt eingerichtet. GITHUB_OWNER, GITHUB_REPO oder GITHUB_TOKEN fehlt.' }, 500, cors);
      }

      const ext = extensionFromType(file.type);
      const safeName = makeSafeName(file.name || `bild.${ext}`);
      const date = new Date().toISOString().slice(0, 10);
      const id = crypto.randomUUID();
      const path = `${folder}/${date}/${id}-${safeName}`;

      const buffer = await file.arrayBuffer();
      const contentBase64 = arrayBufferToBase64(buffer);

      const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}`;
      const ghRes = await fetch(apiUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'bild-zu-url-cloudflare-worker'
        },
        body: JSON.stringify({
          message: `Upload image ${safeName}`,
          content: contentBase64,
          branch
        })
      });

      const ghData = await ghRes.json().catch(() => ({}));
      if (!ghRes.ok) {
        const msg = ghData?.message || 'GitHub Upload fehlgeschlagen.';
        return json({ error: msg }, ghRes.status, cors);
      }

      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
      return json({ url: rawUrl, path }, 200, cors);
    }

    return json({ ok: true, message: 'Bild-Upload Worker läuft. POST /upload verwenden.' }, 200, cors);
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }
  });
}

function extensionFromType(type) {
  return ({ 'image/jpeg':'jpg', 'image/png':'png', 'image/webp':'webp', 'image/gif':'gif' })[type] || 'bin';
}

function makeSafeName(name) {
  const dot = name.lastIndexOf('.');
  const base = dot > -1 ? name.slice(0, dot) : name;
  const ext = dot > -1 ? name.slice(dot + 1) : 'img';
  const safeBase = base.toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'bild';
  const safeExt = ext.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'img';
  return `${safeBase}.${safeExt}`;
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
