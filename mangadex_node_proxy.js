const http = require('http');
const https = require('https');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const archiver = require('archiver');

const app = express();

app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---- Configuration ----
const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const MANGADEX_REFERER = 'https://mangadex.org/';
const PIXIV_REFERER = 'https://www.pixiv.net/';
const ALLOWED_DOMAINS = [
    'mangadex.org', 'api.mangadex.org', 'uploads.mangadex.org',
    'pixiv.net', 'www.pixiv.net', 'i.pximg.net',
];
const CACHE_TTL_MS = 5 * 60 * 1000; // 5-minute cache
const MAX_CONCURRENCY_FEED = parseInt(process.env.CONCURRENCY_FEED, 10) || 4;
const MAX_CONCURRENCY_CHAPTER = parseInt(process.env.CONCURRENCY_CHAPTER, 10) || 6;
const MAX_CONCURRENCY_DOWNLOAD = parseInt(process.env.CONCURRENCY_DOWNLOAD, 10) || 8;

// ---- Connection Pooling ----
const httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 100,
    maxFreeSockets: 20,
    timeout: 60000,
});

const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 100,
    maxFreeSockets: 20,
    timeout: 60000,
});

// ---- Axios Client ----
const httpClient = axios.create({
    timeout: 30000,
    headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Ch-Ua': '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
        'Origin': 'https://mangadex.org',
        'Referer': 'https://mangadex.org/'
    },
    httpAgent,
    httpsAgent,
});

// ---- In-Memory Cache ----
const memoryCache = new Map();
const cacheTimers = new Map();
// Deduplicate concurrent requests for the same upstream resource. This is
// especially useful when the mobile clients request detail and cover together.
const pendingRequests = new Map();

function cacheGet(key) {
    const entry = memoryCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        memoryCache.delete(key);
        return null;
    }
    return entry.data;
}

function cacheSet(key, data, ttl = CACHE_TTL_MS) {
    // Clear existing timer if any
    if (cacheTimers.has(key)) {
        clearTimeout(cacheTimers.get(key));
    }
    memoryCache.set(key, { data, expiresAt: Date.now() + ttl });
    cacheTimers.set(key, setTimeout(() => {
        memoryCache.delete(key);
        cacheTimers.delete(key);
    }, ttl));
}

function cacheClear() {
    memoryCache.clear();
    for (const timer of cacheTimers.values()) {
        clearTimeout(timer);
    }
    cacheTimers.clear();
    pendingRequests.clear();
}

function stableSerialize(value) {
    if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

// ---- Server Stats ----
const serverStats = {
    startTime: Date.now(),
    requestsTotal: 0,
    requestsByEndpoint: {},
    cacheHits: 0,
    cacheMisses: 0,
};

// ---- Middleware: Request ID + Logging ----
app.use((req, res, next) => {
    req.id = crypto.randomUUID().slice(0, 8);
    serverStats.requestsTotal++;
    const endpoint = req.path || '/';
    serverStats.requestsByEndpoint[endpoint] = (serverStats.requestsByEndpoint[endpoint] || 0) + 1;

    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`[${req.id}] ${req.method} ${endpoint} ${res.statusCode} ${duration}ms`);
    });
    next();
});

// ---- Utility Functions ----
function jsonError(res, status, message, extra = {}) {
    return res.status(status).json({ error: message, ...extra });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFilename(value, fallback = 'download') {
    return String(value || fallback)
        .replace(/[/\\:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 120) || fallback;
}

function getPreferredTitle(titleMap = {}) {
    if (typeof titleMap.en === 'string' && titleMap.en.trim()) {
        return titleMap.en.trim();
    }
    const firstTitle = Object.values(titleMap).find(
        (title) => typeof title === 'string' && title.trim()
    );
    return firstTitle ? firstTitle.trim() : 'Unknown';
}

function getMangaDexTitleId(rawUrl) {
    const titleMatch = String(rawUrl || '').match(/title\/([a-f0-9-]{36})/i);
    return titleMatch ? titleMatch[1] : null;
}

function getMangaDexChapterId(rawUrl) {
    const chapterMatch = String(rawUrl || '').match(/chapter\/([a-f0-9-]{36})/i);
    return chapterMatch ? chapterMatch[1] : null;
}

function isRateLimitError(error) {
    return error?.response?.status === 429;
}

function getRetryAfterMs(error, fallbackMs = 2000) {
    const retryAfter = error?.response?.headers?.['retry-after'];
    if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds) && seconds >= 0) {
            return seconds * 1000;
        }
        const retryDate = Date.parse(retryAfter);
        if (!Number.isNaN(retryDate)) {
            return Math.max(retryDate - Date.now(), 0);
        }
    }
    return fallbackMs;
}

