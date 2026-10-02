const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const mysql = require('mysql2/promise');
const { Pool } = require('pg');
const {
    asegurarTablasWhatsApp,
    buscarClientePorTelefono,
    buscarNotificacionPorMensaje,
    buscarNotificacionesPendientesGerencia,
    crearNotificacion,
    crearPedidoWhatsApp,
    marcarNotificacionFallida,
    obtenerContactosGerencia,
    obtenerContactosParaNotificacion,
    normalizarNumeroWhatsApp,
    registrarMensajeGerencia,
    registrarRespuestaGerencia
} = require('./whatsapp-service');

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
// MEMORIA DE CONVERSACIÓN POR USUARIO
// ============================================================
const userSessions = new Map();
const SESSION_TTL = 30 * 60 * 1000; // 30 minutos

function guardarSesion(jid, productos) {
    userSessions.set(jid, { ...productos, timestamp: Date.now() });
}

function obtenerSesion(jid) {
    const s = userSessions.get(jid);
    if (!s) return null;
    if (Date.now() - s.timestamp > SESSION_TTL) {
        userSessions.delete(jid);
        return null;
    }
    s.timestamp = Date.now();
    return s;
}

function limpiarSesion(jid) {
    userSessions.delete(jid);
}

// ============================================================
// SERVIDOR HTTP (KEEP-ALIVE PARA RENDER)
// ============================================================
const app = express();
const PORT = process.env.PORT || 3000;
let pool;
let pgPool;
let activeSocket;
let shuttingDown = false;
let httpServer;

app.get('/', (req, res) => res.status(200).send('🤖 Bot Sildemar activo'));
app.get('/health', (req, res) => res.status(pool ? 200 : 503).json({
    status: pool ? 'ok' : 'degraded',
    mysql: pool ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
}));

httpServer = app.listen(PORT, () => {
    console.log(`🌐 Servidor HTTP escuchando en puerto ${PORT}`);
});

// ============================================================
// CONEXIÓN A MYSQL (INVENTARIO) - OPTIMIZADO PARA cPANEL
// ============================================================
let mysqlFallos = 0;
const MYSQL_MAX_FALLOS = 5;

