/**
 * El **libro de movimientos** de un barrio: los ingresos y egresos de un rango de períodos, tal
 * como se los entrega al contador (doc 01 §4.8, ADR-0004).
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * ESTE ARCHIVO DEVUELVE DATOS, NO PRESENTACIÓN
 *
 * Nada de acá sabe qué es una celda, una solapa ni un `numFmt`. Los montos salen como **string** de
 * `numeric` (igual que en todo el repo), las fechas como `YYYY-MM-DD` tal cual las entrega Postgres,
 * y los rótulos —"a cuenta", `SIN CLASIFICAR — requiere definición`, el prorrateo de la hoja B— los
 * pone el dataset en `apps/web/src/servidor/export/`. Es la separación de tres capas que el sistema
 * de gas ya tenía y que acá se conserva: **el día que haga falta otro formato, se reusa todo esto**.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ DOS HOJAS DE INGRESOS Y NO UNA (panel `administrador-consorcios` + `contador`, 2026-08-26)
 *
 * `leerIngresos()` devuelve **una fila por `pago`** y `leerImputaciones()` **una por
 * `pago_imputacion`**. No es redundancia:
 *
 *   · Un pago que cubre tres boletas es **un solo** movimiento bancario. Partido en tres filas ya no
 *     se puede cruzar contra el extracto, que es lo primero que hace el contador con este archivo.
 *   · Un pago **no imputado** no tiene concepto en ninguna parte del modelo (`pago` no tiene
 *     `concepto_id`; el concepto vive del otro lado de `pago_imputacion → liquidacion`). En una
 *     planilla puramente imputada ese pago **desaparece**, y la planilla reporta menos caja de la
 *     que entró.
 *   · Pero solo con caja no se puede separar ordinarias, extraordinarias, fondo de reserva e
 *     intereses, que es el otro corte que el contador necesita (art. 2048; arts. 2046 inc. d y 2064
 *     inc. c para el fondo).
 *
 * Por eso `leerIngresos()` trae `monto_imputado` calculado: con él, el dataset arma la fila residual
 * "a cuenta" que hace que la hoja B **sume exactamente igual** que la A. Esa identidad es el producto
 * de esta exportación, no un detalle de presentación.
 *
 * **La hoja B no es "devengado"** y no hay que llamarla así en ningún rótulo: es caja asignada a un
 * devengado anterior. El devengado real es la liquidación emitida, que es otro dato.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * TRES HUECOS DE DATOS, DECLARADOS Y NO SUPLIDOS
 *
 * 1. **El gasto simple no tiene fecha propia.** Solo `created_at`, que es cuándo se cargó. En la
 *    práctica el administrador junta las facturas del mes y las descarga en una sola sesión, así que
 *    usar `created_at` como "fecha del egreso" mostraría cuarenta egresos el mismo día: no distorsiona
 *    un poco, **invalida la columna** para conciliar contra el banco. Por eso van tres columnas
 *    separadas y ninguna miente sobre lo que es.
 * 2. **No existe la fecha de la factura del proveedor.** `orden_pago` tiene `numero_factura` y la
 *    factura adjunta, pero ninguna columna de fecha. Sale vacía.
 * 3. **No hay orden de imputación de un pago parcial** dentro de una liquidación: `pago_imputacion`
 *    imputa contra la boleta entera, no contra el ítem. Por eso el desglose por rubro de la hoja B es
 *    un **prorrateo por composición**, y el dataset lo rotula como tal.
 *
 * Un blanco es información honesta; una fecha equivocada no.
 */

import { sql } from "drizzle-orm";
import { consultaExportacionSchema, type ConsultaExportacion } from "@admin-barrios/shared/consultas";
import type { DbConIdentidad } from "../client.ts";
import { enBase } from "../errores.ts";

/** Una línea de la hoja A: **un pago**, con el monto entero que entró. */
export type FilaIngreso = {
  readonly pagoId: string;
  readonly fecha: string;
  readonly monto: string;
  /** Suma de las imputaciones **vivas** de este pago. `"0.00"` si no se imputó nada. */
  readonly montoImputado: string;
  readonly origen: string;
  readonly estadoConciliacion: string;
  readonly unidadEtiqueta: string;
  readonly obligadoNombre: string | null;
  /** CUIT/CUIL del obligado. **Va como texto a la planilla**: 11 dígitos en una celda numérica los
   *  redondearía (Excel guarda 15 significativos). */
  readonly obligadoCuit: string | null;
  /** Los períodos a los que se imputó, ya listos para una celda. Vacío si es "a cuenta". */
  readonly periodosImputados: string | null;
};

