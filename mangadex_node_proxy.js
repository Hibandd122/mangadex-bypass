// ============================================
// UNIFIED PROXY — MangaDex + Pixiv
// npm install express cors axios archiver sharp
// node mangadex_node_proxy.js
// ============================================

const express  = require('express');
const cors     = require('cors');
const axios    = require('axios');
const https    = require('https');
const archiver = require('archiver');
const crypto   = require('crypto');
const sharp    = require('sharp');

const app  = express();
const port = process.env.PORT || 3000;
app.use(cors());

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const PIXIV_PHPSESSID = process.env.PIXIV_PHPSESSID || '121262264_EnSapQRgc2Z336Zpvz7E3dl3eGEIHCi2';
const PIXIV_SALT      = process.env.PIXIV_SALT      || 'artworkByline';

// ─── HELPERS ────────────────────────────────────────────────────────────────

/** DNS-over-HTTPS (Cloudflare) — vượt tường lửa Port 53 */
async function dohResolve(hostname) {
    try {
        const r = await axios.get(
            `https://cloudflare-dns.com/dns-query?name=${hostname}&type=A`,
            { headers: { accept: 'application/dns-json' }, timeout: 6000 }
        );
        const a = r.data.Answer;
        return a && a.length ? a[0].data : null;
    } catch (e) { return null; }
}

/** https.Agent ghi đè DNS nhưng giữ nguyên SNI */
function buildAgent(host, ip) {
    return new https.Agent({
        lookup: (h, opts, cb) => {
            if (h === host && ip) {
                return opts?.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4);
            }
            require('dns').lookup(h, opts, cb);
        }
    });
}

/** Tải ảnh qua Axios stream, tuỳ chọn headers và httpsAgent */
async function fetchStream(url, headers = {}, agent = null) {
    return axios({ method: 'get', url, responseType: 'stream',
        httpsAgent: agent || undefined, headers, timeout: 20000 });
}

/** Tải ảnh vào Buffer (cho unshuffle) */
async function fetchBuffer(url, headers = {}) {
    const r = await axios({ method: 'get', url, responseType: 'arraybuffer', headers, timeout: 25000 });
    return Buffer.from(r.data);
}

// ─── PIXIV UNSHUFFLE (Xoshiro128**) ─────────────────────────────────────────
function xoshiro128ss(s4) {
    let s = [...s4];
    if (s.every(v => v === 0)) s[0] = 1;
    const rotl = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0;
    return () => {
        const res = (rotl(((s[1] * 5) >>> 0), 7) * 9) >>> 0;
        const t   = (s[1] << 9) >>> 0;
        s[2] = (s[2] ^ s[0]) >>> 0; s[3] = (s[3] ^ s[1]) >>> 0;
        s[1] = (s[1] ^ s[2]) >>> 0; s[0] = (s[0] ^ s[3]) >>> 0;
        s[2] = (s[2] ^ t)    >>> 0; s[3] = rotl(s[3], 11);
        return res;
    };
}

async function unshufflePixiv(buf, key, bs = 32) {
    const h = crypto.createHash('sha256').update(Buffer.from(`${PIXIV_SALT}${key}`, 'utf8')).digest();
    const rng = xoshiro128ss([h.readUInt32LE(0), h.readUInt32LE(4), h.readUInt32LE(8), h.readUInt32LE(12)]);
    for (let i = 0; i < 100; i++) rng();
    const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    const cols = Math.floor(width / bs), rows = Math.ceil(height / bs);
    const perms = Array.from({ length: rows }, () => {
        const idx = Array.from({ length: cols }, (_, i) => i);
        for (let i = cols - 1; i > 0; i--) { const r = rng() % (i + 1); [idx[i], idx[r]] = [idx[r], idx[i]]; }
        return idx.map((_, i) => idx.indexOf(i)); // inverse
    });
    const out = Buffer.allocUnsafe(data.length);
    data.copy(out);
    for (let row = 0; row < rows; row++) {
        const perm = perms[row], y0 = row * bs;
        for (let sc = 0; sc < cols; sc++) {
            const dc = perm[sc], bh = Math.min(bs, height - y0);
            for (let py = 0; py < bh; py++) {
                const y = y0 + py;
                const so = (y * width + sc * bs) * channels;
                const do_ = (y * width + dc * bs) * channels;
                data.copy(out, do_, so, so + bs * channels);
            }
        }
    }
    return sharp(out, { raw: { width, height, channels } }).jpeg({ quality: 95 }).toBuffer();
}

