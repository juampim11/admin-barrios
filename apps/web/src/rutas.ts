import { idSchema } from "@admin-barrios/shared/consultas";

/**
 * ¿El segmento de la URL tiene forma de identificador?
 *
 * **Por qué hace falta, y no es paranoia.** `/{barrio}` es un segmento dinámico de primer nivel: le
 * cae **todo** lo que no matchee otra ruta, empezando por el `/favicon.ico` que pide cualquier
 * navegador. Sin este chequeo ese pedido llega hasta `leerBarrio()`, el `parse()` de Zod lanza y el
 * resultado es un **500** — verificado en el log del servidor la primera vez que se levantó esta
 * pantalla. Con el chequeo es un 404, que es lo que corresponde.
 *
 * **Esto no autoriza nada.** Solo dice "esto ni siquiera tiene forma de id". Quién puede ver ese
 * barrio lo decide la RLS y nada más (ADR-0002 §3.4): un uuid con forma válida pero de otro tenant
 * pasa por acá y muere igual en la policy, devolviendo cero filas y el mismo 404.
 *
 * Usa el `idSchema` de `@admin-barrios/shared/consultas` —el mismo que aplican los servicios— y no
 * una expresión regular propia: dos definiciones de "qué es un id" es una que se va a desincronizar.
 */
export function esIdValido(segmento: string): boolean {
  return idSchema.safeParse(segmento).success;
}

/**
 * **La portada de un barrio: dónde se aterriza al entrar, y al cambiar de barrio.**
 *
 * *(Regla del usuario, 2026-08-04.)* Cambiar de barrio es cambiar de contexto, así que el selector
 * no conserva la sección: manda acá. El motivo está escrito en `destinoPara`
 * (`packages/ui/src/cliente/selector-de-barrio.tsx`) y se resume en que **una sección no significa
 * lo mismo en dos barrios** — `…/liquidacion/cuota` existe en uno de importe fijo y no quiere decir
 * nada en uno que prorratea.
 *
 * Está en una función y no escrito a mano porque **va a cambiar**: hoy es el tablero, y el día que
 * la portada sea otra cosa —un resumen, una bandeja de pendientes— se cambia acá y la siguen el
 * layout, el selector y cualquier enlace de "volver al barrio". Escrita en cada archivo, el día que
 * cambie va a haber tres que no cambien.
 */
export const portadaDelBarrio = (barrioId: string): string => `/${barrioId}/tablero`;

/**
 * El `?volver=` de una pantalla que se abre desde más de un lugar (encargo 8, T1 §2): a dónde lleva su
 * «Cancelar» o su «Volver».
 *
 * **Solo acepta una ruta interna del mismo barrio**, y nada más: tiene que empezar con `/{barrio}/` y
 * estar hecha solo de letras, dígitos, `-`, `_` y `/`, sin `//`. Eso deja afuera, sin listar cada caso,
 * un dominio ajeno (`//otro.com`, `https:`), un `javascript:`, una barra invertida, una consulta o un
 * fragmento. Cualquier otra cosa —incluido "no vino nada"— cae en `porDefecto`, que es la ruta lógica
 * de origen. No es autorización: la pantalla de destino vuelve a pasar por la RLS como siempre.
 */
export function destinoDeVuelta(barrioId: string, crudo: unknown, porDefecto: string): string {
  if (typeof crudo !== "string") return porDefecto;
  const valida = crudo.startsWith(`/${barrioId}/`) && /^\/[A-Za-z0-9/_-]+$/.test(crudo) && !crudo.includes("//");
  return valida ? crudo : porDefecto;
}

/** Una ruta con su `?volver=`: el par de `destinoDeVuelta`, del lado de quien arma el enlace. */
export const conVuelta = (ruta: string, volver: string): string => `${ruta}?volver=${encodeURIComponent(volver)}`;

/**
 * El enlace de un filtro de lista: la ruta con `?filtro=…&q=…`, dejando afuera lo que vale «todos» o
 * está vacío, para que «sin filtro» sea la ruta pelada y no `?filtro=todas`. Es lo que arma
 * `hrefFiltro` en el padrón, para las listas que lo copiaron (encargo 8, T1).
 */
export function hrefDeLista(ruta: string, parametros: Readonly<Record<string, string | null>>): string {
  const presentes = Object.entries(parametros).filter((par): par is [string, string] => par[1] !== null && par[1] !== "");
  const texto = new URLSearchParams(presentes).toString();
  return texto === "" ? ruta : `${ruta}?${texto}`;
}

