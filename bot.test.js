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
    detectarDudaCompra
} = require('./bot');

test('detects Cashea questions, opt-out requests, and sales hesitation', () => {
    assert.equal(detectarConsultaCashea('¿Puedo pagar con Cashea?'), true);
    assert.equal(detectarConsultaCashea('¿Tienen repuestos?'), false);
    assert.match(respuestaCashea(), /mínimo es \$25/);
    assert.match(respuestaCashea(), /3 cuotas/);
    assert.match(respuestaCashea(), /60% para nivel 1, 50% para nivel 2 y 40% para niveles 3 al 6/);
    assert.equal(detectarSolicitudNoContacto('No me escribas más, por favor'), true);
    assert.equal(detectarSolicitudNoContacto('Lo voy a pensar'), false);
    assert.equal(detectarDudaCompra('Lo veo después'), 'pausa');
    assert.equal(detectarDudaCompra('No gracias'), 'rechazo');
    assert.equal(detectarDudaCompra('¿Cuánto cuesta?'), null);
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