function createRateLimitError(error) {
    const retryAfterMs = Math.min(Math.max(getRetryAfterMs(error), 500), 15000);
    const rateLimitError = new Error('Upstream rate limited (429)');
    rateLimitError.status = 429;
    rateLimitError.retryAfterMs = retryAfterMs;
    rateLimitError.retryAfterSeconds = Math.ceil(retryAfterMs / 1000);
    rateLimitError.source = error?.config?.url || null;
    return rateLimitError;
}

function sendRouteError(res, error) {
    if (error?.status === 429) {
        if (error.retryAfterSeconds) {
            res.set('Retry-After', String(error.retryAfterSeconds));
        }
        return jsonError(res, 429, error.message, {
            retryAfterSeconds: error.retryAfterSeconds || 1,
            source: error.source || undefined,
        });
    }
    return jsonError(res, 500, error.message);
}

// ---- URL Validation (SSRF Protection) ----
function isValidProxyUrl(urlString) {
    try {
        const parsed = new URL(urlString);
        const hostname = parsed.hostname.replace(/^www\./, '');
        return ALLOWED_DOMAINS.some(domain => hostname === domain || hostname.endsWith('.' + domain));
    } catch {
        return false;
    }
}

// ---- Concurrency Helper ----
async function mapWithConcurrency(items, concurrency, mapper) {
    if (!items.length) return [];
    const workerCount = Math.max(1, Math.min(concurrency, items.length));
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < items.length) {
            const currentIndex = nextIndex++;
            results[currentIndex] = await mapper(items[currentIndex], currentIndex);
        }
    }

    await Promise.all(Array.from({ length: workerCount }, worker));
    return results;
}

async function fetchStream(url, headers = {}) {
    return requestGet(url, { headers, responseType: 'stream' });
}

async function fetchManga(titleOrChapterPath) {
    try {
        if (titleOrChapterPath.includes('/manga/')) {
            const baseUrl = titleOrChapterPath.split('?')[0];
            return await requestGet(baseUrl, {
                params: { 'includes[]': ['artist', 'author', 'cover_art'] }
            });
        }
        return await requestGet(titleOrChapterPath);
    } catch (e) {
        if (e.response && e.response.status === 400) {
            const errorDetails = e.response.data ? JSON.stringify(e.response.data) : '';
            throw new Error(`fetchManga 400 Error. Data: ${errorDetails}`);
        }
        throw e;
    }
}

// ---- Retry Logic ----
async function requestWithRetry(config, options = {}) {
    const { retries = 2, baseDelayMs = 1200 } = options;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            return await httpClient.request(config);
        } catch (error) {
            if (!isRateLimitError(error)) throw error;
            if (attempt === retries) throw createRateLimitError(error);

            const waitMs = Math.min(
                Math.max(getRetryAfterMs(error, baseDelayMs * (attempt + 1)), 500),
                15000
            );
            await sleep(waitMs);
        }
    }
    throw new Error('Unexpected retry state');
}

async function requestGet(url, config = {}, options = {}) {
    return requestWithRetry({ method: 'get', url, ...config }, options);
}