/**
 * **Las altas con su página propia vuelven a la lista con «Listo:»** (encargo 9, PR 1 §2): el
 * formulario, al guardar, lleva a `{lista}?listo={alta}&id={id}` y la lista dibuja el aviso.
 *
 * La clave es de una lista cerrada y el texto lo arma la lista con **sus** datos (busca el `id` entre
 * las filas que ya leyó bajo RLS): de la URL no sale ni una palabra que se muestre. Un `?listo=` que no
 * es el de esa lista, o un `id` que no es un uuid, se ignoran.
 */
export const ALTAS_CON_LISTO = [
  "proveedor",
  "gasto",
  "cargo",
  "unidad",
  "coeficientes",
  // El estado de cuenta de la unidad (encargo 10): el pago registrado, la condonación y el pago anulado.
  "pago",
  "condonacion",
  "anulacion",
] as const;
export type AltaConListo = (typeof ALTAS_CON_LISTO)[number];

export const conListo = (ruta: string, alta: AltaConListo, id?: string | null): string =>
  hrefDeLista(ruta, { listo: alta, id: id ?? null });

/** `{ id }` si la URL trae el `?listo=` de esta lista (con el id solo si es un uuid); si no, `null`. */
export function leerListo(
  crudos: Readonly<Record<string, string | string[] | undefined>>,
  alta: AltaConListo,
): { readonly id: string | null } | null {
  if (crudos["listo"] !== alta) return null;
  const id = crudos["id"];
  return { id: typeof id === "string" && esIdValido(id) ? id : null };
}

/**
 * Las rutas del alta de barrio (T3). `nuevo` cuelga de un segmento ESTÁTICO (`/barrios/nuevo`), que
 * en el App Router gana sobre el dinámico `[barrio]`: no hay uuid que pueda chocar.
 */
export const RUTA_NUEVO_BARRIO = "/barrios/nuevo";
export const rutaDelPadron = (barrioId: string): string => `/${barrioId}/padron`;
/**
 * Las altas del padrón, en su página (encargo 9, PR 1 §2). `nueva` es un segmento estático y gana
 * sobre el dinámico `padron/[unidad]` (mismo criterio que `padron/importar`).
 */
export const rutaDeNuevaUnidad = (barrioId: string): string => `/${barrioId}/padron/nueva`;
export const rutaDeNuevaVersionDeCoeficientes = (barrioId: string): string => `/${barrioId}/padron/coeficientes/nueva`;
/** La ficha de una unidad en el padrón. Se llega desde la grilla del padrón y desde el estado de cuenta. */
export const rutaDeFichaDelPadron = (barrioId: string, unidadFuncionalId: string): string =>
  `/${barrioId}/padron/${unidadFuncionalId}`;
export const rutaDeLiquidacion = (barrioId: string): string => `/${barrioId}/liquidacion`;

/**
 * «<Mes> en mis barrios» (T2, ADR-0011): el estado del mes en cada barrio, en la barra de la
 * administración. Segmento estático de primer nivel, como `/configuracion` y `/barrios/nuevo`.
 */
export const RUTA_LIQUIDACION_ACTUAL = "/liquidacion-actual";
/** Los meses anteriores de un barrio (la lista de períodos), desde la cabecera del mes. */
export const rutaDeMesesAnteriores = (barrioId: string): string => `/${barrioId}/liquidacion/meses`;
/**
 * La cuota fija vive en Configuración del barrio (T2, D4). `rigeDesde` abre el aumento desde ese mes, y
 * `desdeElMes` (el id del período) es a dónde vuelve «Cancelar».
 */
export const rutaDeCuota = (barrioId: string, rigeDesde?: string, desdeElMes?: string): string => {
  const q = [
    rigeDesde ? `aumento=${encodeURIComponent(rigeDesde)}` : null,
    desdeElMes ? `desde=${encodeURIComponent(desdeElMes)}` : null,
  ].filter((x): x is string => x !== null);
  return `/${barrioId}/configuracion/cuota${q.length > 0 ? `?${q.join("&")}` : ""}`;
};

/**
 * **La configuración general es de la administración, no de un barrio** (encargo 8, T1 §4): vive en
 * `/configuracion`, fuera de todo `[barrio]`. Es un segmento ESTÁTICO de primer nivel, así que gana
 * sobre el dinámico `[barrio]` (mismo criterio que `/barrios/nuevo`).
 *
 * Qué administración muestra lo decide la página: la única que se ve, o la del `?administracion=`
 * (validado contra las visibles), o la del último barrio visitado. Con `administracionId` el enlace la
 * fija; sin él, elige la página.
 */
