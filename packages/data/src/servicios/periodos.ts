/**
 * Períodos de expensa de un barrio, el detalle de uno y los gastos que lo componen.
 *
 * **Toda cifra viaja como `string`.** `pg` no castea `numeric` a propósito (ver `client.ts`): un
 * `Number()` sobre un importe es una pérdida de exactitud silenciosa, y acá los importes son la
 * base del reparto. La aritmética que haga falta se hace con `@admin-barrios/shared/dinero`, que
 * trabaja en centavos con `bigint`.
 *
 * **`leerPeriodo` no recibe `barrioId`, y eso no es un olvido.** Deriva el barrio de la propia fila
 * bajo RLS, igual que `armarVistasDelPeriodo()` (ADR-0001 §5.2, ADR-0002 §3.4). Un servicio que
 * recibe un `barrioId` que no usa es una invitación a que el próximo que lo toque lo use para
 * filtrar — y ahí el aislamiento pasa a depender de un parámetro que manda el cliente.
 */

import { sql } from "drizzle-orm";
import { sumarMontos } from "@admin-barrios/shared/dinero";
import { consultaBarrioSchema, consultaPeriodoSchema } from "@admin-barrios/shared/consultas";
import { crearPeriodoSchema, type CrearPeriodo } from "@admin-barrios/shared/escrituras";
import type { EstadoPeriodo, ModeloExpensa } from "@admin-barrios/shared/liquidacion";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar } from "../errores.ts";
import { SQL_ROLES_QUE_EMITEN } from "./roles.ts";

// `EstadoPeriodo` y `ModeloExpensa` se reexportan por comodidad de quien consume el servicio, pero
// se **importan** de `shared/liquidacion`, que es de donde sale el `pgEnum`. Escribirlos a mano acá
// sería una segunda definición de la máquina de estados del período.
export type { EstadoPeriodo, ModeloExpensa };

export type PeriodoDeLista = {
  readonly id: string;
  /** `YYYY-MM`. El formateo a "julio de 2026" es de `@admin-barrios/shared/fechas`, no de la UI. */
  readonly periodo: string;
  readonly estado: EstadoPeriodo;
  readonly modelo: ModeloExpensa;
  readonly denominacionConcepto: string | null;
  readonly primerVencimiento: string | null;
  readonly segundoVencimiento: string | null;
  readonly totalGastos: string | null;
  readonly totalCargos: string | null;
  readonly totalDescuentos: string | null;
  /**
   * Marca de emisión, como la entrega Postgres (`2026-07-28 10:20:32.29+00`) y **no como `Date`**.
   *
   * Decía `Date` y era mentira: `db.execute()` de Drizzle instala su propio parser de tipos y
   * devuelve `timestamptz` **en crudo**, así que un `.toLocaleDateString()` en la pantalla reventaba
   * con "is not a function". Se corrige el tipo y no el valor: convertir acá a `Date` metería una
   * zona horaria en el medio, que es exactamente lo que `shared/fechas.ts` existe para evitar.
   */
  readonly emitidaAt: string | null;
  /** Cuántas liquidaciones tiene generadas. 0 = todavía no se armó el borrador. */
  readonly liquidaciones: number;
  /**
   * El período todavía se puede tocar. Quien lo decide de verdad es el trigger
   * `app.periodo_editable` (migración 0013); acá se replica **una sola vez**, para que la UI no
   * ofrezca un botón que la base va a rechazar y para que el estado se pueda dibujar distinto según
   * sea editable o no.
   *
   * Viaja en `PeriodoDeLista` y no solo en el detalle **a propósito**: sin esto, la pantalla que
   * lista períodos tendría que derivarlo del estado por su cuenta, y esa tercera copia de la regla
   * es exactamente la que ningún test puede detectar (ADR-0002 §5.3).
   */
  readonly editable: boolean;
};

