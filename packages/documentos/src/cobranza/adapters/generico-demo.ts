/**
 * `generico-demo` — el único adapter de `MedioCobranza` de esta fase (ADR-0001 §10).
 *
 * **Nada específico de una red concreta y ningún nombre de cliente en el código** (ADR-0001 §1.1):
 * el convenio es ficticio, y todo lo que identifica al barrio entra por parámetro.
 *
 * El riesgo que este archivo administra es concreto: **una boleta que se ve real, con un CBU real,
 * es una boleta que alguien paga.** La muestra se reenvía por WhatsApp — al socio, al contador, a
 * alguien del consejo. Tiene que ser **imposible que mueva un peso**, sin que eso se note al mirarla
 * (doc 09 §E.15.4). Por eso cada instrumento es real y escaneable **sobre un número que ninguna red
 * puede aceptar**, y `verificar()` lo afirma en positivo: si algún día un instrumento de este
 * adapter resultara *válido*, la verificación **falla**.
 *
 * La otra mitad de la salvaguarda no está acá: `sinValorDePago = true` obliga al **renderizador** a
 * estampar la marca de agua (ADR-0001 §10). No depende de que alguien se acuerde de activarla.
 */

import { aCentavos, montoSchema } from "@admin-barrios/shared/dinero";
import { fechaIsoSchema } from "@admin-barrios/shared/fechas";
import {
  bloquePagoSchema,
  cifra,
  fechaImpresa,
  leibleNormalizado,
  type BloquePago,
} from "@admin-barrios/shared/documentos";
import { revisarCargaSimbolo } from "../../simbolos.ts";
import { revisarTextosImpresos } from "../../lenguaje-prohibido.ts";
import { cbuValido, verificadorBloque1, verificadorBloque2 } from "../cbu.ts";
import type { EntradaBloquePago, MedioCobranza, ResultadoVerificacion } from "../medio-cobranza.ts";

export const CLAVE_GENERICO_DEMO = "generico-demo";

/** Convenio inexistente. Cinco ceros no los asigna ninguna red: la caja responde "convenio inexistente". */
const CONVENIO_INEXISTENTE = "00000";
/** Largo del código de barras, alineado con el de una boleta real (doc 09 §A). **Par**, siempre. */
export const LARGO_CARGA_BARRAS = 58;

/** Solo dígitos, recortado o rellenado a la izquierda con ceros. */
function aDigitos(valor: string, largo: number): string {
  const limpio = valor.replace(/\D/g, "");
  return limpio.length >= largo ? limpio.slice(-largo) : limpio.padStart(largo, "0");
}

/** Módulo 10 con pesos alternados (Luhn). Es **propio del convenio de demo y no vale para ninguna red**. */
export function digitoVerificadorDemo(digitos: string): number {
  let suma = 0;
  for (let i = digitos.length - 1, alterna = true; i >= 0; i--, alterna = !alterna) {
    const d = Number(digitos[i] ?? "0");
    const x = alterna ? d * 2 : d;
    suma += x > 9 ? x - 9 : x;
  }
  return (10 - (suma % 10)) % 10;
}

/** El verificador **deliberadamente incorrecto**: la red lo rechaza antes de tocar plata. */
function digitoVerificadorRoto(digitos: string): number {
  return (digitoVerificadorDemo(digitos) + 1) % 10;
}

/** Carga del código de barras: convenio · comprobante · período · vencimiento · importe · relleno · DV roto. */
export function cargaCodigoDeBarras(entrada: EntradaBloquePago): string {
  // Sin comprobante, `aDigitos("")` da doce ceros y **todas las boletas del período con el mismo
  // importe reciben el mismo instrumento**, byte a byte. En la demo es inerte, pero este archivo es
  // la plantilla desde la que se va a copiar todo adapter real: se corta acá.
  if (!entrada.comprobante?.trim()) {
    throw new Error(
      "no se puede armar el instrumento sin número de comprobante: sin él, dos unidades con el mismo " +
        "importe reciben códigos idénticos (doc 09 §E.11 ítem 4)",
    );
  }
  // Un saldo a favor no es cobrable en una caja, y el layout de la carga no tiene lugar para el
  // signo: `.replace(/-/,"")` lo codificaría como una deuda del mismo monto. Se rechaza explícito.
  if (aCentavos(montoSchema.parse(entrada.importe)) < 0n) {
    throw new Error("el importe del cupón es negativo (saldo a favor): no se emite un instrumento de pago por un crédito");
  }
  const comprobante = aDigitos(entrada.comprobante, 12);
  const periodo = entrada.periodo.replace("-", ""); // YYYYMM
  const vencimiento = entrada.vencimiento.replace(/-/g, ""); // YYYYMMDD
  const centavos = aDigitos(montoSchema.parse(entrada.importe).replace(/[-.]/g, ""), 14);
  const cuerpo = `${CONVENIO_INEXISTENTE}${comprobante}${periodo}${vencimiento}${centavos}`.padEnd(
    LARGO_CARGA_BARRAS - 1,
    "0",
  );
  return `${cuerpo}${digitoVerificadorRoto(cuerpo)}`;
}

