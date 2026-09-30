require('dotenv').config();
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const mysql = require('mysql2/promise');
const { Pool } = require('pg');

const logger = pino({ level: 'silent' });

// ============================================================
// CONFIGURACIÓN DEL NEGOCIO
// ============================================================
const CONFIG = {
    nombre: 'Sildemar',
    catalogo: 'https://storesildemar.com.ve/cliente/cliente',
    ubicacion: 'https://maps.app.goo.gl/sj9paCiKBdVG6FFj7',
    telefono: '0426-2267929'
};

// ============================================================
// SERVIDOR HTTP (KEEP-ALIVE PARA RENDER)
// ============================================================
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.status(200).send('🤖 Bot Sildemar activo'));
app.get('/health', (req, res) => res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
}));

app.listen(PORT, () => {
    console.log(`🌐 Servidor HTTP escuchando en puerto ${PORT}`);
});

// ============================================================
// CONEXIÓN A MYSQL (INVENTARIO)
// ============================================================
let pool;

async function conectarBD() {
    try {
        pool = mysql.createPool({
            host: process.env.DB_HOST || 'localhost',
            port: parseInt(process.env.DB_PORT) || 3306,
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'storesil_sildemar',
            waitForConnections: true,
            connectionLimit: 5,
            queueLimit: 0
        });

        const conn = await pool.getConnection();
        console.log('✅ Conexión a MySQL (inventario) establecida');
        conn.release();
    } catch (err) {
        console.error('❌ Error conectando a MySQL:', err.message);
    }
}

