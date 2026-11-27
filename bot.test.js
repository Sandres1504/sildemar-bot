const test = require('node:test');
const assert = require('node:assert/strict');
const {
    GeminiService,
    construirPromptGemini,
    respuestaErrorGemini,
    prepararConsultaProducto,
    detectarConsultaCashea,
    respuestaCashea,
    detectarSolicitudNoContacto,
    detectarDudaCompra,
    detectarNivelCashea,
    interpretarMetodoPago,
    interpretarDecisionPrepedido,
    confirmarSolicitud,
    resolverProductoDeOpciones,
    describirPagoCashea,
    obtenerTotalCarrito,
    cumpleMontoMinimoCashea,
    palabraANumero,
    respuestaGerenciaEsAmbigua,
    crearFichaPrepedido,
    serializarPrepedido,
    reconstruirSesionPrepedido,
    procesarFlujoPedido
} = require('./bot');

test('Cashea requires a level and the manager pre-order shows its terms clearly', async () => {
    const sentMessages = [];
    const sock = {
        async sendMessage(jid, message) {
            sentMessages.push({ jid, ...message });
        }
    };
    const sesion = {
        etapa: 'cashea_nivel',
        carrito: [{ id_producto: 7, codigo: 'M-7', nombre_producto: 'Muñón Corsa', cantidad: 2, precio: 20 }],
        metodoEntrega: 'Retiro en Local',
        datosEntrega: {},
        cliente: { nombre: 'Cliente de Prueba', cedula: '12345678' },
        telefono: '584121234567'
    };

    await procesarFlujoPedido(sock, 'cliente-3', 'Confirmar', null, sesion);
    assert.equal(sesion.etapa, 'cashea_nivel');
    assert.match(sentMessages[0].text, /necesito tu nivel/);
    assert.match(sentMessages[0].text, /OTRO PAGO/);
    assert.match(sentMessages[0].text, /Aún no se ha registrado/);

    sesion.nivelCashea = 2;
    sesion.metodoPago = 'Cashea';
    const ficha = crearFichaPrepedido(sesion, 'PRE-TEST');
    assert.match(ficha, /Total estimado: \$40\.00/);
    assert.match(ficha, /nivel 2.*inicial 50% \(\$20\.00\)/);
    assert.match(ficha, /APROBAR/);
    assert.match(ficha, /ni reserva inventario/);

    const restaurada = reconstruirSesionPrepedido(serializarPrepedido(sesion));
    assert.equal(restaurada.etapa, 'confirmar_pedido');
    assert.equal(restaurada.metodoPago, 'Cashea');
    assert.equal(restaurada.nivelCashea, 2);
});

test('detects Cashea questions, opt-out requests, and sales hesitation', () => {
    assert.equal(detectarConsultaCashea('¿Puedo pagar con Cashea?'), true);
    assert.equal(detectarConsultaCashea('¿Tienen repuestos?'), false);
    assert.match(respuestaCashea(), /mínimo es \$25/);
    assert.match(respuestaCashea(), /3 cuotas/);
    assert.match(respuestaCashea(), /60% para nivel 1, 50% para nivel 2 y 40% para niveles 3 al 6/);
    assert.match(respuestaCashea(), /https:\/\/mobile\.cashea\.app\/merchants\/ffaba67b-db15-47eb-b9eb-cc1fdf769542/);
    assert.equal(detectarSolicitudNoContacto('No me escribas más, por favor'), true);
    assert.equal(detectarSolicitudNoContacto('Lo voy a pensar'), false);
    assert.equal(detectarDudaCompra('Lo veo después'), 'pausa');
    assert.equal(detectarDudaCompra('No gracias'), 'rechazo');
    assert.equal(detectarDudaCompra('¿Cuánto cuesta?'), null);
    assert.equal(detectarNivelCashea('mi nivel 2'), 2);
    assert.equal(detectarNivelCashea('7'), null);
    assert.match(describirPagoCashea(40, 2), /inicial 50% \(\$20\.00\)/);
    assert.equal(obtenerTotalCarrito({ carrito: [{ precio: 20, cantidad: 2 }] }), 40);
    assert.equal(cumpleMontoMinimoCashea(24.99), false);
    assert.equal(cumpleMontoMinimoCashea(25), true);
    assert.equal(respuestaGerenciaEsAmbigua('Confirmar'), true);
    assert.equal(respuestaGerenciaEsAmbigua('Cashea validado para nivel 2.'), false);
    assert.equal(interpretarMetodoPago('divisa'), 'Divisa (USD)');
    assert.equal(interpretarMetodoPago('pago móvil'), 'Pago móvil');
    assert.equal(interpretarMetodoPago('Zelle'), null);
    assert.deepEqual(interpretarDecisionPrepedido('APROBAR'), { decision: 'aprobada', motivo: '' });
    assert.deepEqual(interpretarDecisionPrepedido('RECHAZAR: sin disponibilidad'), {
        decision: 'rechazada',
        motivo: 'sin disponibilidad'
    });
    assert.equal(interpretarDecisionPrepedido('Confirmar'), null);
    assert.equal(confirmarSolicitud('Confirmar pedido'), true);
    assert.equal(confirmarSolicitud('Confirmar'), true);
    assert.equal(confirmarSolicitud('Sí'), false);
});