async function requestGetWithCache(url, config = {}, options = {}, ttl = CACHE_TTL_MS) {
    const cacheKey = `${url}::${stableSerialize(config?.params || {})}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
        serverStats.cacheHits++;
        return cached;
    }
    const pending = pendingRequests.get(cacheKey);
    if (pending) {
        serverStats.cacheHits++;
        return pending;
    }

    serverStats.cacheMisses++;
    const request = requestGet(url, config, options)
        .then((response) => {
            cacheSet(cacheKey, response, ttl);
            return response;
        })
        .finally(() => pendingRequests.delete(cacheKey));
    pendingRequests.set(cacheKey, request);
    return request;
}

// ---- MangaDex Feed ----
async function fetchAllMangaFeedChapters(mangaId, extraParams = {}) {
    const limit = 100;
    const baseConfig = {
        params: {
            limit,
            offset: 0,
            'order[chapter]': 'desc',
            'translatedLanguage[]': ['vi', 'en'],
            ...extraParams,
        },
    };

    let firstPage;
    try {
        firstPage = await requestGet(`https://api.mangadex.org/manga/${mangaId}/feed`, baseConfig);
    } catch (e) {
        if (e.response && e.response.status === 400) {
            throw new Error(`feed API 400 Error: ${JSON.stringify(e.response.data)}`);
        }
        throw e;
    }
    const firstBatch = firstPage.data?.data || [];
    const total = Number(firstPage.data?.total || firstBatch.length);

    if (total <= limit) return firstBatch;

    const offsets = [];
    for (let offset = limit; offset < total; offset += limit) {
        offsets.push(offset);
    }

    const remainingPages = await mapWithConcurrency(offsets, MAX_CONCURRENCY_FEED, async (offset) => {
        const response = await requestGet(`https://api.mangadex.org/manga/${mangaId}/feed`, {
            params: { ...baseConfig.params, offset },
        });
        return response.data?.data || [];
    });

    return [firstBatch, ...remainingPages].flat();
}

// ---- Chapter Image Builder ----
async function buildChapterItems(chapters, concurrency = MAX_CONCURRENCY_CHAPTER) {
    const chapterEntries = await mapWithConcurrency(chapters, concurrency, async (chapter, index) => {
        const chapterId = chapter.id;
        const chapterNumber =
            chapter.attributes?.chapter ||
            chapter.chapterLabel ||
            `part_${String(index + 1).padStart(3, '0')}`;

        try {
            const atHome = await requestGet(`https://api.mangadex.org/at-home/server/${chapterId}`, {
                headers: { Referer: MANGADEX_REFERER },
            });

            const chapterData = atHome.data?.chapter;
            const baseUrl = atHome.data?.baseUrl;
            if (!baseUrl || !chapterData?.hash || !Array.isArray(chapterData.data) || chapterData.data.length === 0) {
                return [];
            }

            const chapterFolder = sanitizeFilename(`Chapter_${chapterNumber}`, `Chapter_${chapterId.slice(0, 8)}`);

            return chapterData.data.map((file, pageIndex) => ({
                url: `${baseUrl}/data/${chapterData.hash}/${file}`,
                name: `${chapterFolder}/${String(pageIndex + 1).padStart(3, '0')}.jpg`,
            }));
        } catch (error) {
            if (error?.status === 429) throw error;
            console.error(`Failed to fetch chapter ${chapterId}:`, error.message);
            return [];
        }
    });

    return chapterEntries.flat();
}

// ---- ZIP Streaming ----
async function streamZip(res, filename, items, getHeaders, concurrency = MAX_CONCURRENCY_CHAPTER) {
    res.set({
        'Content-Type': 'application/zip',
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    });

    const archive = archiver('zip', { store: true });

    archive.on('warning', (error) => {
        if (error.code !== 'ENOENT') {
            console.warn('Archive warning:', error.message);
        }
    });

    archive.on('error', (error) => {
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
            return;
        }
        res.destroy(error);
    });

    res.on('close', () => {
        if (!res.writableEnded) archive.abort();
    });

    archive.pipe(res);

    await mapWithConcurrency(items, concurrency, async (item) => {
        try {
            const headers = await getHeaders(item.url, item);
            const response = await fetchStream(item.url, headers);
            archive.append(response.data, { name: item.name });

            response.data.on('end', () => {
                if (response.data.destroy) response.data.destroy();
            });
        } catch (error) {
            if (error?.status === 429) {
                archive.append(
                    Buffer.from(
                        `RATE LIMITED\nRetry after: ${error.retryAfterSeconds || 1}s\nURL: ${item.url}`
                    ),
                    { name: `_RATE_LIMIT_${sanitizeFilename(item.name, 'file.txt')}.txt` }
                );
                return;
            }
            archive.append(Buffer.from(`ERROR: ${error.message}\nURL: ${item.url}`), {
                name: `_ERROR_${sanitizeFilename(item.name, 'file.txt')}`,
            });
        }
    });

    await archive.finalize();

    if (global.gc) {
        setTimeout(() => global.gc(), 1000);
    }
}

