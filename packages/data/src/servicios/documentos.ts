/**
 * Los documentos emitidos: registrarlos al generarlos, listarlos, y preparar una descarga.
 *
 * ### La regla que sostiene toda la seguridad de la descarga
 *
 * **Ninguna firma se acuña sobre una clave que no volvió de una fila leída bajo RLS en esa misma
 * transacción.** No es una convención de estilo: presignar una URL de S3 **no consulta a nadie** —se
 * calcula localmente con la credencial— y la credencial de la aplicación alcanza al bucket entero.
 * Lo único que separa "mi boleta" de "todas las boletas de todos los barrios" es este `select`.
 *
 * De ahí salen dos consecuencias que hay que respetar aunque parezcan incómodas:
 *
 *  - `prepararDescarga` recibe un **`documentoId`**, jamás una `storage_key`. Una ruta que acepte una
 *    clave por parámetro convierte la credencial en una llave maestra.
 *  - **El registro de la descarga se escribe antes de firmar, en la misma transacción.** Si el
 *    registro falla, no hay URL. Una auditoría que se puede saltear con un error no es una auditoría.
 *
 * ### Y una que se nota compilando
 *
 * `documento_emitido.vista` **no se le concede en lectura al rol de request** (grant por columna,
 * migración 0027): la vista congelada es el documento entero, y proyectarla es servirlo sin pasar por
 * la ruta de descarga ni por su registro. Por eso acá **no hay ningún `select *`**: enumerar las
 * columnas obliga a decidir si se quiere la vista, y la respuesta es que no.
 */

import { sql } from "drizzle-orm";
import { consultaPeriodoSchema, consultaUnidadSchema, idSchema } from "@admin-barrios/shared/consultas";
import { etiquetaUnidad } from "@admin-barrios/shared/barrio";
import {
  prepararSubidaDeComprobanteSchema,
  type PrepararSubidaDeComprobante,
} from "@admin-barrios/shared/escrituras";
import { claveDeComprobante, nuevoToken, type ContentTypeDeComprobante } from "@admin-barrios/almacenamiento";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar } from "../errores.ts";

/** Espejo del enum `app.tipo_documento`. */
export type TipoDocumento = "boleta_unidad" | "informe_mensual" | "listado_saldos_pendientes";

export type DocumentoDeLista = {
  readonly id: string;
  readonly tipo: TipoDocumento;
  /** `null` para los documentos del período (informe, listado). */
  readonly unidad: string | null;
  readonly bytes: number;
  readonly emitidoAt: string;
};

/**
 * Cómo se llama el archivo que baja. **Una sola definición**, porque había dos: el worker lo grababa
 * en el objeto de una forma y la ruta de descarga lo firmaba de otra. Ganaba el del presign, así que
 * el del objeto era código muerto que se leía como si hiciera algo.
 *
 * **Nunca lleva el nombre del titular**: viaja en el querystring de la URL firmada, que va al log de
 * acceso del proveedor de almacenamiento igual que la clave. La unidad sí, que es lo que hace que
 * cincuenta boletas en la carpeta de descargas se puedan distinguir.
 */
export function nombreDeArchivo(d: {
  tipo: TipoDocumento;
  periodo: string;
  /** La etiqueta de la unidad (`etiquetaUnidad(manzana, lote)`), o `null` si el documento es del período. */
  unidad?: string | null;
}): string {
  const prefijo =
    d.tipo === "boleta_unidad" ? "Expensas" : d.tipo === "informe_mensual" ? "Informe" : "Saldos-pendientes";
  // El saneado a caracteres de nombre de archivo lo hace el adapter de almacenamiento, en un solo
  // lugar y para todos los llamadores.
  return `${prefijo}-${d.periodo}${d.unidad ? `-${d.unidad}` : ""}.pdf`;
}

export type DescargaPreparada = {
  readonly storageKey: string;
  /**
   * Cómo se va a llamar el archivo que baja.
   *
   * **Nunca lleva el nombre del titular**, y no es una precaución teórica: este texto viaja en el
   * querystring de la URL firmada, que va al log de acceso del proveedor de almacenamiento igual que
   * la clave. La unidad sí va: es lo que hace que 50 boletas en la carpeta de descargas se puedan
   * distinguir.
   */
  readonly nombreArchivo: string;
};