test('selects additional cart items by displayed number, SKU, or brand', () => {
    const products = [
        {
            codigo: '92099365',
            nombre_producto: 'Muñón Corsa largo GM',
            marca_repuesto: 'GM HE',
            marca_carro: 'Chevrolet',
            modelo_vehiculo: 'Corsa'
        },
        {
            codigo: 'TVA-90444294',
            nombre_producto: 'Muñón Corsa todos largo',
            marca_repuesto: 'TVA',
            marca_carro: 'Chevrolet',
            modelo_vehiculo: 'Corsa'
        },
        {
            codigo: 'TVA-11111',
            nombre_producto: 'Muñón Aveo',
            marca_repuesto: 'TVA',
            marca_carro: 'Chevrolet',
            modelo_vehiculo: 'Aveo'
        }
    ];

    assert.equal(resolverProductoDeOpciones(products, '2').producto, products[1]);
    assert.equal(resolverProductoDeOpciones(products, 'TVA-90444294').producto, products[1]);
    assert.equal(resolverProductoDeOpciones(products, 'GM HE').producto, products[0]);
    assert.equal(resolverProductoDeOpciones(products, 'la marca GM HE').producto, products[0]);
    assert.equal(resolverProductoDeOpciones(products, 'el de la marca GM HE').producto, products[0]);
    assert.deepEqual(resolverProductoDeOpciones(products, 'TVA').productos, [products[1], products[2]]);
});

test('accepts natural quantity phrasing without misreading longer messages', () => {
    assert.equal(palabraANumero('Quiero 3'), 3);
    assert.equal(palabraANumero('Necesito dos unidades'), 2);
    assert.equal(palabraANumero('opción 4'), 4);
    assert.equal(palabraANumero('quiero 3 filtros'), null);
});

test('adds only predefined, customer-data-free human corrections to Gemini guidance', () => {
    const prompt = construirPromptGemini([
        { categoria: 'cashea' },
        { categoria: 'inventario' },
        { categoria: 'cashea' },
        { categoria: 'unknown', detalle: 'No debe incluirse' }
    ]);

    assert.match(prompt, /condiciones confirmadas de Cashea/);
    assert.match(prompt, /resultados reales del inventario/);
    assert.equal((prompt.match(/condiciones confirmadas de Cashea/g) || []).length, 1);
    assert.doesNotMatch(prompt, /No debe incluirse/);
});

test('Gemini service requests structured JSON and keeps only recent chat history', async () => {
    const requests = [];
    const fakeModel = {
        async generateContent(request) {
            requests.push(request);
            return {
                response: {
                    text: () => JSON.stringify({
                        accion: 'buscar_producto',
                        respuesta_texto: 'Voy a revisar el inventario.',
                        producto: 'empacadura',
                        vehiculo: 'Hyundai Accent'
                    })
                }
            };
        }
    };
    const service = new GeminiService(fakeModel, { maxMessages: 20 });

    const result = await service.generarRespuesta('¿Tienen esa empacadura?', 'cliente-1');
    service.guardarRespuesta('cliente-1', 'Sí tenemos una opción.');
    await service.generarRespuesta('¿Y el precio?', 'cliente-1');

    assert.equal(result.accion, 'buscar_producto');
    assert.equal(result.producto, 'empacadura');
    assert.equal(requests[0].contents.length, 1);
    assert.deepEqual(requests[1].contents.map(({ role }) => role), ['user', 'model', 'user']);
    assert.equal(service.historiales.get('cliente-1').mensajes.length, 3);
});

test('Gemini service rejects malformed responses and reports rate limits politely', async () => {
    const service = new GeminiService({
        async generateContent() {
            return { response: { text: () => 'not json' } };
        }
    });

    await assert.rejects(service.generarRespuesta('Hola', 'cliente-2'), /JSON inválida/);
    assert.match(respuestaErrorGemini({ status: 429 }), /muchas consultas/i);
});

test('Gemini service isolates clients and limits history to ten exchanges', async () => {
    const fakeModel = {
        async generateContent() {
            return {
                response: {
                    text: () => JSON.stringify({
                        accion: 'conversacion_general',
                        respuesta_texto: 'De acuerdo.',
                        producto: '',
                        vehiculo: ''
                    })
                }
            };
        }
    };
    const service = new GeminiService(fakeModel);

    for (let i = 0; i < 11; i++) {
        await service.generarRespuesta(`mensaje ${i}`, 'cliente-1');
        service.guardarRespuesta('cliente-1', `respuesta ${i}`);
    }
    await service.generarRespuesta('Hola', 'cliente-2');

    assert.equal(service.historiales.get('cliente-1').mensajes.length, 20);
    assert.equal(service.historiales.get('cliente-2').mensajes.length, 1);
    await assert.rejects(
        new GeminiService(null).generarRespuesta('Hola', 'cliente-3'),
        { code: 'GEMINI_API_KEY_MISSING' }
    );
});

test('removes conversational wording while retaining the requested part and vehicle', () => {
    assert.deepEqual(
        prepararConsultaProducto('¿Tienen empacadura para Hyundai Accent?'),
        ['EMPACADURA', 'HYUNDAI', 'ACCENT']
    );
    assert.deepEqual(prepararConsultaProducto('¿Precio?'), []);
});
