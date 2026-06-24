const http = require('http');
const https = require('https');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const archiver = require('archiver');

const app = express();

app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const MANGADEX_REFERER = 'https://mangadex.org/';
const PIXIV_REFERER = 'https://www.pixiv.net/';

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
    const rateLimitError = new Error('Upstream bi gioi han toc do (429)');

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

async function mapWithConcurrency(items, concurrency, mapper) {
    if (!items.length) {
        return [];
    }

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
    return requestGet(url, {
        headers,
        responseType: 'stream',
    });
}

async function fetchManga(titleOrChapterPath) {
    try {
        if (titleOrChapterPath.includes('/manga/')) {
            const baseUrl = titleOrChapterPath.split('?')[0];
            return await requestGet(baseUrl, {
                params: {
                    'includes[]': ['artist', 'author', 'cover_art']
                }
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

async function requestWithRetry(config, options = {}) {
    const { retries = 2, baseDelayMs = 1200 } = options;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            return await httpClient.request(config);
        } catch (error) {
            if (!isRateLimitError(error)) {
                throw error;
            }

            if (attempt === retries) {
                throw createRateLimitError(error);
            }

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
    return requestWithRetry(
        {
            method: 'get',
            url,
            ...config,
        },
        options
    );
}

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

    if (total <= limit) {
        return firstBatch;
    }

    const offsets = [];
    for (let offset = limit; offset < total; offset += limit) {
        offsets.push(offset);
    }

    const remainingPages = await mapWithConcurrency(offsets, 4, async (offset) => {
        const response = await requestGet(`https://api.mangadex.org/manga/${mangaId}/feed`, {
            params: {
                ...baseConfig.params,
                offset,
            },
        });
        return response.data?.data || [];
    });

    return [firstBatch, ...remainingPages].flat();
}

async function buildChapterItems(chapters, concurrency = 6) {
    const chapterEntries = await mapWithConcurrency(chapters, concurrency, async (chapter, index) => {
        const chapterId = chapter.id;
        const chapterNumber =
            chapter.attributes?.chapter ||
            chapter.chapterLabel ||
            `part_${String(index + 1).padStart(3, '0')}`;

        try {
            const atHome = await requestGet(`https://api.mangadex.org/at-home/server/${chapterId}`, {
                headers: {
                    Referer: MANGADEX_REFERER,
                },
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
            if (error?.status === 429) {
                throw error;
            }

            console.error(`Failed to fetch chapter ${chapterId}:`, error.message);
            return [];
        }
    });

    return chapterEntries.flat();
}

async function streamZip(res, filename, items, getHeaders, concurrency = 6) {
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
        if (!res.writableEnded) {
            archive.abort();
        }
    });

    archive.pipe(res);

    await mapWithConcurrency(items, concurrency, async (item) => {
        try {
            const headers = await getHeaders(item.url, item);
            const response = await fetchStream(item.url, headers);
            archive.append(response.data, { name: item.name });
            
            // Release memory immediately after stream ends to assist Garbage Collection
            response.data.on('end', () => {
                if (response.data.destroy) response.data.destroy();
            });
        } catch (error) {
            if (error?.status === 429) {
                archive.append(
                    Buffer.from(
                        `RATE LIMITED\nRetry after: ${error.retryAfterSeconds || 1}s\nURL: ${item.url}`
                    ),
                    {
                        name: `_RATE_LIMIT_${sanitizeFilename(item.name, 'file.txt')}.txt`,
                    }
                );
                return;
            }

            archive.append(Buffer.from(`ERROR: ${error.message}\nURL: ${item.url}`), {
                name: `_ERROR_${sanitizeFilename(item.name, 'file.txt')}`,
            });
        }
    });

    await archive.finalize();
    
    // Explicit GC signal if exposed
    if (global.gc) {
        setTimeout(() => global.gc(), 1000);
    }
}

app.get('/', (req, res) => {
    res.json({
        name: 'mangadex-proxy',
        apiOnly: true,
        endpoints: [
            'GET /api/proxy?url=...',
            'GET /api/chapters?url=...',
            'GET /api/download?url=...',
            'GET /api/download?url=...&chapters=id1,id2',
        ],
    });
});

app.get('/api/proxy', async (req, res) => {
    const { url } = req.query;
    if (!url) {
        return jsonError(res, 400, 'Missing url');
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

app.get('/api/chapters', async (req, res) => {
    const { url } = req.query;
    if (!url) {
        return jsonError(res, 400, 'Missing url');
    }

    const mangaId = getMangaDexTitleId(url);
    if (!mangaId) {
        return jsonError(res, 400, 'URL khong phai MangaDex title');
    }

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
                group:
                    chapter.relationships?.find((relationship) => relationship.type === 'scanlation_group')
                        ?.attributes?.name || 'Unknown',
            })),
        });
    } catch (error) {
        return sendRouteError(res, error);
    }
});

app.get('/api/download', async (req, res) => {
    const { url, chapters } = req.query;
    if (!url) {
        return jsonError(res, 400, 'Missing url');
    }

    try {
        if (String(url).includes('/chapter/')) {
            const chapterId = getMangaDexChapterId(url);
            if (!chapterId) {
                throw new Error('Khong tim thay Chapter ID');
            }

            let atHome;
            try {
                atHome = await requestGet(`https://api.mangadex.org/at-home/server/${chapterId}`, {
                    headers: { Referer: MANGADEX_REFERER },
                });
            } catch (err) {
                if (err.response?.status === 400 || err.response?.status === 404) {
                    throw new Error(`Chap ${chapterId} là External Link, bi khoa, hoac khong co du lieu tren MangaDex.`);
                }
                throw err;
            }

            const chapterData = atHome.data?.chapter;
            const baseUrl = atHome.data?.baseUrl;
            if (!baseUrl || !chapterData?.hash || !Array.isArray(chapterData.data) || chapterData.data.length === 0) {
                throw new Error('Khong lay duoc du lieu chapter');
            }

            const items = chapterData.data.map((file, index) => ({
                url: `${baseUrl}/data/${chapterData.hash}/${file}`,
                name: `${String(index + 1).padStart(3, '0')}.jpg`,
            }));

            return streamZip(
                res,
                `MangaDex_Chapter_${chapterId}.zip`,
                items,
                async () => ({ Referer: MANGADEX_REFERER }),
                6
            );
        }

        if (String(url).includes('/title/')) {
            const mangaId = getMangaDexTitleId(url);
            if (!mangaId) {
                throw new Error('Khong tim thay Title ID');
            }

            const mangaResponsePromise = fetchManga(`https://api.mangadex.org/manga/${mangaId}`);

            let chaptersToDownload;
            if (chapters) {
                const chapterIds = String(chapters)
                    .split(',')
                    .map((chapterId) => chapterId.trim())
                    .filter(Boolean);

                chaptersToDownload = await mapWithConcurrency(chapterIds, 6, async (chapterId, index) => {
                    try {
                        const response = await requestGet(`https://api.mangadex.org/chapter/${chapterId}`);
                        return response.data?.data || {
                            id: chapterId,
                            chapterLabel: `part_${String(index + 1).padStart(3, '0')}`,
                        };
                    } catch (error) {
                        if (error?.status === 429) {
                            throw error;
                        }

                        console.error(`Failed to fetch chapter ${chapterId}:`, error.message);
                        return null;
                    }
                });

                chaptersToDownload = chaptersToDownload.filter(Boolean);
            } else {
                chaptersToDownload = await fetchAllMangaFeedChapters(mangaId);
            }

            if (chaptersToDownload.length === 0) {
                throw new Error('Khong co chapter nao de tai');
            }

            const [mangaResponse, allItems] = await Promise.all([
                mangaResponsePromise,
                buildChapterItems(chaptersToDownload, 6),
            ]);

            if (allItems.length === 0) {
                throw new Error('Khong the lay duoc trang anh nao');
            }

            const mangaTitle = getPreferredTitle(mangaResponse.data?.data?.attributes?.title);
            const zipName = `MangaDex_${sanitizeFilename(mangaTitle, 'Manga')}.zip`;

            return streamZip(
                res,
                zipName,
                allItems,
                async () => ({ Referer: MANGADEX_REFERER }),
                8
            );
        }

        if (String(url).includes('pixiv.net') && String(url).includes('artworks')) {
            const artworkMatch = String(url).match(/artworks\/(\d+)/i);
            if (!artworkMatch) {
                throw new Error('Khong tim thay Artwork ID');
            }

            const artworkId = artworkMatch[1];
            const headers = { Referer: PIXIV_REFERER };
            const response = await requestGet(`https://www.pixiv.net/ajax/illust/${artworkId}/pages?lang=en`, {
                headers,
            });

            if (response.data?.error) {
                throw new Error(response.data.message || 'Pixiv API error');
            }

            const items = (response.data?.body || []).map((page, index) => {
                const imageUrl = page.urls?.regular;
                const extension = imageUrl ? imageUrl.split('.').pop() : 'jpg';
                return {
                    url: imageUrl,
                    name: `${String(index + 1).padStart(3, '0')}.${extension}`,
                };
            }).filter((item) => item.url);

            if (items.length === 0) {
                throw new Error('Khong co anh nao de tai');
            }

            return streamZip(
                res,
                `PixivArt_${artworkId}.zip`,
                items,
                async () => headers,
                6
            );
        }

        if (String(url).includes('pixiv.net') && String(url).includes('series')) {
            const seriesMatch = String(url).match(/series\/(\d+)/i);
            if (!seriesMatch) {
                throw new Error('Khong tim thay Series ID');
            }

            const seriesId = seriesMatch[1];
            const headers = { Referer: PIXIV_REFERER };

            // Gọi API lấy thông tin các chapter trong series
            const response = await requestGet(`https://www.pixiv.net/ajax/series/${seriesId}?lang=en`, { headers });
            
            if (response.data?.error) {
                throw new Error(response.data.message || 'Pixiv Series API error');
            }

            const pageData = response.data?.body?.page;
            if (!pageData || !pageData.seriesContents) {
                throw new Error('Khong the doc duoc noi dung Series (Co the API bi doi hoac Series bi xoa)');
            }

            // seriesContents chứa danh sách các illust trong series
            const artworkIds = pageData.seriesContents.map(item => item.id).filter(Boolean);

            if (artworkIds.length === 0) {
                throw new Error('Series nay chua co chapter nao hoac khong the doc duoc ID');
            }

            // Giới hạn 50 chap mới nhất để tránh timeout
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
                                // Đặt tên file theo định dạng: Chap_xx_Page_yy.jpg
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

            if (allItems.length === 0) {
                throw new Error('Khong the lay duoc anh nao tu Series');
            }

            return streamZip(
                res,
                `PixivSeries_${seriesId}.zip`,
                allItems,
                async () => headers,
                6
            );
        }

        if (String(url).includes('pixiv.net') && String(url).includes('users')) {
            const userMatch = String(url).match(/users\/(\d+)/i);
            if (!userMatch) {
                throw new Error('Khong tim thay User ID');
            }

            const userId = userMatch[1];
            const headers = { Referer: PIXIV_REFERER };
            
            // Lấy danh sách toàn bộ ID artwork của user
            const response = await requestGet(`https://www.pixiv.net/ajax/user/${userId}/profile/all?lang=en`, {
                headers,
            });

            if (response.data?.error) {
                throw new Error(response.data.message || 'Pixiv API error');
            }

            const illusts = response.data?.body?.illusts || {};
            const manga = response.data?.body?.manga || {};
            const artworkIds = [...Object.keys(illusts), ...Object.keys(manga)].sort((a, b) => b - a);

            if (artworkIds.length === 0) {
                throw new Error('User khong co artwork hoac manga nao');
            }

            // Để tránh timeout Vercel (10s limit), ta giới hạn lấy 50 post mới nhất của User
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
                                allItems.push({
                                    url: imageUrl,
                                    name: `${artId}_p${idx}.${extension}`,
                                });
                            }
                        });
                    }
                } catch (e) {
                    console.error(`Pixiv User: Failed to fetch pages for artwork ${artId}:`, e.message);
                }
            });

            if (allItems.length === 0) {
                throw new Error('Khong the lay duoc anh nao tu profile cua user');
            }

            return streamZip(
                res,
                `PixivUser_${userId}.zip`,
                allItems,
                async () => headers,
                6
            );
        }

        return jsonError(res, 400, 'URL khong duoc ho tro');
    } catch (error) {
        if (!res.headersSent) {
            return sendRouteError(res, error);
        }

        return res.end();
    }
});

app.use((req, res) => jsonError(res, 404, 'Route not found', { apiOnly: true }));

if (require.main === module) {
    const port = Number(process.env.PORT) || 3000;
    app.listen(port, () => {
        console.log(`API server listening on port ${port}`);
    });
}

module.exports = app;