/** Lo que el worker escribe al terminar cada documento. */
export type DocumentoEmitido = {
  readonly periodoId: string;
  readonly barrioId: string;
  readonly tipo: TipoDocumento;
  readonly liquidacionId: string | null;
  readonly storageKey: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly vista: unknown;
  readonly vistaVersion: string;
  readonly motor: string;
  readonly plantillaHash: string;
  readonly medioCobranza: string;
};

/**
 * Registra un documento ya escrito en el almacenamiento.
 *
 * **El orden importa y es objeto primero, fila después.** Si el proceso muere en el medio, lo que
 * queda es un objeto huérfano de 73 KB en una clave aleatoria que nadie referencia. Al revés
 * quedaría una fila que la pantalla ofrece y cuya descarga rompe — o peor, una `storage_key`
 * reservada que una corrida posterior escribe con **otro** contenido.
 *
 * `emitido_por` y `emitido_at` no están en la lista de columnas a propósito: los escribe la base
 * desde `app.current_user_id()`, igual que `periodo_expensa.emitida_por` (0013).
 */
export async function registrarDocumentoEmitido(
  tx: DbConIdentidad,
  d: DocumentoEmitido,
): Promise<string> {
  return enBase(async () => {
    const fila = (
      await tx.execute<{ id: string }>(sql`
        insert into documento_emitido
          (barrio_id, periodo_id, tipo, liquidacion_id, storage_key, sha256, bytes,
           vista, vista_version, motor, plantilla_hash, medio_cobranza)
        values
          (${d.barrioId}, ${d.periodoId}, ${d.tipo}::app.tipo_documento, ${d.liquidacionId},
           ${d.storageKey}, ${d.sha256}, ${d.bytes}, ${JSON.stringify(d.vista)}::jsonb,
           ${d.vistaVersion}, ${d.motor}, ${d.plantillaHash}, ${d.medioCobranza})
        returning id
      `)
    ).rows[0];
    if (!fila) {
      rechazar(
        "desconocido",
        "No se pudo registrar el documento emitido.",
        "Volvé a generar los documentos del período.",
      );
    }
    return fila.id;
  });
}

/**
 * `etiqueta de unidad → liquidacion.id` para un período.
 *
 * Existe por un motivo chico y concreto: `VistaBoleta` **no lleva el `liquidacion_id`**, y no tiene
 * por qué llevarlo — es el modelo de lo que se imprime, y ese uuid no se imprime. Pero la fila del
 * documento emitido sí necesita saber de qué liquidación salió.
 *
 * Se resuelve por la etiqueta (`Mza 3 · Lote 12`), que es única dentro del barrio, y **no por la
 * posición en el array**: aparear dos listas por índice es correcto hasta que alguien cambia un
 * `order by` en el otro archivo, y entonces cada boleta queda registrada contra la unidad de al lado
 * sin que nada falle.
 */
export async function liquidacionesPorUnidad(
  tx: DbConIdentidad,
  periodoId: string,
): Promise<Map<string, string>> {
  return enBase(async () => {
    const filas = await tx.execute<{ id: string; manzana: string; lote: string }>(sql`
      select l.id, u.manzana, u.lote
        from liquidacion l
        join unidad_funcional u on u.id = l.unidad_funcional_id
       where l.periodo_id = ${periodoId}
    `);
    return new Map(filas.rows.map((f) => [etiquetaUnidad(f.manzana, f.lote), f.id]));
  });
}

/**
 * Las liquidaciones del período que **ya tienen su boleta emitida**.
 *
 * Es lo que hace que "generar los que falten" sea cierto y no un rótulo. Sin esto, un reintento
 * después de una falla parcial vuelve a renderizar el período entero y deja **dos filas por unidad**,
 * distinguibles solo por la hora — y quien mira la pantalla no tiene forma de saber cuál mandó.
 *
 * Es también el "guard de early-exit barato" que pide ADR-0001 §5 punto 6: si el período ya está
 * completo, el trabajo retorna sin renderizar nada.
 */
export async function liquidacionesConBoleta(
  tx: DbConIdentidad,
  periodoId: string,
): Promise<Set<string>> {
  return enBase(async () => {
    const filas = await tx.execute<{ liquidacion_id: string }>(sql`
      select distinct liquidacion_id from documento_emitido
       where periodo_id = ${periodoId} and tipo = 'boleta_unidad' and liquidacion_id is not null
    `);
    return new Set(filas.rows.map((f) => f.liquidacion_id));
  });
}