export const RUTA_CONFIGURACION_GENERAL = "/configuracion";
export const rutaDeConfiguracionGeneral = (administracionId?: string): string =>
  administracionId
    ? `${RUTA_CONFIGURACION_GENERAL}?administracion=${encodeURIComponent(administracionId)}`
    : RUTA_CONFIGURACION_GENERAL;

/**
 * La entrada a la configuración general **desde un barrio**: un route handler que recuerda ese barrio
 * (cookie `httpOnly`, `COOKIE_ULTIMO_BARRIO`) y redirige a `/configuracion`. Es lo que usan la barra
 * lateral y el selector, para que al salir de la configuración general se vuelva al barrio de donde
 * se vino.
 */
export const rutaDeConfiguracionGeneralDesde = (barrioId: string): string =>
  `${RUTA_CONFIGURACION_GENERAL}/desde/${barrioId}`;

/** El nombre de la cookie del último barrio visitado. Solo la escribe el route handler de arriba. */
export const COOKIE_ULTIMO_BARRIO = "ultimo_barrio";

/**
 * Las rutas de un período. Un solo lugar donde se arman, y por eso un solo lugar donde se rompen.
 *
 * No es azúcar: estas cuatro cadenas aparecen en las pantallas, en los enlaces de las notas y en las
 * salidas de los errores. Escritas a mano en cada archivo, el día que una cambie va a haber tres que
 * no cambien y el enlace roto se va a descubrir en producción.
 */
export const rutasDelPeriodo = (barrioId: string, periodoId: string) =>
  ({
    resumen: `/${barrioId}/liquidacion/${periodoId}`,
    gastos: `/${barrioId}/liquidacion/${periodoId}/gastos`,
    /** Las altas del período, cada una en su página (encargo 9, PR 1 §2). */
    nuevoGasto: `/${barrioId}/liquidacion/${periodoId}/gastos/nuevo`,
    cargos: `/${barrioId}/liquidacion/${periodoId}/cargos`,
    nuevoCargo: `/${barrioId}/liquidacion/${periodoId}/cargos/nuevo`,
    /** La vista previa antes de emitir y las boletas emitidas después (T2). */
    boletas: `/${barrioId}/liquidacion/${periodoId}/boletas`,
    /** Lo de después de emitir: PDF, informe, paquete y el envío por correo (T2, D5). */
    envio: `/${barrioId}/liquidacion/${periodoId}/envio`,
    // Las pantallas del circuito viejo se fueron (T2): «Revisar y emitir» es Boletas, y Documentos y
    // Distribución son Envío. Las claves quedan para los enlaces que todavía las nombran.
    revision: `/${barrioId}/liquidacion/${periodoId}/boletas`,
    documentos: `/${barrioId}/liquidacion/${periodoId}/envio`,
    distribucion: `/${barrioId}/liquidacion/${periodoId}/envio`,
    periodos: `/${barrioId}/liquidacion/meses`,
    padron: `/${barrioId}/padron`,
    /** Las versiones de coeficientes del barrio (T3, pantalla 6): cuelgan del padrón, no del período. */
    coeficientes: `/${barrioId}/padron/coeficientes`,
    /**
     * El valor de la expensa. **Cuelga del barrio y no del período** —por eso no lleva `periodoId`—
     * porque el valor se define una vez y rige para los meses que vengan. Está acá igual porque es
     * uno de los destinos a los que manda el resumen de un período (`DestinoDeAccion`).
     */
    cuota: `/${barrioId}/configuracion/cuota`,
  }) as const;

/**
 * A dónde mandar a la persona según el **código** del error — la parte del contrato de errores que
 * no es texto.
 *
 * `mensaje` y `sugerencia` se muestran tal cual porque los escribimos nosotros; el `codigo` es lo
 * único que la pantalla interpreta, y lo interpreta para una sola cosa: ofrecer la salida. Un error
 * de dinero sin salida es un callejón — la persona ya sabe que algo falló, lo que no sabe es a dónde
 * ir a arreglarlo.
 *
 * La tabla es **parcial a propósito**. Un código sin entrada muestra el mensaje y la sugerencia sin
 * enlace, que es lo correcto cuando la salida no es una pantalla sino una persona ("pedile a quien
 * administra el barrio que lo aplique"): un enlace ahí sería una promesa falsa.
 */
