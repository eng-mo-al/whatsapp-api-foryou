const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());

let sock;
let qrCodeImage = '';
let connectionStatus = 'DISCONNECTED';

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            connectionStatus = 'SCAN_QR';
            qrCodeImage = await QRCode.toDataURL(qr);
            console.log('QR Code generated as image.');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
            connectionStatus = 'DISCONNECTED';
            console.log('Connection closed, reconnecting...', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            connectionStatus = 'CONNECTED';
            qrCodeImage = '';
            console.log('WhatsApp connected successfully!');
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

app.get('/', (req, res) => {
    res.send(`
        <html>
            <body style="font-family: Arial; text-align: center; margin-top: 50px; background: #f9f9f9;">
                <div style="background: white; padding: 30px; border-radius: 10px; display: inline-block; box-shadow: 0 4px 10px rgba(0,0,0,0.1);">
                    <h2>WhatsApp API Gateway</h2>
                    <p>Status: <b style="color: ${connectionStatus === 'CONNECTED' ? 'green' : 'orange'}">${connectionStatus}</b></p>
                    ${connectionStatus === 'SCAN_QR' && qrCodeImage ? `
                        <h3>Scan this QR Code with WhatsApp:</h3>
                        <img src="${qrCodeImage}" alt="QR Code" style="width: 250px; height: 250px; border: 5px solid #eee; border-radius: 8px;" />
                        <p style="color: #666; font-size: 14px; margin-top: 10px;">Open WhatsApp on your phone -> Linked Devices -> Link a Device</p>
                    ` : connectionStatus === 'CONNECTED' ? `
                        <h3 style="color: green;">✅ WhatsApp is Connected and Ready!</h3>
                    ` : `
                        <p>Initializing connection, please refresh the page in a few seconds...</p>
                    `}
                </div>
            </body>
        </html>
    `);
});

app.post('/api/sendText', async (req, res) => {
    try {
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    connectToWhatsApp();
});