/** Los documentos ya emitidos de un período, para la pantalla que los ofrece. */
export async function listarDocumentosDePeriodo(
  tx: DbConIdentidad,
  entrada: { periodoId: string },
): Promise<DocumentoDeLista[]> {
  const { periodoId } = consultaPeriodoSchema.parse(entrada);
  return enBase(async () => {
    const filas = await tx.execute<{
      id: string;
      tipo: TipoDocumento;
      manzana: string | null;
      lote: string | null;
      bytes: number;
      emitido_at: string;
    }>(sql`
      select d.id, d.tipo::text as tipo, u.manzana, u.lote, d.bytes, d.emitido_at::text as emitido_at
        from documento_emitido d
        left join liquidacion l on l.id = d.liquidacion_id
        left join unidad_funcional u on u.id = l.unidad_funcional_id
       where d.periodo_id = ${periodoId}
       order by u.manzana nulls first, u.lote nulls first, d.emitido_at
    `);
    return filas.rows.map((f) => ({
      id: f.id,
      tipo: f.tipo,
      unidad: f.manzana && f.lote ? etiquetaUnidad(f.manzana, f.lote) : null,
      bytes: f.bytes,
      emitidoAt: f.emitido_at,
    }));
  });
}

/**
 * Lee el documento bajo RLS, **registra la acuñación del link**, y devuelve la clave para firmar.
 *
 * Las dos operaciones van en la misma transacción y en este orden. Quien llame a esto no tiene que
 * acordarse de registrar nada: no hay forma de obtener la clave sin dejar el rastro.
 */
export async function prepararDescarga(
  tx: DbConIdentidad,
  entrada: { documentoId: string; ttlSegundos: number },
): Promise<DescargaPreparada> {
  // Un segmento de URL sin forma de uuid es "no existe", **no** un error del sistema. Sin esto
  // revienta el cast de Postgres (22P02) y sale un 500 con código de soporte por una dirección mal
  // tipeada — una caída aparente donde solo hubo un enlace roto.
  //
  // Y se traduce al MISMO rechazo que un uuid válido inexistente, a propósito: un código distinto
  // para "mal formado" es un oráculo que ayuda a enumerar.
  const id = idSchema.safeParse(entrada.documentoId);
  if (!id.success) {
    rechazar(
      "documento_no_encontrado",
      "El documento no existe o no tenés acceso.",
      "Volvé a la lista de documentos del período y probá de nuevo.",
    );
  }
  const documentoId = id.data;
  return enBase(async () => {
    const fila = (
      await tx.execute<{
        id: string;
        storage_key: string;
        tipo: TipoDocumento;
        periodo: string;
        manzana: string | null;
        lote: string | null;
      }>(sql`
        select d.id, d.storage_key, d.tipo::text as tipo, p.periodo, u.manzana, u.lote
          from documento_emitido d
          join periodo_expensa p on p.id = d.periodo_id
          left join liquidacion l on l.id = d.liquidacion_id
          left join unidad_funcional u on u.id = l.unidad_funcional_id
         where d.id = ${documentoId}
      `)
    ).rows[0];

    // "No existe" y "no lo podés ver" son el mismo caso: distinguirlos convertiría esta ruta en un
    // oráculo que dice si un documento de otro barrio existe.
    if (!fila) {
      rechazar(
        "documento_no_encontrado",
        "El documento no existe o no tenés acceso.",
        "Volvé a la lista de documentos del período y probá de nuevo.",
      );
    }

    // Antes de firmar, no después. El trigger deriva el barrio del documento —bajo RLS otra vez— y
    // escribe quién lo pidió.
    await registrarDescarga(tx, { documentoId: fila.id, ttlSegundos: entrada.ttlSegundos });

    return {
      storageKey: fila.storage_key,
      nombreArchivo: nombreDeArchivo({
        tipo: fila.tipo,
        periodo: fila.periodo,
        unidad: fila.manzana && fila.lote ? etiquetaUnidad(fila.manzana, fila.lote) : null,
      }),
    };
  });
}