export function salidasDelPeriodo(barrioId: string, periodoId: string) {
  const r = rutasDelPeriodo(barrioId, periodoId);
  return {
    // Falta la versión de coeficientes del **barrio**: es trabajo de padrón, no de liquidación.
    barrio_sin_coeficientes: { texto: "Ir a Coeficientes", href: conVuelta(r.coeficientes, r.resumen) },
    // El **período** no tiene versión asignada todavía: se la pone el borrador.
    sin_coeficientes: { texto: "Ver la vista previa", href: r.boletas },
    coeficientes_sin_cerrar: { texto: "Ir al padrón del barrio", href: r.padron },
    // Hay unidades activas que la versión del período no incluye (alta reciente): se arregla con una
    // versión nueva que rija desde este período (T3).
    unidades_sin_coeficiente: { texto: "Ir a Coeficientes", href: conVuelta(r.coeficientes, r.resumen) },
    // El mes no cuadra o faltan unidades: se ve en la grilla de revisión, con las cifras al lado.
    periodo_no_cuadra: { texto: "Ver la vista previa", href: r.boletas },
    periodo_incompleto: { texto: "Ver la vista previa", href: r.boletas },
    neto_negativo: { texto: "Revisar los cargos y descuentos", href: r.cargos },
    // Ya no se edita: lo que queda es mirar cómo quedó.
    periodo_no_editable: { texto: "Ver el período", href: r.resumen },
    registro_inmutable: { texto: "Ver el período", href: r.resumen },
    transicion_invalida: { texto: "Ver el período", href: r.resumen },
    // El período que se quiso crear ya existe.
    periodo_ya_existe: { texto: "Ver los meses anteriores", href: r.periodos },
    // El catálogo del barrio es lo que hay que mirar.
    concepto_sin_valor_vigente: { texto: "Ver el catálogo de conceptos", href: r.cargos },
    concepto_no_encontrado: { texto: "Ver el catálogo de conceptos", href: r.cargos },
    // La lista quedó vieja respecto de lo que hay en la base.
    aplicacion_no_encontrada: { texto: "Recargar los cargos del período", href: r.cargos },
    aplicacion_ya_anulada: { texto: "Recargar los cargos del período", href: r.cargos },
    aplicacion_no_se_edita: { texto: "Recargar los cargos del período", href: r.cargos },
    gasto_no_encontrado: { texto: "Recargar los gastos del período", href: r.gastos },
    // Todavía no hay nada que emitir: el borrador se genera en la pantalla de revisión.
    periodo_sin_liquidaciones: { texto: "Ver la vista previa", href: r.boletas },
    // Ya hay una generación en curso: la pantalla de documentos la muestra con su progreso.
    trabajo_ya_encolado: { texto: "Ver el envío del mes", href: r.envio },
    paso_en_espera: { texto: "Ver el envío del mes", href: r.envio },
    trabajo_no_encontrado: { texto: "Ver el envío del mes", href: r.envio },
    documento_no_encontrado: { texto: "Ver el envío del mes", href: r.envio },
    // El ZIP se arma en la pantalla de distribución, que es la misma que muestra el rechazo.
    periodo_sin_paquete: { texto: "Ver el envío del mes", href: r.envio },
  } as const;
}

/**
 * Las rutas de Cobros. Mismo criterio que `rutasDelPeriodo`: un solo lugar donde se arman, para que
 * el día que una cambie no queden tres archivos con la vieja.
 */
export const rutasDeCobros = (barrioId: string) =>
  ({
    grilla: `/${barrioId}/cobros`,
    nuevo: `/${barrioId}/cobros/nuevo`,
  }) as const;

/**
 * La ruta del estado de cuenta de una unidad. Aparte de `rutasDeCobros` porque, a diferencia de
 * `grilla` y `nuevo`, necesita la unidad — mismo motivo por el que `rutasDelPeriodo` recibe el
 * período como parámetro en vez de vivir adentro del objeto fijo.
 */
export const rutaDeUnidad = (barrioId: string, unidadFuncionalId: string): string =>
  `/${barrioId}/cobros/${unidadFuncionalId}`;

/** El estado de cuenta con los pagos anulados a la vista, con su motivo («Ver anulados», BL-029). */
export const rutaDeUnidadConAnulados = (barrioId: string, unidadFuncionalId: string): string =>
  hrefDeLista(rutaDeUnidad(barrioId, unidadFuncionalId), { anulados: "1" });

/**
 * «Registrar pago de esta unidad», desde el estado de cuenta (encargo 8, T1 §8): `cobros/nuevo` con la
 * unidad preseleccionada. La página valida el parámetro (`esIdValido` + que la unidad esté entre las
 * del barrio) y, si no pasa, lo ignora.
 */
export const rutaDePagoDeUnidad = (barrioId: string, unidadFuncionalId: string): string =>
  `${rutasDeCobros(barrioId).nuevo}?unidad=${unidadFuncionalId}`;

