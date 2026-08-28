/**
 * El cuerpo del email con el que viaja la liquidación.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LO QUE **NO** VA, QUE ES LA PARTE QUE IMPORTA
 *
 * Este texto viaja en claro entre servidores, queda indexado en el buzón de quien lo recibe y
 * aparece en la vista previa de una pantalla bloqueada. Por eso:
 *
 *  - **Ningún importe. Ningún saldo.** El importe está en el adjunto, que es el documento. Un total
 *    en el cuerpo es el número de la deuda de una familia visible desde la pantalla apagada del
 *    teléfono, y no compra nada que el PDF no diga mejor.
 *  - **Ninguna mención de mora ni de deuda.** Ya está decidido en otro lado (doc 01 §4.8, doc 10
 *    §E.3) y acá se cumple: el listado de mora tiene su propio canal y su propia lista.
 *  - **Ningún link con token.** Sería un secreto de portador viajando por el mismo canal, que
 *    sobrevive al reenvío — y hoy no hay a qué colgarlo, porque no existe el portal del residente.
 *    El día que exista, es su propia decisión escrita.
 *  - **Ninguna otra unidad.** Ni siquiera una lista tipo "adjuntamos las liquidaciones de sus
 *    unidades": cada envío es de una unidad.
 *  - **Sin `List-Unsubscribe`.** No hay baja autogestiva, y prometer una que no existe es peor que
 *    no ofrecerla.
 *
 * Lo que sí va: barrio, período, qué se adjunta, y a quién dirigirse.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * EL TEXTO PASA POR EL MISMO FILTRO QUE EL PAPEL
 *
 * `revisarTextosImpresos()` (doc 07 §E) existe para que ningún documento le diga "moroso" a nadie.
 * **El correo que acompaña la boleta es tan susceptible de decirlo como la boleta**, así que pasa
 * por el mismo filtro — y `armarMensajeDeLiquidacion()` falla si algo no lo pasa, en vez de mandar.
 */

import { revisarTextosImpresos } from "@admin-barrios/documentos/lenguaje";
import { sanearTextoDePlanilla } from "@admin-barrios/shared/planilla";

/**
 * La versión del cuerpo, que se guarda en cada fila de `envio_liquidacion`.
 *
 * **Es lo que permite reconstruir qué decía un correo sin haberlo guardado** — y no guardarlo es lo
 * que mantiene el importe y el nombre fuera de la tabla de registro. Sube cuando el texto cambia.
 */
export const VERSION_PLANTILLA_LIQUIDACION = "liquidacion/1";

export type DatosDeLiquidacion = {
  readonly barrioNombre: string;
  /** `"07/2026"`, ya formateado por quien llama: acá no se formatea nada. */
  readonly periodoEtiqueta: string;
  /** Cómo llama el barrio a lo que cobra. Nunca "expensa" horneado: en una SA son aportes. */
  readonly denominacion: string;
  readonly unidadEtiqueta: string;
  readonly nombreDestinatario: string | null;
  /** La casilla que alguien lee. Sin esto el correo es una vía muerta. */
  readonly responderA: string | null;
};

export type CuerpoDeCorreo = {
  readonly asunto: string;
  readonly texto: string;
  readonly version: string;
};

/**
 * Arma el asunto y el cuerpo. **Lanza si el texto no pasa el filtro de lenguaje**: es preferible no
 * mandar a mandar algo que el proyecto se comprometió a no decir.
 */
export function armarCuerpoDeLiquidacion(datos: DatosDeLiquidacion): CuerpoDeCorreo {
  /*
   * El nombre del barrio y el de la persona son texto que escribió un humano. Se sanean con la misma
   * función que la planilla —no por el riesgo de fórmula, que acá no aplica, sino porque neutraliza
   * los caracteres de control que después terminan en una cabecera— y el adapter vuelve a rechazar
   * cualquier CR/LF antes de mandar. Dos capas, a propósito.
   */
  const barrio = sanearTextoDePlanilla(datos.barrioNombre);
  const unidad = sanearTextoDePlanilla(datos.unidadEtiqueta);
  const nombre = datos.nombreDestinatario ? sanearTextoDePlanilla(datos.nombreDestinatario) : null;
  const denominacion = sanearTextoDePlanilla(datos.denominacion);

  const asunto = `${barrio} — ${denominacion} ${datos.periodoEtiqueta} — ${unidad}`;

  const saludo = nombre ? `Hola, ${nombre}:` : "Hola:";
  const cierre = datos.responderA
    ? `Ante cualquier consulta podés responder a este correo o escribir a ${datos.responderA}.`
    : "Ante cualquier consulta podés responder a este correo.";

  const texto = [
    saludo,
    "",
    `Te enviamos la liquidación de ${denominacion} del período ${datos.periodoEtiqueta} ` +
      `correspondiente a ${unidad}, en ${barrio}.`,
    "",
    "Adjuntamos dos archivos:",
    `· Tu liquidación individual, con el detalle de lo que corresponde a ${unidad}.`,
    "· El informe mensual del barrio, con los gastos del período.",
    "",
    cierre,
    "",
    barrio,
  ].join("\n");

  /*
   * El mismo filtro que el papel. Si algo no pasa, **no se manda**: un correo con una palabra
   * prohibida es más difícil de retirar que un PDF, porque ya está en la bandeja de quien lo recibió.
   */
  const problemas = revisarTextosImpresos([asunto, texto]);
  if (problemas.length > 0) {
    throw new Error(
      `el cuerpo del correo no pasa el filtro de lenguaje y no se envía: ${problemas.join("; ")}`,
    );
  }

  return { asunto, texto, version: VERSION_PLANTILLA_LIQUIDACION };
}