/** Una línea de la hoja B: **una imputación**, con la composición de la boleta que cubre. */
export type FilaImputacion = {
  readonly imputacionId: string;
  readonly pagoId: string;
  readonly fechaPago: string;
  readonly montoImputado: string;
  readonly unidadEtiqueta: string;
  readonly periodoOrigen: string;
  readonly numeroComprobante: string | null;
  /**
   * La composición de la liquidación cubierta. El dataset prorratea `montoImputado` sobre estos
   * subtotales y **rotula el resultado como prorrateo**: el modelo no registra a qué ítem fue el
   * dinero, y fingir que sí lo hace sería una cifra sin origen (CLAUDE.md §1.4).
   */
  readonly liquidacionTotal: string;
  readonly subtotalOrdinarias: string;
  readonly subtotalExtraordinarias: string;
  readonly subtotalFondoReserva: string;
  readonly interesMora: string | null;
};

/** Una línea de egreso. */
export type FilaEgreso = {
  readonly gastoId: string;
  readonly periodo: string;
  readonly descripcion: string;
  readonly monto: string;
  readonly conceptoNombre: string;
  /** `ordinaria` | `extraordinaria` — el corte del art. 2048, columna propia y no una nota. */
  readonly conceptoTipo: string;
  /** Fondo de reserva segregado (arts. 2046 inc. d y 2064 inc. c): columna propia. */
  readonly esFondoReserva: boolean;
  readonly clasificacionFiscal: string;
  /** `snapshot` cuando salió de `item_liquidacion` (período emitido), `catalogo` si no. */
  readonly origenClasificacion: "snapshot" | "catalogo";
  readonly proveedorNombre: string | null;
  readonly proveedorCuit: string | null;
  readonly comprobante: string | null;
  readonly numeroFactura: string | null;
  /** `orden_pago.pagada_at` — **la única fecha de egreso que es un hecho financiero**. */
  readonly fechaPago: string | null;
  /** `created_at`: cuándo se cargó en el sistema. Nunca se presenta como "fecha del egreso". */
  readonly fechaRegistracion: string;
  /** Declaración deliberada de que no va a haber factura. Insumo directo del libro de egresos. */
  readonly sinRespaldoDocumental: boolean;
  readonly motivoSinRespaldo: string | null;
  readonly sinRespaldoAsamblea: boolean;
  /**
   * Solo en una fila de **ajuste** de una orden de pago anulada: la descripción y el período del
   * gasto que revierte. Con esto la fila se presenta como reversión con su origen a la vista, que es
   * lo que evita que un monto negativo aparezca suelto (CLAUDE.md §1.4).
   */
  readonly revierteDescripcion: string | null;
  readonly revierteperiodo: string | null;
};

/** Un pago anulado **dentro del rango**, aunque su fecha sea anterior. */
export type FilaAnulacion = {
  readonly pagoId: string;
  readonly fecha: string;
  readonly monto: string;
  readonly unidadEtiqueta: string;
  readonly anuladoAt: string;
  readonly motivoAnulacion: string | null;
};

/** Los datos del encabezado del libro. */
export type CabeceraDelLibro = {
  readonly barrioNombre: string;
  readonly barrioCuit: string | null;
  readonly municipio: string;
  /**
   * La figura jurídica **vigente en el período**, no la actual: los cinco ejes se versionan con
   * vigencia temporal (`REQUISITOS-MODELO-DATOS.md` §1), y un barrio que se adecuó en 2027 no
   * cambia retroactivamente el encuadre de su libro de 2026.
   */
  readonly figuraJuridica: string;
  readonly modelosDePeriodo: readonly string[];
  /** Al menos un período del rango no está emitido: el libro sale marcado `PROVISORIO`. */
  readonly incluyeProvisorio: boolean;
};

