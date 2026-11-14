const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// 🔐 المفتاح السري الواضح (يقرأ أولاً من متغير البيئة API_TOKEN، وإذا لم يوجد يستخدم القيمة المحددة هنا)
const API_TOKEN = process.env.API_TOKEN || 'mohammed8685';
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
                console.log('QR Code received. Open the web dashboard to scan.');
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                connectionStatus = 'DISCONNECTED';
                isConnecting = false;

                console.log('Connection closed. Status:', statusCode, 'Reconnect:', shouldReconnect);

                if (shouldReconnect) {
                    setTimeout(() => {
                        connectToWhatsApp();
                    }, 3000);
                } else {
                    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    rawQrCode = '';
                    setTimeout(() => {
                        connectToWhatsApp();
                    }, 2000);
                }
            } else if (connection === 'open') {
                connectionStatus = 'CONNECTED';
                rawQrCode = '';
                isConnecting = false;
                console.log('WhatsApp connected successfully!');
            }
        });

        sock.ev.on('creds.update', saveCreds);
    } catch (err) {
        isConnecting = false;
        connectionStatus = 'DISCONNECTED';
        console.error('Error in connectToWhatsApp:', err);
        setTimeout(() => {
            connectToWhatsApp();
        }, 5000);
    }
}

// ✅ مسار فحص حيوية السيرفر لـ UptimeRobot بدون طلب توكن
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        whatsapp: connectionStatus,
        uptime: Math.floor(process.uptime())
    });
});

// 🛡️ صفحة الويب
app.get('/', (req, res) => {
    const providedToken = req.query.token;

    if (!providedToken || providedToken !== API_TOKEN) {
        return res.status(401).send(`
            <body style="text-align: center; margin-top: 100px; font-family: Arial;">
                <h1 style="color: red;">⛔ غير مصرح لك بالدخول</h1>
                <p>يجب إضافة المفتاح السري في الرابط هكذا: <br> <b>your-server-url.com/?token=YOUR_SECRET</b></p>
            </body>
        `);
    }

    const qrImageUrl = rawQrCode
        ? `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(rawQrCode)}`
        : '';

    res.send(`
        <html>
            <body style="font-family: Arial; text-align: center; margin-top: 50px; background: #f9f9f9;">
                <div style="background: white; padding: 30px; border-radius: 10px; display: inline-block; box-shadow: 0 4px 10px rgba(0,0,0,0.1);">
                    <h2>WhatsApp API Gateway - معهد فور يو</h2>
                    <p>Status: <b style="color: ${connectionStatus === 'CONNECTED' ? 'green' : 'orange'}">${connectionStatus}</b></p>
                    ${connectionStatus === 'SCAN_QR' && qrImageUrl ? `
                        <h3>Scan this QR Code with WhatsApp:</h3>
                        <img src="${qrImageUrl}" alt="QR Code" style="width: 250px; height: 250px; border: 5px solid #eee; border-radius: 8px;" />
                        <p style="color: #666; font-size: 14px; margin-top: 10px;">Open WhatsApp -> Linked Devices -> Link a Device</p>
                    ` : connectionStatus === 'CONNECTED' ? `
                        <h3 style="color: green;">✅ WhatsApp is Connected and Ready!</h3>
                    ` : `
                        <p>Initializing connection, please refresh the page in 5 seconds...</p>
                    `}
                </div>
            </body>
        </html>
    `);
});

// 🛡️ الـ API
app.post('/api/sendText', async (req, res) => {
    try {
        const providedToken = req.headers['x-api-key'] || req.query.token;

        if (!providedToken || providedToken !== API_TOKEN) {
            return res.status(401).json({ success: false, error: 'Unauthorized: Invalid API Token' });
        }

        const { chatId, text, number } = req.body;
        const target = chatId || `${number}@s.whatsapp.net`;

        if (!sock || connectionStatus !== 'CONNECTED') {
            return res.status(400).json({ success: false, error: 'WhatsApp is not connected yet. Please scan QR.' });
        }

        await sock.sendMessage(target, { text: text });
        res.json({ success: true, message: 'Message sent successfully' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.SERVER_PORT || process.env.PORT || 61408;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
    connectToWhatsApp();
});
