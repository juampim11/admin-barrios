-- =============================================================================================
-- 0031_medio_cobranza_del_barrio — cómo cobra cada barrio deja de estar escrito en el código
--
-- QUÉ ESTABA MAL
--
-- El medio de cobranza estaba **hardcodeado** en `apps/worker/src/main.ts`:
--
--     const medio = crearMedioGenericoDemo();
--
-- Un literal, a nivel módulo, para todos los barrios de todos los administradores. La abstracción
-- `MedioCobranza` existía desde el ADR-0001 §4.4 —con su puerto, su registro y su resolución por
-- clave— pero **nadie la usaba**: el registro se resolvía siempre al mismo adapter. Estaba anotado
-- como faltante en `FALTANTES_CONOCIDOS.medioCobranzaPorBarrio`.
--
-- POR QUÉ IMPORTA AHORA, Y NO ES SOLO PROLIJIDAD
--
-- La decisión del usuario del 2026-08-05 sobre la boleta de la demostración es que **no replique la
-- del barrio piloto** y que en cambio demuestre *"la capacidad de adaptarse al sistema de cobro que
-- se tenga (o que se vaya a incorporar)"*.
--
-- Sin esta columna, esa capacidad hay que **contarla**. Con ella, se **muestra**: se cambia un valor,
-- se regenera la boleta, y el pie cambia entero —los instrumentos, los canales, el troquel y las
-- instrucciones— sin que nadie toque la plantilla. Es la diferencia entre afirmar que el sistema es
-- portable y verlo.
--
-- POR QUÉ ES `text` Y NO UN ENUM
--
-- Un `enum` de Postgres obligaría a una migración cada vez que se agrega un adapter, que es
-- exactamente el acoplamiento que el puerto vino a evitar: el conjunto de medios lo define el
-- **registro** de la aplicación, no el esquema. La clave se valida al resolver
-- (`crearRegistroMediosCobranza` rechaza una clave que no está registrada, con "no se imprime una
-- boleta impagable"), y esa falla es ruidosa y temprana.
--
-- El default es `generico-demo` **a propósito**: es el medio que todos los barrios tenían de hecho
-- hasta esta migración, así que ninguna fila existente cambia de comportamiento.
-- =============================================================================================

ALTER TABLE "barrio" ADD COLUMN "medio_cobranza_clave" text NOT NULL DEFAULT 'generico-demo';
--> statement-breakpoint

COMMENT ON COLUMN "barrio"."medio_cobranza_clave" IS
  'Clave del adapter de MedioCobranza con el que se arma el bloque de pago de la boleta. La resuelve el registro de la aplicación, no el esquema: agregar un medio no debe requerir una migración.';
