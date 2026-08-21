/**
 * Armado de la `VistaRecibo` desde la base.
 *
 * Mismo patrón que `vista-boleta.ts`: **lectura → armado puro → nada de escritura**. Corre dentro
 * de la transacción del request (`conUsuario`), y `barrio_id` se deriva del pago bajo RLS — este
 * servicio no filtra por barrio a mano y no lo recibe por parámetro.
 *
 * **El número de recibo y la fecha de emisión llegan por parámetro, ya resueltos.** No los arma
 * este archivo: `numeroRecibo` sale de `reservarNumeroDeRecibo()` (`documentos.ts`, migración
 * `0042`) — un paso de escritura, que no pertenece a un armador que solo lee — y `fechaEmisionIso`
 * es cuándo se genera el documento, no un dato que se pueda derivar del pago.
 */

import { sql } from "drizzle-orm";
import { cifra, fechaImpresa, acentoImpreso, parsearVistaRecibo, VERSION_VISTA_RECIBO, type VistaRecibo } from "@admin-barrios/shared/documentos";
import { etiquetaUnidad } from "@admin-barrios/shared/barrio";
import type { OrigenPago } from "@admin-barrios/shared/cobros";
import type { DbConIdentidad } from "../client.ts";
import { ROLES_QUE_EMITEN, SQL_ROLES_QUE_EMITEN } from "./roles.ts";

type FilaPago = {
  pago_id: string;
  barrio_id: string;
  monto: string;
  fecha: string;
  origen: OrigenPago;
  anulado: boolean;
  manzana: string;
  lote: string;
  barrio_nombre: string;
  administrador_nombre: string | null;
  tiene_mandato: boolean;
  obligado_nombre: string | null;
  /** `app.tipo_obligado`, solo si el obligado del pago tiene un vínculo VIGENTE con esta unidad —
   *  puede ser `null` con `obligado_nombre` no nulo (el vínculo venció, el nombre sigue siendo el
   *  del pago). No se inventa un rol que no está vigente. */
  obligado_rol: string | null;
  puede_emitir: boolean;
};

/**
 * Mismo criterio que `leerPeriodo()` en `vista-boleta.ts`: el nombre del administrador se trae
 * aparte del de la unidad (dos `left join`, no uno), para distinguir "no hay administrador" de
 * "hay uno y no lo puedo leer" — dos casos que un solo `join` colapsaría en el mismo `null`.
 *
 * **El destinatario sale de `pago.obligado_id`, no de "el obligado vigente de la unidad".** Son dos
 * preguntas distintas: un pago puede haberse registrado sin obligado aunque la unidad tenga uno
 * vigente hoy — `obligadoId` es un parámetro propio de `registrarPago()`, no una consecuencia de
 * quién vive ahí. Confirmado con un bug real, encontrado renderizando la plantilla contra datos de
 * siembra: la primera versión de un script de prueba resolvía el destinatario por el obligado
 * vigente de la unidad, y mostraba un nombre en un recibo de un pago que se había registrado SIN
 * obligado. El `left join unidad_obligado` de acá abajo es solo para el ROL (propietario/poseedor/
 * usufructuario/tenedor), atado al PAR (unidad, obligado) — nunca para decidir SI hay destinatario.
 */
async function leerPago(tx: DbConIdentidad, pagoId: string): Promise<FilaPago> {
  const fila = (
    await tx.execute<FilaPago>(sql`
      select pg.id as pago_id, pg.barrio_id, pg.monto::text, pg.fecha::text,
             pg.origen, (pg.anulado_at is not null) as anulado,
             uf.manzana, uf.lote,
             tb.nombre as barrio_nombre,
             ta.nombre as administrador_nombre,
             (m.id is not null) as tiene_mandato,
             ob.nombre as obligado_nombre,
             uo.tipo::text as obligado_rol,
             app.has_role_on(pg.barrio_id, ${SQL_ROLES_QUE_EMITEN}) as puede_emitir
        from pago pg
        join unidad_funcional uf on uf.id = pg.unidad_funcional_id
        join tenant_node tb on tb.id = pg.barrio_id
        left join mandato_administracion m on m.barrio_id = pg.barrio_id and m.hasta is null
        left join tenant_node ta on ta.id = m.administrador_id
        left join obligado ob on ob.id = pg.obligado_id
        left join unidad_obligado uo
          on uo.obligado_id = pg.obligado_id and uo.unidad_funcional_id = pg.unidad_funcional_id
             and uo.hasta is null
       where pg.id = ${pagoId}
    `)
  ).rows[0];
  // "No existe" y "no lo podés ver" son el mismo caso: distinguirlos convertiría esto en un oráculo
  // que confirma la existencia de un pago de otro barrio.
  if (!fila) throw new Error("el pago no existe o no es accesible");
  return fila;
}