// ---- API Endpoints ----

// Health check
app.get('/api/health', (req, res) => {
    const uptime = Date.now() - serverStats.startTime;
    res.json({
        status: 'ok',
        uptime: Math.floor(uptime / 1000),
        uptimeHuman: `${Math.floor(uptime / 3600000)}h ${Math.floor((uptime % 3600000) / 60000)}m`,
        version: '2.5.0',
        memory: process.memoryUsage(),
        stats: {
            totalRequests: serverStats.requestsTotal,
            endpoints: serverStats.requestsByEndpoint,
            cacheHits: serverStats.cacheHits,
            cacheMisses: serverStats.cacheMisses,
            cacheSize: memoryCache.size,
        },
    });
});

// Clear cache
app.post('/api/cache/clear', (req, res) => {
    cacheClear();
    res.json({ status: 'ok', message: 'Cache cleared' });
});

// Search manga
app.get('/api/search', async (req, res) => {
    const { q, limit = 20, offset = 0 } = req.query;
    if (!q || String(q).trim().length === 0) {
        return jsonError(res, 400, 'Missing search query (?q=...)');
    }

    try {
        const response = await requestGetWithCache('https://api.mangadex.org/manga', {
            params: {
                title: String(q).trim(),
                limit: Math.min(Math.max(Number(limit) || 20, 1), 100),
                offset: Math.max(Number(offset) || 0, 0),
                'includes[]': ['cover_art', 'artist', 'author'],
                'contentRating[]': ['safe', 'suggestive', 'erotica', 'pornographic'],
                'order[relevance]': 'desc',
            },
        });

        const mangaList = (response.data?.data || []).map((manga) => {
            const coverRel = (manga.relationships || []).find(r => r.type === 'cover_art');
            const artistRel = (manga.relationships || []).find(r => r.type === 'artist');
            const authorRel = (manga.relationships || []).find(r => r.type === 'author');
            return {
                id: manga.id,
                title: getPreferredTitle(manga.attributes?.title),
                altTitles: (manga.attributes?.altTitles || []).map(t => Object.values(t)[0]).filter(Boolean),
                description: manga.attributes?.description?.en || '',
                year: manga.attributes?.year,
                status: manga.attributes?.status,
                coverFileName: coverRel?.attributes?.fileName || null,
                artist: artistRel?.attributes?.name || null,
                author: authorRel?.attributes?.name || null,
                tags: (manga.attributes?.tags || []).map(t => t.attributes?.name?.en).filter(Boolean),
                rating: manga.attributes?.rating?.bayesian || null,
                followCount: manga.attributes?.followCount || 0,
                contentRating: manga.attributes?.contentRating || 'safe',
            };
        });

        return res.json({
            total: response.data?.total || mangaList.length,
            limit: response.data?.limit || Number(limit),
            offset: response.data?.offset || Number(offset),
            results: mangaList,
        });
    } catch (error) {
        return sendRouteError(res, error);
    }
});

// Search suggestions (quick)
app.get('/api/search/suggest', async (req, res) => {
    const { q } = req.query;
    if (!q || String(q).trim().length === 0) {
        return jsonError(res, 400, 'Missing query');
    }

    try {
        const response = await requestGetWithCache('https://api.mangadex.org/manga', {
            params: {
                title: String(q).trim(),
                limit: 10,
                'includes[]': ['cover_art'],
                'order[relevance]': 'desc',
                'contentRating[]': ['safe', 'suggestive', 'erotica', 'pornographic'],
            },
        }, {}, 120000); // 2 min cache for suggestions

        const suggestions = (response.data?.data || []).map((manga) => {
            const coverRel = (manga.relationships || []).find(r => r.type === 'cover_art');
            return {
                id: manga.id,
                title: getPreferredTitle(manga.attributes?.title),
                year: manga.attributes?.year,
                coverFileName: coverRel?.attributes?.fileName || null,
            };
        });

        return res.json({ query: q, suggestions });
    } catch (error) {
        return sendRouteError(res, error);
    }
});

