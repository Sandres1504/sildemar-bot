CREATE TABLE IF NOT EXISTS whatsapp_demanda_sin_stock (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    referencia VARCHAR(40) NOT NULL,
    producto VARCHAR(255) NOT NULL,
    producto_key VARCHAR(191) NOT NULL,
    client_jid VARCHAR(191) NOT NULL,
    telefono_cliente VARCHAR(32) NOT NULL,
    creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_whatsapp_demanda_referencia_producto (referencia, producto_key),
    KEY idx_whatsapp_demanda_creado (creado_en),
    KEY idx_whatsapp_demanda_producto_fecha (producto_key, creado_en)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS whatsapp_resumenes_semanales (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    semana_inicio DATETIME NOT NULL,
    semana_fin DATETIME NOT NULL,
    contacto_tipo VARCHAR(20) NOT NULL,
    estado VARCHAR(20) NOT NULL DEFAULT 'enviando',
    intentado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    mensaje_id VARCHAR(191) NULL,
    detalle_error VARCHAR(1000) NULL,
    enviado_en DATETIME NULL,
    UNIQUE KEY uq_whatsapp_resumen_periodo_contacto (semana_inicio, semana_fin, contacto_tipo),
    KEY idx_whatsapp_resumen_estado (estado, intentado_en)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
