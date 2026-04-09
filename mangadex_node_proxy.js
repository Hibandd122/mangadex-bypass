// ============================================
// UNIFIED PROXY — VERCEL EDITION
// MangaDex (title + chọn chapter) + Pixiv Artworks + Pixiv User
// ============================================

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const archiver = require('archiver');
const sharp = require('sharp');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const PIXIV_PHPSESSID = process.env.PIXIV_PHPSESSID || null;
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

// ─── ZIP STREAMING ──────────────────────────────────────────────────────────
async function streamZip(res, filename, items, getHeaders, concurrency = 3) {
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
            const { url, name } = item;
            try {
                const buf = await fetchBuffer(url, await getHeaders(url));
                archive.append(buf, { name });
            } catch (e) {
                archive.append(Buffer.from(`ERROR: ${e.message}\nURL: ${url}`), { name: `_ERROR_${name}` });
            }
        }));
    }

    await archive.finalize();
}

// ─── PIXIV HELPERS ──────────────────────────────────────────────────────────
function getPixivHeaders() {
    const headers = {
        'User-Agent': DEFAULT_USER_AGENT,
        'Referer': 'https://www.pixiv.net/'
    };
    if (PIXIV_PHPSESSID) {
        headers.Cookie = `PHPSESSID=${PIXIV_PHPSESSID}`;
    }
    return headers;
}

