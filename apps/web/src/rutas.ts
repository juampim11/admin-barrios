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
    cargos: `/${barrioId}/liquidacion/${periodoId}/cargos`,
    revision: `/${barrioId}/liquidacion/${periodoId}/revision`,
    documentos: `/${barrioId}/liquidacion/${periodoId}/documentos`,
    periodos: `/${barrioId}/liquidacion`,
    padron: `/${barrioId}/padron`,
    /**
     * El valor de la expensa. **Cuelga del barrio y no del período** —por eso no lleva `periodoId`—
     * porque el valor se define una vez y rige para los meses que vengan. Está acá igual porque es
     * uno de los destinos a los que manda el resumen de un período (`DestinoDeAccion`).
     */
    cuota: `/${barrioId}/liquidacion/cuota`,
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
    barrio_sin_coeficientes: { texto: "Ir al padrón del barrio", href: r.padron },
    // El **período** no tiene versión asignada todavía: se la pone el borrador.
    sin_coeficientes: { texto: "Generar el borrador", href: r.revision },
    coeficientes_sin_cerrar: { texto: "Ir al padrón del barrio", href: r.padron },
    // El mes no cuadra o faltan unidades: se ve en la grilla de revisión, con las cifras al lado.
    periodo_no_cuadra: { texto: "Revisar las cifras del período", href: r.revision },
    periodo_incompleto: { texto: "Revisar las cifras del período", href: r.revision },
    neto_negativo: { texto: "Revisar los cargos y descuentos", href: r.cargos },
    // Ya no se edita: lo que queda es mirar cómo quedó.
    periodo_no_editable: { texto: "Ver el período", href: r.resumen },
    registro_inmutable: { texto: "Ver el período", href: r.resumen },
    transicion_invalida: { texto: "Ver el período", href: r.resumen },
    // El período que se quiso crear ya existe.
    periodo_ya_existe: { texto: "Ver los períodos del barrio", href: r.periodos },
    // El catálogo del barrio es lo que hay que mirar.
    concepto_sin_valor_vigente: { texto: "Ver el catálogo de conceptos", href: r.cargos },
    concepto_no_encontrado: { texto: "Ver el catálogo de conceptos", href: r.cargos },
    // La lista quedó vieja respecto de lo que hay en la base.
    aplicacion_no_encontrada: { texto: "Recargar los cargos del período", href: r.cargos },
    aplicacion_ya_anulada: { texto: "Recargar los cargos del período", href: r.cargos },
    aplicacion_no_se_edita: { texto: "Recargar los cargos del período", href: r.cargos },
    gasto_no_encontrado: { texto: "Recargar los gastos del período", href: r.gastos },
    // Todavía no hay nada que emitir: el borrador se genera en la pantalla de revisión.
    periodo_sin_liquidaciones: { texto: "Generar el borrador", href: r.revision },
    // Ya hay una generación en curso: la pantalla de documentos la muestra con su progreso.
    trabajo_ya_encolado: { texto: "Ver los documentos del período", href: r.documentos },
    trabajo_no_encontrado: { texto: "Ver los documentos del período", href: r.documentos },
    documento_no_encontrado: { texto: "Ver los documentos del período", href: r.documentos },
  } as const;
}
