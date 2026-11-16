const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 🔐 المفتاح السري للدخول والـ API
const API_TOKEN = process.env.API_TOKEN || 'foryou_secret_2026';
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

let sock;
let rawQrCode = '';
let connectionStatus = 'DISCONNECTED';
let isConnecting = false;

// 📦 1. استعادة الجلسة من متغير البيئة WA_SESSION عند بدء التشغيل
function restoreSessionFromEnv() {
    const sessionEnv = process.env.WA_SESSION;
    if (!sessionEnv || sessionEnv.trim() === '') return false;

    try {
        const compressedBuffer = Buffer.from(sessionEnv.trim(), 'base64');
        const jsonString = zlib.gunzipSync(compressedBuffer).toString('utf-8');
        const filesMap = JSON.parse(jsonString);

        if (!fs.existsSync(AUTH_DIR)) {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }

        for (const [fileName, content] of Object.entries(filesMap)) {
            fs.writeFileSync(path.join(AUTH_DIR, fileName), content, 'utf-8');
        }
        console.log('✅ Session restored successfully from WA_SESSION!');
        return true;
    } catch (err) {
        console.error('❌ Failed to restore session from WA_SESSION:', err.message);
        return false;
    }
}

// 📤 2. ضغط ملفات الجلسة الحالية إلى نص Base64 لعرضه ونسخه إلى Render
function exportSessionToString() {
    try {
        if (!fs.existsSync(AUTH_DIR)) return '';
        const files = fs.readdirSync(AUTH_DIR);
        if (files.length === 0) return '';

        const filesMap = {};
        for (const file of files) {
            const fullPath = path.join(AUTH_DIR, file);
            if (fs.statSync(fullPath).isFile()) {
                // نأخذ الملفات الأساسية للجلسة (creds.json ومفاتيح التشفير الأساسية)
                if (file === 'creds.json' || file.startsWith('app-state-sync-key') || file.startsWith('session-') || file.startsWith('sender-key-')) {
                    filesMap[file] = fs.readFileSync(fullPath, 'utf-8');
                }
            }
        }

        if (!filesMap['creds.json']) return '';

        const jsonString = JSON.stringify(filesMap);
        const compressed = zlib.gzipSync(jsonString);
        return compressed.toString('base64');
    } catch (err) {
        console.error('Error exporting session:', err.message);
        return '';
    }
}

async function connectToWhatsApp() {
    if (isConnecting) return;
    isConnecting = true;

    try {
        if (!fs.existsSync(AUTH_DIR)) {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

        sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                connectionStatus = 'SCAN_QR';
                rawQrCode = qr;
                console.log('QR Code generated. Open dashboard to scan.');
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                connectionStatus = 'DISCONNECTED';
                isConnecting = false;

                console.log('Connection closed. Status:', statusCode, 'Reconnect:', shouldReconnect);

                if (shouldReconnect) {
                    setTimeout(() => connectToWhatsApp(), 3000);
                } else {
                    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    rawQrCode = '';
                    setTimeout(() => connectToWhatsApp(), 2000);
                }
            } else if (connection === 'open') {
                connectionStatus = 'CONNECTED';
                rawQrCode = '';
                isConnecting = false;
                console.log('WhatsApp Connected successfully!');
            }
        });

        sock.ev.on('creds.update', saveCreds);
    } catch (err) {
        isConnecting = false;
        connectionStatus = 'DISCONNECTED';
        console.error('WhatsApp connection error:', err);
        setTimeout(() => connectToWhatsApp(), 5000);
    }
}

// ✅ مسار UptimeRobot لإبقاء السيرفر مستيقظاً 24 ساعة
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        whatsapp: connectionStatus,
        hasEnvSession: Boolean(process.env.WA_SESSION)
    });
});