export type GastoDelPeriodo = {
  readonly id: string;
  readonly descripcion: string;
  readonly monto: string;
  readonly conceptoId: string;
  readonly conceptoNombre: string;
  /** `ordinaria` | `extraordinaria` (art. 2048). */
  readonly conceptoTipo: string;
  readonly esFondoReserva: boolean;
  readonly proveedorNombre: string | null;
  readonly comprobante: string | null;
  /** Acta que respalda una extraordinaria, si la hay. */
  readonly actaTitulo: string | null;
  /**
   * Extraordinaria cargada **sin** acta. Lo marca un trigger, no la app. No bloquea la carga —pasa
   * en la operatoria real— pero condiciona el reclamo de la deuda, así que la pantalla lo tiene que
   * poder mostrar.
   */
  readonly sinRespaldoAsamblea: boolean;
  readonly motivoSinRespaldo: string | null;
};

export type DetallePeriodo = PeriodoDeLista & {
  readonly barrioId: string;
  readonly barrioNombre: string;
  readonly coeficienteVersionId: string | null;
  readonly cuotaFijaVersionId: string | null;
  /**
   * La cuota que pagan **todas** las unidades, cuando es una sola (modelo `fija`).
   *
   * `null` si el período no es de cuota fija, si no hay versión, o si **las unidades tienen importes
   * distintos**: ahí no existe "la cuota" y decir una sería elegir cuál mostrar. Que los importes
   * difieran es legítimo —lote baldío, categorías— y por eso se distingue en vez de promediar.
   */
  readonly cuotaFijaUnica: string | null;
  readonly notas: string | null;
  /** El usuario tiene un rol que puede emitir. Es para la UI; la base lo vuelve a verificar. */
  readonly puedeEmitir: boolean;
  readonly gastos: readonly GastoDelPeriodo[];
  /** Suma de `gastos`, recalculada acá. Ver la nota de abajo sobre por qué no se confía en la columna. */
  readonly totalGastosCargados: string;
};

type FilaPeriodo = {
  id: string;
  periodo: string;
  estado: EstadoPeriodo;
  modelo: ModeloExpensa;
  denominacion_concepto: string | null;
  primer_vencimiento: string | null;
  segundo_vencimiento: string | null;
  total_gastos: string | null;
  total_cargos: string | null;
  total_descuentos: string | null;
  emitida_at: string | null;
  liquidaciones: number;
};

const mapearPeriodo = (f: FilaPeriodo): PeriodoDeLista => ({
  id: f.id,
  periodo: f.periodo,
  estado: f.estado,
  modelo: f.modelo,
  denominacionConcepto: f.denominacion_concepto,
  primerVencimiento: f.primer_vencimiento,
  segundoVencimiento: f.segundo_vencimiento,
  totalGastos: f.total_gastos,
  totalCargos: f.total_cargos,
  totalDescuentos: f.total_descuentos,
  emitidaAt: f.emitida_at,
  liquidaciones: f.liquidaciones,
  // La regla del trigger `app.periodo_editable` (0013), replicada acá y en ningún otro lado.
  editable: f.estado === "borrador" || f.estado === "revisada",
});

/**
 * Los períodos de un barrio, del más nuevo al más viejo — pantalla `/[barrio]/liquidacion`.
 *
 * Sin paginado: son doce por año. El `order by p.periodo desc` ordena bien porque `periodo` es
 * `YYYY-MM` con relleno de ceros y un `check` que lo hace cumplir — el orden lexicográfico y el
 * cronológico coinciden.
 *
 * El conteo de liquidaciones va como subconsulta correlacionada y no como `group by`: resuelve por
 * el prefijo de `uq_liquidacion_periodo_uf (periodo_id, unidad_funcional_id)` y son decenas de
 * filas, no miles. Con un `left join` habría que agrupar 200 liquidaciones por período para
 * devolver un número.
 */
export async function listarPeriodos(
  tx: DbConIdentidad,
  parametros: { barrioId: string },
): Promise<PeriodoDeLista[]> {
  const { barrioId } = consultaBarrioSchema.parse(parametros);

  const { rows } = await tx.execute<FilaPeriodo>(sql`
    select p.id, p.periodo, p.estado::text as estado, p.modelo::text as modelo,
           p.denominacion_concepto,
           p.primer_vencimiento::text, p.segundo_vencimiento::text,
           p.total_gastos::text, p.total_cargos::text, p.total_descuentos::text,
           p.emitida_at,
           (select count(*) from liquidacion l where l.periodo_id = p.id)::int as liquidaciones
      from periodo_expensa p
     where p.barrio_id = ${barrioId}
     order by p.periodo desc
  `);
  return rows.map(mapearPeriodo);
}

