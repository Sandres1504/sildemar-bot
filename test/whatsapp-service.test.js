const test = require('node:test');
const assert = require('node:assert/strict');
const {
    asegurarTablasWhatsApp,
    buscarNotificacionPorMensaje,
    buscarNotificacionesPendientesGerencia,
    crearPedidoWhatsApp,
    obtenerContactosGerencia,
    obtenerContactosParaNotificacion,
    normalizarNumeroWhatsApp
} = require('../whatsapp-service');

test('crea las tablas auxiliares de WhatsApp si aún no existen', async () => {
    const statements = [];
    await asegurarTablasWhatsApp({
        async execute(sql) {
            statements.push(sql);
        }
    });

    assert.equal(statements.length, 2);
    assert.match(statements[0], /CREATE TABLE IF NOT EXISTS whatsapp_solicitudes/);
    assert.match(statements[1], /CREATE TABLE IF NOT EXISTS whatsapp_notificaciones/);
});

test('normaliza los contactos locales a JID de WhatsApp con código de país', () => {
    const contactos = obtenerContactosGerencia({
        GERENTE_DELIVERY_PHONE: '04142149796',
        GERENTE_SHIPPING_PHONE: '04142522920'
    });

    assert.match(contactos.delivery.jid, /^58\d+@s\.whatsapp\.net$/);
    assert.match(contactos.envio.jid, /^58\d+@s\.whatsapp\.net$/);
    assert.notEqual(contactos.delivery.jid, contactos.envio.jid);
    assert.equal(normalizarNumeroWhatsApp(`+${contactos.delivery.telefono}`), contactos.delivery.telefono);

    assert.deepEqual(
        obtenerContactosParaNotificacion('pedido', {
            GERENTE_DELIVERY_PHONE: '04142149796',
            GERENTE_SHIPPING_PHONE: '04142522920'
        }).map((contacto) => contacto.tipo),
        ['delivery']
    );
    assert.deepEqual(
        obtenerContactosParaNotificacion('envio', {
            GERENTE_DELIVERY_PHONE: '04142149796',
            GERENTE_SHIPPING_PHONE: '04142522920'
        }).map((contacto) => contacto.tipo),
        ['envio']
    );
    assert.deepEqual(
        obtenerContactosParaNotificacion('consulta', {
            GERENTE_DELIVERY_PHONE: '04142149796',
            GERENTE_SHIPPING_PHONE: '04142522920'
        }).map((contacto) => contacto.tipo),
        ['delivery', 'envio']
    );
});

test('usa los contactos predeterminados cuando faltan variables de entorno', () => {
    const contactos = obtenerContactosGerencia({});
    assert.match(contactos.delivery.jid, /^584142149796@s\.whatsapp\.net$/);
    assert.match(contactos.envio.jid, /^584142522920@s\.whatsapp\.net$/);
});

test('rechaza un contacto de gerencia inválido', () => {
    assert.throws(() => normalizarNumeroWhatsApp(''), /no es válido/);
    assert.throws(() => obtenerContactosGerencia({
        GERENTE_DELIVERY_PHONE: '1',
        GERENTE_SHIPPING_PHONE: '04142522920'
    }), /no es válido/);
});

test('busca una respuesta citada solo entre las notificaciones de ese gerente', async () => {
    let consulta;
    let parametros;
    const resultadoEsperado = { id: 3, estado: 'enviada' };
    const pool = {
        async execute(sql, valores) {
            consulta = sql;
            parametros = valores;
            return [[resultadoEsperado]];
        }
    };

    const resultado = await buscarNotificacionPorMensaje(pool, 'mensaje-123', 'envio');

    assert.equal(resultado, resultadoEsperado);
    assert.match(consulta, /manager_message_id = \? AND referencia LIKE \?/);
    assert.deepEqual(parametros, ['mensaje-123', '%-E']);
});

test('solo usa una respuesta sin cita cuando el gerente tiene una notificación pendiente', async () => {
    let parametros;
    const pool = {
        async execute(sql, valores) {
            assert.match(sql, /estado = 'enviada'/);
            assert.match(sql, /ORDER BY creado_en DESC\s+LIMIT 2/);
            parametros = valores;
            return [[{ id: 1 }]];
        }
    };

    const pendientes = await buscarNotificacionesPendientesGerencia(pool, 'delivery');

    assert.deepEqual(pendientes, [{ id: 1 }]);
    assert.deepEqual(parametros, ['%-D']);
});

