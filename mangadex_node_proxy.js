// ============================================
// UNIFIED PROXY — VERCEL EDITION
// MangaDex + Pixiv (không WebSocket, tối ưu serverless)
// ============================================

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');
const archiver = require('archiver');
const crypto = require('crypto');
const sharp = require('sharp');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from 'public' directory
app.use(express.static('public'));

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const PIXIV_PHPSESSID = process.env.PIXIV_PHPSESSID || null;
const PIXIV_COMIC_UNSHUFFLE_SALT = '4wXCKprMMoxnyJ3PocJFs4CYbfnbazNe';
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

// ─── HELPERS ────────────────────────────────────────────────────────────────
async function fetchStream(url, headers = {}) {
    return axios({
        method: 'get', url,
        responseType: 'stream',
        headers: { 'User-Agent': DEFAULT_USER_AGENT, ...headers },
        timeout: 25000
    });
}

async function fetchBuffer(url, headers = {}) {
    const r = await axios({
        method: 'get', url,
        responseType: 'arraybuffer',
        headers: { 'User-Agent': DEFAULT_USER_AGENT, ...headers },
        timeout: 30000
    });
    return Buffer.from(r.data);
}

// ─── PIXIV UNSHUFFLE ────────────────────────────────────────────────────────
function xoshiro128ss(s4) {
    let s = [...s4];
    if (s.every(v => v === 0)) s[0] = 1;
    const rotl = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0;
    return () => {
        const res = (rotl(((s[1] * 5) >>> 0), 7) * 9) >>> 0;
        const t = (s[1] << 9) >>> 0;
        s[2] = (s[2] ^ s[0]) >>> 0; s[3] = (s[3] ^ s[1]) >>> 0;
        s[1] = (s[1] ^ s[2]) >>> 0; s[0] = (s[0] ^ s[3]) >>> 0;
        s[2] = (s[2] ^ t) >>> 0; s[3] = rotl(s[3], 11);
        return res;
    };
}