/**
 * Inserta el registro de auditoría de una descarga, bajo la RLS de quien la pide.
 *
 * Común a las dos variantes de acá (documento de período, recibo de pago): la única diferencia entre
 * ellas es CUÁL de las referencias exclusivas de `descarga_documento` viaja no nula
 * (`descarga_referencia_unica_chk`, migración `0039`) — la columna que no se manda queda `NULL` sin
 * necesidad de decirlo. Extraído para que las dos variantes no repitan el `insert`: es el mismo motivo
 * por el que `prepararDescarga` ya documentaba "el orden importa, objeto primero, fila después" — ese
 * comentario vale igual para las dos, y repetirlo en cada una es el riesgo de que diverjan.
 *
 * **Las tres variantes son mutuamente excluyentes**, mismo `CHECK num_nonnulls(...) = 1` de la base
 * (`descarga_referencia_unica_chk`, `0039`): quien llama pasa una sola de las tres claves.
 */
async function registrarDescarga(
  tx: DbConIdentidad,
  entrada: { documentoId?: string; reciboId?: string; pagoId?: string; ttlSegundos: number },
): Promise<void> {
  await tx.execute(sql`
    insert into descarga_documento (documento_id, recibo_emitido_id, pago_id, ttl_segundos)
    values (${entrada.documentoId ?? null}, ${entrada.reciboId ?? null}, ${entrada.pagoId ?? null}, ${entrada.ttlSegundos})
  `);
}

/**
 * Cómo se llama el archivo de un recibo que baja. Lleva el número de recibo y no el período: a
 * diferencia de una boleta, un recibo no está atado a un período de expensa (`recibo_emitido.pago_id`
 * cuelga de `pago`, no de `periodo_expensa`) — su identidad natural es la numeración correlativa por
 * barrio que asigna `app.recibo_antes()` (migración `0039`).
 *
 * Separado de `nombreDeArchivo()` y no un caso más de su `switch`: esa función arma el nombre a partir
 * de `TipoDocumento` (`boleta_unidad` | `informe_mensual` | `listado_saldos_pendientes`), que es el
 * enum de `documento_emitido` — un recibo no es ninguno de esos tres, forzarlo ahí sería mentirle al
 * tipo para reusar una función que en realidad necesita otro dato (el número, no el período).
 */
function nombreDeArchivoRecibo(numeroRecibo: string): string {
  return `Recibo-${numeroRecibo}.pdf`;
}

/**
 * Lee un recibo bajo RLS, registra la acuñación del link, y devuelve la clave para firmar. Mismo
 * contrato que `prepararDescarga()`, para uno de los otros dos orígenes posibles de una descarga
 * (recibo de pago en vez de documento de período): recibe un `reciboId`, jamás una `storage_key`, y
 * el registro se escribe **antes** de firmar.
 */
export async function prepararDescargaDeRecibo(
  tx: DbConIdentidad,
  entrada: { reciboId: string; ttlSegundos: number },
): Promise<DescargaPreparada> {
  // Mismo motivo que en `prepararDescarga`: un segmento de URL sin forma de uuid es "no existe", no
  // un error del sistema.
  const id = idSchema.safeParse(entrada.reciboId);
  if (!id.success) {
    rechazar(
      "recibo_no_encontrado",
      "El recibo no existe o no tenés acceso.",
      "Volvé a la lista de pagos del barrio y probá de nuevo.",
    );
  }
  const reciboId = id.data;
  return enBase(async () => {
    const fila = (
      await tx.execute<{ id: string; storage_key: string; numero_recibo: string }>(sql`
        select id, storage_key, numero_recibo::text
          from recibo_emitido
         where id = ${reciboId}
      `)
    ).rows[0];

    // "No existe" y "no lo podés ver" son el mismo caso, igual que en `prepararDescarga`.
    if (!fila) {
      rechazar(
        "recibo_no_encontrado",
        "El recibo no existe o no tenés acceso.",
        "Volvé a la lista de pagos del barrio y probá de nuevo.",
      );
    }

    // Antes de firmar, no después — mismo motivo que `prepararDescarga`.
    await registrarDescarga(tx, { reciboId: fila.id, ttlSegundos: entrada.ttlSegundos });

    return {
      storageKey: fila.storage_key,
      nombreArchivo: nombreDeArchivoRecibo(fila.numero_recibo),
    };
  });
}

