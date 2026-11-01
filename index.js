const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

const app = express();
app.use(express.json());

let sock;
let qrCodeData = '';
let connectionStatus = 'DISCONNECTED';

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrCodeData = qr;
            connectionStatus = 'SCAN_QR';
            console.log('QR Code received, scan it from your browser or terminal.');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
            connectionStatus = 'DISCONNECTED';
            console.log('Connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            connectionStatus = 'CONNECTED';
            qrCodeData = '';
            console.log('WhatsApp connected successfully!');
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// صفحة لعرض حالة الاتصال والـ QR Code
app.get('/', (req, res) => {
    res.send(`
        <html>
            <body style="font-family: Arial; text-align: center; margin-top: 50px;">
                <h2>WhatsApp API Gateway Status</h2>
                <p>Status: <b>${connectionStatus}</b></p>
                ${connectionStatus === 'SCAN_QR' ? `<h3>Scan this text/data or check server logs for QR</h3><p style="word-break: break-all; background: #f4f4f4; padding: 20px;">${qrCodeData}</p>` : ''}
            </body>
        </html>
    `);
});

// نقطة النهاية لإرسال الرسائل
app.post('/api/sendText', async (req, res) => {
    try {
        const { chatId, text, number } = req.body;
        const target = chatId || `${number}@s.whatsapp.net`;

        if (!sock || connectionStatus !== 'CONNECTED') {
            return res.status(400).json({ success: false, error: 'WhatsApp is not connected yet.' });
        }

        await sock.sendMessage(target, { text: text });
        res.json({ success: true, message: 'Message sent successfully' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- هنا تم تغيير المنفذ نهائياً وجعله 8080 (أو سيعمل تلقائياً من إعدادات المنصة السحابية) ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    connectToWhatsApp();
});