// ─── ZIP HELPER ──────────────────────────────────────────────────────────────
/** Bơm mảng ảnh vào archive ZIP và finalize. items = [{url, key?, name}] */
async function streamZip(res, filename, items, getHeaders, concurrency = 3, needBuffer = false) {
    res.set({ 'Content-Type': 'application/zip',
               'Content-Disposition': `attachment; filename="${filename}"`,
               'Transfer-Encoding': 'chunked' });
    const archive = archiver('zip', { zlib: { level: 4 } });
    archive.on('error', err => { if (!res.headersSent) res.status(500).end(); });
    archive.pipe(res);
    for (let i = 0; i < items.length; i += concurrency) {
        await Promise.all(items.slice(i, i + concurrency).map(async ({ url, key, name }, j) => {
            const idx = i + j + 1;
            try {
                if (needBuffer || key) {
                    let buf = await fetchBuffer(url, await getHeaders(url));
                    if (key) buf = await unshufflePixiv(buf, key);
                    archive.append(buf, { name });
                } else {
                    const r = await fetchStream(url, await getHeaders(url));
                    archive.append(r.data, { name });
                    await new Promise((ok, fail) => { r.data.on('end', ok); r.data.on('error', fail); });
                }
                console.log(`[ZIP] ✓ ${idx}/${items.length} — ${name}`);
            } catch (e) {
                console.error(`[ZIP] ✗ ${idx}: ${e.message}`);
                archive.append(Buffer.from(`ERR: ${e.message}`), { name: `ERROR_${String(idx).padStart(3,'0')}.txt` });
            }
        }));
    }
    await archive.finalize();
}

// ─── ENDPOINT 1: /api/proxy?url= ─────────────────────────────────────────────
// Proxy 1 ảnh đơn — auto-detect MangaDex / Pixiv / bất kỳ URL nào
app.get('/api/proxy', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "Missing 'url'" });
    try {
        const host = new URL(url).hostname;
        let headers = { 'User-Agent': 'Mozilla/5.0 Chrome/146.0.0.0', 'Referer': 'https://mangadex.org/' };
        let agent = null;

        if (host.includes('pximg.net') || host.includes('pixiv.net')) {
            headers = { 'User-Agent': headers['User-Agent'], 'Referer': 'https://www.pixiv.net/',
                        'Cookie': `PHPSESSID=${PIXIV_PHPSESSID};` };
        } else {
            // MangaDex / CDN khác → DoH bypass
            const ip = await dohResolve(host);
            if (ip) agent = buildAgent(host, ip);
        }

        const resp = await fetchStream(url, headers, agent);
        res.set({ 'Content-Type': resp.headers['content-type'] || 'image/jpeg',
                  'Content-Length': resp.headers['content-length'] || '',
                  'Cache-Control': 'public, max-age=86400' });
        resp.data.pipe(res);
    } catch (err) {
        if (!res.headersSent) res.status(err.response?.status || 500).json({ error: err.message });
    }
});

