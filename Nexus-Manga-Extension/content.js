// content.js
const BACKEND_URL = "https://mahirun.hicanh69.workers.dev";
let pageState = 'IDLE'; // IDLE, VI, EN

// --- IndexedDB Caching ---
const DB_NAME = "NexusMangaDB";
const STORE_NAME = "TranslatedCache";

function initDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: "url" });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function saveToCache(url, b64Data) {
    try {
        const db = await initDB();
        return new Promise(resolve => {
            const tx = db.transaction(STORE_NAME, "readwrite");
            tx.objectStore(STORE_NAME).put({ url: url, image: b64Data, timestamp: Date.now() });
            tx.oncomplete = () => resolve();
        });
    } catch(e) {}
}

async function getFromCache(url) {
    try {
        const db = await initDB();
        return new Promise(resolve => {
            const tx = db.transaction(STORE_NAME, "readonly");
            const req = tx.objectStore(STORE_NAME).get(url);
            req.onsuccess = () => resolve(req.result ? req.result.image : null);
            req.onerror = () => resolve(null);
        });
    } catch(e) { return null; }
}

// Hàng đợi chống spam quá tải (Concurrency limit = 3)
class TranslateQueue {
    constructor(concurrency) {
        this.concurrency = concurrency;
        this.active = 0;
        this.queue = [];
    }

    add(task) {
        this.queue.push(task);
        this.next();
    }

    next() {
        if (this.active >= this.concurrency || this.queue.length === 0) return;
        this.active++;
        const task = this.queue.shift();
        task().finally(() => {
            this.active--;
            this.next();
        });
    }
}
const queue = new TranslateQueue(5);

let totalImgs = 0;
let translatedImgs = 0;

function updateProgressHUD() {
    let hud = document.getElementById('nexus-progress-hud');
    if (!hud) {
        hud = document.createElement('div');
        hud.id = 'nexus-progress-hud';
        Object.assign(hud.style, {
            position: 'fixed', top: '20px', left: '20px', zIndex: '999999',
            padding: '8px 15px', backgroundColor: 'rgba(10, 12, 16, 0.85)',
            color: '#00e5ff', border: '1px solid #00e5ff', borderRadius: '8px',
            fontFamily: '"JetBrains Mono", monospace', fontSize: '12px', fontWeight: 'bold',
            backdropFilter: 'blur(10px)', boxShadow: '0 0 15px rgba(0, 229, 255, 0.2)',
            transition: 'all 0.3s'
        });
        document.body.appendChild(hud);
    }
    if (pageState === 'VI') {
        hud.style.display = 'block';
        hud.innerText = `⚡ NEXUS ENGINE: ${translatedImgs} / ${totalImgs} ẢNH`;
        if (translatedImgs === totalImgs && totalImgs > 0) {
            hud.style.borderColor = '#10b981';
            hud.style.color = '#10b981';
            hud.style.boxShadow = '0 0 15px rgba(16, 185, 129, 0.2)';
            hud.innerText = `⚡ NEXUS ENGINE: HOÀN TẤT (${totalImgs}/${totalImgs})`;
        } else {
            hud.style.borderColor = '#00e5ff';
            hud.style.color = '#00e5ff';
            hud.style.boxShadow = '0 0 15px rgba(0, 229, 255, 0.2)';
        }
    } else {
        hud.style.display = 'none';
    }
}

