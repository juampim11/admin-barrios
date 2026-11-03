/**
 * Las piezas **inertes** que comparten los adapters de demostración.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * EL RIESGO QUE ESTE ARCHIVO ADMINISTRA
 *
 * **Una boleta que se ve real, con un CBU real, es una boleta que alguien paga.** La muestra se
 * reenvía por WhatsApp —al socio, al contador, a alguien del consejo— y tiene que ser **imposible que
 * mueva un peso**, sin que eso se note al mirarla (doc 09 §E.15.4).
 *
 * Cada instrumento de acá es real y escaneable **sobre un número que ninguna red puede aceptar**. La
 * inercia no es que el número parezca raro: es que el sistema del otro lado lo rechace **antes** de
 * llegar a la pantalla donde alguien confirmaría por costumbre.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ VIVEN ACÁ Y NO EN UN ADAPTER
 *
 * Vivían dentro de `adapters/generico-demo.ts`, que era el único que había. Con el segundo adapter
 * —`transferencia-qr`, el que no lleva código de barras— quedaban dos caminos malos: copiarlas, o que
 * un adapter importe del otro. Las dos terminan igual, y el final es conocido: **el día que una copia
 * se “arregle” y la otra no, hay una muestra pagable suelta**.
 *
 * `generico-demo.ts` las reexporta para que nada de afuera se entere del movimiento.
 */

import { montoSchema } from "@admin-barrios/shared/dinero";
import { verificadorBloque1, verificadorBloque2 } from "./cbu.ts";
import type { EntradaBloquePago } from "./medio-cobranza.ts";
import { conCrc, tlv } from "./emvco.ts";


/**
 * CBU de 22 dígitos con **los dos verificadores rotos** (posiciones 8 y 22). Es el control más
 * importante de todos: el home banking lo rechaza **antes** de pedir confirmación, así que ni
 * siquiera llega a la pantalla donde alguien podría confirmar por inercia.
 */
export function cbuInerte(): string {
  const bloque1 = "0001234";
  const bloque2 = "0000000000174";
  const dv1 = (verificadorBloque1(bloque1) + 1) % 10;
  const dv2 = (verificadorBloque2(bloque2) + 1) % 10;
  return `${bloque1}${dv1}${bloque2}${dv2}`;
}

/**
 * Alias derivado del nombre del barrio, con el sufijo que lo delata. No es registrable por un tercero.
 *
 * El alias CBU admite **hasta 20 caracteres**, así que hay que recortar. Se recorta por palabras
 * enteras y nunca el sufijo: cortar a ciegas en el carácter 20 produce cosas como
 * `LAS.CORZUELAS.MUESTR`, que en una demostración se lee como un error del sistema y no como el
 * límite que es. Se descartan los artículos, que no aportan nada y ocupan lugar.
 */
export function aliasInerte(barrio: string): string {
  const SUFIJO = "MUESTRA";
  const ARTICULOS = new Set(["EL", "LA", "LOS", "LAS", "DE", "DEL", "Y"]);
  const palabras = barrio
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((p) => p.length > 0 && !ARTICULOS.has(p));

  const elegidas: string[] = [];
  for (const palabra of palabras) {
    if ([...elegidas, palabra, SUFIJO].join(".").length <= 20) elegidas.push(palabra);
  }
  return [...(elegidas.length > 0 ? elegidas : ["BARRIO"]), SUFIJO].join(".");
}

// --- QR de pago ---------------------------------------------------------------------------------
//
// QR de **pago**, no de acceso: codifica CVU + importe, nunca una URL ni un token (doc 09 §E.3.3 —
// del PDF nunca sale un identificador que **abra** algo; sí puede salir uno que **cobre**). Estructura
// TLV al estilo EMVCo, con su CRC: sintácticamente válido, se escanea bien, y el CVU no existe, así
// que la billetera lo lee y falla limpio.
//
// El template del comercio (tag 26) es un **placeholder**: el identificador real del esquema
// interoperable llega con la especificación del convenio (ADR-0001 §10, punto 1).

// `tlv` y el CRC viven en `emvco.ts`: el armado y la lectura (`leerEmv`, con la que se verifica el
// payload en los tests) son el mismo código.

/**
 * CVU inexistente: 22 dígitos con prefijo de entidad que no está asignado.
 *
 * **Se exporta** porque es lo que `verificar()` afirma en positivo: un adapter de demostración cuyo
 * QR no lo lleve está codificando una cuenta que podría existir.
 */
export const CVU_INEXISTENTE = "0000003100000000000000";