// ─── ENDPOINT 2: /api/download?url= ──────────────────────────────────────────
// Auto-detect URL → trả về ZIP:
//   mangadex.org/chapter/…      → MangaDex chapter
//   pixiv.net/artworks/…        → Pixiv Artworks
//   comic.pixiv.net/…stories/…  → Pixiv Comic (giải mã xoshiro128)
app.get('/api/download', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "Missing 'url'" });

    try {
        // ── MangaDex ────────────────────────────────────────────────────────
        if (url.includes('mangadex.org') || url.match(/chapter\/[a-f0-9-]{36}/i)) {
            const m = url.match(/chapter\/([a-f0-9-]{36})/i);
            if (!m) return res.status(400).json({ error: 'Không tìm thấy Chapter ID.' });
            const chapterId = m[1];
            const apiResp = await axios.get(`https://api.mangadex.org/at-home/server/${chapterId}`,
                { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://mangadex.org/' }, timeout: 12000 });
            const { baseUrl, chapter: ch } = apiResp.data;
            if (!baseUrl || !ch?.data) throw new Error('MangaDex API trả về dữ liệu không hợp lệ.');
            const imageHost = new URL(baseUrl).hostname;
            const imageIP   = await dohResolve(imageHost);
            const agent     = buildAgent(imageHost, imageIP);
            const mdHeaders = { 'User-Agent': 'Mozilla/5.0 Chrome/146.0.0.0', 'Referer': 'https://mangadex.org/' };
            const items = ch.data.map((f, i) => ({
                url: `${baseUrl}/data/${ch.hash}/${f}`,
                name: `${String(i + 1).padStart(3,'0')}_${f}`,
                key: null,
            }));
            console.log(`[MDX] Chapter ${chapterId} — ${items.length} ảnh`);
            return streamZip(res, `MangaDex_${chapterId}.zip`, items, () => mdHeaders, 3);
        }

        // ── Pixiv Artworks ───────────────────────────────────────────────────
        if (url.includes('pixiv.net') && url.includes('artworks')) {
            const m = url.match(/artworks\/(\d+)/i);
            if (!m) return res.status(400).json({ error: 'Không tìm thấy Artwork ID.' });
            const artId = m[1];
            const pxH = { 'User-Agent': 'Mozilla/5.0 Chrome/146.0.0.0',
                           'Referer': 'https://www.pixiv.net/', 'Cookie': `PHPSESSID=${PIXIV_PHPSESSID};` };
            const api = await axios.get(`https://www.pixiv.net/ajax/illust/${artId}/pages?lang=en`,
                { headers: pxH, timeout: 12000 });
            if (api.data.error) throw new Error(api.data.message);
            const items = api.data.body.map((p, i) => {
                const ext = p.urls.original.split('.').pop();
                return { url: p.urls.original, name: `${String(i+1).padStart(3,'0')}_${artId}.${ext}`, key: null };
            });
            console.log(`[PX ART] ${artId} — ${items.length} ảnh`);
            return streamZip(res, `PixivArt_${artId}.zip`, items, () => pxH, 3);
        }

        // ── Pixiv Comic ──────────────────────────────────────────────────────
        if (url.includes('comic.pixiv.net') || url.includes('stories/')) {
            const m = url.match(/stories\/(\d+)/i);
            if (!m) return res.status(400).json({ error: 'Không tìm thấy Story ID.' });
            const storyId = m[1];
            const comH = { 'User-Agent': 'Mozilla/5.0 Chrome/146.0.0.0',
                            'Referer': 'https://comic.pixiv.net/',
                            'Cookie': `PHPSESSID=${PIXIV_PHPSESSID};`,
                            'X-Requested-With': 'pixivcomic' };
            const api = await axios.get(`https://comic.pixiv.net/api/app/episodes/${storyId}/read_v4`,
                { headers: comH, timeout: 15000 });
            const ep = api.data?.data?.reading_episode;
            if (!ep) throw new Error('API Pixiv Comic không hợp lệ.');
            const label = `PixivComic_${(ep.work_title || storyId)}_${ep.numbering_title || ''}`.replace(/[/\\:*?"<>|]/g, '_');
            const items = ep.pages.map((p, i) => ({
                url: p.url, key: p.key || null,
                name: `${String(i+1).padStart(3,'0')}.jpg`,
            }));
            console.log(`[PX COM] ${label} — ${items.length} trang`);
            return streamZip(res, `${label}.zip`, items, () => comH, 2, true);
        }

        return res.status(400).json({ error: 'URL không được hỗ trợ. Vui lòng dùng link MangaDex chapter hoặc Pixiv.' });

    } catch (err) {
        console.error('[DOWNLOAD ERROR]', err.message);
        if (!res.headersSent) res.status(500).json({ error: err.message });
        else res.end();
    }
});

// ─── STATUS DASHBOARD ────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="vi"><head><meta charset="UTF-8"><title>Proxy Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d0d0d;color:#e0e0e0;font-family:'Segoe UI',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:linear-gradient(135deg,#111,#1a1a2e);border:1px solid #2a2a4a;border-radius:16px;padding:32px;max-width:680px;width:100%;box-shadow:0 0 40px #00ffff22}
h1{font-size:1.6rem;color:#00ffff;text-shadow:0 0 10px #00ffff80;margin-bottom:4px}
.badge{display:inline-block;background:#00ffff22;color:#00ffff;border:1px solid #00ffff55;border-radius:20px;padding:2px 12px;font-size:.75rem;margin-bottom:24px}
.ep{background:#0f0f1a;border:1px solid #222;border-radius:10px;padding:14px 16px;margin-bottom:10px}
.ep-head{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.m{background:#00ffff22;color:#00ffff;border-radius:6px;padding:2px 8px;font-size:.7rem;font-weight:700}
code{color:#a0c4ff;font-size:.85rem}
.tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.tag{background:#1a1a2e;border:1px solid #333;border-radius:12px;padding:1px 8px;font-size:.72rem;color:#888}
.note{background:#ff660011;border:1px solid #ff660033;border-radius:8px;padding:10px 14px;font-size:.78rem;color:#ff9966;margin-top:14px}
</style>
</head><body>
<div class="card">
  <h1>&#x1F680; Unified Proxy</h1>
  <span class="badge">&#x1F7E2; ONLINE &mdash; port ${port}</span>

  <div class="ep">
    <div class="ep-head"><span class="m">GET</span><code>/api/proxy?url=IMAGE_URL</code></div>
    Proxy 1 &aacute;nh &mdash; auto-detect headers/DoH
    <div class="tags"><span class="tag">MangaDex CDN</span><span class="tag">pximg.net</span><span class="tag">any URL</span></div>
  </div>

  <div class="ep">
    <div class="ep-head"><span class="m">GET</span><code>/api/download?url=PAGE_URL</code></div>
    T&#7843;i to&agrave;n b&#7897; &rarr; ZIP (auto-detect lo&#7841;i URL)
    <div class="tags">
      <span class="tag">mangadex.org/chapter/&hellip;</span>
      <span class="tag">pixiv.net/artworks/&hellip;</span>
      <span class="tag">comic.pixiv.net/&hellip;stories/&hellip;</span>
    </div>
  </div>

  <div class="note">&#9888; Pixiv c&#7847;n <code>PIXIV_PHPSESSID</code> h&#7907;p l&#7879; trong bi&#7871;n m&ocirc;i tr&#432;&#7901;ng.</div>
</div>
</body></html>`);
});

module.exports = app;
if (require.main === module) {
    app.listen(port, () => {
        console.log(`\n\u{1F680} Proxy Dashboard: http://localhost:${port}`);
        console.log('  /api/proxy?url=    \u2192 Proxy 1 anh');
        console.log('  /api/download?url= \u2192 ZIP (MangaDex / Pixiv Art / Pixiv Comic)');
    });
}