/**
 * Los gastos cargados en un período — pantalla `…/gastos`.
 *
 * Separado de `leerPeriodo` porque es lo que se vuelve a leer después de cada alta o anulación,
 * mientras la cabecera no cambió.
 */
export async function listarGastos(
  tx: DbConIdentidad,
  parametros: { periodoId: string },
): Promise<GastoDelPeriodo[]> {
  const { periodoId } = consultaPeriodoSchema.parse(parametros);

  type FilaGasto = {
    id: string;
    descripcion: string;
    monto: string;
    concepto_id: string;
    concepto_nombre: string;
    concepto_tipo: string;
    es_fondo_reserva: boolean;
    proveedor_nombre: string | null;
    comprobante: string | null;
    acta_titulo: string | null;
    sin_respaldo_asamblea: boolean;
    motivo_sin_respaldo: string | null;
  };

  const { rows } = await tx.execute<FilaGasto>(sql`
    select g.id, g.descripcion, g.monto::text,
           c.id as concepto_id, c.nombre as concepto_nombre, c.tipo::text as concepto_tipo,
           c.es_fondo_reserva,
           g.proveedor_nombre, g.comprobante,
           d.titulo as acta_titulo,
           g.sin_respaldo_asamblea, g.motivo_sin_respaldo
      from gasto_periodo g
      join concepto c on c.id = g.concepto_id
      left join documento_barrio d on d.id = g.acta_documento_id
     where g.periodo_id = ${periodoId}
     order by c.tipo, c.nombre, g.descripcion
  `);

  return rows.map((g) => ({
    id: g.id,
    descripcion: g.descripcion,
    monto: g.monto,
    conceptoId: g.concepto_id,
    conceptoNombre: g.concepto_nombre,
    conceptoTipo: g.concepto_tipo,
    esFondoReserva: g.es_fondo_reserva,
    proveedorNombre: g.proveedor_nombre,
    comprobante: g.comprobante,
    actaTitulo: g.acta_titulo,
    sinRespaldoAsamblea: g.sin_respaldo_asamblea,
    motivoSinRespaldo: g.motivo_sin_respaldo,
  }));
}

/**
 * El detalle de un período **con sus gastos** — la cabecera de todas las pantallas de liquidación.
 *
 * `null` = no existe o no es accesible, indistinguibles a propósito (ver `barrios.ts`).
 *
 * **`totalGastosCargados` se recalcula y no se lee de `periodo_expensa.total_gastos`.** No es
 * desconfianza en la base: la columna la escribe el servicio **al liquidar**, así que mientras el
 * período está en borrador y se están cargando gastos, la columna está desactualizada o en `null`.
 * Devolver las dos permite que la pantalla muestre "cargado" y "liquidado" por separado, y que la
 * diferencia entre ambas sea visible en vez de ser un misterio. Es la regla de dinero trazable
 * aplicada a una pantalla: la cifra se explica con su origen.
 */
export async function leerPeriodo(
  tx: DbConIdentidad,
  parametros: { periodoId: string },
): Promise<DetallePeriodo | null> {
  const { periodoId } = consultaPeriodoSchema.parse(parametros);

  type FilaDetalle = FilaPeriodo & {
    barrio_id: string;
    barrio_nombre: string;
    coeficiente_version_id: string | null;
    cuota_fija_version_id: string | null;
    cuota_fija_unica: string | null;
    notas: string | null;
    puede_emitir: boolean;
  };

  const [{ rows }, gastos] = await Promise.all([
    tx.execute<FilaDetalle>(sql`
      select p.id, p.periodo, p.estado::text as estado, p.modelo::text as modelo,
             p.denominacion_concepto,
             p.primer_vencimiento::text, p.segundo_vencimiento::text,
             p.total_gastos::text, p.total_cargos::text, p.total_descuentos::text,
             p.emitida_at, p.notas,
             p.barrio_id, n.nombre as barrio_nombre,
             p.coeficiente_version_id, p.cuota_fija_version_id,
             (select case when count(distinct cf.importe) = 1 then min(cf.importe)::text end
                from cuota_fija cf where cf.version_id = p.cuota_fija_version_id) as cuota_fija_unica,
             (select count(*) from liquidacion l where l.periodo_id = p.id)::int as liquidaciones,
             app.has_role_on(p.barrio_id, ${SQL_ROLES_QUE_EMITEN}) as puede_emitir
        from periodo_expensa p
        join tenant_node n on n.id = p.barrio_id
       where p.id = ${periodoId}
    `),
    listarGastos(tx, { periodoId }),
  ]);

  const f = rows[0];
  if (!f) return null;

  return {
    ...mapearPeriodo(f),
    barrioId: f.barrio_id,
    barrioNombre: f.barrio_nombre,
    coeficienteVersionId: f.coeficiente_version_id,
    cuotaFijaVersionId: f.cuota_fija_version_id,
    cuotaFijaUnica: f.cuota_fija_unica,
    notas: f.notas,
    puedeEmitir: f.puede_emitir,
    gastos,
    // Con la lista vacía `sumarMontos()` devuelve "0.00": el cero acá es real, no fabricado.
    totalGastosCargados: sumarMontos(...gastos.map((g) => g.monto)),
  };
}