async function unshufflePixiv(buf, key, bs = 32) {
    const h = crypto.createHash('sha256').update(Buffer.from(`${PIXIV_COMIC_UNSHUFFLE_SALT}${key}`, 'utf8')).digest();
    const rng = xoshiro128ss([h.readUInt32LE(0), h.readUInt32LE(4), h.readUInt32LE(8), h.readUInt32LE(12)]);
    for (let i = 0; i < 100; i++) rng();
    const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    const cols = Math.floor(width / bs), rows = Math.ceil(height / bs);
    const perms = Array.from({ length: rows }, () => {
        const idx = Array.from({ length: cols }, (_, i) => i);
        for (let i = cols - 1; i > 0; i--) { const r = rng() % (i + 1); [idx[i], idx[r]] = [idx[r], idx[i]]; }
        return idx.map((_, i) => idx.indexOf(i));
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

// ─── ZIP STREAMING (VERCEL COMPATIBLE) ──────────────────────────────────────
async function streamZip(res, filename, items, getHeaders, concurrency = 5, needBuffer = false) {
    res.set({
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
    });

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', err => { if (!res.headersSent) res.status(500).end(err.message); });
    archive.pipe(res);

    for (let i = 0; i < items.length; i += concurrency) {
        const batch = items.slice(i, i + concurrency);
        await Promise.all(batch.map(async (item) => {
            const { url, key, name } = item;
            try {
                let buf = await fetchBuffer(url, await getHeaders(url));
                if (key) buf = await unshufflePixiv(buf, key);
                archive.append(buf, { name });
            } catch (e) {
                archive.append(Buffer.from(`ERROR: ${e.message}\nURL: ${url}`), { name: `_ERROR_${name}` });
            }
        }));
    }

    await archive.finalize();
}

// ─── API ENDPOINTS ──────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
    res.json({ hasCookie: !!PIXIV_PHPSESSID });
});

app.get('/api/proxy', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing url' });
    try {
        const headers = { Referer: new URL(url).origin };
        if (PIXIV_PHPSESSID && (url.includes('pximg.net') || url.includes('pixiv.net'))) {
            headers.Cookie = `PHPSESSID=${PIXIV_PHPSESSID}`;
        }
        const resp = await fetchStream(url, headers);
        res.set({
            'Content-Type': resp.headers['content-type'] || 'image/jpeg',
            'Cache-Control': 'public, max-age=86400'
        });
        resp.data.pipe(res);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/download', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing url' });

    try {
        // ---------- MangaDex ----------
        if (url.includes('mangadex.org')) {
            const m = url.match(/chapter\/([a-f0-9-]{36})/i);
            if (!m) throw new Error('Không tìm thấy Chapter ID');
            const chapterId = m[1];

            const api = await axios.get(`https://api.mangadex.org/at-home/server/${chapterId}`, {
                headers: { 'User-Agent': DEFAULT_USER_AGENT }
            });
            const { baseUrl, chapter } = api.data;
            const items = chapter.data.map((f, i) => ({
                url: `${baseUrl}/data/${chapter.hash}/${f}`,
                name: `${String(i+1).padStart(3,'0')}.jpg`,
            }));

            const headers = () => ({ Referer: 'https://mangadex.org/' });
            return streamZip(res, `MangaDex_${chapterId}.zip`, items, headers, 3, false);
        }

        // ---------- Pixiv Artworks ----------
        if (url.includes('pixiv.net') && url.includes('artworks')) {
            const m = url.match(/artworks\/(\d+)/i);
            if (!m) throw new Error('Không tìm thấy Artwork ID');
            const artId = m[1];

            const headers = {
                'User-Agent': DEFAULT_USER_AGENT,
                Referer: 'https://www.pixiv.net/'
            };
            if (PIXIV_PHPSESSID) headers.Cookie = `PHPSESSID=${PIXIV_PHPSESSID}`;

            const api = await axios.get(`https://www.pixiv.net/ajax/illust/${artId}/pages?lang=en`, { headers });
            if (api.data.error) throw new Error(api.data.message);

            const items = api.data.body.map((p, i) => {
                const imgUrl = PIXIV_PHPSESSID ? p.urls.original : p.urls.regular;
                const ext = imgUrl.split('.').pop();
                return { url: imgUrl, name: `${String(i+1).padStart(3,'0')}.${ext}` };
            });

            return streamZip(res, `PixivArt_${artId}.zip`, items, () => headers, 3, false);
        }

        // ---------- Pixiv Comic ----------
        if (url.includes('comic.pixiv.net')) {
            const m = url.match(/stories\/(\d+)/i);
            if (!m) throw new Error('Không tìm thấy Story ID');
            const storyId = m[1];

            let salt = 'nuxP2h3-ubK7Ol4edtPAbZVxahIXYWSJHfCsFksPORk';
            try {
                const page = await axios.get(`https://comic.pixiv.net/viewer/stories/${storyId}`, {
                    headers: { 'User-Agent': DEFAULT_USER_AGENT }
                });
                const match = page.data.match(/<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/s);
                if (match) {
                    const next = JSON.parse(match[1]);
                    salt = next?.props?.pageProps?.salt || salt;
                }
            } catch (e) { /* fallback */ }

            const timeStr = new Date().toISOString().replace(/\.\d+/, '');
            const hash = crypto.createHash('sha256').update(timeStr + salt).digest('hex');

            const comHeaders = {
                'User-Agent': DEFAULT_USER_AGENT,
                Referer: 'https://comic.pixiv.net/',
                'X-Client-Time': timeStr,
                'X-Client-Hash': hash
            };
            if (PIXIV_PHPSESSID) comHeaders.Cookie = `PHPSESSID=${PIXIV_PHPSESSID}`;

            const api = await axios.get(`https://comic.pixiv.net/api/app/viewer/v3/episodes/${storyId}/read`, {
                headers: comHeaders
            });
            const ep = api.data?.data?.reading_episode;
            if (!ep) throw new Error('Không thể đọc episode');

            const label = `PixivComic_${ep.work_title}_${ep.numbering_title}`.replace(/[/\\:*?"<>|]/g, '_');
            const items = ep.pages.map((p, i) => ({
                url: p.url,
                key: p.key,
                name: `${String(i+1).padStart(3,'0')}.jpg`
            }));

            const getImgHeaders = (imgUrl) => imgUrl.includes('pximg.net')
                ? { Referer: 'https://comic.pixiv.net/' }
                : comHeaders;

            return streamZip(res, `${label}.zip`, items, getImgHeaders, 2, true);
        }

        return res.status(400).json({ error: 'URL không được hỗ trợ' });
    } catch (err) {
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

// Fallback route để trả về index.html cho SPA (nếu cần)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Không dùng app.listen vì Vercel xử lý qua module.exports
module.exports = app;