async function conectarBD() {
    const required = [
        'DB_HOST',
        'DB_USER',
        'DB_PASSWORD',
        'DB_NAME',
        'DATABASE_URL'
    ];
    const missing = required.filter((key) => !process.env[key]);
    if (missing.length > 0) {
        throw new Error(`Faltan variables de entorno requeridas para iniciar el bot: ${missing.join(', ')}`);
    }
    obtenerContactosGerencia();

    try {
        pool = mysql.createPool({
            host: process.env.DB_HOST,
            port: parseInt(process.env.DB_PORT) || 3306,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            waitForConnections: true,
            connectionLimit: 5,
            maxIdle: 2,
            idleTimeout: 10000,
            queueLimit: 0,
            connectTimeout: 15000,
            enableKeepAlive: true,
            decimalNumbers: true
        });

        const conn = await pool.getConnection();
        console.log('✅ Conexión a MySQL (inventario) establecida');
        conn.release();

        try {
            await asegurarTablasWhatsApp(pool);
            console.log('✅ Tablas de integración WhatsApp listas');
        } catch (error) {
            if (error.code === 'ER_TABLEACCESS_DENIED_ERROR' || error.errno === 1142) {
                throw new Error(
                    'El usuario MySQL no tiene permiso CREATE para preparar las tablas WhatsApp. ' +
                    'Importa backend/sql/whatsapp_integration.sql con un usuario administrador.',
                    { cause: error }
                );
            }
            throw error;
        }

        for (const table of ['whatsapp_solicitudes', 'whatsapp_notificaciones']) {
            const [tables] = await pool.execute(
                `SELECT 1 FROM information_schema.TABLES
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
                [table]
            );
            if (tables.length === 0) {
                throw new Error(`Falta la tabla ${table}; importe backend/sql/whatsapp_integration.sql.`);
            }
        }
    } catch (err) {
        if (pool) {
            try {
                await pool.end();
            } catch (closeError) {
                console.error('Error cerrando el pool MySQL tras fallo de conexión:', closeError.message);
            }
        }
        pool = null;
        console.error('Error conectando a MySQL:', err.message);
        throw err;
    }
}

async function querySegura(sql, params = []) {
    if (!pool) throw new Error('La conexión con MySQL no está disponible.');
    try {
        const [rows] = await pool.query(sql, params);
        mysqlFallos = 0;
        return rows;
    } catch (err) {
        mysqlFallos++;
        console.error(`⚠️  Error MySQL (${mysqlFallos}/${MYSQL_MAX_FALLOS}):`, err.message);

        if (mysqlFallos >= MYSQL_MAX_FALLOS) {
            console.log('🔄 Reiniciando pool MySQL...');
            const poolActual = pool;
            pool = null;
            try {
                await poolActual.end();
            } catch (closeError) {
                console.error('Error cerrando el pool MySQL:', closeError.message);
            }
            await new Promise(r => setTimeout(r, 5000));
            await conectarBD();
            mysqlFallos = 0;
        }
        throw err;
    }
}

// ============================================================
// ADAPTADOR DE SESIÓN EN POSTGRESQL (SUPABASE)
// ============================================================
async function useSupabaseAuthState(sessionId = 'sildemar-bot') {
    if (!process.env.DATABASE_URL) {
        throw new Error('Falta la variable de entorno DATABASE_URL para la sesión de WhatsApp.');
    }
    if (!pgPool) {
        pgPool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false },
            max: 3
        });
    }

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
// 🔥 UTILIDADES DE TEXTO
// ============================================================

// Limpia el texto dejando solo letras, números y vocales acentuadas
function limpiarTexto(texto) {
    return String(texto || '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')  // quitar símbolos y emojis
        .replace(/\s+/g, ' ')
        .trim();
}

// Quita acentos para comparaciones
function sinAcentos(texto) {
    return String(texto || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}

// 🔥 Detecta si un mensaje NO tiene contenido útil (solo emojis, thumbs up, etc)
function esMensajeVacio(texto) {
    const limpio = limpiarTexto(texto);
    // Si después de quitar símbolos/emojis queda menos de 2 caracteres → ignorar
    if (limpio.length < 2) return true;
    return false;
}

// ============================================================
// DETECCIÓN DE INTENCIONES
// ============================================================
function detectarIntencion(texto) {
    const t = sinAcentos(texto);

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
// DETECCIÓN DE SELECCIÓN
// ============================================================
function detectarSeleccion(texto) {
    const t = sinAcentos(texto).trim();

    // Número puro o con prefijo: "1", "el 2", "opción 3"
    const matchNum = t.match(/^(?:el|la|opcion|numero)?\s*(\d+)\s*$/);
    if (matchNum) return { tipo: 'numero', valor: parseInt(matchNum[1]) };

    // Ordinales
    const ordinales = { 'primero': 1, 'segundo': 2, 'tercero': 3, 'cuarto': 4, 'quinto': 5 };
    for (const [palabra, num] of Object.entries(ordinales)) {
        if (t.includes(palabra)) return { tipo: 'numero', valor: num };
    }

    // "quiero el de vega", "el de bosch"
    const matchDe = t.match(/(?:el|la)\s+de\s+(.+)/);
    if (matchDe) return { tipo: 'marca', texto: matchDe[1] };

    // "quiero el vega"
    const matchEl = t.match(/^(?:quiero\s+)?(?:el|la)\s+(.+)/);
    if (matchEl) return { tipo: 'marca', texto: matchEl[1] };

    // "ese", "esa", "quiero ese", etc.
    if (/^(ese|esa|esos|esas|si|quiero|separalo|separame|anotalo|ese mismo|si por favor)\s*$/.test(t)) {
        return { tipo: 'primero' };
    }

    return null;
}

// ============================================================
// RESOLVER SELECCIÓN
// ============================================================
function resolverSeleccion(sesion, seleccion) {
    const productos = sesion.productos;
    if (!productos || productos.length === 0) return null;

    if (seleccion.tipo === 'numero') {
        return productos[seleccion.valor - 1] || null;
    }

    if (seleccion.tipo === 'primero') {
        return productos[0];
    }

    if (seleccion.tipo === 'marca') {
        const palabras = seleccion.texto.split(' ').filter(p => p.length >= 3);
        for (const p of productos) {
            const textoProd = `${p.nombre_producto} ${p.marca_repuesto || ''} ${p.marca_carro || ''} ${p.modelo_vehiculo || ''}`.toLowerCase();
            if (palabras.some(pal => textoProd.includes(pal))) return p;
        }
    }

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

function respuestaSeleccion(producto, tasa) {
    const precioBs = (parseFloat(producto.precio) * tasa).toFixed(2);
    return `¡Perfecto! 🙌 Aquí está el detalle:\n\n` +
           `*${producto.nombre_producto}*\n` +
           `   Código: ${producto.codigo}\n` +
           (producto.marca_carro ? `   Vehículo: ${producto.marca_carro} ${producto.modelo_vehiculo || ''}\n` : '') +
           (producto.marca_repuesto ? `   Marca: ${producto.marca_repuesto}\n` : '') +
           `   💵 $${parseFloat(producto.precio).toFixed(2)}\n` +
           `   🇻🇪 Bs ${precioBs}\n` +
           `   📦 Stock: ${producto.stock_actual}\n\n` +
           `*¿Cómo lo separamos?* 🛒\n\n` +
           `1️⃣ Pasa por el local y menciona el código *${producto.codigo}*\n` +
           `2️⃣ O escríbenos aquí y coordinamos\n\n` +
           `📍 *Estamos aquí:*\n${CONFIG.ubicacion}\n\n` +
           `También puedes ver el catálogo completo:\n${CONFIG.catalogo}`;
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
    const limpio = limpiarTexto(mensajeCliente);
    if (!limpio || limpio.length < 3) return [];

    const stopWords = ['DE','LA','EL','LOS','LAS','UN','UNA','PARA','POR','CON','QUE','DEL','Y','O','AL','SE','SU','MI','TU','BUSCO','NECESITO','TIENEN','TENGO','QUIERO'];
    const palabras = limpio.toUpperCase().split(' ').filter(p => p.length >= 3 && !stopWords.includes(p));
    if (palabras.length === 0) return [];

    const conditions = palabras.map(() =>
        `(nombre_producto LIKE ? OR marca_carro LIKE ? OR marca_repuesto LIKE ? OR modelo_vehiculo LIKE ?)`
    ).join(' AND ');
    const params = palabras.flatMap(p => [`%${p}%`, `%${p}%`, `%${p}%`, `%${p}%`]);

    return querySegura(
        `SELECT id_producto, codigo, nombre_producto, marca_repuesto, marca_carro,
                modelo_vehiculo, precio, stock_actual
         FROM producto
         WHERE (${conditions}) AND stock_actual > 0
         LIMIT 5`,
        params
    );
}

// ============================================================
// TASA DEL DÍA
// ============================================================
async function obtenerTasa() {
    const rows = await querySegura('SELECT tasa_dolar FROM configuracion WHERE id = 1');
    if (rows.length === 0 || Number(rows[0].tasa_dolar) <= 0) {
        throw new Error('No hay una tasa de cambio válida configurada.');
    }
    return Number(rows[0].tasa_dolar);
}

// ============================================================
// FORMATEAR RESPUESTA
// ============================================================
function formatearProductos(productos, tasa) {
    if (productos.length === 0) {
        return `no encontré ese repuesto en el inventario 🤔\n\n` +
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
    texto += `💡 _Responde con el número o el nombre del producto que te interese_\n\n`;
    texto += `🛒 Ver más productos: ${CONFIG.catalogo}`;

    return texto;
}

function extraerTexto(mensaje) {
    return mensaje.conversation ||
        mensaje.extendedTextMessage?.text ||
        mensaje.imageMessage?.caption ||
        mensaje.videoMessage?.caption ||
        mensaje.buttonsResponseMessage?.selectedButtonId ||
        mensaje.listResponseMessage?.singleSelectReply?.selectedRowId ||
        mensaje.templateButtonReplyMessage?.selectedId ||
        '';
}

function desenvolverMensaje(mensaje) {
    let contenido = mensaje;
    const envolturas = [
        'ephemeralMessage',
        'viewOnceMessage',
        'viewOnceMessageV2',
        'documentWithCaptionMessage',
        'editedMessage'
    ];
    while (contenido) {
        const envoltura = envolturas.find((tipo) => contenido[tipo]?.message);
        if (!envoltura) break;
        contenido = contenido[envoltura].message;
    }
    return contenido || {};
}

function obtenerIdMensajeCitado(mensaje) {
    const contextInfo = mensaje.extendedTextMessage?.contextInfo ||
        mensaje.imageMessage?.contextInfo ||
        mensaje.videoMessage?.contextInfo ||
        mensaje.documentMessage?.contextInfo;
    return contextInfo?.stanzaId || null;
}

function extraerUbicacion(mensaje) {
    const ubicacion = mensaje.locationMessage || mensaje.liveLocationMessage;
    if (!ubicacion || !Number.isFinite(ubicacion.degreesLatitude) ||
        !Number.isFinite(ubicacion.degreesLongitude)) {
        return null;
    }

    const latitud = ubicacion.degreesLatitude;
    const longitud = ubicacion.degreesLongitude;
    return {
        latitud,
        longitud,
        enlace: `https://maps.google.com/?q=${latitud},${longitud}`,
        texto: ubicacion.name || ubicacion.address || ''
    };
}

function obtenerTelefonoJid(jid) {
    const digitos = String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
    return digitos || null;
}

function identificarGerencia(jid, jidAlternativo) {
    const contactos = obtenerContactosGerencia();
    for (const valor of [jid, jidAlternativo]) {
        if (!valor) continue;
        try {
            const telefono = normalizarNumeroWhatsApp(obtenerTelefonoJid(valor));
            const contacto = Object.values(contactos).find((item) => item.telefono === telefono);
            if (contacto) return contacto.tipo;
        } catch (error) {
            continue;
        }
    }
    return null;
}

function esJidGerencia(jid, jidAlternativo) {
    return Boolean(identificarGerencia(jid, jidAlternativo));
}

function crearWaMe(telefono) {
    return `https://wa.me/${String(telefono || '').replace(/\D/g, '')}`;
}

async function enviarNotificacionGerencia(sock, datos, texto, contacto) {
    const notificacion = await crearNotificacion(pool, datos);

    try {
        const resultado = await sock.sendMessage(contacto.jid, { text: texto });
        if (!resultado?.key?.id) {
            throw new Error('WhatsApp no devolvió el identificador del mensaje enviado.');
        }
        await registrarMensajeGerencia(pool, notificacion.id, resultado.key.id);
        return notificacion.referencia;
    } catch (error) {
        await marcarNotificacionFallida(pool, notificacion.id, error.message);
        throw error;
    }
}

function obtenerContactosNotificacion(tipo) {
    return obtenerContactosParaNotificacion(tipo);
}

async function enviarNotificacionContactos(sock, datos, texto, tipoContacto, referencia) {
    const contactos = obtenerContactosNotificacion(tipoContacto);
    const resultados = await Promise.allSettled(contactos.map((contacto) => {
        const sufijo = contacto.tipo === 'delivery' ? 'D' : 'E';
        const refContacto = `${referencia}-${sufijo}`;
        return enviarNotificacionGerencia(
            sock,
            { ...datos, referencia: refContacto },
            texto,
            contacto
        );
    }));
    const errores = resultados
        .filter((resultado) => resultado.status === 'rejected')
        .map((resultado) => resultado.reason);
    if (errores.length > 0) {
        throw new AggregateError(errores, 'No se pudo entregar la notificación a todos los contactos asignados.');
    }
    return referencia;
}

async function notificarProductoNoDisponible(sock, datosCliente, consulta) {
    return enviarNotificacionContactos(sock, {
        tipo: 'consulta',
        referencia: datosCliente.referencia,
        clientJid: datosCliente.jid,
        nombre: datosCliente.nombre,
        telefono: datosCliente.telefono,
        detalle: consulta
    }, [
        '🔎 CONSULTA DE PRODUCTO PARA VENTAS',
        `🏷️ Referencia interna: ${datosCliente.referencia}`,
        `👤 Cliente: ${datosCliente.nombre}`,
        `📱 Teléfono: ${datosCliente.telefono} (${crearWaMe(datosCliente.telefono)})`,
        `🛒 Consulta exacta: ${consulta}`
    ].join('\n'), 'consulta', datosCliente.referencia);
}

function textoOpcionesEntrega() {
    return '¿Cómo deseas recibir tu pedido?\n\n' +
        '1️⃣ Delivery Local\n' +
        '2️⃣ Envío Nacional (Zoom / MRW)\n\n' +
        'Responde 1 o 2.';
}

async function iniciarDatosEntrega(sock, jid, sesion) {
    const cliente = await buscarClientePorTelefono(pool, sesion.telefono);
    if (cliente) {
        sesion.cliente = {
            nombre: cliente.nombre || sesion.nombreWhatsApp,
            cedula: cliente.cedula
        };
        if (sesion.cliente.cedula) {
            sesion.etapa = 'metodo_entrega';
            guardarSesion(jid, sesion);
            await sock.sendMessage(jid, { text: textoOpcionesEntrega() });
            return;
        }
        sesion.cliente.nombre = cliente.nombre || sesion.nombreWhatsApp;
        sesion.etapa = 'cedula';
        guardarSesion(jid, sesion);
        await sock.sendMessage(jid, {
            text: 'Para registrar el pedido, envíame la cédula del destinatario.'
        });
        return;
    }

    sesion.cliente = {};
    sesion.etapa = 'nombre';
    guardarSesion(jid, sesion);
    await sock.sendMessage(jid, {
        text: 'Para registrar tu pedido, envíame tu nombre y apellido completos.'
    });
}

function crearFichaDespacho(pedido, referencia) {
    const listaProductos = pedido.detalles.map((producto) =>
        `• ${producto.nombre_producto} (${producto.codigo || `ID ${producto.id_producto}`}) x ${producto.cantidad}`
    ).join('\n');
    const entrega = pedido.metodoEntrega === 'Delivery Local'
        ? pedido.datosEntrega.ubicacion?.enlace || pedido.datosEntrega.direccion
        : [
            `Estado: ${pedido.datosEntrega.estado}`,
            `Ciudad: ${pedido.datosEntrega.ciudad}`,
            `Agencia: ${pedido.datosEntrega.agencia}`,
            `Cédula destinatario: ${pedido.datosEntrega.cedula_destinatario}`,
            `Teléfono de contacto: ${pedido.datosEntrega.telefono_contacto}`
        ].join('\n');

    return [
        '📦 NUEVO PEDIDO CON DESPACHO',
        `🏷️ Referencia interna: ${referencia}`,
        `🧾 Pedido: ${pedido.codigo}`,
        `👤 Cliente: ${pedido.nombre}`,
        `📱 Teléfono: ${pedido.telefono} (${crearWaMe(pedido.telefono)})`,
        `🛒 Productos solicitados:\n${listaProductos}`,
        `💵 Total: $${pedido.total.toFixed(2)}`,
        `🚚 Método de entrega: ${pedido.metodoEntrega}`,
        `📍 Ubicación / Datos de envío:\n${entrega}`
    ].join('\n\n');
}

async function solicitarConfirmacionPedido(sock, jid, sesion) {
    sesion.etapa = 'confirmar_pedido';
    guardarSesion(jid, sesion);

    const productos = sesion.carrito.map((item) =>
        `• ${item.nombre_producto} x ${item.cantidad} ($${(item.precio * item.cantidad).toFixed(2)})`
    ).join('\n');
    const entrega = sesion.metodoEntrega === 'Delivery Local'
        ? sesion.datosEntrega.ubicacion?.enlace || sesion.datosEntrega.direccion
        : `${sesion.datosEntrega.agencia}, ${sesion.datosEntrega.ciudad}, ${sesion.datosEntrega.estado}`;

    await sock.sendMessage(jid, {
        text: `Revisa tu pedido:\n${productos}\n\n` +
            `🚚 ${sesion.metodoEntrega}: ${entrega}\n\n` +
            'Responde *CONFIRMAR* para registrar el pedido o *CANCELAR* para descartarlo. ' +
            'El inventario y los precios se validarán al confirmar.'
    });
}

async function finalizarPedido(sock, jid, sesion) {
    const pedido = await crearPedidoWhatsApp(pool, {
        telefono: sesion.telefono,
        nombre: sesion.cliente.nombre,
        cedula: sesion.cliente.cedula,
        carrito: sesion.carrito,
        metodoEntrega: sesion.metodoEntrega,
        datosEntrega: sesion.datosEntrega
    });
    limpiarSesion(jid);

    try {
        const referencia = await enviarNotificacionContactos(sock, {
            tipo: 'pedido',
            idSolicitud: pedido.idSolicitud,
            clientJid: jid,
            nombre: pedido.nombre,
            telefono: pedido.telefono,
            detalle: JSON.stringify({
                metodoEntrega: pedido.metodoEntrega,
                datosEntrega: pedido.datosEntrega
            })
        }, crearFichaDespacho(pedido, pedido.codigo),
        pedido.metodoEntrega === 'Delivery Local' ? 'pedido' : 'envio',
        pedido.codigo);

        await sock.sendMessage(jid, {
            text: `✅ Pedido ${pedido.codigo} registrado y enviado a gerencia para coordinar el despacho.\n` +
                `🚚 Entrega: ${pedido.metodoEntrega}.\n` +
                `Referencia: ${referencia}.`
        });
    } catch (error) {
        console.error(`Pedido ${pedido.codigo} registrado, pero falló la notificación a gerencia:`, error.message);
        await sock.sendMessage(jid, {
            text: `✅ Tu pedido ${pedido.codigo} quedó registrado, pero no se pudo notificar a gerencia en este momento. ` +
                'Por favor, contacta directamente a la tienda para confirmar el despacho.'
        });
    }
}

async function procesarFlujoPedido(sock, jid, texto, ubicacion, sesion) {
    if (sesion.etapa === 'cantidad') {
        const match = texto.trim().match(/^(?:cantidad\s*)?(\d+)$/i);
        const cantidad = match ? Number(match[1]) : 0;
        if (!Number.isSafeInteger(cantidad) || cantidad < 1) {
            await sock.sendMessage(jid, { text: 'Envíame una cantidad entera mayor que cero.' });
            return true;
        }
        if (cantidad > Number(sesion.producto.stock_actual)) {
            await sock.sendMessage(jid, {
                text: `Solo quedan ${sesion.producto.stock_actual} unidades disponibles. Indica otra cantidad.`
            });
            return true;
        }

        const item = {
            id_producto: sesion.producto.id_producto,
            cantidad,
            nombre_producto: sesion.producto.nombre_producto,
            codigo: sesion.producto.codigo,
            precio: Number(sesion.producto.precio)
        };
        if (sesion.productoAdicional) {
            sesion.carrito.push(item);
            sesion.productoAdicional = false;
        } else {
            sesion.carrito = [item];
        }
        sesion.etapa = 'mas_productos';
        guardarSesion(jid, sesion);
        await sock.sendMessage(jid, {
            text: '¿Quieres agregar otro producto?\nResponde *sí* para buscar otro o *no* para continuar.'
        });
        return true;
    }

    if (sesion.etapa === 'mas_productos') {
        const opcion = sinAcentos(texto).trim().toLowerCase();
        if (['si', 'sí', 's', 'otro', 'agregar'].includes(opcion)) {
            sesion.etapa = 'busqueda_adicional';
            guardarSesion(jid, sesion);
            await sock.sendMessage(jid, { text: '¿Qué otro repuesto buscas?' });
            return true;
        }
        if (['no', 'n', 'continuar', 'listo'].includes(opcion)) {
            await iniciarDatosEntrega(sock, jid, sesion);
            return true;
        }
        await sock.sendMessage(jid, { text: 'Responde *sí* para agregar otro producto o *no* para continuar.' });
        return true;
    }

    if (sesion.etapa === 'busqueda_adicional') {
        const productos = await buscarProductos(texto);
        if (productos.length === 0) {
            const referencia = `CONS-${Date.now().toString(36).toUpperCase()}`;
            try {
                await notificarProductoNoDisponible(sock, {
                    jid,
                    nombre: sesion.nombreWhatsApp,
                    telefono: sesion.telefono,
                    referencia
                }, texto);
                await sock.sendMessage(jid, {
                    text: `No encontré disponibilidad para "${texto}". Envié la consulta a ventas. ` +
                        `Referencia: ${referencia}. Puedes buscar otro producto o responder *no*.`
                });
            } catch (error) {
                console.error(`No se pudo remitir la consulta ${referencia} a gerencia:`, error.message);
                await sock.sendMessage(jid, {
                    text: 'No se pudo comunicar la consulta a ventas. Puedes buscar otro producto o responder *no*.'
                });
            }
            return true;
        }

        const tasa = await obtenerTasa();
        sesion.etapa = 'seleccion_adicional';
        sesion.productos = productos;
        guardarSesion(jid, sesion);
        await sock.sendMessage(jid, {
            text: `${formatearProductos(productos, tasa)}\n\nResponde con el número del producto.`
        });
        return true;
    }

    if (sesion.etapa === 'confirmar_pedido') {
        const respuesta = sinAcentos(texto).trim().toLowerCase();
        if (['confirmar', 'si', 's', '1'].includes(respuesta)) {
            await finalizarPedido(sock, jid, sesion);
        } else {
            await sock.sendMessage(jid, {
                text: 'Responde *CONFIRMAR* para registrar el pedido o *CANCELAR* para descartarlo.'
            });
        }
        return true;
    }

    if (sesion.etapa === 'nombre') {
        if (texto.trim().length < 3) {
            await sock.sendMessage(jid, { text: 'Envíame tu nombre y apellido completos.' });
            return true;
        }
        sesion.cliente.nombre = texto.trim();
        sesion.etapa = 'cedula';
        guardarSesion(jid, sesion);
        await sock.sendMessage(jid, { text: 'Ahora envíame tu cédula.' });
        return true;
    }

    if (sesion.etapa === 'cedula') {
        const cedula = texto.trim();
        if (!cedula || cedula.length > 32) {
            await sock.sendMessage(jid, { text: 'La cédula no es válida. Inténtalo nuevamente.' });
            return true;
        }
        sesion.cliente.cedula = cedula;
        sesion.etapa = 'metodo_entrega';
        guardarSesion(jid, sesion);
        await sock.sendMessage(jid, { text: textoOpcionesEntrega() });
        return true;
    }

    if (sesion.etapa === 'metodo_entrega') {
        const opcion = sinAcentos(texto).trim().toLowerCase();
        if (opcion === '1' || opcion.includes('delivery') || opcion.includes('local')) {
            sesion.metodoEntrega = 'Delivery Local';
            sesion.etapa = 'delivery_direccion';
            guardarSesion(jid, sesion);
            await sock.sendMessage(jid, {
                text: 'Compárteme tu ubicación por WhatsApp (punto GPS o ubicación en tiempo real) o escribe tu dirección exacta.'
            });
            return true;
        }
        if (opcion === '2' || opcion.includes('zoom') || opcion.includes('mrw') || opcion.includes('nacional')) {
            sesion.metodoEntrega = 'Envío Nacional';
            sesion.datosEntrega = {};
            sesion.etapa = 'envio_estado';
            guardarSesion(jid, sesion);
            await sock.sendMessage(jid, { text: 'Indica el estado de destino.' });
            return true;
        }
        await sock.sendMessage(jid, { text: 'Responde 1 para Delivery Local o 2 para Envío Nacional (Zoom / MRW).' });
        return true;
    }

    if (sesion.etapa === 'delivery_direccion') {
        if (ubicacion) {
            sesion.datosEntrega = {
                ubicacion,
                direccion: ubicacion.texto || null
            };
        } else if (texto.trim()) {
            sesion.datosEntrega = { direccion: texto.trim() };
        } else {
            await sock.sendMessage(jid, { text: 'Comparte un punto GPS o escribe tu dirección exacta.' });
            return true;
        }
        await solicitarConfirmacionPedido(sock, jid, sesion);
        return true;
    }

    const camposEnvio = {
        envio_estado: {
            campo: 'estado',
            siguiente: 'envio_ciudad',
            pregunta: 'Indica la ciudad de destino.'
        },
        envio_ciudad: {
            campo: 'ciudad',
            siguiente: 'envio_agencia',
            pregunta: 'Indica el nombre de la agencia Zoom o MRW donde retirarás el envío.'
        },
        envio_agencia: {
            campo: 'agencia',
            siguiente: 'envio_cedula',
            pregunta: 'Indica la cédula de la persona destinataria.'
        },
        envio_cedula: {
            campo: 'cedula_destinatario',
            siguiente: 'envio_telefono',
            pregunta: 'Indica el teléfono de contacto del destinatario.'
        },
        envio_telefono: {
            campo: 'telefono_contacto',
            siguiente: null,
            pregunta: null
        }
    };
    const campo = camposEnvio[sesion.etapa];
    if (!campo) return false;

    const valor = texto.trim();
    if (!valor) {
        await sock.sendMessage(jid, { text: 'Ese dato es obligatorio. Inténtalo nuevamente.' });
        return true;
    }
    if (sesion.etapa === 'envio_telefono' && valor.replace(/\D/g, '').length < 8) {
        await sock.sendMessage(jid, { text: 'Ese teléfono parece incompleto. Envíalo con su código de área.' });
        return true;
    }

    sesion.datosEntrega[campo.campo] = valor;
    if (campo.siguiente) {
        sesion.etapa = campo.siguiente;
        guardarSesion(jid, sesion);
        await sock.sendMessage(jid, { text: campo.pregunta });
    } else {
        await solicitarConfirmacionPedido(sock, jid, sesion);
    }
    return true;
}

async function procesarMensaje(sock, msg) {
    if (!msg?.message || msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    if (!jid || esMensajeDeGrupo(jid)) return;

    const mensaje = desenvolverMensaje(msg.message);
    const texto = extraerTexto(mensaje);
    const ubicacion = extraerUbicacion(msg.message);
    const jidAlternativo = msg.key.remoteJidAlt;

    const tipoGerencia = identificarGerencia(jid, jidAlternativo);
    if (tipoGerencia) {
        if (!texto.trim()) return;

        let respuestaEntregada = false;
        try {
            const stanzaId = obtenerIdMensajeCitado(mensaje);
            let notificacion;
            if (stanzaId) {
                notificacion = await buscarNotificacionPorMensaje(pool, stanzaId, tipoGerencia);
                if (!notificacion) {
                    await sock.sendMessage(jid, {
                        text: 'No pude identificar la notificación citada. Responde directamente al mensaje original enviado por el bot.'
                    });
                    return;
                }
            } else {
                const pendientes = await buscarNotificacionesPendientesGerencia(pool, tipoGerencia);
                if (pendientes.length !== 1) {
                    await sock.sendMessage(jid, {
                        text: pendientes.length > 1
                            ? 'Hay varias consultas pendientes. Para evitar enviar tu respuesta al cliente equivocado, usa *Responder* sobre la notificación correspondiente.'
                            : 'No encontré una consulta pendiente para este número. Responde usando *Responder* sobre la notificación original del bot.'
                    });
                    return;
                }
                [notificacion] = pendientes;
            }

            if (notificacion.estado !== 'enviada') {
                await sock.sendMessage(jid, {
                    text: 'Esta notificación ya fue respondida anteriormente.'
                });
                return;
            }

            await sock.sendMessage(notificacion.client_jid, {
                text: `💬 Respuesta de gerencia:\n\n${texto.trim()}`
            });
            respuestaEntregada = true;
            const respuestaRegistrada = await registrarRespuestaGerencia(pool, notificacion.id, texto.trim());
            if (respuestaRegistrada) {
                await sock.sendMessage(jid, {
                    text: `🙏 ¡Muchas gracias por la atención! ✅ Tu respuesta fue enviada al cliente ${notificacion.client_name}.`
                });
            } else {
                await sock.sendMessage(jid, {
                    text: 'El mensaje llegó al cliente, pero no pude actualizar el estado de la notificación. Revisa los registros del bot.'
                });
            }
        } catch (error) {
            console.error('Error reenviando la respuesta de gerencia al cliente:', error);
            await sock.sendMessage(jid, {
                text: respuestaEntregada
                    ? 'El mensaje llegó al cliente, pero ocurrió un problema al actualizar la notificación. El bot registró el error.'
                    : 'No pude reenviar tu respuesta al cliente en este momento. El bot registró el error; intenta nuevamente más tarde.'
            });
        }
        return;
    }

    const numeroCliente = obtenerTelefonoJid(jidAlternativo || jid);
    if (!numeroCliente) {
        console.error('No se pudo obtener el teléfono del remitente de WhatsApp.');
        return;
    }

    const pushName = (msg.pushName || 'Cliente').trim();
    const sesion = obtenerSesion(jid);
    if (sesion && texto.trim().toLowerCase() === 'cancelar') {
        limpiarSesion(jid);
        await sock.sendMessage(jid, { text: 'Pedido cancelado. Cuando quieras, dime qué repuesto buscas.' });
        return;
    }

    if (sesion?.etapa && sesion.etapa !== 'resultados') {
        const manejado = await procesarFlujoPedido(sock, jid, texto, ubicacion, sesion);
        if (manejado) return;
    }

    if (!texto.trim()) return;
    if (esMensajeVacio(texto)) return;
    if (esListaDePrecios(texto)) return;
    if (esMensajePropioDelNegocio(texto)) return;

    console.log(`📩 [${pushName}]: ${texto}`);
    try {
        await sock.sendPresenceUpdate('composing', jid);
    } catch (error) {
        console.warn('No se pudo actualizar la presencia de WhatsApp:', error.message);
    }

    if (sesion && ['resultados', 'seleccion_adicional'].includes(sesion.etapa)) {
        const seleccion = detectarSeleccion(texto);
        if (seleccion) {
            const productoElegido = resolverSeleccion(sesion, seleccion);
            if (productoElegido) {
                const esAdicional = sesion.etapa === 'seleccion_adicional';
                const tasa = await obtenerTasa();
                sesion.producto = productoElegido;
                sesion.productoAdicional = esAdicional;
                if (!esAdicional) sesion.carrito = [];
                sesion.nombreWhatsApp = pushName;
                sesion.telefono = numeroCliente;
                sesion.etapa = 'cantidad';
                guardarSesion(jid, sesion);
                const respuesta = respuestaSeleccion(productoElegido, tasa) +
                    '\n\n¿Cuántas unidades deseas?';
                await sock.sendMessage(jid, { text: respuesta });
                return;
            }
        }
    }

    const intencion = detectarIntencion(texto);
    switch (intencion) {
        case 'ubicacion':
            await sock.sendMessage(jid, { text: respuestaUbicacion() });
            return;
        case 'saludo':
            await sock.sendMessage(jid, { text: respuestaSaludo(pushName) });
            return;
        case 'gracias':
            await sock.sendMessage(jid, { text: respuestaGracias() });
            return;
        case 'horario':
            await sock.sendMessage(jid, { text: respuestaHorario() });
            return;
        default: {
            const productos = await buscarProductos(texto);
            if (productos.length > 0) {
                const tasa = await obtenerTasa();
                guardarSesion(jid, {
                    etapa: 'resultados',
                    productos,
                    nombreWhatsApp: pushName,
                    telefono: numeroCliente
                });
                await sock.sendMessage(jid, { text: formatearProductos(productos, tasa) });
                return;
            }

            const referencia = `CONS-${Date.now().toString(36).toUpperCase()}`;
            try {
                await notificarProductoNoDisponible(sock, {
                    jid,
                    nombre: pushName,
                    telefono: numeroCliente,
                    referencia
                }, texto);
                await sock.sendMessage(jid, {
                    text: `No encontré disponibilidad en el inventario para "${texto}". ` +
                        'Envié tu consulta al área de ventas para verificar depósitos y proveedores. ' +
                        `Referencia: ${referencia}.`
                });
            } catch (error) {
                console.error(`No se pudo remitir la consulta ${referencia} a gerencia:`, error.message);
                await sock.sendMessage(jid, {
                    text: 'No encontré disponibilidad y no pude comunicar la consulta a ventas en este momento. ' +
                        'Por favor, contacta directamente a la tienda.'
                });
            }
        }
    }
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
    activeSocket = sock;

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n📱 Escanea este QR con tu WhatsApp:\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = !shuttingDown &&
                lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('⚠️  Conexión cerrada. Reconectando...', shouldReconnect);
            if (shouldReconnect) {
                setTimeout(() => {
                    if (!shuttingDown) iniciarBot().catch((error) => {
                        console.error('Error al reconectar el bot:', error);
                    });
                }, 3000);
            }
        } else if (connection === 'open') {
            console.log('✅ ¡Bot conectado a WhatsApp!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            try {
                await procesarMensaje(sock, msg);
            } catch (error) {
                console.error('Error procesando mensaje entrante:', error);
                const jid = msg?.key?.remoteJid;
                if (jid && !esMensajeDeGrupo(jid) && !esJidGerencia(jid, msg.key.remoteJidAlt)) {
                    try {
                        await sock.sendMessage(jid, {
                            text: 'Ocurrió un problema temporal al consultar el inventario o procesar tu pedido. ' +
                                'No se confirmó ninguna operación; inténtalo nuevamente en unos minutos.'
                        });
                    } catch (sendError) {
                        console.error('No se pudo enviar el aviso de error al cliente:', sendError.message);
                    }
                }
            }
        }
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

async function cerrarServicio(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Cerrando servicio (${signal})...`);

    if (activeSocket) {
        await activeSocket.end(new Error('Servicio en cierre.'));
    }
    if (httpServer) {
        await new Promise((resolve) => httpServer.close(resolve));
    }
    if (pool) {
        await pool.end();
        pool = null;
    }
    if (pgPool) {
        await pgPool.end();
        pgPool = null;
    }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
        cerrarServicio(signal).catch((error) => {
            console.error('Error durante el cierre:', error);
            process.exitCode = 1;
        });
    });
}