/**
 * Cómo se llama el archivo del comprobante que baja. Lleva la fecha del pago y no el número de
 * recibo: un comprobante puede existir sin que el pago tenga ningún recibo emitido todavía (son dos
 * documentos con ciclos de vida independientes — el comprobante lo sube el operador al registrar el
 * cobro, el recibo lo emite un trabajo aparte, después).
 */
function nombreDeArchivoComprobante(fecha: string): string {
  return `Comprobante-${fecha}.pdf`;
}

/**
 * Lee el comprobante adjunto de un pago manual bajo RLS, registra la acuñación del link, y devuelve
 * la clave para firmar. Tercera variante del mismo contrato que `prepararDescarga()`/
 * `prepararDescargaDeRecibo()`: recibe un `pagoId`, jamás una `storage_key`.
 *
 * **No todo pago tiene comprobante.** Uno de `origen = 'extracto'` nunca lo carga a mano
 * (`pago_manual_exige_registrador_chk`, `0034`, exige el par contrario). Ese caso no es "no existe o
 * no tenés acceso" — el pago existe y es accesible, simplemente no hay nada que descargar — así que
 * se distingue con su propio mensaje en vez de reusar `pago_no_encontrado`, que sería falso acá.
 */
export async function prepararDescargaDeComprobante(
  tx: DbConIdentidad,
  entrada: { pagoId: string; ttlSegundos: number },
): Promise<DescargaPreparada> {
  // Mismo motivo que en `prepararDescarga`: un segmento de URL sin forma de uuid es "no existe", no
  // un error del sistema.
  const id = idSchema.safeParse(entrada.pagoId);
  if (!id.success) {
    rechazar(
      "pago_no_encontrado",
      "Ese pago no existe o no tenés acceso.",
      "Volvé a la lista de pagos del barrio y probá de nuevo.",
    );
  }
  const pagoId = id.data;
  return enBase(async () => {
    const fila = (
      await tx.execute<{ id: string; comprobante_adjunto: string | null; fecha: string }>(sql`
        select id, comprobante_adjunto, fecha::text
          from pago
         where id = ${pagoId}
      `)
    ).rows[0];

    // "No existe" y "no lo podés ver" son el mismo caso, igual que en `prepararDescarga`.
    if (!fila) {
      rechazar(
        "pago_no_encontrado",
        "Ese pago no existe o no tenés acceso.",
        "Volvé a la lista de pagos del barrio y probá de nuevo.",
      );
    }

    if (fila.comprobante_adjunto === null) {
      rechazar(
        "comprobante_no_adjunto",
        "Ese pago no tiene comprobante adjunto.",
        "Los pagos de extracto no llevan un comprobante cargado a mano.",
      );
    }

    // Antes de firmar, no después — mismo motivo que `prepararDescarga`.
    await registrarDescarga(tx, { pagoId: fila.id, ttlSegundos: entrada.ttlSegundos });

    return {
      storageKey: fila.comprobante_adjunto,
      nombreArchivo: nombreDeArchivoComprobante(fila.fecha),
    };
  });
}

/** Un recibo ya emitido, para el panel "Recibos" del estado de cuenta. */
export type ReciboDeUnidad = {
  readonly id: string;
  readonly numeroRecibo: string;
  readonly emitidoAt: string;
  readonly pagoId: string;
  readonly montoPago: string;
};

/**
 * Los recibos ya emitidos de una unidad, más nuevo primero.
 *
 * Cuelga de `pago.unidad_funcional_id` y no de `recibo_emitido` directo: la tabla solo tiene
 * `pago_id`, la unidad es un salto más (mismo motivo que `listarPagosDeUnidad`, `pagos.ts` — un
 * recibo no está atado a un período, así que no hay un `periodo_id`/`unidad_funcional_id` a mano en
 * la fila misma).
 */
export async function listarRecibosDeUnidad(
  tx: DbConIdentidad,
  entrada: { unidadFuncionalId: string },
): Promise<ReciboDeUnidad[]> {
  const { unidadFuncionalId } = consultaUnidadSchema.parse(entrada);
  return enBase(async () => {
    const filas = await tx.execute<{
      id: string;
      numero_recibo: string;
      emitido_at: string;
      pago_id: string;
      monto_pago: string;
    }>(sql`
      select r.id, r.numero_recibo::text, r.emitido_at::text, r.pago_id, p.monto::text as monto_pago
        from recibo_emitido r
        join pago p on p.id = r.pago_id
       where p.unidad_funcional_id = ${unidadFuncionalId}
       order by r.emitido_at desc
    `);
    return filas.rows.map((f) => ({
      id: f.id,
      numeroRecibo: f.numero_recibo,
      emitidoAt: f.emitido_at,
      pagoId: f.pago_id,
      montoPago: f.monto_pago,
    }));
  });
}