export type ConteoDeMovimientos = {
  readonly ingresos: number;
  readonly imputaciones: number;
  readonly egresos: number;
  readonly total: number;
};

export type LibroDeMovimientos = {
  readonly cabecera: CabeceraDelLibro;
  readonly ingresos: readonly FilaIngreso[];
  readonly imputaciones: readonly FilaImputacion[];
  readonly egresos: readonly FilaEgreso[];
  readonly anulaciones: readonly FilaAnulacion[];
};

/** `manzana`/`lote` como una etiqueta legible. No hay un campo `codigo` en `unidad_funcional`. */
const ETIQUETA_UF = sql`('MZ ' || uf.manzana || ' — LOTE ' || uf.lote)`;

/**
 * Cuántas filas tendría el libro, **sin traerlas**.
 *
 * Es el freno del `GET` síncrono: `exceljs` arma el workbook entero en memoria del proceso web, así
 * que el tope se decide **antes** de construir nada. Contar para después descubrir que era demasiado
 * ya habría pagado el costo que el tope existe para evitar (`security-engineer`, panel 2026-08-26).
 *
 * Corre bajo RLS como todo lo demás: un barrio ajeno cuenta cero, no falla.
 */
export async function contarMovimientos(
  tx: DbConIdentidad,
  parametros: ConsultaExportacion,
): Promise<ConteoDeMovimientos> {
  const { barrioId, periodoDesde, periodoHasta } = consultaExportacionSchema.parse(parametros);

  return enBase(async () => {
    const { rows } = await tx.execute<{ ingresos: string; imputaciones: string; egresos: string }>(sql`
      with periodos as (
        select id from periodo_expensa
         where barrio_id = ${barrioId} and periodo between ${periodoDesde} and ${periodoHasta}
      )
      select
        (select count(*) from pago p
          where p.barrio_id = ${barrioId} and p.anulado_at is null
            and to_char(p.fecha, 'YYYY-MM') between ${periodoDesde} and ${periodoHasta}) as ingresos,
        (select count(*) from pago_imputacion pi
           join pago p on p.id = pi.pago_id
          where pi.barrio_id = ${barrioId} and pi.anulado_at is null and p.anulado_at is null
            and to_char(p.fecha, 'YYYY-MM') between ${periodoDesde} and ${periodoHasta}) as imputaciones,
        (select count(*) from gasto_periodo g
          where g.barrio_id = ${barrioId} and g.periodo_id in (select id from periodos)) as egresos
    `);

    const fila = rows[0] ?? { ingresos: "0", imputaciones: "0", egresos: "0" };
    const ingresos = Number.parseInt(fila.ingresos, 10);
    const imputaciones = Number.parseInt(fila.imputaciones, 10);
    const egresos = Number.parseInt(fila.egresos, 10);
    return { ingresos, imputaciones, egresos, total: ingresos + imputaciones + egresos };
  });
}

/**
 * Registra la extracción — **y en el mismo acto autoriza que ocurra**.
 *
 * La policy de `insert` de `exportacion_movimientos` (`0051`) es el gate de rol de esta feature:
 * `admin_plataforma`/`admin_barrio`/`contador` siempre, `operador` nunca, `auditor` según
 * `barrio.auditor_exporta_movimientos`. Como no hay artefacto persistido, no existe una tabla sobre
 * la cual poner una policy de `select` que decida quién puede exportar; poniéndolo en el `insert` de
 * la traza, las dos garantías se sostienen entre sí: **no se puede exportar sin dejar rastro, ni
 * dejar rastro sin tener el rol**.
 *
 * Por eso esta función se llama **antes** de serializar y en la **misma transacción** que la
 * lectura. Es el principio que `descarga_documento` ya fijó: si el registro falla, no hay entrega.
 *
 * `solicitado_por` y `solicitado_at` **no viajan en el insert**: los escribe la base
 * (`app.exportacion_antes_insert()`). Una firma de auditoría que puede escribir quien la genera no
 * es una firma.
 */
