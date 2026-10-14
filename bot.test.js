const test = require('node:test');
const assert = require('node:assert/strict');
const {
    GeminiService,
    respuestaErrorGemini,
    prepararConsultaProducto
} = require('./bot');

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