export type OpcionesVistaRecibo = {
  readonly numeroRecibo: string;
  readonly fechaEmisionIso: string;
};

/** Arma la `VistaRecibo` de UN pago. Un `DocumentoSolicitado` sale de acá vía `solicitudDeRecibo()`. */
export async function armarVistaDeRecibo(
  tx: DbConIdentidad,
  pagoId: string,
  opciones: OpcionesVistaRecibo,
): Promise<VistaRecibo> {
  const pago = await leerPago(tx, pagoId);

  if (!pago.puede_emitir) {
    // La RLS ya dejó leer el pago (hay membership sobre el barrio), pero emitir un recibo es otra
    // cosa — mismo criterio que `armarVistasDelPeriodo()` en `vista-boleta.ts`.
    throw new Error(
      "no tenés permiso para emitir el recibo de este pago: hace falta un rol de administración " +
        `(${ROLES_QUE_EMITEN.join(", ")})`,
    );
  }

  // Un pago anulado no se le "recibe" a nadie — mismo criterio que `encolarEmisionDeRecibo()`
  // (`servicios/cobros.ts`), repetido acá porque el pago pudo anularse DESPUÉS de encolar el
  // trabajo y ANTES de que el worker lo procese: encolar y generar son dos momentos distintos, y
  // el segundo no puede confiar en que el primero siga siendo cierto.
  if (pago.anulado) {
    throw new Error("el pago está anulado: no se le puede emitir un recibo");
  }

  // Compuerta 0, igual que `armarVistasDelPeriodo()`: el emisor impreso no puede caer a un valor
  // por defecto. Con mandato abierto pero sin nombre legible, se corta acá — antes que imprimir un
  // emisor equivocado — en vez de tapar el hueco con `??` en silencio.
  if (pago.tiene_mandato && !pago.administrador_nombre) {
    throw new Error(
      "el barrio tiene un mandato de administración abierto pero el nombre del administrador no es " +
        "legible: la emisión se bloquea antes que imprimir un emisor equivocado",
    );
  }

  return parsearVistaRecibo({
    version: VERSION_VISTA_RECIBO,
    marca: {
      barrio: {
        nombre: pago.barrio_nombre,
        logo: null,
        // El barrio no tiene columna de color: sale el gris neutro, nunca la marca del producto —
        // mismo criterio que `armarVistasDelPeriodo()`.
        acentoHex: acentoImpreso(null),
      },
      emisor: {
        // Sin mandato, el emisor es el barrio mismo — correcto, no un fallback silencioso: la
        // compuerta de arriba ya cortó el único caso en que este `??` escondería algo.
        razonSocial: pago.administrador_nombre ?? pago.barrio_nombre,
        cuit: null,
        domicilio: null,
        contacto: null,
        logo: null,
      },
      pie: [],
    },
    unidad: {
      etiqueta: etiquetaUnidad(pago.manzana, pago.lote),
      destinatario: pago.obligado_nombre,
      rolDestinatario: pago.obligado_rol ?? undefined,
    },
    recibo: { numero: opciones.numeroRecibo, fecha: fechaImpresa(opciones.fechaEmisionIso) },
    pago: { fecha: fechaImpresa(pago.fecha), monto: cifra(pago.monto), origen: pago.origen },
    leyendas: [
      "Este recibo acredita el pago registrado; no implica conformidad con liquidaciones de otros períodos.",
    ],
    faltantes: [],
  });
}