// ── Escritura ──────────────────────────────────────────────────────────────────────────────────

/**
 * Crea un período en **borrador** para un barrio — el primer paso del recorrido.
 *
 * **Tres campos que el servicio no manda, y ninguno por olvido:**
 *
 * - **`estado`**: un período nace en `borrador` por trigger (`app.periodo_nace_en_borrador`,
 *   migración `0013` §2). Antes de esa migración se podía insertar uno ya `emitida`, o sea un
 *   contenedor donde `app.validar_emision` nunca corrió: un período que nadie verificó que cuadre,
 *   indistinguible de uno emitido en regla. Mandarlo desde acá reabriría ese camino.
 * - **`modelo`**: queda en su default (`variable`). El modelo de cuota fija necesita una versión de
 *   cuotas cargada, que no tiene pantalla en este incremento (ADR-0002 §8) — ofrecer el campo sería
 *   dejar crear períodos que después no se pueden liquidar.
 * - **`coeficiente_version_id`**: lo fija `generarLiquidaciones()` al armar el borrador, con la
 *   versión cerrada y vigente del barrio. Elegirlo en el alta permitiría liquidar contra una versión
 *   abierta, que es justo lo que `app.validar_emision` rechaza al final del camino.
 *
 * El `barrioId` **sí** viaja acá, a diferencia del resto de los servicios: es un alta, no hay ninguna
 * fila de la que derivarlo. No autoriza nada — quién puede crear períodos en ese barrio lo decide la
 * policy de `insert` de `periodo_expensa` (0005 §5), que exige rol de gestión.
 */
export async function crearPeriodo(
  tx: DbConIdentidad,
  parametros: CrearPeriodo,
): Promise<{ readonly id: string; readonly periodo: string }> {
  const p = crearPeriodoSchema.parse(parametros);

  return enBase(async () => {
    const { rows } = await tx.execute<{ id: string; periodo: string }>(sql`
      insert into periodo_expensa (barrio_id, periodo, primer_vencimiento, segundo_vencimiento, notas)
      values (${p.barrioId}, ${p.periodo}, ${p.primerVencimiento}::date, ${p.segundoVencimiento}::date,
              ${p.notas})
      returning id, periodo
    `);

    const fila = rows[0];
    if (!fila) {
      // La policy de `insert` rechaza con 42501 (lo traduce `errores.ts`), así que llegar acá sin
      // fila sería un `insert` que no insertó y no rebotó. No debería pasar; si pasa, no se devuelve
      // un éxito vacío que la pantalla mostraría como un período creado.
      // `desconocido` y no `periodo_no_encontrado`: acá el período no es que no se encuentre, es
      // que el `insert` no insertó y no rebotó. El `codigo` es lo que la pantalla usa para decidir a
      // dónde ir, y un "no encontrado" en el alta mandaría a la persona de vuelta al listado a
      // buscar algo que nunca existió. `desconocido` además queda registrado en el log.
      rechazar(
        "desconocido",
        "No se pudo crear el período.",
        "Recargá la pantalla y volvé a intentar. Si sigue pasando, pasale el código de referencia a quien te da soporte.",
      );
    }
    return fila;
  });
}
