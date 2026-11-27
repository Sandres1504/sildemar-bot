const test = require('node:test');
const assert = require('node:assert/strict');
const {
    asegurarTablasWhatsApp,
    buscarPrepedidoActivo,
    buscarNotificacionPorMensaje,
    buscarNotificacionesPendientesGerencia,
    cancelarNotificacionesCliente,
    crearPedidoWhatsApp,
    obtenerContactosGerencia,
    obtenerContactosParaNotificacion,
    obtenerTelefonoDueno,
    normalizarNumeroWhatsApp,
    registrarFeedbackIA,
    obtenerFeedbackIA,
    registrarMensajeGerencia,
    registrarDecisionPrepedido,
    cancelarPrepedido
} = require('../whatsapp-service');

test('crea las tablas auxiliares de WhatsApp si aún no existen', async () => {
    const statements = [];
    await asegurarTablasWhatsApp({
        async execute(sql) {
            statements.push(sql);
            return sql.includes('information_schema.COLUMNS') ? [[]] : [{}];
        }
    });

    assert.equal(statements.length, 6);
    assert.match(statements[0], /CREATE TABLE IF NOT EXISTS whatsapp_solicitudes/);
    assert.match(statements[1], /CREATE TABLE IF NOT EXISTS whatsapp_notificaciones/);
    assert.match(statements[3], /CREATE TABLE IF NOT EXISTS whatsapp_ia_feedback/);
    assert.match(statements[5], /ADD COLUMN metodo_pago VARCHAR\(32\)/);
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

test('normalizes the optional owner phone used by administrative commands', () => {
    assert.equal(obtenerTelefonoDueno({ OWNER_PHONE: '04121234567' }), '584121234567');
    assert.equal(obtenerTelefonoDueno({}), null);
});

test('busca una respuesta citada solo entre las notificaciones de ese gerente', async () => {
    let consulta;
    let parametros;
    const resultadoEsperado = { id: 3, estado: 'enviada', tipo: 'prepedido', referencia: 'PRE-123-D' };
    const pool = {
        async execute(sql, valores) {
            consulta = sql;
            parametros = valores;
            return [[resultadoEsperado]];
        }
    };

    const resultado = await buscarNotificacionPorMensaje(pool, 'mensaje-123', 'envio');

    assert.equal(resultado, resultadoEsperado);
    assert.match(consulta, /m\.manager_message_id = \? AND n\.referencia LIKE \?/);
    assert.deepEqual(parametros, ['mensaje-123', '%-E']);
});

test('loads, approves, rejects, and cancels pre-orders with guarded status updates', async () => {
    const calls = [];
    const pool = {
        async execute(sql, params) {
            calls.push({ sql, params });
            if (sql.includes('SELECT id, referencia')) {
                return [[{ id: 9, estado: 'enviada', tipo: 'prepedido', detalle: '{}' }]];
            }
            return [{ affectedRows: 1 }];
        }
    };

    const active = await buscarPrepedidoActivo(pool, 'client-jid');
    assert.equal(active.id, 9);
    assert.deepEqual(calls[0].params, ['client-jid']);

    assert.equal(await registrarDecisionPrepedido(pool, 9, 'aprobada', 'APROBAR'), true);
    assert.equal(await registrarDecisionPrepedido(pool, 9, 'rechazada', 'RECHAZAR: sin stock'), true);
    await assert.rejects(registrarDecisionPrepedido(pool, 9, 'enviada', 'texto'), /decisión.*no es válida/i);
    assert.equal(await cancelarPrepedido(pool, 9, 'client-jid'), true);

    assert.match(calls[1].sql, /estado = 'enviada'/);
    assert.deepEqual(calls[1].params, ['aprobada', 'APROBAR', 9]);
    assert.match(calls[3].sql, /estado IN \('enviada', 'aprobada'\)/);
});

test('stores aggregate AI feedback by approved category without conversation content', async () => {
    const calls = [];
    const feedback = [{ categoria: 'cashea', ocurrencias: 2 }];
    const pool = {
        async execute(sql, params) {
            calls.push({ sql, params });
            return [feedback];
        }
    };

    await registrarFeedbackIA(pool, 'cashea');
    assert.deepEqual(await obtenerFeedbackIA(pool), feedback);
    assert.match(calls[0].sql, /ocurrencias = ocurrencias \+ 1/);
    assert.deepEqual(calls[0].params, ['cashea']);
    await assert.rejects(registrarFeedbackIA(pool, 'texto-libre'), /categoría.*no es válida/i);
});

test('cancels outstanding sales notifications after a client requests no contact', async () => {
    let sql;
    let params;
    const cantidadCancelada = await cancelarNotificacionesCliente({
        async execute(statement, values) {
            sql = statement;
            params = values;
            return [{ affectedRows: 2 }];
        }
    }, 'cliente@s.whatsapp.net');

    assert.equal(cantidadCancelada, 2);
    assert.match(sql, /estado IN \('pendiente', 'enviada', 'aprobada'\)/);
    assert.deepEqual(params, ['cliente@s.whatsapp.net']);
});

test('does not reopen cancelled notifications when registering the manager message', async () => {
    let statement;
    const calls = [];
    const registered = await registrarMensajeGerencia({
        async execute(sql) {
            calls.push(sql);
            statement = sql;
            return [{ affectedRows: 0 }];
        }
    }, 7, 'manager-message');

    assert.equal(registered, false);
    assert.match(statement, /estado IN \('pendiente', 'enviada'\)/);
    assert.equal(calls.length, 1);
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

function crearPoolSimulado(stock = 10, fallaReserva = false, fallaPreaprobacion = false, precioActual = 25) {
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
            if (sql.includes("SET estado = 'registrando'")) {
                return [{ affectedRows: fallaPreaprobacion ? 0 : 1 }];
            }
            if (sql.includes('SELECT detalle FROM whatsapp_notificaciones')) {
                return [[{
                    detalle: JSON.stringify({
                        carrito: [{ id_producto: 7, cantidad: 2, precio: 25 }],
                        metodoEntrega: 'Delivery Local',
                        metodoPago: 'Efectivo',
                        nivelCashea: null
                    })
                }]];
            }
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
                    precio: precioActual,
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
    metodoPago: 'Efectivo',
    datosEntrega: { direccion: 'Av. Principal' }
};

test('creates an approved request, records payment method, and commits the transaction', async () => {
    const { pool, estado } = crearPoolSimulado();

    const resultado = await crearPedidoWhatsApp(pool, { ...pedido, preaprobacionId: 99 });

    assert.equal(resultado.idSolicitud, 56);
    assert.equal(resultado.codigo, 'SOL-000056');
    assert.equal(resultado.total, 50);
    assert.equal(resultado.detalles[0].cantidad, 2);
    assert.equal(estado.iniciada, true);
    assert.equal(estado.confirmada, true);
    assert.equal(estado.revertida, false);
    assert.equal(estado.liberada, true);
    assert.ok(estado.statements.some((sql) => sql.includes('INSERT INTO whatsapp_solicitudes')));
    assert.ok(estado.statements.some((sql) => sql.includes('metodo_pago')));
    assert.ok(estado.statements.some((sql) => sql.includes('INSERT INTO detalle_solicitud')));
});

test('creates an approved WhatsApp pre-order transactionally before reserving stock', async () => {
    const { pool, estado } = crearPoolSimulado();

    const resultado = await crearPedidoWhatsApp(pool, { ...pedido, preaprobacionId: 99 });

    assert.equal(resultado.metodoPago, 'Efectivo');
    assert.equal(estado.confirmada, true);
    assert.ok(estado.statements.some((sql) => sql.includes("SET estado = 'registrando'")));
    assert.ok(estado.statements.some((sql) => sql.includes("SET estado = 'completada'")));
});

test('requires a pre-approval and rejects a price that changed after manager review', async () => {
    await assert.rejects(
        crearPedidoWhatsApp({ async getConnection() { throw new Error('must not connect'); } }, pedido),
        /Se requiere una preaprobación vigente/
    );

    const { pool, estado } = crearPoolSimulado(10, false, false, 30);
    await assert.rejects(
        crearPedidoWhatsApp(pool, { ...pedido, preaprobacionId: 99 }),
        { code: 'PREAPROBACION_DESACTUALIZADA' }
    );
    assert.equal(estado.confirmada, false);
    assert.equal(estado.revertida, true);
    assert.equal(estado.statements.some((sql) => sql.includes('INSERT INTO solicitud')), false);
});

test('refuses to create a request without a live manager pre-approval', async () => {
    const { pool, estado } = crearPoolSimulado(10, false, true);

    await assert.rejects(
        crearPedidoWhatsApp(pool, { ...pedido, preaprobacionId: 99 }),
        /requiere aprobación vigente/
    );

    assert.equal(estado.confirmada, false);
    assert.equal(estado.revertida, true);
    assert.equal(estado.statements.some((sql) => sql.includes('INSERT INTO solicitud')), false);
});

test('revierte todos los cambios si no puede reservar el stock', async () => {
    const { pool, estado } = crearPoolSimulado(1);

    await assert.rejects(
        crearPedidoWhatsApp(pool, { ...pedido, preaprobacionId: 99 }),
        { code: 'PREAPROBACION_DESACTUALIZADA' }
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
        crearPedidoWhatsApp(pool, { ...pedido, preaprobacionId: 99 }),
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
