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
import { consultaPeriodoSchema, idSchema } from "@admin-barrios/shared/consultas";
import { etiquetaUnidad } from "@admin-barrios/shared/barrio";
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
    await tx.execute(sql`
      insert into descarga_documento (documento_id, ttl_segundos)
      values (${fila.id}, ${entrada.ttlSegundos})
    `);

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