/**
 * A dónde mandar según el **código** del error, en el módulo de Cobros. Mismo criterio que
 * `salidasDelPeriodo`: la tabla es parcial a propósito, y todas caen en la grilla porque ninguno de
 * estos rechazos deja a la pantalla sabiendo una unidad válida a la que volver.
 */
export function salidasDeCobros(barrioId: string) {
  const r = rutasDeCobros(barrioId);
  return {
    unidad_no_encontrada: { texto: "Ver la grilla de cobros", href: r.grilla },
    pago_no_encontrado: { texto: "Ver la grilla de cobros", href: r.grilla },
    pago_ya_anulado: { texto: "Ver la grilla de cobros", href: r.grilla },
    recibo_no_encontrado: { texto: "Ver la grilla de cobros", href: r.grilla },
    comprobante_no_adjunto: { texto: "Ver la grilla de cobros", href: r.grilla },
  } as const;
}

/** Las rutas del catálogo de Proveedores. Una sola pantalla hoy — sin `nuevo` propio: el alta vive
 *  en un panel desplegable de la misma grilla, mismo criterio que `cargos`/`gastos`. */
export const rutasDeProveedores = (barrioId: string) =>
  ({
    grilla: `/${barrioId}/proveedores`,
    /** El alta, en su página (encargo 9, PR 1 §2). Segmento estático: no choca con ningún id. */
    nuevo: `/${barrioId}/proveedores/nuevo`,
  }) as const;

/** A dónde mandar según el **código** del error, en el catálogo de Proveedores. Mismo criterio que
 *  `salidasDeCobros`: todas caen en la grilla, que es la única pantalla del catálogo. */
export function salidasDeProveedores(barrioId: string) {
  const r = rutasDeProveedores(barrioId);
  return {
    desconocido: { texto: "Ver el catálogo de proveedores", href: r.grilla },
    dato_invalido: { texto: "Ver el catálogo de proveedores", href: r.grilla },
  } as const;
}

/**
 * Las rutas de Órdenes de pago. Mismo criterio que `rutasDeCobros`: un solo lugar donde se arman.
 * `proveedores` está acá porque las órdenes de pago enlazan al catálogo; desde el encargo 8 (T1 §5)
 * además tiene su ítem en la barra lateral, junto a «Órdenes de pago».
 */
export const rutasDeOrdenesPago = (barrioId: string) =>
  ({
    grilla: `/${barrioId}/ordenes-pago`,
    nuevo: `/${barrioId}/ordenes-pago/nuevo`,
    proveedores: `/${barrioId}/proveedores`,
  }) as const;

/** La ruta del detalle de una orden de pago. Aparte de `rutasDeOrdenesPago` por el mismo motivo que
 *  `rutaDeUnidad`: necesita el id, y `rutasDeOrdenesPago` es el objeto fijo del barrio. */
export const rutaDeOrdenPago = (barrioId: string, ordenPagoId: string): string =>
  `/${barrioId}/ordenes-pago/${ordenPagoId}`;

/**
 * A dónde mandar según el **código** del error, en Proveedores/Órdenes de pago. Mismo criterio que
 * `salidasDeCobros`: la tabla es parcial a propósito.
 */
export function salidasDeOrdenesPago(barrioId: string) {
  const r = rutasDeOrdenesPago(barrioId);
  return {
    desconocido: { texto: "Ver la lista de órdenes de pago", href: r.grilla },
    transicion_invalida: { texto: "Ver la lista de órdenes de pago", href: r.grilla },
    orden_pago_no_se_edita: { texto: "Ver la lista de órdenes de pago", href: r.grilla },
    orden_pago_motivo_requerido: { texto: "Ver la lista de órdenes de pago", href: r.grilla },
    orden_pago_sin_periodo_reversion: { texto: "Ver la lista de órdenes de pago", href: r.grilla },
    comprobante_no_adjunto: { texto: "Ver la lista de órdenes de pago", href: r.grilla },
    factura_no_adjunta: { texto: "Ver la lista de órdenes de pago", href: r.grilla },
  } as const;
}

/**
 * El primer segmento de las migas en toda pantalla de un barrio: su nombre, enlazado a su tablero.
 * Las migas las arma cada pantalla con lo que ya leyó; esto solo evita repetir el enlace.
 */
export const migaDelBarrio = (barrio: { readonly id: string; readonly nombre: string }) =>
  ({ texto: barrio.nombre, href: portadaDelBarrio(barrio.id) }) as const;