// --- Cuentas de demostración (T3) ----------------------------------------------------------------
//
// Con «una cuenta por unidad», la boleta imprime la cuenta de la unidad. La base exige que esa cuenta
// tenga los verificadores **válidos** (`app.cbu_valido`), así que el truco del CBU roto no sirve, y
// tampoco sirve mirar el prefijo: `000` es el de TODOS los CVU (las billeteras), no una entidad
// inexistente (panel `security-engineer`, 2026-11-03, bloqueante B1).
//
// La única regla que no deja una muestra pagable es una **lista cerrada**: el medio de demostración
// imprime una cuenta declarada solo si es una de estas, y el alias solo si es uno de estos. Cualquier
// otra —la cuenta real que cargue una administración— hace fallar `verificar()`, y esa boleta no se
// emite (compuerta 1) hasta que exista el medio real del recaudador.
//
// Es la misma apuesta que `CVU_INEXISTENTE` (que también tiene los verificadores bien): números de
// cuenta que no son de nadie, con un patrón que no se asigna (`9999999` y un correlativo de 6
// dígitos, sobre el prefijo de demostración). La demo (`seed-demo.ts`) y los tests usan estas.

const CANTIDAD_CUENTAS_DEMO = 60;

/** La cuenta de demostración `n` (1 a 60): 22 dígitos con los dos verificadores bien. */
export function cuentaDeDemostracion(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > CANTIDAD_CUENTAS_DEMO) throw new RangeError(`no hay cuenta de demostración ${n}`);
  const bloque1 = "0000003";
  const bloque2 = `9999999${String(n).padStart(6, "0")}`;
  return `${bloque1}${verificadorBloque1(bloque1)}${bloque2}${verificadorBloque2(bloque2)}`;
}

/** El alias de demostración `n` (1 a 60). */
export function aliasDeDemostracion(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > CANTIDAD_CUENTAS_DEMO) throw new RangeError(`no hay alias de demostración ${n}`);
  return `muestra.cuenta.${String(n).padStart(2, "0")}`;
}

const CUENTAS_DEMO = new Set(Array.from({ length: CANTIDAD_CUENTAS_DEMO }, (_, i) => cuentaDeDemostracion(i + 1)));
const ALIAS_DEMO = new Set(Array.from({ length: CANTIDAD_CUENTAS_DEMO }, (_, i) => aliasDeDemostracion(i + 1)));

/** ¿Es una de las cuentas (o alias) de la lista cerrada de demostración? */
export const esCuentaDeDemostracion = (cbu: string): boolean => CUENTAS_DEMO.has(cbu);
export const esAliasDeDemostracion = (alias: string): boolean => ALIAS_DEMO.has(alias.toLowerCase());

/**
 * El payload se mantiene **corto a propósito**: cada byte de más sube la versión del QR y, con el
 * lado mínimo de 25 mm que exige el papel impreso (doc 09 §E.10.1), un payload largo produce
 * módulos tan finos que un teléfono no los resuelve. Se codifica lo indispensable —cuenta, moneda,
 * importe y referencia— y se deja afuera el nombre del comercio, que el vecino ya está leyendo en
 * la hoja.
 *
 * **La referencia va en el campo 62 (datos adicionales)** desde BL-012: el `05` (etiqueta de
 * referencia) lleva el **código de pago de la UF** —estable, el que identifica a la unidad al
 * imputar— y el `01` (número de factura) el **comprobante** de la boleta. Antes el comentario decía
 * "y referencia" pero el payload no la llevaba. El código va sin separador: solo dígitos.
 */
export function payloadQrPago(entrada: EntradaBloquePago): string {
  // El comprobante entra como número de factura solo si es ASCII imprimible y de hasta 25 caracteres
  // (el máximo del subcampo): truncarlo podría hacer que dos boletas compartan el `01`, y un carácter
  // fuera de ASCII rompería el largo. Si no cumple, no va —sigue impreso en la boleta—; el código de
  // pago, que es lo que se imputa, va siempre.
  const comprobante = entrada.comprobante?.trim() ?? "";
  const adicionales =
    (/^[ -~]{1,25}$/.test(comprobante) ? tlv("01", comprobante) : "") +
    tlv("05", entrada.codigoPago.replace(/\D/g, ""));
  const cuerpo =
    tlv("00", "01") + // versión del formato
    // La cuenta declarada (la de la unidad o la del barrio, T3) o, sin ella, el CVU inexistente de la demo.
    tlv("26", tlv("01", entrada.cuenta?.cbu ?? CVU_INEXISTENTE)) +
    tlv("53", "032") + // moneda ISO 4217 — ARS
    tlv("54", montoSchema.parse(entrada.importe)) +
    tlv("62", adicionales);
  return conCrc(cuerpo);
}