export async function registrarExportacion(
  tx: DbConIdentidad,
  parametros: ConsultaExportacion & {
    readonly conteo: ConteoDeMovimientos;
    readonly incluyoProvisorio: boolean;
  },
): Promise<{ readonly selloDeExtraccion: string }> {
  const { barrioId, periodoDesde, periodoHasta } = consultaExportacionSchema.parse(parametros);
  const { conteo, incluyoProvisorio } = parametros;

  return enBase(async () => {
    await tx.execute(sql`
      insert into exportacion_movimientos
        (barrio_id, periodo_desde, periodo_hasta, alcance, formato,
         filas_ingresos, filas_imputaciones, filas_egresos, incluyo_provisorio)
      values
        (${barrioId}, ${periodoDesde}, ${periodoHasta}, 'movimientos', 'xlsx',
         ${conteo.ingresos}, ${conteo.imputaciones}, ${conteo.egresos}, ${incluyoProvisorio})
    `);

    /*
     * El sello sale de la base y **no se genera en el proceso web**: es lo único que permite atar un
     * archivo que anda dando vueltas por un mail a su fila de auditoría, así que tiene que ser el
     * mismo instante que quedó registrado. Dos relojes para el mismo hecho es uno de más.
     *
     * **Y NO se puede pedir con `returning`, aunque sea lo obvio.** Bajo RLS, un `INSERT …
     * RETURNING` exige que la fila pase también la policy de **SELECT** — y el `contador`, que es
     * quien más va a usar esta feature, puede insertar pero deliberadamente NO puede leer esta tabla
     * (no es supervisor del uso del sistema). Con `returning`, exportar le fallaría al destinatario
     * del entregable. Encontrado corriendo los tests, no razonándolo.
     *
     * `now()` es el timestamp de **inicio de la transacción** y es constante durante toda ella, así
     * que este valor es exactamente el que el trigger escribió en `solicitado_at` unas líneas más
     * arriba. No es una aproximación: es el mismo instante, garantizado por Postgres.
     */
    const { rows } = await tx.execute<{ sello: string }>(
      sql`select to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as sello`,
    );
    return { selloDeExtraccion: rows[0]?.sello ?? "" };
  });
}

/**
 * El libro completo, en una sola pasada.
 *
 * **Las cinco consultas van juntas y en la misma transacción a propósito.** Basta que una olvide el
 * `barrio_id` o se resuelva fuera de la sesión con identidad para mezclar dos barrios adentro de un
 * mismo archivo — y eso no lo atrapa ninguna pantalla, porque el archivo se abre afuera. Nada de
 * `Promise.all` sobre conexiones distintas (`security-engineer`, panel 2026-08-26).
 *
 * Un barrio ajeno devuelve **cero filas, no un error**: distinguir "no existe" de "no es tuyo"
 * convertiría esto en un oráculo de existencia de barrios, mismo criterio que la ruta de descarga.
 */
export async function leerLibroDeMovimientos(
  tx: DbConIdentidad,
  parametros: ConsultaExportacion,
): Promise<LibroDeMovimientos> {
  const { barrioId, periodoDesde, periodoHasta } = consultaExportacionSchema.parse(parametros);

  return enBase(async () => {
    const cabecera = await leerCabecera(tx, barrioId, periodoDesde, periodoHasta);
    const ingresos = await leerIngresos(tx, barrioId, periodoDesde, periodoHasta);
    const imputaciones = await leerImputaciones(tx, barrioId, periodoDesde, periodoHasta);
    const egresos = await leerEgresos(tx, barrioId, periodoDesde, periodoHasta);
    const anulaciones = await leerAnulaciones(tx, barrioId, periodoDesde, periodoHasta);
    return { cabecera, ingresos, imputaciones, egresos, anulaciones };
  });
}

/**
 * El encabezado, con la **figura jurídica vigente en el período**.
 *
 * Se toma la vigencia que cubre el **primer día del período inicial** del rango: `vigente_desde <=
 * fecha` y (`vigente_hasta` nula o posterior). Si el barrio no tiene vigencia cargada para ese
 * momento, cae en el valor actual de `barrio.figura_juridica` — que es lo que hay, y el libro lo
 * dice en su encabezado en vez de afirmar una figura que nadie declaró para esa fecha.
 */