async function translateImage(imgElement, retryCount = 0) {
    const originalUrl = imgElement.dataset.originalUrl;
    if (!originalUrl) return;
    if (imgElement.dataset.queued === "true") return;

    // Check DB cache first
    const cached = await getFromCache(originalUrl);
    if (cached) {
        imgElement.dataset.translatedUrl = cached;
        imgElement.dataset.translated = "true";
        if (pageState === 'VI') {
            imgElement.src = cached;
            imgElement.style.opacity = "1";
            imgElement.style.filter = "none";
            imgElement.style.border = "none";
            imgElement.style.boxShadow = "none";
        }
        return;
    }

    imgElement.dataset.queued = "true";
    
    if (pageState === 'VI') {
        imgElement.style.transition = "opacity 0.3s";
        imgElement.style.opacity = "0.4";
        imgElement.style.filter = "grayscale(100%) blur(2px)";
    }
    
    queue.add(async () => {
        try {
            const res = await fetch(originalUrl);
            const blob = await res.blob();
            
            const storage = await chrome.storage.local.get(['promptMode']);
            const promptMode = storage.promptMode || "none";

            const formData = new FormData();
            formData.append("image", blob, "manga_page.jpg");
            formData.append("prompt_mode", promptMode);
            
            const uploadRes = await fetch(`${BACKEND_URL}/photo-translate`, {
                method: 'POST',
                body: formData
            });
            const uploadData = await uploadRes.json();
            
            if (uploadData.success && uploadData.task_id) {
                await new Promise((resolve, reject) => {
                    const source = new EventSource(`${BACKEND_URL}/photo-translate-status/${uploadData.task_id}`);
                    
                    // Timeout 120s để chống treo socket (Server dịch lâu quá hoặc rớt mạng)
                    const timeoutTimer = setTimeout(() => {
                        source.close();
                        reject(new Error("SSE Timeout - Pipeline hung"));
                    }, 120000);

                    source.onmessage = async function(event) {
                        try {
                            const data = JSON.parse(event.data);
                            if (data.status === 'done' || data.success === false || data.status === 'error') {
                                clearTimeout(timeoutTimer);
                                source.close();
                                // Validate payload: Bắt buộc phải có image và độ dài b64 > 1000 char (tránh ảnh rỗng/lỗi)
                                if (data.status === 'done' && data.image && data.image.length > 1000) {
                                    imgElement.dataset.translatedUrl = data.image;
                                    imgElement.dataset.translated = "true";
                                    await saveToCache(originalUrl, data.image);

                                    if (pageState === 'VI') {
                                        imgElement.src = data.image;
                                        imgElement.style.opacity = "1";
                                        imgElement.style.filter = "none";
                                        imgElement.style.border = "none";
                                        imgElement.style.boxShadow = "none";
                                    }
                                    
                                    translatedImgs = Array.from(document.querySelectorAll('img')).filter(i => i.dataset.translated === "true").length;
                                    updateProgressHUD();
                                    
                                    resolve();
                                } else {
                                    reject(new Error("Payload broken or translation failed silently"));
                                }
                            }
                        } catch(parseErr) {
                            // Ignored: JSON chunk có thể bị chia nhỏ
                        }
                    };

                    source.onerror = () => {
                        clearTimeout(timeoutTimer);
                        source.close();
                        reject(new Error("SSE Connection Dropped"));
                    };
                });
            } else {
                throw new Error("Upload Failed");
            }
        } catch (e) {
            // Auto Retry Logic (Tối đa 3 lần)
            if (retryCount < 3) {
                imgElement.dataset.queued = ""; // Xóa cờ để chạy lại
                setTimeout(() => {
                    if (pageState === 'VI') translateImage(imgElement, retryCount + 1);
                }, 2000); // Đợi 2s rồi thử lại
            } else {
                // Hết cứu
                imgElement.style.opacity = "1";
                imgElement.style.filter = "none";
                imgElement.dataset.translated = "error";
                if (pageState === 'VI') {
                    imgElement.style.border = "2px solid #f43f5e"; // Viền đỏ báo lỗi
                    imgElement.style.boxShadow = "0 0 15px rgba(244, 63, 94, 0.5)";
                }
            }
        }
    });
}

