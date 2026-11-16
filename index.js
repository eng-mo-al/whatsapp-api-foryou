const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 🔐 المفتاح السري (سيقرأ من متغير البيئة API_TOKEN في Render، أو يستخدم هذا المفتاح الافتراضي)
const API_TOKEN = process.env.API_TOKEN || 'foryou_secret_2026';
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

let sock;
let rawQrCode = '';
let connectionStatus = 'DISCONNECTED';
let isConnecting = false;

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
                console.log('QR Code generated. Ready to scan.');
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                connectionStatus = 'DISCONNECTED';
                isConnecting = false;

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
                console.log('WhatsApp Connected!');
            }
        });

        sock.ev.on('creds.update', saveCreds);
    } catch (err) {
        isConnecting = false;
        connectionStatus = 'DISCONNECTED';
        setTimeout(() => connectToWhatsApp(), 5000);
    }
}

// ✅ مسار UptimeRobot لإبقاء السيرفر مستيقظاً 24 ساعة
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', whatsapp: connectionStatus });
});

// 🛡️ لوحة التحكم وعرض QR Code
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

    res.send(`
        <html>
            <head><meta charset="utf-8"><title>بوابة واتساب - معهد فور يو</title></head>
            <body style="font-family: Arial; text-align: center; margin-top: 50px; background: #f4f6f8;">
                <div style="background: white; padding: 30px; border-radius: 12px; display: inline-block; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
                    <h2>WhatsApp API Gateway - معهد فور يو</h2>
                    <p>الحالة: <b style="color: ${connectionStatus === 'CONNECTED' ? 'green' : 'orange'}">${connectionStatus}</b></p>
                    ${connectionStatus === 'SCAN_QR' && qrImageUrl ? `
                        <p>امسح الرمز من واتساب (الأجهزة المرتبطة -> ربط جهاز):</p>
                        <img src="${qrImageUrl}" alt="QR Code" style="width: 250px; height: 250px; border: 5px solid #eee; border-radius: 8px;" />
                        <p style="font-size: 12px; color: #777;">حدّث الصفحة إذا انتهت صلاحية الرمز</p>
                    ` : connectionStatus === 'CONNECTED' ? `
                        <h3 style="color: green;">✅ متصل وجاهز لإرسال الرسائل!</h3>
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
    connectToWhatsApp();
});
