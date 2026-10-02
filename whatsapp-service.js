function normalizarTelefono(telefono) {
    const digitos = String(telefono || '').replace(/\D/g, '');
    if (!digitos) {
        throw new Error('No se pudo obtener el número telefónico del cliente.');
    }

    const ultimosDiez = digitos.slice(-10);
    const candidatos = [digitos, `+${digitos}`, ultimosDiez];
    if (digitos.startsWith('58')) candidatos.push(`0${ultimosDiez}`);
    return {
        almacenado: `+${digitos}`,
        candidatos: [...new Set(candidatos)]
    };
}

function normalizarNumeroWhatsApp(telefono) {
    let digitos = String(telefono || '').replace(/\D/g, '');
    if (digitos.startsWith('00')) digitos = digitos.slice(2);
    if (digitos.length === 11 && digitos.startsWith('0')) {
        digitos = `58${digitos.slice(1)}`;
    }
    if (digitos.length < 8) {
        throw new Error('El número de WhatsApp configurado no es válido.');
    }
    return digitos;
}

const TELEFONOS_GERENCIA_PREDETERMINADOS = {
    delivery: '04142149796',
    envio: '04142522920'
};

function obtenerContactosGerencia(environment = process.env) {
    const delivery = normalizarNumeroWhatsApp(
        environment.GERENTE_DELIVERY_PHONE || TELEFONOS_GERENCIA_PREDETERMINADOS.delivery
    );
    const envio = normalizarNumeroWhatsApp(
        environment.GERENTE_SHIPPING_PHONE || TELEFONOS_GERENCIA_PREDETERMINADOS.envio
    );
    return {
        delivery: { tipo: 'delivery', telefono: delivery, jid: `${delivery}@s.whatsapp.net` },
        envio: { tipo: 'envio', telefono: envio, jid: `${envio}@s.whatsapp.net` }
    };
}

function obtenerContactosParaNotificacion(tipo, environment = process.env) {
    const contactos = obtenerContactosGerencia(environment);
    if (tipo === 'pedido') return [contactos.delivery];
    if (tipo === 'envio') return [contactos.envio];
    return [contactos.delivery, contactos.envio];
}

