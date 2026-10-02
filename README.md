# Bot de WhatsApp de Sildemar

El bot consulta el inventario y la tasa de cambio en MySQL, crea solicitudes
pendientes de WhatsApp con sus detalles en una transacción y remite a gerencia
las fichas de despacho y las consultas de productos sin disponibilidad.

## Variables de entorno

Configura estas variables en Render. No publiques el archivo `.env` ni valores
reales de credenciales:

| Variable | Uso |
| --- | --- |
| `DB_HOST` | Host MySQL habilitado para conexiones desde Render |
| `DB_PORT` | Puerto MySQL; normalmente `3306` |
| `DB_NAME` | Base de datos |
| `DB_USER` | Usuario MySQL |
| `DB_PASSWORD` | Contraseña MySQL |
| `GERENTE_DELIVERY_PHONE` | Contacto de despacho local y consultas sin stock |
| `GERENTE_SHIPPING_PHONE` | Contacto de envíos nacionales y consultas sin stock |
| `DATABASE_URL` | PostgreSQL de Supabase usado para persistir la sesión de Baileys |
| `PORT` | Puerto HTTP asignado por Render |

En cPanel, configura también `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` y,
si corresponde, `DB_PORT` para PHP. `DB_HOST` puede ser distinto entre Render y
cPanel. Si el hosting no permite conexiones MySQL remotas, habilita el acceso
remoto y autoriza las direcciones IP de salida de Render antes de probar el bot.

## Preparación de MySQL

1. Haz una copia de seguridad de la base de datos.
2. Importa [`../backend/sql/whatsapp_integration.sql`](../backend/sql/whatsapp_integration.sql)
   en `storesil_sildemar`.
3. Confirma que el usuario de MySQL configurado en Render tiene permisos de
   lectura/escritura sobre las tablas del inventario, clientes y solicitudes,
   y permisos de lectura sobre `information_schema`.
4. Despliega el servicio del bot en Render.

La integración utiliza las columnas de `persona`, `cliente`, `producto`,
`solicitud` y `detalle_solicitud` que ya emplea el backend PHP. Las tablas
complementarias almacenan el canal de origen, los datos de despacho y la
referencia necesaria para encaminar las respuestas citadas de gerencia.

## Flujo

El cliente busca un producto, selecciona una opción, indica cantidad y los datos
de identidad necesarios. Después elige Delivery Local o Envío Nacional (Zoom /
MRW) y entrega la ubicación/dirección o los datos de la agencia. Al confirmar,
el bot reserva existencias y escribe la solicitud, los detalles y los datos de
despacho dentro de la misma transacción. La ficha local se envía al contacto
`GERENTE_DELIVERY_PHONE`; la ficha de envío nacional, a `GERENTE_SHIPPING_PHONE`.

Las consultas sin producto disponible se registran y se remiten a ventas con una
referencia y se envían a ambos contactos. El número local con prefijo 0 se
normaliza a código internacional de Venezuela al generar el JID de WhatsApp.
Gerencia puede responder citando el mensaje original de la notificación; el bot
reenvía la respuesta al cliente y confirma el envío.

Usa [`.env.example`](./.env.example) como referencia para las variables locales
y configura las mismas variables en Render. Los valores de los contactos ya
están precargados en el ejemplo; añade allí las credenciales reales de tu
entorno local sin compartir ni subir el archivo `.env`.
