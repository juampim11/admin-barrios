/**
 * `transferencia-qr` — cobro **sin red de cobranza**: transferencia bancaria y QR de pago.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ EXISTE ESTE ADAPTER
 *
 * Decisión del usuario del 2026-08-05: la boleta de la demostración **no replica la del barrio
 * piloto**. *"No tiene que ser la boleta de Diego, porque hay info que no tenemos. Lo que le
 * presentemos tiene que demostrar la capacidad de adaptarse al sistema de cobro que se tenga (o que
 * se vaya a incorporar)."*
 *
 * De ahí lo único que este archivo tiene de particular: **no emite ningún código de barras**, ni
 * válido ni dibujado. No hay instructivo del convenio, no se conoce el proceso de la red, y un código
 * inventado es peor que ninguno.
 *
 * Y es, además, la prueba de que la abstracción sirve: se agrega un archivo, se registra, y **cambia
 * el pie de la boleta sin tocar una línea de la plantilla ni del generador**. Eso es lo que
 * ADR-0001 §4.4 prometió, y acá se cobra.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * ⚠ LA INERCIA HUBO QUE REESCRIBIRLA, NO HEREDARLA
 *
 * `generico-demo` afirma en positivo que no puede cobrar apoyándose en **tres** hechos del código de
 * barras: el largo, el dígito verificador roto y el prefijo de convenio inexistente. Los tres cuelgan
 * de encontrar el instrumento `interleaved2of5`. **Acá ese instrumento no existe**, así que copiar
 * `verificar()` hubiera dejado las afirmaciones colgando de un `find` que siempre falla — o sea, una
 * salvaguarda que se lee como activa y no verifica nada.
 *
 * Lo que queda verificable en positivo son dos cosas, y este archivo las afirma:
 *
 *   1. **El CBU tiene los dos verificadores rotos** (`cbuValido()` tiene que dar `false`). Es el
 *      control más importante: el home banking lo rechaza **antes** de pedir confirmación, así que ni
 *      siquiera llega a la pantalla donde alguien confirmaría por costumbre.
 *   2. **El QR codifica un CVU inexistente**, y no una URL. Del PDF puede salir algo que *cobre*,
 *      nunca algo que *abra* (doc 09 §E.3.3): la boleta de expensas es el archivo más reenviado de un
 *      barrio.
 *
 * Y una tercera, que es específica de este medio: **no puede haber un código de barras**. Si alguien
 * le agrega uno, la verificación falla — porque sería un instrumento sobre un convenio que este
 * adapter no tiene.
 */

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
import { cbuValido } from "../cbu.ts";
import { CVU_INEXISTENTE, aliasInerte, cbuInerte, payloadQrPago } from "../inercia.ts";
import type { EntradaBloquePago, MedioCobranza, ResultadoVerificacion } from "../medio-cobranza.ts";

export const CLAVE_TRANSFERENCIA_QR = "transferencia-qr";

/**
 * La referencia que se pone en el concepto de la transferencia.
 *
 * **Sale del número de comprobante y no de la unidad**, por el mismo motivo por el que el código de
 * barras de `generico-demo` se niega a armarse sin comprobante: sin algo único por boleta, dos
 * transferencias del mismo importe son indistinguibles y la imputación queda a ojo.
 */
export function referenciaDePago(entrada: EntradaBloquePago): string {
  const comprobante = entrada.comprobante?.trim();
  if (!comprobante) {
    throw new Error(
      "no se puede armar la referencia de pago sin número de comprobante: sin ella dos transferencias " +
        "del mismo importe no se pueden imputar (doc 09 §E.11 ítem 4)",
    );
  }
  return comprobante;
}

/** Leyendas del cupón. Redactadas **solo en positivo** (doc 07 §E). */
export function leyendasTransferencia(): readonly string[] {
  return [
    "MUESTRA SIN VALOR COMERCIAL. Este cupón es una demostración del formato y no habilita ningún pago.",
    "El pago de la presente no libera de obligaciones de períodos anteriores.",
  ];
}