async function leerCabecera(
  tx: DbConIdentidad,
  barrioId: string,
  periodoDesde: string,
  periodoHasta: string,
): Promise<CabeceraDelLibro> {
  type Fila = {
    nombre: string;
    cuit: string | null;
    municipio: string;
    figura_juridica: string;
    modelos: string[] | null;
    incluye_provisorio: boolean;
  };

  const { rows } = await tx.execute<Fila>(sql`
    select b.nombre, b.cuit, b.municipio,
           coalesce(
             (select v.valor from barrio_atributo_vigencia v
               where v.barrio_id = b.barrio_id and v.eje = 'figura_juridica'
                 and v.vigente_desde <= (${periodoDesde} || '-01')::date
                 and (v.vigente_hasta is null or v.vigente_hasta >= (${periodoDesde} || '-01')::date)
               order by v.vigente_desde desc limit 1),
             b.figura_juridica::text
           ) as figura_juridica,
           (select array_agg(distinct pe.modelo::text)
              from periodo_expensa pe
             where pe.barrio_id = b.barrio_id
               and pe.periodo between ${periodoDesde} and ${periodoHasta}) as modelos,
           coalesce((select bool_or(pe.estado <> 'emitida' and pe.estado <> 'distribuida')
                       from periodo_expensa pe
                      where pe.barrio_id = b.barrio_id
                        and pe.periodo between ${periodoDesde} and ${periodoHasta}), true) as incluye_provisorio
      from barrio b
     where b.barrio_id = ${barrioId}
  `);

  const f = rows[0];
  if (!f) {
    // Barrio inaccesible o inexistente: no se distingue, y el libro sale vacío en vez de delatar
    // cuál de las dos cosas era.
    return {
      barrioNombre: "",
      barrioCuit: null,
      municipio: "",
      figuraJuridica: "",
      modelosDePeriodo: [],
      incluyeProvisorio: true,
    };
  }

  return {
    barrioNombre: f.nombre,
    barrioCuit: f.cuit,
    municipio: f.municipio,
    figuraJuridica: f.figura_juridica,
    modelosDePeriodo: f.modelos ?? [],
    incluyeProvisorio: f.incluye_provisorio,
  };
}

/** Hoja A: un pago, una fila. El corte es por `pago.fecha`, que es `date NOT NULL`. */
async function leerIngresos(
  tx: DbConIdentidad,
  barrioId: string,
  periodoDesde: string,
  periodoHasta: string,
): Promise<FilaIngreso[]> {
  type Fila = {
    pago_id: string;
    fecha: string;
    monto: string;
    monto_imputado: string;
    origen: string;
    estado_conciliacion: string;
    unidad_etiqueta: string;
    obligado_nombre: string | null;
    obligado_cuit: string | null;
    periodos_imputados: string | null;
  };

  const { rows } = await tx.execute<Fila>(sql`
    select p.id as pago_id, p.fecha::text, p.monto::text,
           coalesce((select sum(pi.monto_imputado) from pago_imputacion pi
                      where pi.pago_id = p.id and pi.anulado_at is null), 0)::numeric(14,2)::text
             as monto_imputado,
           p.origen::text, p.estado_conciliacion::text,
           ${ETIQUETA_UF} as unidad_etiqueta,
           o.nombre as obligado_nombre, o.cuit_cuil as obligado_cuit,
           (select string_agg(distinct pe.periodo, ', ' order by pe.periodo)
              from pago_imputacion pi
              join liquidacion l on l.id = pi.liquidacion_id
              join periodo_expensa pe on pe.id = l.periodo_id
             where pi.pago_id = p.id and pi.anulado_at is null) as periodos_imputados
      from pago p
      join unidad_funcional uf on uf.id = p.unidad_funcional_id
      left join obligado o on o.id = p.obligado_id
     where p.barrio_id = ${barrioId}
       and p.anulado_at is null
       and to_char(p.fecha, 'YYYY-MM') between ${periodoDesde} and ${periodoHasta}
     order by p.fecha, p.id
  `);

  return rows.map((f) => ({
    pagoId: f.pago_id,
    fecha: f.fecha,
    monto: f.monto,
    montoImputado: f.monto_imputado,
    origen: f.origen,
    estadoConciliacion: f.estado_conciliacion,
    unidadEtiqueta: f.unidad_etiqueta,
    obligadoNombre: f.obligado_nombre,
    obligadoCuit: f.obligado_cuit,
    periodosImputados: f.periodos_imputados,
  }));
}

