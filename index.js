const express = require('express');
const { default: makeWASocket, DisconnectReason, initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const { MongoClient } = require('mongodb');
const pino = require('pino');

const app = express();
app.use(express.json());

// 🔐 مفتاح الأمان السري
const API_TOKEN = process.env.API_TOKEN || 'my_super_secret_token_123';

// 🗄️ رابط قاعدة بيانات MongoDB ومتغيرات الجلسة
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.MONGO_DB_NAME || 'whatsapp_gateway';
const SESSION_ID = process.env.SESSION_ID || 'foryou_main_session';

let sock;
let rawQrCode = '';
let connectionStatus = 'DISCONNECTED';
let mongoCollection;

// إعداد اتصال MongoDB وتهيئة تخزين الجلسة (Auth State)
async function getMongoAuthState(collection) {
    const docId = SESSION_ID;

    const readData = async (key) => {
        const doc = await collection.findOne({ _id: docId });
        if (!doc || !doc.data || !doc.data[key]) return null;
        return JSON.parse(JSON.stringify(doc.data[key]), BufferJSON.reviver);
    };

    const writeData = async (key, value) => {
        const serialized = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
        await collection.updateOne(
            { _id: docId },
            { $set: { [`data.${key}`]: serialized, updatedAt: new Date() } },
            { upsert: true }
        );
    };

    const removeData = async (key) => {
        await collection.updateOne(
            { _id: docId },
            { $unset: { [`data.${key}`]: '' } }
        );
    };

    const existingDoc = await collection.findOne({ _id: docId });
    const creds = existingDoc?.data?.creds
        ? JSON.parse(JSON.stringify(existingDoc.data.creds), BufferJSON.reviver)
        : initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(key, value) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            await writeData('creds', sock.authState.creds);
        }
    };
}

async function initDatabase() {
    if (!MONGO_URI) {
        throw new Error('MONGO_URI is missing in environment variables.');
    }
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    const db = client.db(DB_NAME);
    mongoCollection = db.collection('baileys_sessions');
    console.log('Connected to MongoDB for WhatsApp session persistence.');
}

async function connectToWhatsApp() {
    if (!mongoCollection) {
        await initDatabase();
    }

    const { state, saveCreds } = await getMongoAuthState(mongoCollection);

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' })
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
            console.log('Connection closed, reconnecting...', shouldReconnect);

            if (shouldReconnect) {
                setTimeout(() => {
                    connectToWhatsApp().catch((err) => console.error('Reconnect error:', err));
                }, 3000);
            } else {
                // إذا تم تسجيل الخروج صراحة من الهاتف، نحذف الجلسة القديمة لتوليد QR جديد
                await mongoCollection.deleteOne({ _id: SESSION_ID });
                rawQrCode = '';
                connectToWhatsApp().catch((err) => console.error('Fresh connect error:', err));
            }
        } else if (connection === 'open') {
            connectionStatus = 'CONNECTED';
            rawQrCode = '';
            console.log('WhatsApp connected successfully!');
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// ✅ مسار فحص حيوية السيرفر لـ UptimeRobot بدون طلب توكن
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        whatsapp: connectionStatus,
        uptime: process.uptime()
    });
});

// 🛡️ صفحة الويب: لا تفتح إلا إذا كان معك المفتاح
app.get('/', (req, res) => {
    const providedToken = req.query.token;

    if (providedToken !== API_TOKEN) {
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

// 🛡️ الـ API: لا ترسل رسائل إلا إذا كان معك المفتاح
app.post('/api/sendText', async (req, res) => {
    try {
        const providedToken = req.headers['x-api-key'] || req.query.token;

        if (providedToken !== API_TOKEN) {
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
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Server is running on port ${PORT}`);
    try {
        await connectToWhatsApp();
    } catch (err) {
        console.error('Failed to start WhatsApp client:', err);
    }
});
