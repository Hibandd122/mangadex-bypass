// ============================================
// HƯỚNG DẪN CÀI ĐẶT TRÊN HOST MỚI (NODE.JS)
// ============================================
// 1. Tạo thư mục mới trên host và chạy: npm init -y
// 2. Cài việ thư viện: npm install express cors axios https-proxy-agent
// 3. Chạy server bằng lệnh: node index.js
// ============================================

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');
const stream = require('stream');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());

// ---------------------------------------------------------
// HÀM DNS-OVER-HTTPS (Vượt tường lửa chặn Port 53)
// ---------------------------------------------------------
async function getRealIP(hostname) {
    try {
        // Gọi Cloudflare qua HTTPs port 443 -> host không thể chặn!
        const res = await axios.get(`https://cloudflare-dns.com/dns-query?name=${hostname}&type=A`, {
            headers: { 'accept': 'application/dns-json' },
            timeout: 5000
        });
        const answers = res.data.Answer;
        if (answers && answers.length > 0) {
            // Trả về IP thật của MangaDex
            return answers[0].data;
        }
        throw new Error("Không tìm thấy DNS record");
    } catch (e) {
        console.error("Lỗi phân giải DoH:", e.message);
        return null;
    }
}

// ---------------------------------------------------------
// API PROXY MANGADEX: Xử lý Tải Ảnh & Streaming Xuyên Proxy
// ---------------------------------------------------------
app.get('/api/mangadex/image', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "Missing 'url' parameter" });

    try {
        // Phân tích tên miền gốc
        const urlObj = new URL(url);
        const originalHost = urlObj.hostname; // vd: cmdxd98sb0x3yprd.mangadex.network
        
        // Vượt Tường Lửa DNS
        const realIP = await getRealIP(originalHost);
        if (!realIP) {
            return res.status(502).json({ error: "DNS over HTTPS Resolution Failed" });
        }

        console.log(`[DOWNLOAD] Nhận yêu cầu: ${originalHost}`);
        console.log(`[BYPASS] DNS Phân giải ảo sang IP: ${realIP}`);

        // Dùng custom https.Agent để ghi đè IP nhưng vẫn giữ nguyên URL giúp SNI của Cloudflare không bị vỡ
        const customAgent = new https.Agent({
            lookup: (hostname, options, callback) => {
                if (hostname === originalHost) {
                    if (options && options.all) {
                        return callback(null, [{ address: realIP, family: 4 }]);
                    }
                    return callback(null, realIP, 4);
                } else {
                    require('dns').lookup(hostname, options, callback);
                }
            }
        });

        // Chọn request không proxy, trực tiếp qua server đã bypass DNS
        const axiosConfig = {
            method: 'get',
            url: url, // GIAO DIỆN URL GIỮ NGUYÊN (Không đổi IP)
            responseType: 'stream',
            httpsAgent: customAgent,
            headers: {
                'Host': originalHost,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
                'Referer': 'https://mangadex.org/',
                'Origin': 'https://mangadex.org'
            },
            timeout: 15000,
        };

        const response = await axios(axiosConfig);

        // Đổ Header gốc từ MangaDex ngược lại Client (VD: Content-Type: image/jpeg)
        res.set({
            'Content-Type': response.headers['content-type'],
            'Content-Length': response.headers['content-length'],
            'Cache-Control': 'public, max-age=31536000'
        });

        // Pipe (Dẫn ống) Stream nguyên cặn bắn thẳng về cho Python Server / Trình duyệt nhận
        response.data.pipe(res);

    } catch (error) {
        console.error("Proxy Error:", error.message);
        const status = error.response ? error.response.status : 500;
        return res.status(status).json({ 
            error: "Fetch Failed", 
            details: error.message 
        });
    }
});

// Trang chính test
app.get('/', (req, res) => {
    res.send('<h1 style="color:cyan; background:#111; padding:20px; font-family:monospace;">MANGADEX BYPASS PROXY ROOT (NODE.JS) 🟢 ONLINE TRÊN VERCEL</h1>');
});

// Xuất app ra module cho Vercel chạy (Serverless Function)
module.exports = app;

// Nếu chạy thủ công trên máy bằng lệnh `node ...`
if (require.main === module) {
    app.listen(port, () => {
        console.log(`===============================================`);
        console.log(`🚀 MangaDex Bypass Proxy (NodeJS) is running!`);
        console.log(`👉 Link API Test: http://localhost:${port}/api/mangadex/image?url=YOUR_MANGADEX_URL_IMG`);
        console.log(`===============================================`);
    });
}