function processImages() {
    // Thu thập tất cả ảnh hợp lệ trong DOM để đánh index
    const allMangaImgs = Array.from(document.querySelectorAll('img')).filter(img => {
        if (!img.src) return false;
        const isMangaDexUpload = img.src.includes('uploads.mangadex.org/data') || img.src.includes('mangadex.org');
        const isDataUrl = img.src.startsWith('blob:');
        return (isMangaDexUpload || isDataUrl) && img.width >= 150 && img.height >= 200;
    });

    allMangaImgs.forEach((img, index) => {
        if (!img.dataset.originalUrl) {
            img.dataset.originalUrl = img.src;
        }

        // Ưu tiên nạp từ ZIP Cache nếu có (từ luồng Batch)
        if (window.nexusZipCache && window.nexusZipCache[index] && pageState === 'VI') {
            const b64 = window.nexusZipCache[index];
            img.dataset.translatedUrl = b64;
            img.dataset.translated = "true";
            if (img.src !== b64) {
                img.src = b64;
                saveToCache(img.dataset.originalUrl, b64); // Lưu DB luôn
            }
            return;
        }

        if (!img.dataset.translated && !img.dataset.queued && pageState === 'VI') {
            translateImage(img);
        } else if (img.dataset.translated === "true") {
            if (pageState === 'VI' && img.src !== img.dataset.translatedUrl) {
                img.src = img.dataset.translatedUrl;
                img.style.border = "none";
                img.style.boxShadow = "none";
            } else if ((pageState === 'EN' || pageState === 'IDLE') && img.src !== img.dataset.originalUrl) {
                img.src = img.dataset.originalUrl;
                img.style.border = "none";
                img.style.boxShadow = "none";
            }
        } else if (img.dataset.translated === "error" && pageState === 'EN') {
            // Clear error UI when toggling back to EN
            img.style.border = "none";
            img.style.boxShadow = "none";
        }
    });

    totalImgs = allMangaImgs.length;
    translatedImgs = allMangaImgs.filter(i => i.dataset.translated === "true").length;
    updateProgressHUD();
}

function isReaderPage() {
    const p = window.location.pathname.toLowerCase();
    if (p.includes('chapter') || p.includes('chap') || p.includes('manga') || p.includes('read') || p.includes('comic')) return true;
    let count = 0;
    document.querySelectorAll('img').forEach(i => { if (i.width > 300 && i.height > 400) count++; });
    return count >= 1;
}

function injectTranslateButton() {
    if (document.getElementById('nexus-btn-container')) return;
    if (!isReaderPage()) return;

    const container = document.createElement('div');
    container.id = 'nexus-btn-container';
    Object.assign(container.style, {
        position: 'fixed', bottom: '20px', right: '20px', zIndex: '999999',
        display: 'flex', flexDirection: 'column', gap: '10px'
    });

    const styleTemplate = {
        padding: '12px 20px', backgroundColor: 'rgba(10, 12, 16, 0.85)',
        color: '#00e5ff', border: '1px solid #00e5ff', borderRadius: '8px',
        fontFamily: '"JetBrains Mono", monospace', fontWeight: 'bold', fontSize: '13px',
        cursor: 'pointer', backdropFilter: 'blur(10px)',
        boxShadow: '0 0 15px rgba(0, 229, 255, 0.2)', transition: 'all 0.3s'
    };

    const btnOverlay = document.createElement('button');
    btnOverlay.id = 'nexus-translate-btn';
    btnOverlay.innerText = '⬡ Dịch Màn Hình (VI)';
    Object.assign(btnOverlay.style, styleTemplate);
    btnOverlay.style.boxShadow = '0 0 20px rgba(0, 229, 255, 0.4)';
    btnOverlay.style.padding = '14px 24px';
    btnOverlay.style.fontSize = '14px';

    btnOverlay.onmouseover = () => btnOverlay.style.boxShadow = '0 0 30px rgba(0, 229, 255, 0.8)';
    btnOverlay.onmouseout = () => btnOverlay.style.boxShadow = '0 0 20px rgba(0, 229, 255, 0.4)';

    btnOverlay.onclick = () => {
        if (pageState === 'IDLE' || pageState === 'EN') {
            pageState = 'VI';
            btnOverlay.innerText = '⬡ Bản Gốc (EN)';
            btnOverlay.style.backgroundColor = '#00e5ff';
            btnOverlay.style.color = '#000';
            processImages();
        } else if (pageState === 'VI') {
            pageState = 'EN';
            btnOverlay.innerText = '⬡ Dịch Màn Hình (VI)';
            btnOverlay.style.backgroundColor = 'rgba(10, 12, 16, 0.85)';
            btnOverlay.style.color = '#00e5ff';
            processImages();
        }
    };

    container.appendChild(btnOverlay);
    document.body.appendChild(container);
}