// ============================================================
// ADAPTADOR DE SESIÓN EN POSTGRESQL (SUPABASE)
// ============================================================
async function useSupabaseAuthState(sessionId = 'sildemar-bot') {
    const pgPool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 3
    });

    // Crear tabla si no existe
    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS baileys_auth (
            session_id TEXT NOT NULL,
            key_id TEXT NOT NULL,
            value TEXT,
            updated_at TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (session_id, key_id)
        )
    `);
    console.log('📦 Tabla baileys_auth lista');

    const writeData = async (data, key) => {
        const value = JSON.stringify(data, BufferJSON.replacer);
        await pgPool.query(
            `INSERT INTO baileys_auth (session_id, key_id, value, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (session_id, key_id)
             DO UPDATE SET value = $3, updated_at = NOW()`,
            [sessionId, key, value]
        );
    };

    const readData = async (key) => {
        const res = await pgPool.query(
            `SELECT value FROM baileys_auth WHERE session_id = $1 AND key_id = $2`,
            [sessionId, key]
        );
        if (res.rows.length === 0) return null;
        try {
            return JSON.parse(res.rows[0].value, BufferJSON.reviver);
        } catch {
            return null;
        }
    };

    const removeData = async (key) => {
        await pgPool.query(
            `DELETE FROM baileys_auth WHERE session_id = $1 AND key_id = $2`,
            [sessionId, key]
        );
    };

    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category of Object.keys(data)) {
                        for (const id of Object.keys(data[category])) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

// ============================================================
// DETECCIÓN DE INTENCIONES
// ============================================================
function detectarIntencion(texto) {
    const t = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    const palabrasUbicacion = ['ubicacion', 'donde', 'direccion', 'mapa', 'local', 'llegar', 'lugar', 'tienda', 'sucursal', 'como llego', 'donde quedan', 'donde estan'];
    if (palabrasUbicacion.some(p => t.includes(p))) return 'ubicacion';

    const palabrasSaludo = ['hola', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches', 'buen dia', 'hey', 'saludos', 'que tal'];
    if (palabrasSaludo.some(p => t.includes(p)) && t.length < 25) return 'saludo';

    const palabrasGracias = ['gracias', 'gracia', 'mil gracias', 'se agradece'];
    if (palabrasGracias.some(p => t.includes(p)) && t.length < 20) return 'gracias';

    if (t.includes('horario') || t.includes('abren') || t.includes('cierran') || t.includes('abierto')) return 'horario';

    return null;
}

// ============================================================
// RESPUESTAS ESPECIALES
// ============================================================
function respuestaUbicacion() {
    return `📍 *¡Claro! Estamos aquí:*\n\n${CONFIG.ubicacion}\n\n` +
           `Abre el link y te lleva directo con Google Maps 🗺️\n\n` +
           `También puedes ver nuestro catálogo completo aquí:\n${CONFIG.catalogo}`;
}

function respuestaSaludo(nombre) {
    return `¡Hola ${nombre}! 👋 Soy el asistente virtual de *${CONFIG.nombre}*.\n\n` +
           `¿En qué te puedo ayudar? Puedes:\n\n` +
           `🔧 *Buscar un repuesto* — solo dime el nombre y el carro\n` +
           `   _Ej: "amortiguador corsa"_\n\n` +
           `📍 *Ver nuestra ubicación* — escribe "ubicación"\n\n` +
           `🛒 *Ver catálogo completo* — aquí:\n${CONFIG.catalogo}\n\n` +
           `¿Qué necesitas?`;
}

function respuestaGracias() {
    return `¡Con gusto! 🙌 Cualquier cosa que necesites, aquí estamos.\n\n` +
           `Recuerda nuestro catálogo:\n${CONFIG.catalogo}`;
}

function respuestaHorario() {
    return `🕒 *Nuestro horario:*\n\n` +
           `Lunes a Viernes: 8:00 am - 5:00 pm\n` +
           `Sábados: 8:00 am - 1:00 pm\n\n` +
           `📍 Ubicación: ${CONFIG.ubicacion}`;
}

// ============================================================
// FILTROS DE MENSAJES
// ============================================================
function esMensajeDeGrupo(remoteJid) {
    return remoteJid.endsWith('@g.us') || remoteJid.endsWith('@broadcast');
}

function esListaDePrecios(texto) {
    const t = texto.toUpperCase();
    if (texto.length > 400) return true;
    const saltos = (texto.match(/\n/g) || []).length;
    if (saltos >= 4) return true;
    const signosPrecio = (t.match(/\$/g) || []).length;
    if (signosPrecio >= 3) return true;
    const palabrasProveedor = ['LISTA DE PRECIO', 'LISTA DE PRECIOS', 'DISPONIBLE', 'DISPONIBLES', 'PROVEEDOR', 'MAYOR', 'AL MAYOR', 'PRECIO DE COSTO', 'FACTURA', 'PEDIDO', 'STOCK DISPONIBLE', 'COTIZACION', 'COTIZACIÓN'];
    if (palabrasProveedor.some(p => t.includes(p))) return true;
    return false;
}

function esMensajePropioDelNegocio(texto) {
    const t = texto.toLowerCase();
    return t.includes('storesildemar.com.ve') || t.includes('maps.app.goo.gl');
}

// ============================================================
// BUSCAR PRODUCTOS
// ============================================================
async function buscarProductos(mensajeCliente) {
    if (!pool) return [];
    try {
        const limpio = mensajeCliente.replace(/[^\w\sáéíóúñÁÉÍÓÚÑ]/gi, ' ').replace(/\s+/g, ' ').trim();
        if (!limpio || limpio.length < 3) return [];

        const stopWords = ['DE','LA','EL','LOS','LAS','UN','UNA','PARA','POR','CON','QUE','DEL','Y','O','AL','SE','SU','MI','TU','BUSCO','NECESITO','TIENEN','TENGO','QUIERO'];
        const palabras = limpio.toUpperCase().split(' ').filter(p => p.length >= 3 && !stopWords.includes(p));
        if (palabras.length === 0) return [];

        const booleanQuery = palabras.map(p => `+${p}*`).join(' ');

        const [booleanResults] = await pool.query(
            `SELECT id_producto, codigo, nombre_producto, marca_repuesto, marca_carro,
                    modelo_vehiculo, precio, stock_actual,
                    MATCH(nombre_producto, marca_carro, marca_repuesto, modelo_vehiculo)
                          AGAINST(? IN BOOLEAN MODE) AS score
             FROM producto
             WHERE MATCH(nombre_producto, marca_carro, marca_repuesto, modelo_vehiculo)
                   AGAINST(? IN BOOLEAN MODE)
                   AND stock_actual > 0
             ORDER BY score DESC
             LIMIT 5`,
            [booleanQuery, booleanQuery]
        );

        if (booleanResults.length > 0) return booleanResults;

        const conditions = palabras.map(() =>
            `(nombre_producto LIKE ? OR marca_carro LIKE ? OR marca_repuesto LIKE ? OR modelo_vehiculo LIKE ?)`
        ).join(' AND ');
        const params = palabras.flatMap(p => [`%${p}%`, `%${p}%`, `%${p}%`, `%${p}%`]);

        const [likeResults] = await pool.query(
            `SELECT id_producto, codigo, nombre_producto, marca_repuesto, marca_carro,
                    modelo_vehiculo, precio, stock_actual
             FROM producto
             WHERE (${conditions}) AND stock_actual > 0
             LIMIT 5`,
            params
        );

        return likeResults;
    } catch (err) {
        console.error('Error buscando productos:', err.message);
        return [];
    }
}

// ============================================================
// TASA DEL DÍA
// ============================================================
async function obtenerTasa() {
    if (!pool) return 1;
    try {
        const [rows] = await pool.query('SELECT tasa_dolar FROM configuracion WHERE id = 1');
        return parseFloat(rows[0]?.tasa_dolar) || 1;
    } catch {
        return 1;
    }
}

// ============================================================
// FORMATEAR RESPUESTA
// ============================================================
function formatearProductos(productos, tasa) {
    if (productos.length === 0) {
        return `Hmm, no encontré ese repuesto en el inventario 🤔\n\n` +
               `Puede que esté con otro nombre, o quizás no lo tengamos cargado.\n\n` +
               `Te invito a revisar nuestro catálogo completo:\n\n` +
               `🛒 ${CONFIG.catalogo}\n\n` +
               `Si lo ves por ahí, escríbenos y lo separamos 😉`;
    }

    let texto = `¡Sí tenemos! 🙌 Aquí te muestro ${productos.length} opción(es):\n\n`;

    productos.forEach((p, i) => {
        const precioBs = (parseFloat(p.precio) * tasa).toFixed(2);
        const stockAviso = parseInt(p.stock_actual) < 5 ? ' ⚠️ *Últimas unidades*' : '';
        texto += `*${i + 1}. ${p.nombre_producto}*\n`;
        texto += `   Código: ${p.codigo}\n`;
        if (p.marca_carro) texto += `   Vehículo: ${p.marca_carro} ${p.modelo_vehiculo || ''}\n`;
        if (p.marca_repuesto) texto += `   Marca: ${p.marca_repuesto}\n`;
        texto += `   💵 $${parseFloat(p.precio).toFixed(2)}\n`;
        texto += `   🇻🇪 Bs ${precioBs}\n`;
        texto += `   📦 Stock: ${p.stock_actual}${stockAviso}\n\n`;
    });

    texto += `_Los precios en Bs se calculan con la tasa del día._\n\n`;
    texto += `¿Te interesa alguno? Escríbenos y lo separamos 😉\n\n`;
    texto += `🛒 Ver más productos: ${CONFIG.catalogo}`;

    return texto;
}

// ============================================================
// BOT
// ============================================================
async function iniciarBot() {
    const { state, saveCreds } = await useSupabaseAuthState('sildemar-bot');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: state,
        browser: ['Sildemar Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n📱 Escanea este QR con tu WhatsApp:\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('⚠️  Conexión cerrada. Reconectando...', shouldReconnect);
            if (shouldReconnect) setTimeout(iniciarBot, 3000);
        } else if (connection === 'open') {
            console.log('✅ ¡Bot conectado a WhatsApp!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        const msg = messages[0];
        if (!msg.message) return;
        if (msg.key.fromMe) return;

        const remitente = msg.key.remoteJid;

        if (esMensajeDeGrupo(remitente)) {
            console.log(`⏭️  Ignorado (grupo)`);
            return;
        }

        const pushName = (msg.pushName || 'Cliente').split(' ')[0];

        const texto =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            '';

        if (!texto) return;

        if (esListaDePrecios(texto)) {
            console.log(`⏭️  Ignorado (lista de precios)`);
            return;
        }

        if (esMensajePropioDelNegocio(texto)) {
            console.log(`⏭️  Ignorado (mensaje propio)`);
            return;
        }

        console.log(`📩 [${pushName}]: ${texto}`);

        try { await sock.sendPresenceUpdate('composing', remitente); } catch {}

        const intencion = detectarIntencion(texto);
        let respuesta;

        switch (intencion) {
            case 'ubicacion':
                respuesta = respuestaUbicacion();
                break;
            case 'saludo':
                respuesta = respuestaSaludo(pushName);
                break;
            case 'gracias':
                respuesta = respuestaGracias();
                break;
            case 'horario':
                respuesta = respuestaHorario();
                break;
            default: {
                const productos = await buscarProductos(texto);
                const tasa = await obtenerTasa();
                respuesta = formatearProductos(productos, tasa);
                break;
            }
        }

        await sock.sendMessage(remitente, { text: respuesta });
    });

    return sock;
}

// ============================================================
// ARRANQUE
// ============================================================
(async () => {
    await conectarBD();
    await iniciarBot();
})().catch(err => console.error('❌ Error fatal:', err));