/** Hoja B: una imputación, una fila, con la composición de la boleta que cubre. */
async function leerImputaciones(
  tx: DbConIdentidad,
  barrioId: string,
  periodoDesde: string,
  periodoHasta: string,
): Promise<FilaImputacion[]> {
  type Fila = {
    imputacion_id: string;
    pago_id: string;
    fecha_pago: string;
    monto_imputado: string;
    unidad_etiqueta: string;
    periodo_origen: string;
    numero_comprobante: string | null;
    liquidacion_total: string;
    subtotal_ordinarias: string;
    subtotal_extraordinarias: string;
    subtotal_fondo_reserva: string;
    interes_mora: string | null;
  };

  const { rows } = await tx.execute<Fila>(sql`
    select pi.id as imputacion_id, pi.pago_id, p.fecha::text as fecha_pago,
           pi.monto_imputado::text,
           ${ETIQUETA_UF} as unidad_etiqueta,
           pe.periodo as periodo_origen,
           l.numero_comprobante,
           l.total::text as liquidacion_total,
           l.subtotal_ordinarias::text, l.subtotal_extraordinarias::text,
           l.subtotal_fondo_reserva::text, l.interes_mora::text
      from pago_imputacion pi
      join pago p on p.id = pi.pago_id
      join unidad_funcional uf on uf.id = p.unidad_funcional_id
      join liquidacion l on l.id = pi.liquidacion_id
      join periodo_expensa pe on pe.id = l.periodo_id
     where pi.barrio_id = ${barrioId}
       and pi.anulado_at is null
       and p.anulado_at is null
       and to_char(p.fecha, 'YYYY-MM') between ${periodoDesde} and ${periodoHasta}
     order by p.fecha, pi.pago_id, pe.periodo
  `);

  return rows.map((f) => ({
    imputacionId: f.imputacion_id,
    pagoId: f.pago_id,
    fechaPago: f.fecha_pago,
    montoImputado: f.monto_imputado,
    unidadEtiqueta: f.unidad_etiqueta,
    periodoOrigen: f.periodo_origen,
    numeroComprobante: f.numero_comprobante,
    liquidacionTotal: f.liquidacion_total,
    subtotalOrdinarias: f.subtotal_ordinarias,
    subtotalExtraordinarias: f.subtotal_extraordinarias,
    subtotalFondoReserva: f.subtotal_fondo_reserva,
    interesMora: f.interes_mora,
  }));
}

/**
 * Egresos del rango, con el self-JOIN que hace explicable una reversión.
 *
 * La clasificación fiscal sale del **snapshot** (`item_liquidacion.clasificacion_fiscal`, congelado
 * al emitir) cuando existe, y del **catálogo vigente** cuando no —un período en borrador todavía no
 * congeló nada—. Cuál de las dos se usó viaja en `origen_clasificacion`, **por fila y no solo en el
 * encabezado**, porque un rango puede mezclar períodos emitidos y borradores.
 */