/**
 * Lo mínimo del recibo ya emitido de un pago, para que `emitirReciboDePago` (`apps/worker`) pueda
 * cerrar el trabajo sin generar un segundo recibo.
 *
 * **Por qué hace falta antes de renderizar nada:** `recibo_emitido.numero_recibo` es secuencial por
 * barrio (`recibo_secuencia`, migración `0042`), así que un reintento que no chequeara esto
 * generaría un SEGUNDO recibo válido para el mismo pago, con otro número — dos documentos "reales"
 * donde debería haber uno. Este chequeo es lo que hace que reencolar el trabajo sea seguro.
 */
export type ReciboExistente = {
  readonly id: string;
  readonly storageKey: string;
  readonly bytes: number;
};

/** `null` si el pago todavía no tiene recibo — el camino normal, antes de la primera emisión. */
export async function reciboYaEmitido(tx: DbConIdentidad, pagoId: string): Promise<ReciboExistente | null> {
  return enBase(async () => {
    const fila = (
      await tx.execute<{ id: string; storage_key: string; bytes: number }>(sql`
        select id, storage_key, bytes from recibo_emitido where pago_id = ${pagoId}
      `)
    ).rows[0];
    return fila ? { id: fila.id, storageKey: fila.storage_key, bytes: fila.bytes } : null;
  });
}

/**
 * Reserva el próximo número de recibo del barrio del pago — ANTES de renderizar, para que el número
 * pueda imprimirse dentro del PDF (`app.reservar_numero_recibo()`, migración `0042`). El valor que
 * devuelve se le pasa tal cual a `armarVistaDeRecibo()` (para imprimirlo) y a
 * `registrarReciboEmitido()` (para que `app.recibo_antes()` lo respete en vez de reasignarlo).
 *
 * **Sin ceros de relleno**: es el mismo `numero_recibo::text` crudo que ya usan
 * `listarRecibosDeUnidad()` y `prepararDescargaDeRecibo()` más arriba en este archivo — no hay una
 * convención de formato distinta que inventar acá.
 *
 * **Riesgo aceptado, Nivel 1** (decisión del usuario, no de este código): si el proceso muere entre
 * esta llamada y el `insert` de `registrarReciboEmitido()`, este número queda consumido sin un
 * recibo asociado — un hueco en la secuencia del barrio. `legal-ph` y `contador` (panel del
 * 2026-08-20) no identificaron esto como riesgo legal ni fiscal para el recibo de pago —vacío de
 * fuente, no autorización normativa; validar con profesional matriculado antes de tratarlo como
 * definitivo—. Ver el comentario de cabecera de la migración `0042_reserva_numero_recibo.sql` para
 * el detalle completo, incluido por qué NO se implementó la garantía de cero huecos (Nivel 2).
 */
export async function reservarNumeroDeRecibo(tx: DbConIdentidad, pagoId: string): Promise<string> {
  return enBase(async () => {
    const fila = (
      await tx.execute<{ numero: string }>(
        sql`select app.reservar_numero_recibo(${pagoId}) as numero`,
      )
    ).rows[0];
    if (!fila) {
      rechazar(
        "desconocido",
        "No se pudo reservar el número de recibo.",
        "Volvé a intentar. Si sigue pasando, avisá con el código de referencia.",
      );
    }
    return String(fila.numero);
  });
}

/** Lo que el worker escribe al terminar la emisión del recibo de un pago. */
export type ReciboEmitido = {
  readonly barrioId: string;
  readonly pagoId: string;
  /** El que devolvió `reservarNumeroDeRecibo()` — se nombra explícito para que el trigger lo respete. */
  readonly numeroRecibo: string;
  readonly storageKey: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly vista: unknown;
  readonly vistaVersion: string;
  readonly motor: string;
  readonly plantillaHash: string;
};