export function crearMedioTransferenciaQr(): MedioCobranza {
  return {
    clave: CLAVE_TRANSFERENCIA_QR,

    armarBloquePago(entrada) {
      fechaIsoSchema.parse(entrada.vencimiento);
      const importe = cifra(entrada.importe);

      return bloquePagoSchema.parse({
        medio: CLAVE_TRANSFERENCIA_QR,
        // Dos lugares, no cuatro: el CBU, el alias y la referencia son **datos** de la transferencia,
        // no lugares donde pagar. Viven abajo, en el cupón.
        canalesDePago: ["Transferencia", "Billetera virtual"],
        instrumentos: [
          {
            tipo: "simbolo",
            etiqueta: "QR de pago",
            simbologia: "qrcode",
            carga: payloadQrPago(entrada),
            // El payload de un QR no se imprime debajo: no lo tipea nadie.
            leible: null,
          },
          { tipo: "texto", etiqueta: "CBU", valor: cbuInerte(), nota: "Cuenta de demostración" },
          { tipo: "texto", etiqueta: "Alias", valor: aliasInerte(entrada.barrio), nota: null },
          {
            tipo: "texto",
            etiqueta: "Referencia",
            valor: referenciaDePago(entrada),
            nota: "Ponela en el concepto: así el pago se imputa solo a esta boleta",
          },
        ],
        fechas: {
          vencimiento: fechaImpresa(entrada.vencimiento),
          tope: entrada.fechaTope === null ? null : fechaImpresa(entrada.fechaTope),
        },
        /*
         * Los dos importes son **iguales** porque este medio no cobra recargo. Desde el 2026-08-05 el
         * esquema ya no lo exige —dos fechas con importes distintos son legítimas— así que esto es una
         * política de este adapter y no una restricción del modelo. El día que haya recargo, el
         * importe al tope llega armado desde el servicio: acá no se calcula nada.
         */
        importes: { alVencimiento: importe, alTope: entrada.fechaTope === null ? null : importe },
        presentacion: {
          // **Sin troquel**: no hay cupón que llevar a ninguna caja. Dibujar la tijera sería prometer
          // un trámite que no existe.
          troquel: null,
          talon: "COMPROBANTE PARA VOS",
          instrucciones: [
            "Escaneá el QR desde tu billetera virtual o transferí a los datos de abajo.",
            "Guardá el comprobante: el pago se imputa solo con la referencia.",
          ],
        },
        leyendas: leyendasTransferencia(),
        logos: entrada.logos ?? [],
        sinValorDePago: true,
      } satisfies unknown);
    },

    verificar(bloque: BloquePago): ResultadoVerificacion {
      const motivos: string[] = [];

      if (bloque.medio !== CLAVE_TRANSFERENCIA_QR) motivos.push(`el bloque dice ser de "${bloque.medio}"`);
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

      // 1. El CBU, con los dos verificadores rotos. Es el control que corta antes de que aparezca
      //    ninguna pantalla de confirmación.
      const cbu = bloque.instrumentos.find((i) => i.tipo === "texto" && i.etiqueta === "CBU");
      if (!cbu || cbu.tipo !== "texto") {
        motivos.push("falta el CBU");
      } else if (!/^\d{22}$/.test(cbu.valor)) {
        motivos.push("el CBU no tiene 22 dígitos: se vería falso a simple vista");
      } else if (cbuValido(cbu.valor)) {
        motivos.push("el CBU tiene los verificadores VÁLIDOS: el home banking lo aceptaría y alguien podría pagarlo");
      }

      // 2. El QR, sobre un CVU que no existe. Se afirma que **contiene** el CVU inerte y no solo que
      //    "no es una URL": lo segundo lo cumple cualquier cadena, incluido un CVU real.
      const qr = bloque.instrumentos.find((i) => i.tipo === "simbolo" && i.simbologia === "qrcode");
      if (!qr || qr.tipo !== "simbolo") {
        motivos.push("falta el QR de pago");
      } else {
        if (!qr.carga.includes(CVU_INEXISTENTE)) {
          motivos.push("el QR no codifica el CVU inexistente de la demo: podría estar apuntando a una cuenta real");
        }
        if (/https?:\/\//i.test(qr.carga)) {
          motivos.push("el QR codifica una URL: del PDF puede salir algo que cobre, nunca algo que abra (doc 09 §E.3.3)");
        }
      }

      // 3. Y lo propio de ESTE medio: no hay red de cobranza, así que no puede haber cupón de caja.
      //    Sin esta afirmación, alguien podría agregarle un código de barras sobre un convenio que
      //    este adapter no tiene, y ninguna de las dos primeras se enteraría.
      if (bloque.instrumentos.some((i) => i.tipo === "simbolo" && i.simbologia !== "qrcode")) {
        motivos.push("este medio no tiene convenio con ninguna red: no puede llevar un símbolo de caja");
      }
      if (bloque.presentacion.troquel !== null) {
        motivos.push("este medio no se paga en una caja: el troquel prometería un trámite que no existe");
      }

      motivos.push(...revisarTextosImpresos(bloque.leyendas));

      return motivos.length === 0 ? { ok: true } : { ok: false, motivos };
    },
  };
}
