/**
 * `MedioCobranza` — el bloque de pago, enchufable por barrio (ADR-0001 §4.4).
 *
 * El medio de cobranza **no se puede hardcodear**: hoy un piloto cobra por una red bancaria
 * concreta; el próximo cliente va a usar otro banco, débito automático o una billetera. Es otra
 * abstracción de portabilidad, en la misma línea que `AuthProvider` y `ObjectStorage`.
 *
 * El corte de responsabilidades es lo que hace que esto escale a N clientes:
 *
 *  - el **adapter** decide simbología, carga y dígito verificador — todo lo que depende del convenio;
 *  - el **renderizador** (`../simbolos.ts`) decide geometría — ancho de módulo, zona muda, fondo;
 *  - la **plantilla** recorre `instrumentos` y pinta. No tiene un `if` por banco. Nunca.
 *
 * Un cliente nuevo = un archivo en `./adapters/` + una fila en el barrio. Cero cambios en la
 * plantilla, en el generador y en el worker.
 */

import type { BloquePago, LogoDocumento } from "@admin-barrios/shared/documentos";

/** Todo lo que el adapter necesita para armar el bloque. **Nada que obligue a tocar red ni base.** */
export type EntradaBloquePago = {
  /** Nombre comercial del barrio, para las leyendas del cupón. */
  readonly barrio: string;
  /** `liquidacion.numero_comprobante`. Hoy es texto libre nullable, sin serie ni correlativo. */
  readonly comprobante: string | null;
  /** Período `YYYY-MM`. */
  readonly periodo: string;
  /** `liquidacion` / `periodo_expensa.primer_vencimiento`, `YYYY-MM-DD`. */
  readonly vencimiento: string;
  /**
   * Límite de la red de cobranza. **Hoy el sistema no tiene campo propio** (doc 09 §E.11 ítem 1) y
   * el segundo vencimiento **no es** la fecha tope (§B.6): quien llame decide qué pasa acá y lo
   * declara en `faltantes`.
   */
  readonly fechaTope: string | null;
  /** TOTAL A PAGAR, como `numeric(14,2)`. Tiene que ser el mismo que imprime la zona 1. */
  readonly importe: string;
  /** Logos de la red, ya resueltos a `data:` desde `ObjectStorage` antes de render. */
  readonly logos?: readonly LogoDocumento[];
};

export type ResultadoVerificacion = { readonly ok: true } | { readonly ok: false; readonly motivos: readonly string[] };

export interface MedioCobranza {
  /** `"generico-demo"`, `"<banco>-<convenio>"`, `"debito-cbu"`. Se persiste con el documento. */
  readonly clave: string;
  /** Puro: no toca red ni base. Todo lo que necesita viene en la entrada. */
  armarBloquePago(entrada: EntradaBloquePago): BloquePago;
  /**
   * Verificación estructural propia del adapter — **compuerta 1** de ADR-0001 §7.2. Se corre
   * ANTES de emitir: si falla, la emisión **de esa unidad se bloquea**. No sale un documento con un
   * instrumento dudoso.
   */
  verificar(bloque: BloquePago): ResultadoVerificacion;
}

/*
 * ⚠ **Acá vivía `MEDIOS_SIN_VALOR_DE_PAGO`, una lista de claves que "obligaban a la marca de agua".
 * Se borró el 2026-08-05 porque no la usaba nadie**, y vale dejar escrito por qué el borrado mejora
 * la seguridad en vez de empeorarla.
 *
 * Su comentario afirmaba que la verificaba `solicitudDeBoleta()`, *"así la salvaguarda no depende de
 * que alguien se acuerde de llamar a `verificar()`"*. **Eso era falso**: `solicitudDeBoleta()` nunca
 * consultó la lista; resuelve el adapter y delega en su `verificar()`, y la marca de agua la decide
 * leyendo `bloquePago.sinValorDePago`. Un `grep` sobre el repo entero devolvía una sola línea: su
 * propia declaración.
 *
 * O sea: una salvaguarda que **se leía como activa y no lo estaba**, prometiendo cubrir justo el caso
 * que decía cubrir. Eso es peor que no tenerla, porque el próximo que agregue un adapter va a confiar
 * en ella. La salvaguarda real existe y son dos: cada adapter afirma `sinValorDePago` en su
 * `verificar()`, y el renderizador estampa la marca leyendo ese flag de la vista.
 */

export interface RegistroMediosCobranza {
  /** `barrio.medio_cobranza_clave` → adapter. Lanza si el barrio no tiene medio configurado. */
  resolver(claveBarrio: string): MedioCobranza;
}

/**
 * Registro de adapters.
 *
 * **P0 no es un hueco, es una decisión** (doc 09 §E.10.1): un barrio sin medio configurado **no
 * emite**. Mismo criterio que el bloqueo por fideicomiso — el sistema no emite un documento que no
 * sirve para lo único que tiene que servir.
 */
export function crearRegistroMediosCobranza(medios: readonly MedioCobranza[]): RegistroMediosCobranza {
  const porClave = new Map(medios.map((m) => [m.clave, m]));
  if (porClave.size !== medios.length) throw new Error("hay dos medios de cobranza con la misma clave");
  return {
    resolver(claveBarrio) {
      const medio = porClave.get(claveBarrio);
      if (!medio) {
        throw new Error(
          `el barrio no tiene un medio de pago configurado ("${claveBarrio}"): configuralo antes de emitir — ` +
            "no se imprime una boleta impagable",
        );
      }
      return medio;
    },
  };
}