// Lấy danh sách artworks của user (có phân trang)
async function fetchUserAllArtworks(userId) {
    const headers = getPixivHeaders();
    let allArtworks = [];
    let offset = 0;
    const limit = 48; // Pixiv API trả tối đa 48 artwork mỗi request

    while (true) {
        const url = `https://www.pixiv.net/ajax/user/${userId}/profile/all?lang=en`;
        const resp = await axios.get(url, { headers });
        const body = resp.data.body;
        if (!body || !body.illusts) break;

        const illustIds = Object.keys(body.illusts);
        if (illustIds.length === 0) break;

        // Lấy thông tin chi tiết từng artwork (cần gọi API riêng để có title, pageCount)
        // Để tránh quá nhiều request, ta có thể lấy danh sách ID trước, rồi gọi chi tiết khi cần
        // Nhưng để hiển thị danh sách, ta cần ít nhất title và số trang
        // Giải pháp: gọi API `user/illusts` (không chính thức) hoặc dùng `illust/${id}` tuần tự
        // Tuy nhiên, để đơn giản và tránh timeout, ta chỉ trả về ID và một số thông tin cơ bản
        // Người dùng có thể chọn artwork dựa trên ID (sẽ cải thiện sau)
        for (const id of illustIds) {
            allArtworks.push({
                id: id,
                title: `Artwork ${id}`,
                pageCount: 1 // mặc định, sẽ cập nhật sau khi chọn tải
            });
        }

        // Pixiv user profile/all không phân trang, trả tất cả ID một lần, nên break
        break;
    }

    // Lấy thêm title và pageCount cho mỗi artwork (có thể chậm nếu nhiều)
    // Để tối ưu, ta chỉ lấy thông tin cơ bản, hoặc lấy dần khi render
    // Ở đây ta sẽ fetch tuần tự 10 artwork một lần để không quá tải
    const enrichedArtworks = [];
    for (let i = 0; i < allArtworks.length; i += 10) {
        const batch = allArtworks.slice(i, i + 10);
        await Promise.all(batch.map(async (art) => {
            try {
                const detail = await axios.get(`https://www.pixiv.net/ajax/illust/${art.id}?lang=en`, { headers });
                const data = detail.data.body;
                art.title = data.title || art.id;
                art.pageCount = data.pageCount || 1;
                art.url = `https://www.pixiv.net/en/artworks/${art.id}`;
                // Thêm thumbnail nếu cần
                enrichedArtworks.push(art);
            } catch (e) {
                enrichedArtworks.push(art);
            }
        }));
    }

    return enrichedArtworks;
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

// Lấy danh sách chapter của MangaDex title
app.get('/api/chapters', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing url' });
    const titleMatch = url.match(/title\/([a-f0-9-]{36})/i);
    if (!titleMatch) return res.status(400).json({ error: 'URL không phải MangaDex title' });
    const mangaId = titleMatch[1];

    try {
        const mangaRes = await axios.get(`https://api.mangadex.org/manga/${mangaId}`, {
            headers: { 'User-Agent': DEFAULT_USER_AGENT }
        });
        const mangaTitle = mangaRes.data.data.attributes.title.en || 'Unknown';

        let allChapters = [];
        let offset = 0;
        const limit = 100;
        while (true) {
            const feedRes = await axios.get(`https://api.mangadex.org/manga/${mangaId}/feed`, {
                headers: { 'User-Agent': DEFAULT_USER_AGENT },
                params: {
                    limit,
                    offset,
                    order: { chapter: 'asc' },
                    includes: ['scanlation_group']
                }
            });
            const chapters = feedRes.data.data;
            if (!chapters || chapters.length === 0) break;
            allChapters.push(...chapters);
            if (chapters.length < limit) break;
            offset += limit;
        }

        const result = {
            mangaId,
            mangaTitle,
            chapters: allChapters.map(chap => ({
                id: chap.id,
                chapter: chap.attributes.chapter || 'Oneshot',
                title: chap.attributes.title || '',
                volume: chap.attributes.volume || '',
                translatedLanguage: chap.attributes.translatedLanguage,
                pages: chap.attributes.pages || 0,
                group: chap.relationships?.find(r => r.type === 'scanlation_group')?.attributes?.name || 'Unknown'
            }))
        };
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Lấy danh sách artworks của Pixiv user
app.get('/api/pixiv/user', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing url' });
    const userMatch = url.match(/users\/(\d+)/i);
    if (!userMatch) return res.status(400).json({ error: 'URL không phải Pixiv user' });
    const userId = userMatch[1];

    if (!PIXIV_PHPSESSID) {
        return res.status(403).json({ error: 'Cần PHPSESSID để lấy danh sách artworks của Pixiv user' });
    }

    try {
        const artworks = await fetchUserAllArtworks(userId);
        res.json({
            userId,
            artworks: artworks
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/download', async (req, res) => {
    const { url, chapters, artworks } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing url' });

    try {
        // ---------- MangaDex Chapter đơn ----------
        if (url.includes('/chapter/')) {
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
            return streamZip(res, `MangaDex_Chapter_${chapterId}.zip`, items, headers, 3);
        }

        // ---------- MangaDex Title (có thể chọn chapter) ----------
        if (url.includes('/title/')) {
            const m = url.match(/title\/([a-f0-9-]{36})/i);
            if (!m) throw new Error('Không tìm thấy Title ID');
            const mangaId = m[1];

            const mangaRes = await axios.get(`https://api.mangadex.org/manga/${mangaId}`, {
                headers: { 'User-Agent': DEFAULT_USER_AGENT }
            });
            const mangaTitle = mangaRes.data.data.attributes.title.en || 'Manga';

            let chaptersToDownload = [];
            if (chapters) {
                const chapterIds = chapters.split(',').map(id => id.trim());
                for (const cid of chapterIds) {
                    try {
                        const chapRes = await axios.get(`https://api.mangadex.org/chapter/${cid}`, {
                            headers: { 'User-Agent': DEFAULT_USER_AGENT }
                        });
                        chaptersToDownload.push(chapRes.data.data);
                    } catch (e) {
                        console.error(`Lỗi lấy chapter ${cid}:`, e.message);
                    }
                }
            } else {
                let offset = 0;
                const limit = 100;
                while (true) {
                    const feedRes = await axios.get(`https://api.mangadex.org/manga/${mangaId}/feed`, {
                        headers: { 'User-Agent': DEFAULT_USER_AGENT },
                        params: { limit, offset, order: { chapter: 'asc' } }
                    });
                    const chaps = feedRes.data.data;
                    if (!chaps || chaps.length === 0) break;
                    chaptersToDownload.push(...chaps);
                    if (chaps.length < limit) break;
                    offset += limit;
                }
            }

            if (chaptersToDownload.length === 0) {
                throw new Error('Không có chapter nào để tải');
            }

            let allItems = [];
            const headers = { 'User-Agent': DEFAULT_USER_AGENT, Referer: 'https://mangadex.org/' };

            for (const chap of chaptersToDownload) {
                const chapId = chap.id;
                const chapNum = chap.attributes.chapter || chapId.slice(0,8);
                try {
                    const atHome = await axios.get(`https://api.mangadex.org/at-home/server/${chapId}`, { headers });
                    const { baseUrl, chapter } = atHome.data;
                    const chapterFolder = `Chapter_${chapNum}`;
                    for (let i = 0; i < chapter.data.length; i++) {
                        const fileName = `${String(i+1).padStart(3,'0')}.jpg`;
                        allItems.push({
                            url: `${baseUrl}/data/${chapter.hash}/${chapter.data[i]}`,
                            name: `${chapterFolder}/${fileName}`,
                        });
                    }
                } catch (e) {
                    console.error(`Lỗi lấy chapter ${chapId}:`, e.message);
                }
            }

            if (allItems.length === 0) {
                throw new Error('Không thể lấy được trang ảnh nào');
            }

            const safeTitle = mangaTitle.replace(/[/\\:*?"<>|]/g, '_').substring(0, 100);
            const zipName = `MangaDex_${safeTitle}.zip`;
            return streamZip(res, zipName, allItems, () => headers, 1);
        }

        // ---------- Pixiv Artworks (chọn nhiều) ----------
        if ((url.includes('pixiv.net') && url.includes('artworks')) || artworks) {
            let artIds = [];
            if (artworks) {
                artIds = artworks.split(',').map(id => id.trim());
            } else {
                const m = url.match(/artworks\/(\d+)/i);
                if (!m) throw new Error('Không tìm thấy Artwork ID');
                artIds = [m[1]];
            }

            if (!PIXIV_PHPSESSID) {
                // Fallback: tải ảnh regular không cần cookie
            }

            const headers = getPixivHeaders();
            let allItems = [];

            for (const artId of artIds) {
                try {
                    // Lấy thông tin pages
                    const api = await axios.get(`https://www.pixiv.net/ajax/illust/${artId}/pages?lang=en`, { headers });
                    if (api.data.error) throw new Error(api.data.message);
                    
                    const titleResp = await axios.get(`https://www.pixiv.net/ajax/illust/${artId}?lang=en`, { headers });
                    const artworkTitle = titleResp.data.body.title || artId;
                    const safeTitle = artworkTitle.replace(/[/\\:*?"<>|]/g, '_').substring(0, 50);

                    const pages = api.data.body;
                    pages.forEach((p, i) => {
                        const imgUrl = PIXIV_PHPSESSID ? p.urls.original : p.urls.regular;
                        const ext = imgUrl.split('.').pop();
                        const name = `${safeTitle}/${String(i+1).padStart(3,'0')}.${ext}`;
                        allItems.push({ url: imgUrl, name });
                    });
                } catch (e) {
                    console.error(`Lỗi lấy artwork ${artId}:`, e.message);
                }
            }

            if (allItems.length === 0) {
                throw new Error('Không thể lấy được ảnh nào');
            }

            const zipName = artworks ? `Pixiv_Artworks_${artIds.length}items.zip` : `PixivArt_${artIds[0]}.zip`;
            return streamZip(res, zipName, allItems, () => headers, 2);
        }

        // ---------- Pixiv User (tải nhiều artworks đã chọn) ----------
        // Đã được xử lý chung ở trên với tham số artworks

        return res.status(400).json({ error: 'URL không được hỗ trợ' });
    } catch (err) {
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

// Fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

module.exports = app;