function crearPoolSimulado(stock = 10, fallaReserva = false) {
    const estado = {
        iniciada: false,
        confirmada: false,
        revertida: false,
        liberada: false,
        statements: []
    };
    const conn = {
        async beginTransaction() {
            estado.iniciada = true;
        },
        async commit() {
            estado.confirmada = true;
        },
        async rollback() {
            estado.revertida = true;
        },
        release() {
            estado.liberada = true;
        },
        async execute(sql) {
            estado.statements.push(sql);
            if (sql.includes('SELECT p.id_persona')) return [[]];
            if (sql.includes('INSERT INTO persona')) return [{ insertId: 12 }];
            if (sql.includes('INSERT INTO cliente')) return [{ insertId: 34 }];
            if (sql.includes('SELECT tasa_dolar')) return [[{ tasa_dolar: 40 }]];
            if (sql.includes('information_schema.COLUMNS')) return [[{ 1: 1 }]];
            if (sql.includes('INSERT INTO solicitud')) return [{ insertId: 56 }];
            if (sql.includes('UPDATE producto')) {
                return [{ affectedRows: !fallaReserva && stock >= 2 ? 1 : 0 }];
            }
            return [{ affectedRows: 1 }];
        },
        async query(sql) {
            estado.statements.push(sql);
            if (sql.includes('FROM producto')) {
                return [[{
                    id_producto: 7,
                    codigo: 'P-7',
                    nombre_producto: 'Amortiguador',
                    precio: 25,
                    stock_actual: stock
                }]];
            }
            return [[]];
        }
    };
    return {
        estado,
        pool: {
            async getConnection() {
                return conn;
            }
        }
    };
}

const pedido = {
    telefono: '584121234567',
    nombre: 'Cliente de Prueba',
    cedula: '12345678',
    carrito: [{ id_producto: 7, cantidad: 2 }],
    metodoEntrega: 'Delivery Local',
    datosEntrega: { direccion: 'Av. Principal' }
};

test('crea el pedido, registra su origen y confirma la transacción', async () => {
    const { pool, estado } = crearPoolSimulado();

    const resultado = await crearPedidoWhatsApp(pool, pedido);

    assert.equal(resultado.idSolicitud, 56);
    assert.equal(resultado.codigo, 'SOL-000056');
    assert.equal(resultado.total, 50);
    assert.equal(resultado.detalles[0].cantidad, 2);
    assert.equal(estado.iniciada, true);
    assert.equal(estado.confirmada, true);
    assert.equal(estado.revertida, false);
    assert.equal(estado.liberada, true);
    assert.ok(estado.statements.some((sql) => sql.includes('INSERT INTO whatsapp_solicitudes')));
    assert.ok(estado.statements.some((sql) => sql.includes('INSERT INTO detalle_solicitud')));
});

test('revierte todos los cambios si no puede reservar el stock', async () => {
    const { pool, estado } = crearPoolSimulado(1);

    await assert.rejects(
        crearPedidoWhatsApp(pool, pedido),
        /Stock insuficiente/
    );

    assert.equal(estado.iniciada, true);
    assert.equal(estado.confirmada, false);
    assert.equal(estado.revertida, true);
    assert.equal(estado.liberada, true);
    assert.equal(
        estado.statements.some((sql) => sql.includes('INSERT INTO whatsapp_solicitudes')),
        false
    );
});

test('revierte los detalles y el pedido si falla la actualización del inventario', async () => {
    const { pool, estado } = crearPoolSimulado(10, true);

    await assert.rejects(
        crearPedidoWhatsApp(pool, pedido),
        /No se pudo reservar el stock/
    );

    assert.equal(estado.confirmada, false);
    assert.equal(estado.revertida, true);
    assert.equal(estado.liberada, true);
    assert.ok(estado.statements.some((sql) => sql.includes('INSERT INTO solicitud')));
    assert.ok(estado.statements.some((sql) => sql.includes('INSERT INTO detalle_solicitud')));
    assert.equal(
        estado.statements.some((sql) => sql.includes('INSERT INTO whatsapp_solicitudes')),
        false
    );
});