/** Código de pago electrónico (el que se tipea en un home banking). Mismo convenio inexistente. */
export function codigoElectronico(entrada: EntradaBloquePago): string {
  return `${CONVENIO_INEXISTENTE}${aDigitos(entrada.comprobante ?? "", 11)}`;
}

/** Agrupa de a 4 para que un humano lo pueda leer y tipear sin perder el renglón. */
function agrupar(digitos: string, tamanio = 4): string {
  return digitos.replace(new RegExp(`(.{${tamanio}})(?=.)`, "g"), "$1 ");
}

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
// QR de **pago**, no de acceso: codifica CVU + importe + referencia, nunca una URL ni un token
// (doc 09 §E.3.3 — del PDF nunca sale un identificador que **abra** algo; sí puede salir uno que
// **cobre**). Estructura TLV al estilo EMVCo, con su CRC: sintácticamente válido, se escanea bien, y
// el CVU no existe, así que la billetera lo lee y falla limpio.
//
// El template del comercio (tag 26) es un **placeholder**: el identificador real del esquema
// interoperable llega con la especificación del convenio (ADR-0001 §10, punto 1).

function tlv(tag: string, valor: string): string {
  return `${tag}${String(valor.length).padStart(2, "0")}${valor}`;
}

function crc16(datos: string): string {
  let crc = 0xffff;
  for (const ch of datos) {
    crc ^= ch.charCodeAt(0) << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** CVU inexistente: 22 dígitos con prefijo de entidad que no está asignado. */
const CVU_INEXISTENTE = "0000003100000000000000";

/**
 * El payload se mantiene **corto a propósito**: cada byte de más sube la versión del QR y, con el
 * lado mínimo de 25 mm que exige el papel impreso (doc 09 §E.10.1), un payload largo produce
 * módulos tan finos que un teléfono no los resuelve. Se codifica lo indispensable —cuenta, moneda,
 * importe y referencia— y se deja afuera el nombre del comercio, que el vecino ya está leyendo en
 * la hoja.
 */
export function payloadQrPago(entrada: EntradaBloquePago): string {
  const cuerpo =
    tlv("00", "01") + // versión del formato
    tlv("26", tlv("01", CVU_INEXISTENTE)) +
    tlv("53", "032") + // moneda ISO 4217 — ARS
    tlv("54", montoSchema.parse(entrada.importe));
  const conTagCrc = `${cuerpo}6304`;
  return `${conTagCrc}${crc16(conTagCrc)}`;
}

// --- El adapter ---------------------------------------------------------------------------------

/** Leyendas del cupón. Redactadas **solo en positivo** (doc 07 §E). */
export function leyendasDemo(): readonly string[] {
  return [
    "MUESTRA SIN VALOR COMERCIAL. Este cupón es una demostración del formato y no habilita ningún pago.",
    "El pago de la presente no libera de obligaciones de períodos anteriores.",
    "Esta boleta se abona en las entidades autorizadas hasta su fecha tope de recaudación.",
  ];
}

export function crearMedioGenericoDemo(): MedioCobranza {
  return {
    clave: CLAVE_GENERICO_DEMO,

    armarBloquePago(entrada) {
      fechaIsoSchema.parse(entrada.vencimiento);
      const importe = cifra(entrada.importe);
      const barras = cargaCodigoDeBarras(entrada);
      const electronico = codigoElectronico(entrada);

      return bloquePagoSchema.parse({
        medio: CLAVE_GENERICO_DEMO,
        // Lugares, no campos del cupón: es lo que la zona 1 de la boleta imprime bajo "DÓNDE PAGÁS".
        // El CBU y el alias son los **datos** de la transferencia y el convenio es el número del
        // acuerdo con la red; los tres viven abajo, en el cupón, y ninguno es un lugar.
        canalesDePago: ["Pago electrónico", "Transferencia", "En la caja"],
        instrumentos: [
          {
            tipo: "simbolo",
            etiqueta: "Código de barras",
            simbologia: "interleaved2of5",
            carga: barras,
            leible: agrupar(barras),
          },
          // El código de pago electrónico (LINK / Pago Mis Cuentas) **se tipea, no se escanea**:
          // va como texto, igual que en la boleta real de doc 09 §A y en el wireframe de §E.2.3.
          // Un símbolo de más al pie le come milímetros a la zona del detalle sin darle nada a nadie.
          { tipo: "texto", etiqueta: "Pago electrónico", valor: agrupar(electronico), nota: "LINK · Pago Mis Cuentas" },
          {
            tipo: "simbolo",
            etiqueta: "QR de pago",
            simbologia: "qrcode",
            carga: payloadQrPago(entrada),
            // El payload de un QR no se imprime debajo: no lo tipea nadie.
            leible: null,
          },
          { tipo: "texto", etiqueta: "CBU", valor: cbuInerte(), nota: "Cuenta de demostración" },
          {
            tipo: "texto",
            etiqueta: "Alias",
            valor: aliasInerte(entrada.barrio),
            nota: "Poné el N.º de comprobante en la referencia: así se imputa a esta boleta",
          },
          { tipo: "texto", etiqueta: "Convenio", valor: CONVENIO_INEXISTENTE, nota: null },
        ],
        fechas: {
          vencimiento: fechaImpresa(entrada.vencimiento),
          tope: entrada.fechaTope === null ? null : fechaImpresa(entrada.fechaTope),
        },
        importes: { alVencimiento: importe, alTope: entrada.fechaTope === null ? null : importe },
        leyendas: leyendasDemo(),
        logos: entrada.logos ?? [],
        sinValorDePago: true,
      } satisfies unknown);
    },

    verificar(bloque: BloquePago): ResultadoVerificacion {
      const motivos: string[] = [];

      if (bloque.medio !== CLAVE_GENERICO_DEMO) motivos.push(`el bloque dice ser de "${bloque.medio}"`);
      if (!bloque.sinValorDePago) {
        motivos.push("un bloque de demostración tiene que declarar `sinValorDePago` para que el renderizador estampe la marca de agua");
      }

      for (const inst of bloque.instrumentos) {
        if (inst.tipo !== "simbolo") continue;
        motivos.push(...revisarCargaSimbolo(inst.simbologia, inst.carga).map((m) => `${inst.etiqueta}: ${m}`));
        if (inst.leible !== null && leibleNormalizado(inst.leible) !== inst.carga) {
          motivos.push(`${inst.etiqueta}: lo impreso no es lo codificado`);
        }
      }

      // --- Afirmaciones en POSITIVO de que esto no puede cobrar --------------------------------
      const barras = bloque.instrumentos.find((i) => i.tipo === "simbolo" && i.simbologia === "interleaved2of5");
      if (!barras || barras.tipo !== "simbolo") {
        motivos.push("falta el código de barras");
      } else {
        if (barras.carga.length !== LARGO_CARGA_BARRAS) {
          motivos.push(`el código de barras tiene ${barras.carga.length} dígitos y el convenio de demo usa ${LARGO_CARGA_BARRAS}`);
        }
        const cuerpo = barras.carga.slice(0, -1);
        if (Number(barras.carga.slice(-1)) === digitoVerificadorDemo(cuerpo)) {
          motivos.push("el dígito verificador del código de barras es VÁLIDO: una muestra no puede llevar un instrumento pagable");
        }
        if (!barras.carga.startsWith(CONVENIO_INEXISTENTE)) {
          motivos.push("el código de barras no arranca con el convenio inexistente de la demo");
        }
      }

      const cbu = bloque.instrumentos.find((i) => i.tipo === "texto" && i.etiqueta === "CBU");
      if (!cbu || cbu.tipo !== "texto") {
        motivos.push("falta el CBU");
      } else if (!/^\d{22}$/.test(cbu.valor)) {
        motivos.push("el CBU no tiene 22 dígitos: se vería falso a simple vista");
      } else if (cbuValido(cbu.valor)) {
        motivos.push("el CBU tiene los verificadores VÁLIDOS: el home banking lo aceptaría y alguien podría pagarlo");
      }

      motivos.push(...revisarTextosImpresos(bloque.leyendas));

      return motivos.length === 0 ? { ok: true } : { ok: false, motivos };
    },
  };
}