// Manga detail
app.get('/api/manga/:id', async (req, res) => {
    const { id } = req.params;
    if (!id || !/^[a-f0-9-]{36}$/i.test(id)) {
        return jsonError(res, 400, 'Invalid manga ID format');
    }

    try {
        const response = await requestGetWithCache(`https://api.mangadex.org/manga/${id}`, {
            params: { 'includes[]': ['cover_art', 'artist', 'author'] },
        });

        const manga = response.data?.data;
        if (!manga) return jsonError(res, 404, 'Manga not found');

        const coverRel = (manga.relationships || []).find(r => r.type === 'cover_art');
        const artistRel = (manga.relationships || []).find(r => r.type === 'artist');
        const authorRel = (manga.relationships || []).find(r => r.type === 'author');

        return res.json({
            id: manga.id,
            title: getPreferredTitle(manga.attributes?.title),
            altTitles: (manga.attributes?.altTitles || []).map(t => Object.values(t)[0]).filter(Boolean),
            description: manga.attributes?.description?.en || '',
            year: manga.attributes?.year,
            status: manga.attributes?.status,
            coverFileName: coverRel?.attributes?.fileName || null,
            artist: artistRel?.attributes?.name || null,
            author: authorRel?.attributes?.name || null,
            tags: (manga.attributes?.tags || []).map(t => t.attributes?.name?.en).filter(Boolean),
            rating: manga.attributes?.rating?.bayesian || null,
            followCount: manga.attributes?.followCount || 0,
            contentRating: manga.attributes?.contentRating || 'safe',
            createdAt: manga.attributes?.createdAt,
            updatedAt: manga.attributes?.updatedAt,
        });
    } catch (error) {
        return sendRouteError(res, error);
    }
});

// Cover art
app.get('/api/cover', async (req, res) => {
    const { url, mangaId } = req.query;
    let id = mangaId;

    if (url) {
        id = getMangaDexTitleId(url);
    }

    if (!id || !/^[a-f0-9-]{36}$/i.test(id)) {
        return jsonError(res, 400, 'Missing or invalid mangaId');
    }

    try {
        const response = await requestGetWithCache(`https://api.mangadex.org/manga/${id}`, {
            params: { 'includes[]': ['cover_art'] },
        });

        const coverRel = (response.data?.data?.relationships || []).find(r => r.type === 'cover_art');
        const fileName = coverRel?.attributes?.fileName;

        if (!fileName) {
            return jsonError(res, 404, 'No cover art found');
        }

        const coverUrl = `https://uploads.mangadex.org/covers/${id}/${fileName}`;

        // If redirect param is set, redirect directly to the image
        if (req.query.redirect === '1') {
            return res.redirect(coverUrl);
        }

        return res.json({
            mangaId: id,
            coverUrl,
            fileName,
            original: coverUrl.endsWith('.png') ? coverUrl : coverUrl + '.512.jpg',
            thumbnail: coverUrl + '.256.jpg',
        });
    } catch (error) {
        return sendRouteError(res, error);
    }
});

// Chapter detail
app.get('/api/chapter/:id', async (req, res) => {
    const { id } = req.params;
    if (!id || !/^[a-f0-9-]{36}$/i.test(id)) {
        return jsonError(res, 400, 'Invalid chapter ID format');
    }

    try {
        const response = await requestGetWithCache(`https://api.mangadex.org/chapter/${id}`, {
            params: { 'includes[]': ['scanlation_group', 'manga'] },
        });

        const chapter = response.data?.data;
        if (!chapter) return jsonError(res, 404, 'Chapter not found');

        const mangaRel = (chapter.relationships || []).find(r => r.type === 'manga');
        const groupRel = (chapter.relationships || []).find(r => r.type === 'scanlation_group');

        return res.json({
            id: chapter.id,
            chapter: chapter.attributes?.chapter || 'Oneshot',
            title: chapter.attributes?.title || '',
            volume: chapter.attributes?.volume || '',
            translatedLanguage: chapter.attributes?.translatedLanguage,
            pages: chapter.attributes?.pages || 0,
            publishAt: chapter.attributes?.publishAt,
            createdAt: chapter.attributes?.createdAt,
            updatedAt: chapter.attributes?.updatedAt,
            group: groupRel?.attributes?.name || 'Unknown',
            mangaId: mangaRel?.id || null,
        });
    } catch (error) {
        return sendRouteError(res, error);
    }
});

