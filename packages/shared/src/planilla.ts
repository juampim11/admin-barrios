/**
 * Saneado de texto que va a parar a una **planilla de cálculo**.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * EL ATAQUE, Y POR QUÉ NO ES TEÓRICO ACÁ
 *
 * Una celda cuyo texto empieza con `=`, `+`, `-` o `@` la interpreta Excel (y LibreOffice, y Google
 * Sheets) como **fórmula**, no como dato. Con `=HYPERLINK("http://…"&A1)`, `=WEBSERVICE(…)` o
 * `+cmd|'/c calc'!A1` (DDE), eso pasa de "celda rara" a exfiltración o ejecución de comandos, según
 * versión y configuración.
 *
 * En este producto **el atacante y la víctima no son la misma persona, y ese es el punto**: un
 * `operador` tipea el motivo de anulación de un pago; el archivo lo abre el **contador o el
 * auditor**, en su propia máquina, fuera del sistema. Es un canal operador → contador que cruza el
 * límite de confianza del producto (`security-engineer`, panel 2026-08-26). La superficie real son
 * todos los campos de texto libre que llegan al libro: `motivo_anulacion`, `descripcion`,
 * `proveedor_nombre`, `motivo_factura_no_disponible`, `obligado.nombre`, y los rótulos del
 * encabezado que salen de datos del barrio (la razón social).
 *
 * **El precedente del sistema de gas NO cubre esto, y conviene decirlo fuerte porque su serializador
 * es de donde sale el patrón de este módulo:** su CSV escapa `;`, `"`, `\n` y `\r` (RFC-4180), que
 * es escape de **parsing**, no de **fórmula**. Copiarlo tal cual importa el agujero entero.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * UNA SOLA FUNCIÓN, NO UN `if` POR COLUMNA
 *
 * Es la única decisión de diseño que importa acá: un saneado aplicado columna por columna **se
 * olvida en la columna 14**. Todo texto que un humano tipeó pasa por esta función, una vez, en el
 * armado del dataset — y hay un test de regresión en el gate que inyecta los payloads reales.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ EL APÓSTROFO, SABIENDO QUE SE VE
 *
 * En un XLSX bien escrito el texto va como celda de tipo string y las fórmulas viven en otro
 * elemento del XML, así que el riesgo directo ya está mitigado por el serializador. Esto es la
 * **segunda vuelta de llave**, y existe porque el archivo no se queda quieto: el contador lo abre,
 * lo guarda como CSV, lo pega en otra planilla, lo sube a una hoja de cálculo en la nube. En
 * cualquiera de esos saltos el tipo de celda se pierde y el texto vuelve a ser interpretado.
 *
 * El apóstrofo es la marca que Excel entiende como "esto es texto" y la que recomienda la práctica
 * establecida. **Se ve** —un motivo que legítimamente empieza con `-` va a mostrar `'-`—, y se
 * eligió igual: la alternativa era un espacio de ancho cero, invisible pero que rompe la búsqueda y
 * el copiado, que es peor de depurar. Un carácter visible de más es un costo aceptable; una fórmula
 * ejecutándose en la máquina del contador no lo es.
 */

/**
 * Los caracteres que abren una fórmula si aparecen **primeros** en una celda.
 *
 * TAB (`0x09`) y CR (`0x0D`) están por un motivo distinto de los cuatro obvios: algunos parsers los
 * consumen como espacio en blanco al principio, y lo que queda expuesto es el carácter siguiente —
 * o sea, `\t=1+1` termina siendo `=1+1`. No se filtran por peligrosos en sí, sino porque **corren el
 * punto de partida**.
 */
const INICIALES_PELIGROSAS = ["=", "+", "-", "@", "\t", "\r"] as const;

/** La marca de "esto es texto, no una fórmula". Ver el motivo en el encabezado del módulo. */
const MARCA_DE_TEXTO = "'";

/**
 * Texto de una persona → texto seguro para una celda.
 *
 * Devuelve el texto **intacto** salvo que empiece con uno de los caracteres de arriba; en ese caso
 * lo prefija con un apóstrofo. No recorta, no normaliza acentos, no cambia el contenido: un motivo
 * de anulación es dato que alguien escribió y que puede terminar leyéndose en un reclamo.
 *
 * `null`/`undefined` salen como cadena vacía, que es lo que una celda ausente tiene que mostrar —
 * nunca la palabra "null" adentro de una planilla contable.
 */
export function sanearTextoDePlanilla(texto: string | null | undefined): string {
  if (texto === null || texto === undefined) return "";
  const primero = texto.charAt(0);
  const peligroso = INICIALES_PELIGROSAS.some((c) => c === primero);
  return peligroso ? `${MARCA_DE_TEXTO}${texto}` : texto;
}

/**
 * Nombre de archivo seguro para la cabecera `Content-Disposition`.
 *
 * **No es cosmética: es inyección de cabecera.** La razón social del barrio entra en el nombre del
 * archivo, y es texto que escribe un `admin_barrio`. Un `"` cierra el `filename="…"` antes de
 * tiempo y un CR/LF abre una cabecera nueva — con eso se pueden inventar cabeceras de respuesta
 * enteras (`security-engineer`, panel 2026-08-26).
 *
 * Estrategia **lista blanca, no lista negra**: sobreviven letras, dígitos, espacio, guion, guion
 * bajo y punto; todo lo demás se reemplaza por guion bajo. Una lista negra de "los caracteres malos"
 * es la que se olvida del carácter que todavía no apareció. Se recorta a 120 caracteres para no
 * pelearse con los límites de nombre de archivo de ningún sistema, y nunca vuelve vacío.
 *
 * Los acentos **sobreviven** (`\p{L}` con la bandera `u`, no `[A-Za-z]`): un barrio que se llama
 * "Los Álamos" no se baja como "Los _lamos" — y la regla 7 de `CLAUDE.md` sobre no "arreglar" nada
 * quitando acentos vale también acá.
 */
export function sanearNombreDeArchivo(nombre: string): string {
  const limpio = nombre
    .replace(/[^\p{L}\p{N} \-_.]/gu, "_")
    .replace(/_{2,}/g, "_")
    // Los separadores sobrantes de los extremos: `"///"` colapsa a `"_"`, y un archivo llamado `_`
    // pasa cualquier chequeo de "no está vacío" sin ser un nombre. Se recortan después del colapso,
    // no antes, porque el colapso es el que los produce.
    .replace(/^[\s_.\-]+|[\s_.\-]+$/g, "")
    .slice(0, 120);
  // La condición no es "quedó algo", es "quedó algo que **nombra**": al menos una letra o un dígito.
  return /[\p{L}\p{N}]/u.test(limpio) ? limpio : "exportacion";
}