/**
 * Registra un recibo ya escrito en el almacenamiento. Mismo orden que `registrarDocumentoEmitido()`:
 * objeto primero, fila después.
 *
 * **Nombra `numero_recibo` explícito en el `insert`** (a diferencia del `insert` "clásico", que
 * dejaba que `app.recibo_antes()` lo asignara entero) — es lo que le permite al trigger distinguir
 * "ya viene reservado, respetalo" de "insert directo, asignalo vos" (migración `0042`). Postgres
 * exige privilegio de columna sobre lo que el `insert` nombra explícitamente, así que esto necesitó
 * ensanchar el grant de `0039` — ver la migración `0042`, sección 3.
 */
export async function registrarReciboEmitido(tx: DbConIdentidad, d: ReciboEmitido): Promise<string> {
  return enBase(async () => {
    const fila = (
      await tx.execute<{ id: string }>(sql`
        insert into recibo_emitido
          (barrio_id, pago_id, numero_recibo, storage_key, sha256, bytes,
           vista, vista_version, motor, plantilla_hash)
        values
          (${d.barrioId}, ${d.pagoId}, ${d.numeroRecibo}::bigint, ${d.storageKey}, ${d.sha256}, ${d.bytes},
           ${JSON.stringify(d.vista)}::jsonb, ${d.vistaVersion}, ${d.motor}, ${d.plantillaHash})
        returning id
      `)
    ).rows[0];
    if (!fila) {
      rechazar(
        "desconocido",
        "No se pudo registrar el recibo emitido.",
        "Volvé a generar el recibo de este pago.",
      );
    }
    return fila.id;
  });
}

export type SubidaDeComprobantePreparada = {
  readonly storageKey: string;
};

/**
 * Deriva el barrio de la unidad bajo RLS, arma la clave del comprobante y **registra que se pidió
 * subirlo, en la misma transacción**, antes de que quien llame pueda firmar nada. Mismo principio
 * que `prepararDescarga`/`prepararDescargaDeComprobante`, en la dirección contraria: acá no se lee
 * una fila que ya tiene una clave, se la inventa — pero la clave nunca sale de esta función sin que
 * la fila de auditoría ya esté escrita.
 *
 * **No firma la URL.** Firmar exige el SDK de S3, y este paquete no lo importa (regla 12 del gate de
 * arquitectura: el SDK solo lo nombra la puerta de cada aplicación). Quien llama —la puerta de
 * `apps/web`— toma la `storageKey` que devuelve esto y la pasa a `ObjectStorage.urlFirmadaDeSubida()`
 * recién después.
 */
export async function prepararSubidaDeComprobante(
  tx: DbConIdentidad,
  parametros: PrepararSubidaDeComprobante,
): Promise<SubidaDeComprobantePreparada> {
  const p = prepararSubidaDeComprobanteSchema.parse(parametros);

  return enBase(async () => {
    const fila = (
      await tx.execute<{ barrio_id: string }>(sql`
        select barrio_id from unidad_funcional where id = ${p.unidadFuncionalId}
      `)
    ).rows[0];

    // "No existe" y "no la podés ver" son el mismo caso, mismo criterio que `registrarPago()`: un
    // uuid de una unidad ajena no puede ser un oráculo de existencia.
    if (!fila) {
      rechazar(
        "unidad_no_encontrada",
        "Esa unidad no existe o no tenés acceso a ella.",
        "Volvé al padrón del barrio y elegí la unidad de nuevo.",
      );
    }

    const storageKey = claveDeComprobante({
      barrioId: fila.barrio_id,
      token: nuevoToken(),
      contentType: p.contentType as ContentTypeDeComprobante,
    });

    // Antes de devolver la clave, no después — mismo motivo que `prepararDescarga`. `barrio_id` y
    // `unidad_funcional_id` viajan explícitos (no un `insert … select`): ya se leyeron bajo RLS en
    // el `select` de arriba, y la FK compuesta `fk_subida_comprobante_uf_barrio` (`0041`) rechaza
    // estructuralmente cualquier par que no sea el real de la unidad.
    await tx.execute(sql`
      insert into subida_comprobante_solicitada (barrio_id, unidad_funcional_id, storage_key, content_type)
      values (${fila.barrio_id}, ${p.unidadFuncionalId}, ${storageKey}, ${p.contentType})
    `);

    return { storageKey };
  });
}