const observer = new MutationObserver(() => {
    if (isReaderPage()) {
        injectTranslateButton();
        processImages(); // Will handle newly loaded images based on pageState
    } else {
        pageState = 'IDLE';
        const cont = document.getElementById('nexus-btn-container');
        if (cont) cont.remove();
    }
});

observer.observe(document.body, { childList: true, subtree: true });

if (isReaderPage()) injectTranslateButton();

// Context Menu listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "translate_single") {
        const url = request.srcUrl;
        document.querySelectorAll('img').forEach(img => {
            if (img.src === url || img.dataset.originalUrl === url) {
                if (!img.dataset.originalUrl) img.dataset.originalUrl = img.src;
                if (pageState === 'IDLE') {
                    pageState = 'VI';
                    const btn = document.getElementById('nexus-translate-btn');
                    if(btn) {
                        btn.innerText = '⬡ Bản Gốc (EN)';
                        btn.style.backgroundColor = '#00e5ff';
                        btn.style.color = '#000';
                    }
                }
                translateImage(img);
            }
        });
    }
});

// --- Keyboard Shortcuts & Features ---
document.addEventListener('keydown', (e) => {
    if (e.altKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        const btn = document.getElementById('nexus-translate-btn');
        if (btn) btn.click();
    }
});

// --- Magnifier Lens (Shift + Hover) ---
const lens = document.createElement('div');
Object.assign(lens.style, {
    position: 'absolute', border: '2px solid #00e5ff', borderRadius: '50%',
    width: '240px', height: '240px', backgroundColor: '#111', backgroundRepeat: 'no-repeat',
    pointerEvents: 'none', display: 'none', zIndex: '9999999',
    boxShadow: '0 0 30px rgba(0, 229, 255, 0.4), inset 0 0 20px rgba(0,0,0,0.8)',
    transition: 'opacity 0.2s', opacity: '0'
});
document.body.appendChild(lens);

document.addEventListener('mousemove', (e) => {
    if (!e.shiftKey) {
        if (lens.style.display !== 'none') {
            lens.style.opacity = '0';
            setTimeout(() => { if (!e.shiftKey) lens.style.display = 'none'; }, 200);
        }
        return;
    }
    const target = e.target;
    if (target.tagName === 'IMG' && target.dataset.originalUrl) {
        lens.style.display = 'block';
        lens.style.opacity = '1';
        lens.style.left = (e.pageX - 120) + 'px';
        lens.style.top = (e.pageY - 120) + 'px';
        
        // Dùng ảnh hiện tại (có thể là gốc hoặc đã dịch)
        lens.style.backgroundImage = `url("${target.src}")`;
        
        const rect = target.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        
        const rx = (x / target.width) * 100;
        const ry = (y / target.height) * 100;
        
        lens.style.backgroundPosition = `${rx}% ${ry}%`;
        // Zoom x2.5
        lens.style.backgroundSize = `${target.width * 2.5}px ${target.height * 2.5}px`;
    } else {
        lens.style.opacity = '0';
        setTimeout(() => lens.style.display = 'none', 200);
    }
});