// 🛡️ لوحة التحكم وعرض QR Code ونص الجلسة
app.get('/', (req, res) => {
    const providedToken = req.query.token;

    if (!providedToken || providedToken !== API_TOKEN) {
        return res.status(401).send(`
            <body style="text-align: center; margin-top: 100px; font-family: Arial;">
                <h1 style="color: red;">⛔ غير مصرح لك بالدخول</h1>
                <p>أضف المفتاح السري للرابط: <b>/?token=YOUR_SECRET</b></p>
            </body>
        `);
    }

    const qrImageUrl = rawQrCode
        ? `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(rawQrCode)}`
        : '';

    const exportedSession = connectionStatus === 'CONNECTED' ? exportSessionToString() : '';

    res.send(`
        <html dir="rtl">
            <head><meta charset="utf-8"><title>بوابة واتساب - معهد فور يو</title></head>
            <body style="font-family: Arial; text-align: center; margin-top: 40px; background: #f4f6f8;">
                <div style="background: white; padding: 30px; border-radius: 12px; display: inline-block; max-width: 600px; width: 90%; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
                    <h2>WhatsApp API Gateway - معهد فور يو</h2>
                    <p>حالة الاتصال: <b style="color: ${connectionStatus === 'CONNECTED' ? 'green' : 'orange'}">${connectionStatus}</b></p>

                    ${connectionStatus === 'SCAN_QR' && qrImageUrl ? `
                        <p>امسح الرمز بهاتف المعهد (الأجهزة المرتبطة ← ربط جهاز):</p>
                        <img src="${qrImageUrl}" alt="QR Code" style="width: 250px; height: 250px; border: 5px solid #eee; border-radius: 8px;" />
                        <p style="font-size: 13px; color: #666;">حدّث الصفحة بعد المسح مباشرة للحصول على كود حفظ الجلسة.</p>
                    ` : connectionStatus === 'CONNECTED' ? `
                        <h3 style="color: green;">✅ متصل وجاهز لإرسال الرسائل!</h3>
                        <div style="background: #f0f7ff; border: 1px solid #cce3ff; padding: 15px; border-radius: 8px; margin-top: 20px; text-align: right;">
                            <b>🔐 كود حفظ الجلسة الدائم (WA_SESSION):</b>
                            <p style="font-size: 13px; color: #333; margin: 5px 0 10px;">انسخ هذا النص وضعه في Render داخل <b>Environment</b> باسم <code>WA_SESSION</code> لعدم ضياع الجلسة أبداً:</p>
                            <textarea id="sessionBox" readonly style="width: 100%; height: 90px; font-family: monospace; font-size: 11px; direction: ltr; padding: 8px; border-radius: 6px; border: 1px solid #ccc;">${exportedSession}</textarea>
                            <button onclick="copySession()" style="margin-top: 10px; padding: 10px 20px; background: #0066cc; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;">📋 نسخ كود الجلسة</button>
                            <span id="copyMsg" style="color: green; font-weight: bold; margin-right: 10px; display: none;">تم النسخ!</span>
                        </div>
                        <script>
                            function copySession() {
                                const box = document.getElementById('sessionBox');
                                box.select();
                                document.execCommand('copy');
                                document.getElementById('copyMsg').style.display = 'inline';
                            }
                        </script>
                    ` : `
                        <p>جاري التهيئة... حدّث الصفحة بعد 5 ثوانٍ.</p>
                    `}
                </div>
            </body>
        </html>
    `);
});

// 🛡️ نقطة استقبال وإرسال الرسائل من موقع المعهد
app.post('/api/sendText', async (req, res) => {
    try {
        const providedToken = req.headers['x-api-key'] || req.query.token;

        if (!providedToken || providedToken !== API_TOKEN) {
            return res.status(401).json({ success: false, error: 'Unauthorized: Invalid API Token' });
        }

        const { chatId, text, number } = req.body;
        const cleanNumber = (number || '').toString().replace(/\D/g, '');
        const target = chatId || (cleanNumber ? `${cleanNumber}@s.whatsapp.net` : '');

        if (!target || !text) {
            return res.status(400).json({ success: false, error: 'Missing target or text' });
        }

        if (!sock || connectionStatus !== 'CONNECTED') {
            return res.status(400).json({ success: false, error: 'WhatsApp is not connected' });
        }

        await sock.sendMessage(target, { text: String(text) });
        res.json({ success: true, message: 'Message sent successfully' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.SERVER_PORT || process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    restoreSessionFromEnv();
    connectToWhatsApp();
});
