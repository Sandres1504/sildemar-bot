# Bot de WhatsApp Sildemar

Asistente de WhatsApp con Baileys + Gemini que consulta el inventario MySQL y
crea solicitudes pendientes con sus detalles, notificando a gerencia para el
despacho. Combina IA conversacional (Gemini) con lógica tradicional de
detección de intenciones como respaldo.

## Características

- **IA conversacional** con Google Gemini 2.5 Flash: interpreta el lenguaje
  natural del cliente, mantiene contexto por número de WhatsApp (hasta 10
  intercambios durante 30 minutos) y devuelve respuestas amables.
- **Búsqueda en inventario**: consulta MySQL por FULLTEXT y como respaldo por
  LIKE. Los precios y el stock siempre vienen del inventario real, nunca de la IA.
- **Flujo de pedidos por etapas**: selección → cantidad → identidad → método de
  entrega (Delivery Local / Envío Nacional) → confirmación → notificación a gerencia.
- **Notificaciones a gerencia**: fichas de despacho y consultas de productos sin
  disponibilidad. La gerencia puede responder citando la notificación original.
- **Filtros de mensajes**: ignora grupos, listas de precios, mensajes vacíos y
  mensajes propios del negocio.

## Configuración local

1. Instala Node.js 20 o superior.
2. Instala las dependencias con `npm install`.
3. Copia `.env.example` a `.env` y completa **todos** los valores:
   - `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` (MySQL inventario).
   - `DATABASE_URL` (PostgreSQL Supabase para la sesión Baileys).
   - `GEMINI_API_KEY` (API key de Google AI Studio).
   - `GERENTE_DELIVERY_PHONE`, `GERENTE_SHIPPING_PHONE` (contactos de gerencia).
4. Inicia el bot con `npm start` y escanea el QR que aparece en la terminal.

### Obtener la API key de Gemini

1. Ve a https://aistudio.google.com/app/apikey
2. Inicia sesión con tu cuenta de Google.
3. Haz clic en **"Crear clave de API"**.
4. Copia la clave (empieza con `AIza...`) y pégala en `GEMINI_API_KEY`.
5. **Nunca** subas la clave al repositorio. Guárdala solo en `.env` local y en las
   variables de entorno de Render.

### Variables de entorno

| Variable | Uso |
| --- | --- |
| `DB_HOST` | Host MySQL habilitado para conexiones desde Render |
| `DB_PORT` | Puerto MySQL; normalmente `3306` |
| `DB_NAME` | Base de datos del inventario |
| `DB_USER` | Usuario MySQL |
| `DB_PASSWORD` | Contraseña MySQL |
| `DATABASE_URL` | PostgreSQL de Supabase usado para persistir la sesión de Baileys |
| `GEMINI_API_KEY` | API key de Google AI Studio (Gemini) |
| `GERENTE_DELIVERY_PHONE` | Contacto de despacho local |
| `GERENTE_SHIPPING_PHONE` | Contacto de envíos nacionales |
| `PORT` | Puerto HTTP asignado por Render |

### Preparación de MySQL

Al iniciar, el bot crea las tablas auxiliares `whatsapp_solicitudes` y
`whatsapp_notificaciones` si no existen. El usuario MySQL de Render necesita
permiso `CREATE` en la base de datos. Si la política de cPanel no permite ese
permiso, un administrador puede importar
[`../backend/sql/whatsapp_integration.sql`](../backend/sql/whatsapp_integration.sql)
una vez; luego el bot solo necesita permisos de lectura/escritura habituales.

El usuario MySQL también necesita lectura/escritura sobre las tablas de
inventario, clientes y solicitudes, y lectura sobre `information_schema`.

## Configuración en Render

En la sección **Environment** del servicio:

- Configura `GEMINI_API_KEY` (nueva, generada después de revocar cualquier
  clave expuesta).
- Configura `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` y
  `DATABASE_URL`.
- Render asigna `PORT` automáticamente; no lo configures manualmente.

Después de guardar, haz un **Manual Deploy** o espera al redeploy automático.

## Flujo del bot

1. El cliente envía un mensaje.
2. Gemini interpreta la intención y devuelve una acción (`buscar_producto`,
   `saludo`, `ubicacion`, `agradecimiento`, `conversacion_general`) junto con
   el repuesto y vehículo si los identifica.
3. Si la acción es `buscar_producto`, el bot consulta MySQL y responde con
   precios y stock reales.
4. Si el cliente selecciona un producto, se inicia el flujo de pedido por etapas.
5. Al confirmar, el bot reserva stock en MySQL dentro de una transacción, crea
   la solicitud y notifica a gerencia.
6. Si Gemini falla o no está configurada, el bot cae al flujo tradicional de
   detección de intenciones por expresiones regulares.

## Pruebas

Ejecuta `npm test` para correr las pruebas locales del servicio de Gemini y de
la preparación de consultas. Las pruebas usan una respuesta simulada y no
necesitan llamar a Gemini.

## Seguridad

- Nunca subas `.env` al repositorio. Verifica con `git check-ignore .env`.
- `.env.example` solo debe contener placeholders, nunca claves reales.
- Si una API key se expone (en un chat, captura o commit), revócala
  inmediatamente en https://aistudio.google.com/app/apikey y genera una nueva.
- Los mensajes procesados se envían a la API de Gemini. Revisa las políticas
  de privacidad de Google AI Studio si manejas información sensible.