// List chapters (v2 with better data)
app.get('/api/chapters', async (req, res) => {
    const { url } = req.query;
    if (!url) return jsonError(res, 400, 'Missing url');

    const mangaId = getMangaDexTitleId(url);
    if (!mangaId) return jsonError(res, 400, 'URL is not a MangaDex title');

    try {
        const [mangaResponse, chapters] = await Promise.all([
            fetchManga(`https://api.mangadex.org/manga/${mangaId}`),
            fetchAllMangaFeedChapters(mangaId, { includes: ['scanlation_group'] }),
        ]);

        const mangaTitle = getPreferredTitle(mangaResponse.data?.data?.attributes?.title);
        return res.json({
            mangaId,
            mangaTitle,
            total: chapters.length,
            chapters: chapters.map((chapter) => ({
                id: chapter.id,
                chapter: chapter.attributes?.chapter || 'Oneshot',
                title: chapter.attributes?.title || '',
                volume: chapter.attributes?.volume || '',
                translatedLanguage: chapter.attributes?.translatedLanguage,
                pages: chapter.attributes?.pages || 0,
                publishAt: chapter.attributes?.publishAt,
                group: chapter.relationships?.find((r) => r.type === 'scanlation_group')
                    ?.attributes?.name || 'Unknown',
            })),
        });
    } catch (error) {
        return sendRouteError(res, error);
    }
});

// Image proxy
app.get('/api/proxy', async (req, res) => {
    const { url } = req.query;
    if (!url) return jsonError(res, 400, 'Missing url');

    if (!isValidProxyUrl(url)) {
        return jsonError(res, 403, 'Domain not allowed for proxy');
    }

    try {
        const headers = { Referer: new URL(url).origin };
        const response = await fetchStream(url, headers);

        res.set({
            'Content-Type': response.headers['content-type'] || 'application/octet-stream',
            'Cache-Control': 'public, max-age=86400',
        });

        response.data.pipe(res);
    } catch (error) {
        return sendRouteError(res, error);
    }
});