async function asegurarTablasWhatsApp(pool) {
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS whatsapp_solicitudes (
            id_solicitud BIGINT NOT NULL PRIMARY KEY,
            origen VARCHAR(32) NOT NULL DEFAULT 'whatsapp',
            telefono_cliente VARCHAR(32) NOT NULL,
            metodo_entrega VARCHAR(40) NOT NULL,
            datos_entrega LONGTEXT NOT NULL,
            creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            KEY idx_whatsapp_solicitudes_creado (creado_en),
            KEY idx_whatsapp_solicitudes_origen (origen)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS whatsapp_notificaciones (
            id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            referencia VARCHAR(40) NOT NULL,
            tipo VARCHAR(20) NOT NULL,
            id_solicitud BIGINT NULL,
            client_jid VARCHAR(191) NOT NULL,
            client_name VARCHAR(191) NOT NULL,
            client_phone VARCHAR(32) NOT NULL,
            detalle LONGTEXT NOT NULL,
            manager_message_id VARCHAR(191) NULL,
            estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
            respuesta_gerencia LONGTEXT NULL,
            detalle_error VARCHAR(1000) NULL,
            creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            respondida_en DATETIME NULL,
            UNIQUE KEY uq_whatsapp_notificaciones_referencia (referencia),
            UNIQUE KEY uq_whatsapp_notificaciones_manager_message (manager_message_id),
            KEY idx_whatsapp_notificaciones_estado (estado),
            KEY idx_whatsapp_notificaciones_solicitud (id_solicitud)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

async function buscarPersonaCliente(conn, telefono, cedula = null, lock = false) {
    const { candidatos } = normalizarTelefono(telefono);
    const condiciones = [`p.telefono IN (${candidatos.map(() => '?').join(', ')})`];
    const parametros = [...candidatos];

    if (cedula) {
        condiciones.push('p.cedula = ?');
        parametros.push(cedula);
    }

    const [rows] = await conn.execute(
        `SELECT p.id_persona, p.nombre, p.cedula, p.telefono, p.direccion, c.id_cliente,
                CASE WHEN p.telefono IN (${candidatos.map(() => '?').join(', ')})
                     THEN 1 ELSE 0 END AS coincide_telefono
         FROM persona p
         LEFT JOIN cliente c ON c.id_persona = p.id_persona
         WHERE (${condiciones.join(' OR ')})
         ORDER BY (c.id_cliente IS NOT NULL) DESC
         LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
        [...candidatos, ...parametros]
    );
    return rows[0] || null;
}

async function buscarClientePorTelefono(pool, telefono) {
    const conn = await pool.getConnection();
    try {
        return await buscarPersonaCliente(conn, telefono);
    } finally {
        conn.release();
    }
}

async function crearPedidoWhatsApp(pool, { telefono, nombre, cedula, carrito, metodoEntrega, datosEntrega }) {
    if (!Array.isArray(carrito) || carrito.length === 0) {
        throw new Error('El pedido no contiene productos.');
    }
    if (!String(nombre || '').trim() || !String(cedula || '').trim()) {
        throw new Error('Se requiere el nombre completo y la cédula del cliente.');
    }
    if (!['Delivery Local', 'Envío Nacional'].includes(metodoEntrega)) {
        throw new Error('El método de entrega no es válido.');
    }
    if (metodoEntrega === 'Delivery Local' &&
        !datosEntrega?.ubicacion && !String(datosEntrega?.direccion || '').trim()) {
        throw new Error('Debes compartir una ubicación GPS o una dirección para el delivery.');
    }
    if (metodoEntrega === 'Envío Nacional' &&
        !['estado', 'ciudad', 'agencia', 'cedula_destinatario', 'telefono_contacto']
            .every((campo) => String(datosEntrega?.[campo] || '').trim())) {
        throw new Error('Faltan datos obligatorios para el envío nacional.');
    }

    const { almacenado } = normalizarTelefono(telefono);
    const conn = await pool.getConnection();
    let transaccionIniciada = false;

    try {
        await conn.beginTransaction();
        transaccionIniciada = true;

        let persona = await buscarPersonaCliente(conn, telefono, cedula, true);
        let idCliente;

        if (!persona) {
            const [insertPersona] = await conn.execute(
                `INSERT INTO persona (cedula, nombre, direccion, telefono, correo)
                 VALUES (?, ?, ?, ?, NULL)`,
                [String(cedula).trim(), String(nombre).trim(), datosEntrega.direccion || null, almacenado]
            );
            const idPersona = insertPersona.insertId;
            const [insertCliente] = await conn.execute(
                'INSERT INTO cliente (id_persona) VALUES (?)',
                [idPersona]
            );
            idCliente = insertCliente.insertId;
        } else {
            idCliente = persona.id_cliente;
            if (!idCliente) {
                const [insertCliente] = await conn.execute(
                    'INSERT INTO cliente (id_persona) VALUES (?)',
                    [persona.id_persona]
                );
                idCliente = insertCliente.insertId;
            }

            const updateFields = [];
            const updateValues = [];
            if (!persona.telefono || !persona.coincide_telefono) {
                updateFields.push('telefono = ?');
                updateValues.push(almacenado);
            }
            if (!persona.nombre && nombre) {
                updateFields.push('nombre = ?');
                updateValues.push(String(nombre).trim());
            }
            if (!persona.cedula && cedula) {
                updateFields.push('cedula = ?');
                updateValues.push(String(cedula).trim());
            }
            if (updateFields.length > 0) {
                updateValues.push(persona.id_persona);
                await conn.execute(
                    `UPDATE persona SET ${updateFields.join(', ')} WHERE id_persona = ?`,
                    updateValues
                );
            }
        }

        const cantidades = new Map();
        for (const item of carrito) {
            const id = Number(item.id_producto);
            const cantidad = Number(item.cantidad);
            if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(cantidad) || cantidad <= 0) {
                throw new Error('El carrito contiene una cantidad o producto inválido.');
            }
            cantidades.set(id, (cantidades.get(id) || 0) + cantidad);
        }

        const ids = [...cantidades.keys()];
        const [productos] = await conn.query(
            `SELECT id_producto, codigo, nombre_producto, precio, stock_actual
             FROM producto
             WHERE id_producto IN (${ids.map(() => '?').join(', ')})
             FOR UPDATE`,
            ids
        );
        const porId = new Map(productos.map((producto) => [Number(producto.id_producto), producto]));
        const detalles = [];
        let total = 0;

        for (const [id, cantidad] of cantidades) {
            const producto = porId.get(id);
            if (!producto) {
                throw new Error(`El producto con ID ${id} ya no está disponible.`);
            }
            if (Number(producto.stock_actual) < cantidad) {
                throw new Error(`Stock insuficiente para ${producto.nombre_producto}.`);
            }

            const precio = Number(producto.precio);
            if (!Number.isFinite(precio) || precio < 0) {
                throw new Error(`El precio de ${producto.nombre_producto} no es válido.`);
            }
            const subtotal = precio * cantidad;
            total += subtotal;
            detalles.push({ ...producto, cantidad, precio, subtotal });
        }

        const [configuracion] = await conn.execute(
            'SELECT tasa_dolar FROM configuracion WHERE id = 1'
        );
        const tasa = Number(configuracion[0]?.tasa_dolar);
        if (!Number.isFinite(tasa) || tasa <= 0) {
            throw new Error('No hay una tasa de cambio válida configurada.');
        }

        const [columnasTasa] = await conn.execute(
            `SELECT 1 FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'solicitud'
               AND COLUMN_NAME = 'tasa_aplicada'`
        );
        let insertSolicitud;
        if (columnasTasa.length > 0) {
            [insertSolicitud] = await conn.execute(
                `INSERT INTO solicitud
                    (id_cliente, total, estado, fecha_solicitud, id_vendedor, tasa_aplicada)
                 VALUES (?, ?, 'Pendiente', NOW(), NULL, ?)`,
                [idCliente, total, tasa]
            );
        } else {
            [insertSolicitud] = await conn.execute(
                `INSERT INTO solicitud (id_cliente, total, estado, fecha_solicitud, id_vendedor)
                 VALUES (?, ?, 'Pendiente', NOW(), NULL)`,
                [idCliente, total]
            );
        }
        const idSolicitud = insertSolicitud.insertId;

        for (const detalle of detalles) {
            await conn.execute(
                `INSERT INTO detalle_solicitud
                    (id_solicitud, id_producto, cantidad, precio_unitario, subtotal)
                 VALUES (?, ?, ?, ?, ?)`,
                [idSolicitud, detalle.id_producto, detalle.cantidad, detalle.precio, detalle.subtotal]
            );
            const [stockUpdate] = await conn.execute(
                `UPDATE producto
                 SET stock_actual = stock_actual - ?
                 WHERE id_producto = ? AND stock_actual >= ?`,
                [detalle.cantidad, detalle.id_producto, detalle.cantidad]
            );
            if (stockUpdate.affectedRows !== 1) {
                throw new Error(`No se pudo reservar el stock de ${detalle.nombre_producto}.`);
            }
        }

        await conn.execute(
            `INSERT INTO whatsapp_solicitudes
                (id_solicitud, origen, telefono_cliente, metodo_entrega, datos_entrega)
             VALUES (?, 'whatsapp', ?, ?, ?)`,
            [idSolicitud, almacenado, metodoEntrega, JSON.stringify(datosEntrega)]
        );

        await conn.commit();
        return {
            idSolicitud,
            codigo: `SOL-${String(idSolicitud).padStart(6, '0')}`,
            nombre: String(nombre).trim(),
            telefono: almacenado,
            tasa,
            total,
            metodoEntrega,
            datosEntrega,
            detalles
        };
    } catch (error) {
        if (transaccionIniciada) {
            try {
                await conn.rollback();
            } catch (rollbackError) {
                console.error('Falló el rollback del pedido de WhatsApp:', rollbackError);
                throw new AggregateError(
                    [error, rollbackError],
                    'Falló el pedido y también la reversión de la transacción.'
                );
            }
        }
        throw error;
    } finally {
        conn.release();
    }
}

async function crearNotificacion(pool, {
    tipo,
    idSolicitud = null,
    clientJid,
    nombre,
    telefono,
    detalle,
    referencia: referenciaSolicitada
}) {
    const referencia = referenciaSolicitada ||
        `${tipo === 'pedido' ? 'PED' : 'CONS'}-${Date.now().toString(36).toUpperCase()}`;
    const [result] = await pool.execute(
        `INSERT INTO whatsapp_notificaciones
            (referencia, tipo, id_solicitud, client_jid, client_name, client_phone, detalle, estado)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pendiente')`,
        [referencia, tipo, idSolicitud, clientJid, nombre, telefono, detalle]
    );
    return { id: result.insertId, referencia };
}

async function registrarMensajeGerencia(pool, idNotificacion, messageId) {
    await pool.execute(
        `UPDATE whatsapp_notificaciones
         SET manager_message_id = ?, estado = 'enviada'
         WHERE id = ?`,
        [messageId, idNotificacion]
    );
}

async function marcarNotificacionFallida(pool, idNotificacion, errorMessage) {
    await pool.execute(
        `UPDATE whatsapp_notificaciones
         SET estado = 'error', detalle_error = ?
         WHERE id = ?`,
        [String(errorMessage || 'Error desconocido').slice(0, 1000), idNotificacion]
    );
}

async function buscarNotificacionPorMensaje(pool, messageId) {
    const [rows] = await pool.execute(
        `SELECT id, client_jid, client_name, estado
         FROM whatsapp_notificaciones
         WHERE manager_message_id = ?
         LIMIT 1`,
        [messageId]
    );
    return rows[0] || null;
}

async function registrarRespuestaGerencia(pool, idNotificacion, respuesta) {
    const [result] = await pool.execute(
        `UPDATE whatsapp_notificaciones
         SET estado = 'respondida', respuesta_gerencia = ?, respondida_en = NOW()
         WHERE id = ? AND estado = 'enviada'`,
        [respuesta, idNotificacion]
    );
    return result.affectedRows === 1;
}

module.exports = {
    asegurarTablasWhatsApp,
    buscarClientePorTelefono,
    buscarNotificacionPorMensaje,
    crearNotificacion,
    crearPedidoWhatsApp,
    obtenerContactosGerencia,
    obtenerContactosParaNotificacion,
    normalizarNumeroWhatsApp,
    marcarNotificacionFallida,
    registrarMensajeGerencia,
    registrarRespuestaGerencia
};
