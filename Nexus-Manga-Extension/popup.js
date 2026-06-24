// popup.js
const BACKEND_URL = "https://mahirun.hicanh69.workers.dev";

const setStatus = (msg, state = 'active') => {
    document.getElementById('status').innerText = msg;
    const dot = document.getElementById('status-dot');
    dot.className = 'status-dot';
    if (state !== 'idle') dot.classList.add(state);
};

document.getElementById('translate-btn').addEventListener('click', async () => {
    const url = document.getElementById('url-input').value;
    if (url) {
        try {
            setStatus("Fetching URL...", 'active');
            const res = await fetch(url);
            const blob = await res.blob();
            translateBlob(blob);
        } catch(e) {
            setStatus("Failed to fetch URL", 'error');
        }
    }
});

document.addEventListener('paste', (e) => {
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
            const blob = items[i].getAsFile();
            translateBlob(blob);
            break;
        }
    }
});

const dropZone = document.getElementById('drop-zone');
dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
        translateBlob(e.dataTransfer.files[0]);
    }
});

async function translateBlob(blob) {
    setStatus("Uploading payload...", 'active');
    document.getElementById('result-img').style.display = 'none';
    
    const formData = new FormData();
    formData.append("image", blob, "image.jpg");
    formData.append("prompt_mode", "none");
    
    try {
        const res = await fetch(`${BACKEND_URL}/photo-translate`, { method: 'POST', body: formData });
        const data = await res.json();
        
        if (data.success && data.task_id) {
            setStatus("Engine running...", 'active');
            const source = new EventSource(`${BACKEND_URL}/photo-translate-status/${data.task_id}`);
            source.onmessage = function(event) {
                const sseData = JSON.parse(event.data);
                if (sseData.status === 'done' || sseData.success === false || sseData.status === 'error') {
                    source.close();
                    if (sseData.status === 'done' && sseData.image) {
                        setStatus("Completed", 'idle');
                        document.getElementById('result-img').src = sseData.image;
                        document.getElementById('result-img').style.display = 'block';
                    } else {
                        setStatus("Translation failed", 'error');
                    }
                }
            };
        } else {
            setStatus("API upload failed", 'error');
        }
    } catch(e) {
        setStatus("Backend offline", 'error');
    }
}

document.getElementById('clear-cache-btn').addEventListener('click', () => {
    setStatus("Đang xóa Cache...", 'active');
    try {
        const req = indexedDB.deleteDatabase("NexusMangaDB");
        req.onsuccess = () => {
            setStatus("Đã xóa toàn bộ DB Cache!", 'idle');
            setTimeout(() => setStatus("Standby Mode", 'idle'), 2000);
        };
        req.onerror = () => setStatus("Lỗi xóa Cache", 'error');
    } catch(e) {
        setStatus("Lỗi xóa Cache", 'error');
    }
});

// Config loader
chrome.storage.local.get(['promptMode'], function(result) {
    if (result.promptMode) {
        document.getElementById('prompt-mode').value = result.promptMode;
    }
});
document.getElementById('prompt-mode').addEventListener('change', (e) => {
    chrome.storage.local.set({ promptMode: e.target.value });
});