// Download handler
app.get('/api/download', async (req, res) => {
    const { url, chapters } = req.query;
    if (!url) return jsonError(res, 400, 'Missing url');

    try {
        // --- Single Chapter ---
        if (String(url).includes('/chapter/')) {
            const chapterId = getMangaDexChapterId(url);
            if (!chapterId) throw new Error('Chapter ID not found');

            let atHome;
            try {
                atHome = await requestGet(`https://api.mangadex.org/at-home/server/${chapterId}`, {
                    headers: { Referer: MANGADEX_REFERER },
                });
            } catch (err) {
                if (err.response?.status === 400 || err.response?.status === 404) {
                    throw new Error(`Chapter ${chapterId} is external link, locked, or has no data on MangaDex.`);
                }
                throw err;
            }

            const chapterData = atHome.data?.chapter;
            const baseUrl = atHome.data?.baseUrl;
            if (!baseUrl || !chapterData?.hash || !Array.isArray(chapterData.data) || chapterData.data.length === 0) {
                throw new Error('Could not get chapter data');
            }

            const items = chapterData.data.map((file, index) => ({
                url: `${baseUrl}/data/${chapterData.hash}/${file}`,
                name: `${String(index + 1).padStart(3, '0')}.jpg`,
            }));

            return streamZip(res, `MangaDex_Chapter_${chapterId}.zip`, items, async () => ({ Referer: MANGADEX_REFERER }));
        }

        // --- Title (full manga or selected chapters) ---
        if (String(url).includes('/title/')) {
            const mangaId = getMangaDexTitleId(url);
            if (!mangaId) throw new Error('Title ID not found');

            const mangaResponsePromise = fetchManga(`https://api.mangadex.org/manga/${mangaId}`);

            let chaptersToDownload;
            if (chapters) {
                const chapterIds = String(chapters).split(',').map(id => id.trim()).filter(Boolean);
                chaptersToDownload = await mapWithConcurrency(chapterIds, 6, async (chapterId, index) => {
                    try {
                        const response = await requestGet(`https://api.mangadex.org/chapter/${chapterId}`);
                        return response.data?.data || { id: chapterId, chapterLabel: `part_${String(index + 1).padStart(3, '0')}` };
                    } catch (error) {
                        if (error?.status === 429) throw error;
                        console.error(`Failed to fetch chapter ${chapterId}:`, error.message);
                        return null;
                    }
                });
                chaptersToDownload = chaptersToDownload.filter(Boolean);
            } else {
                chaptersToDownload = await fetchAllMangaFeedChapters(mangaId);
            }

            if (chaptersToDownload.length === 0) throw new Error('No chapters to download');

            const [mangaResponse, allItems] = await Promise.all([
                mangaResponsePromise,
                buildChapterItems(chaptersToDownload),
            ]);

            if (allItems.length === 0) throw new Error('Could not fetch any image pages');

            const mangaTitle = getPreferredTitle(mangaResponse.data?.data?.attributes?.title);
            const zipName = `MangaDex_${sanitizeFilename(mangaTitle, 'Manga')}.zip`;

            return streamZip(res, zipName, allItems, async () => ({ Referer: MANGADEX_REFERER }), MAX_CONCURRENCY_DOWNLOAD);
        }

        // --- Pixiv Artwork ---
        if (String(url).includes('pixiv.net') && String(url).includes('artworks')) {
            const artworkMatch = String(url).match(/artworks\/(\d+)/i);
            if (!artworkMatch) throw new Error('Artwork ID not found');

            const artworkId = artworkMatch[1];
            const headers = { Referer: PIXIV_REFERER };
            const response = await requestGet(`https://www.pixiv.net/ajax/illust/${artworkId}/pages?lang=en`, { headers });

            if (response.data?.error) throw new Error(response.data.message || 'Pixiv API error');

            const items = (response.data?.body || []).map((page, index) => {
                const imageUrl = page.urls?.regular;
                const extension = imageUrl ? imageUrl.split('.').pop() : 'jpg';
                return { url: imageUrl, name: `${String(index + 1).padStart(3, '0')}.${extension}` };
            }).filter(item => item.url);

            if (items.length === 0) throw new Error('No images to download');

            return streamZip(res, `PixivArt_${artworkId}.zip`, items, async () => headers);
        }

        // --- Pixiv Series ---
        if (String(url).includes('pixiv.net') && String(url).includes('series')) {
            const seriesMatch = String(url).match(/series\/(\d+)/i);
            if (!seriesMatch) throw new Error('Series ID not found');

            const seriesId = seriesMatch[1];
            const headers = { Referer: PIXIV_REFERER };
            const response = await requestGet(`https://www.pixiv.net/ajax/series/${seriesId}?lang=en`, { headers });

            if (response.data?.error) throw new Error(response.data.message || 'Pixiv Series API error');

            const pageData = response.data?.body?.page;
            if (!pageData || !pageData.seriesContents) throw new Error('Could not read series content');

            const artworkIds = pageData.seriesContents.map(item => item.id).filter(Boolean);
            if (artworkIds.length === 0) throw new Error('Series has no chapters');

            const limitedIds = artworkIds.slice(-50);
            const allItems = [];
            let chapIndex = 1;

            await mapWithConcurrency(limitedIds, 6, async (artId) => {
                try {
                    const pagesRes = await requestGet(`https://www.pixiv.net/ajax/illust/${artId}/pages?lang=en`, { headers });
                    if (!pagesRes.data?.error && pagesRes.data?.body) {
                        pagesRes.data.body.forEach((page, idx) => {
                            const imageUrl = page.urls?.regular || page.urls?.original;
                            if (imageUrl) {
                                const extension = imageUrl.split('.').pop() || 'jpg';
                                allItems.push({
                                    url: imageUrl,
                                    name: `Chap_${String(chapIndex).padStart(2, '0')}/${String(idx + 1).padStart(3, '0')}.${extension}`,
                                });
                            }
                        });
                        chapIndex++;
                    }
                } catch (e) {
                    console.error(`Pixiv Series: Failed to fetch pages for artwork ${artId}:`, e.message);
                }
            });

            if (allItems.length === 0) throw new Error('Could not fetch any images from series');

            return streamZip(res, `PixivSeries_${seriesId}.zip`, allItems, async () => headers);
        }

        // --- Pixiv User ---
        if (String(url).includes('pixiv.net') && String(url).includes('users')) {
            const userMatch = String(url).match(/users\/(\d+)/i);
            if (!userMatch) throw new Error('User ID not found');

            const userId = userMatch[1];
            const headers = { Referer: PIXIV_REFERER };
            const response = await requestGet(`https://www.pixiv.net/ajax/user/${userId}/profile/all?lang=en`, { headers });

            if (response.data?.error) throw new Error(response.data.message || 'Pixiv API error');

            const illusts = response.data?.body?.illusts || {};
            const manga = response.data?.body?.manga || {};
            const artworkIds = [...Object.keys(illusts), ...Object.keys(manga)].sort((a, b) => b - a);

            if (artworkIds.length === 0) throw new Error('User has no artworks');

            const limitedIds = artworkIds.slice(0, 50);
            const allItems = [];

            await mapWithConcurrency(limitedIds, 6, async (artId) => {
                try {
                    const pagesRes = await requestGet(`https://www.pixiv.net/ajax/illust/${artId}/pages?lang=en`, { headers });
                    if (!pagesRes.data?.error && pagesRes.data?.body) {
                        pagesRes.data.body.forEach((page, idx) => {
                            const imageUrl = page.urls?.regular || page.urls?.original;
                            if (imageUrl) {
                                const extension = imageUrl.split('.').pop() || 'jpg';
                                allItems.push({ url: imageUrl, name: `${artId}_p${idx}.${extension}` });
                            }
                        });
                    }
                } catch (e) {
                    console.error(`Pixiv User: Failed to fetch pages for artwork ${artId}:`, e.message);
                }
            });

            if (allItems.length === 0) throw new Error('Could not fetch any images from user profile');

            return streamZip(res, `PixivUser_${userId}.zip`, allItems, async () => headers);
        }

        return jsonError(res, 400, 'URL not supported');
    } catch (error) {
        if (!res.headersSent) return sendRouteError(res, error);
        return res.end();
    }
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        name: 'mangadex-proxy',
        version: '2.5.0',
        apiOnly: true,
        endpoints: [
            'GET /',
            'GET /api/health',
            'GET /api/search?q=...',
            'GET /api/search/suggest?q=...',
            'GET /api/manga/:id',
            'GET /api/cover?url=...|mangaId=...',
            'GET /api/chapter/:id',
            'GET /api/chapters?url=...',
            'GET /api/proxy?url=...',
            'GET /api/download?url=...',
            'GET /api/download?url=...&chapters=id1,id2',
            'POST /api/cache/clear',
        ],
        cacheStatus: `cacheSize=${memoryCache.size}, hits=${serverStats.cacheHits}, misses=${serverStats.cacheMisses}`,
        uptime: Math.floor((Date.now() - serverStats.startTime) / 1000),
    });
});

// 404 handler
app.use((req, res) => jsonError(res, 404, 'Route not found', { apiOnly: true }));

// Server start
if (require.main === module) {
    const port = Number(process.env.PORT) || 3000;
    const server = app.listen(port, () => {
        console.log(`API server v2.5.0 listening on port ${port}`);
    });

    // Graceful shutdown
    const shutdown = () => {
        console.log('Shutting down gracefully...');
        cacheClear();
        server.close(() => {
            console.log('Server closed');
            process.exit(0);
        });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

module.exports = app;