async function leerEgresos(
  tx: DbConIdentidad,
  barrioId: string,
  periodoDesde: string,
  periodoHasta: string,
): Promise<FilaEgreso[]> {
  type Fila = {
    gasto_id: string;
    periodo: string;
    descripcion: string;
    monto: string;
    concepto_nombre: string;
    concepto_tipo: string;
    es_fondo_reserva: boolean;
    clasificacion_snapshot: string | null;
    clasificacion_catalogo: string;
    proveedor_nombre: string | null;
    proveedor_cuit: string | null;
    comprobante: string | null;
    numero_factura: string | null;
    fecha_pago: string | null;
    fecha_registracion: string;
    sin_respaldo_documental: boolean;
    motivo_sin_respaldo: string | null;
    sin_respaldo_asamblea: boolean;
    revierte_descripcion: string | null;
    revierte_periodo: string | null;
  };

  const { rows } = await tx.execute<Fila>(sql`
    select g.id as gasto_id, pe.periodo, g.descripcion, g.monto::text,
           c.nombre as concepto_nombre, c.tipo::text as concepto_tipo, c.es_fondo_reserva,
           (select il.clasificacion_fiscal::text from item_liquidacion il
             where il.gasto_id = g.id and il.clasificacion_fiscal is not null
             limit 1) as clasificacion_snapshot,
           c.clasificacion_fiscal::text as clasificacion_catalogo,
           g.proveedor_nombre, prov.cuit as proveedor_cuit,
           g.comprobante, op.numero_factura,
           op.pagada_at::date::text as fecha_pago,
           g.created_at::date::text as fecha_registracion,
           coalesce(op.factura_no_disponible, false) as sin_respaldo_documental,
           op.motivo_factura_no_disponible as motivo_sin_respaldo,
           g.sin_respaldo_asamblea,
           orig.descripcion as revierte_descripcion,
           origpe.periodo as revierte_periodo
      from gasto_periodo g
      join periodo_expensa pe on pe.id = g.periodo_id
      join concepto c on c.id = g.concepto_id
      left join orden_pago op on op.id = g.orden_pago_id
      left join proveedor prov on prov.id = op.proveedor_id
      left join gasto_periodo orig on orig.id = g.gasto_periodo_origen_id
      left join periodo_expensa origpe on origpe.id = orig.periodo_id
     where g.barrio_id = ${barrioId}
       and pe.periodo between ${periodoDesde} and ${periodoHasta}
     order by pe.periodo, c.tipo, c.nombre, g.descripcion
  `);

  return rows.map((f) => ({
    gastoId: f.gasto_id,
    periodo: f.periodo,
    descripcion: f.descripcion,
    monto: f.monto,
    conceptoNombre: f.concepto_nombre,
    conceptoTipo: f.concepto_tipo,
    esFondoReserva: f.es_fondo_reserva,
    clasificacionFiscal: f.clasificacion_snapshot ?? f.clasificacion_catalogo,
    origenClasificacion: f.clasificacion_snapshot ? "snapshot" : "catalogo",
    proveedorNombre: f.proveedor_nombre,
    proveedorCuit: f.proveedor_cuit,
    comprobante: f.comprobante,
    numeroFactura: f.numero_factura,
    fechaPago: f.fecha_pago,
    fechaRegistracion: f.fecha_registracion,
    sinRespaldoDocumental: f.sin_respaldo_documental,
    motivoSinRespaldo: f.motivo_sin_respaldo,
    sinRespaldoAsamblea: f.sin_respaldo_asamblea,
    revierteDescripcion: f.revierte_descripcion,
    revierteperiodo: f.revierte_periodo,
  }));
}

/**
 * Los pagos **anulados dentro del rango, aunque su fecha sea anterior**.
 *
 * Es el caso que más molesta en la operatoria real: un pago de mayo anulado en agosto cambia una
 * planilla de mayo que el contador ya procesó. Van en su propia sección, **fuera del total** y
 * nunca borrados en silencio — el corte es por `anulado_at`, no por `fecha`, justamente para que
 * aparezcan en el libro del mes en que se anularon.
 */
async function leerAnulaciones(
  tx: DbConIdentidad,
  barrioId: string,
  periodoDesde: string,
  periodoHasta: string,
): Promise<FilaAnulacion[]> {
  type Fila = {
    pago_id: string;
    fecha: string;
    monto: string;
    unidad_etiqueta: string;
    anulado_at: string;
    motivo_anulacion: string | null;
  };

  const { rows } = await tx.execute<Fila>(sql`
    select p.id as pago_id, p.fecha::text, p.monto::text,
           ${ETIQUETA_UF} as unidad_etiqueta,
           p.anulado_at::date::text as anulado_at,
           p.motivo_anulacion
      from pago p
      join unidad_funcional uf on uf.id = p.unidad_funcional_id
     where p.barrio_id = ${barrioId}
       and p.anulado_at is not null
       and to_char(p.anulado_at, 'YYYY-MM') between ${periodoDesde} and ${periodoHasta}
     order by p.anulado_at, p.id
  `);

  return rows.map((f) => ({
    pagoId: f.pago_id,
    fecha: f.fecha,
    monto: f.monto,
    unidadEtiqueta: f.unidad_etiqueta,
    anuladoAt: f.anulado_at,
    motivoAnulacion: f.motivo_anulacion,
  }));
}
