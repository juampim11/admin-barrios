/**
 * Cómo se dicen en castellano los valores de los enums del dominio, y el chip de estado del período.
 *
 * **Esto es presentación, no dominio.** Traducir `ph_especial` a "PH especial" no decide nada: no
 * cambia qué se puede hacer, ni cuánto se cobra, ni quién ve qué. Por eso vive en `apps/web` y no en
 * `packages/` — es exactamente una de las cuatro cosas que el ADR-0002 §5.1 le deja hacer a la web.
 *
 * **Casi todos los diccionarios son `Record<Union, string>` a propósito.** Si mañana entra un valor
 * nuevo al enum de `@admin-barrios/shared`, esto **no compila** hasta que alguien decida cómo se
 * llama en pantalla. Es lo contrario de un `?? valor` silencioso, que dejaría al usuario leyendo
 * `en_construccion` con guión bajo en la mitad de una tabla.
 *
 * **Dos no lo son, y hay que decirlo:** `ORIGEN_SALDO` y `TIPO_CONCEPTO` son `Record<string, …>`
 * porque sus valores viven en un `check` de una migración y no en una unión de `shared` — no hay
 * tipo contra el cual exigir exhaustividad. Ahí la protección del compilador **no existe**: si la
 * migración agrega un valor, hay que acordarse de agregarlo acá. Anotado como deuda: el día que esos
 * dos conjuntos suban a `shared` como constante, estos dos diccionarios se cierran como los demás.
 *
 * ⚠ **Deuda anotada:** el día que haya email o pantallas del residente, estas etiquetas van a
 * hacer falta en dos lugares. Ahí se mudan a `packages/shared` — igual que pasó con
 * `etiquetaUnidad()`, que existió tres veces antes de existir una.
 */

import type { ComponentType } from "react";
import type {
  Adecuacion2075,
  EncuadreUrbanistico,
  EstadoUnidad,
  FiguraJuridica,
  ServiciosInternos,
  TipoObligado,
  TitularidadEspaciosComunes,
} from "@admin-barrios/shared/barrio";
import type { EstadoPeriodo, ModeloExpensa } from "@admin-barrios/shared/liquidacion";
import type { RolMembership } from "@admin-barrios/shared/tenancy";
import { Chip, type Tono } from "./ui.tsx";
import { IconoBorrador, IconoDistribuida, IconoEmitida, IconoRevisada } from "./iconos.tsx";

export const FIGURA_JURIDICA: Record<FiguraJuridica, string> = {
  sa: "Sociedad anónima",
  asociacion_civil: "Asociación civil",
  ph_especial: "PH especial",
  fideicomiso: "Fideicomiso",
  geodesia: "Geodesia",
};

/** Versión corta, para el chip que viaja en la cabecera de todas las pantallas del barrio. */
export const FIGURA_JURIDICA_CORTA: Record<FiguraJuridica, string> = {
  sa: "SA",
  asociacion_civil: "Asoc. civil",
  ph_especial: "PH especial",
  fideicomiso: "Fideicomiso",
  geodesia: "Geodesia",
};

export const ADECUACION_2075: Record<Adecuacion2075, string> = {
  si: "Adecuado",
  no: "No adecuado",
  en_tramite: "En trámite",
  no_aplica: "No aplica",
};

export const ENCUADRE_URBANISTICO: Record<EncuadreUrbanistico, string> = {
  ure: "Urbanización residencial especial",
  loteo_abierto: "Loteo abierto",
  cierre_calles: "Cierre de calles",
  sin_encuadre: "Sin encuadre",
};

export const SERVICIOS_INTERNOS: Record<ServiciosInternos, string> = {
  municipio: "A cargo del municipio",
  urbanizacion: "A cargo de la urbanización",
  mixto: "Mixto",
};

export const TITULARIDAD_ESPACIOS_COMUNES: Record<TitularidadEspaciosComunes, string> = {
  ente: "Del ente",
  propietarios: "De los propietarios",
  mixto: "Mixta",
};

export const ESTADO_UNIDAD: Record<EstadoUnidad, string> = {
  baldio: "Baldío",
  en_construccion: "En construcción",
  construido: "Construido",
};

export const TIPO_OBLIGADO: Record<TipoObligado, string> = {
  propietario: "Propietario",
  poseedor: "Poseedor",
  usufructuario: "Usufructuario",
  tenedor: "Tenedor",
};

export const ROL: Record<RolMembership, string> = {
  admin_plataforma: "Admin. de plataforma",
  admin_barrio: "Administrador",
  operador: "Operador",
  contador: "Contador",
  auditor: "Auditor",
  propietario: "Propietario",
  residente: "Residente",
};

export const MODELO_EXPENSA: Record<ModeloExpensa, string> = {
  variable: "Prorrateo por coeficiente",
  fija: "Cuota fija",
};

/*
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * CÓMO LLAMA CADA BARRIO A LO QUE COBRA
 *
 * Lo que se cobra se llama distinto según la figura: **expensa** en un PH, **cuota social** o
 * **aporte** en una asociación civil, **contribución** en un fideicomiso. El barrio lo declara en
 * `denominacion_concepto` y es lo que sale impreso en la boleta; si una pantalla dijera "cuota", el
 * administrador leería una palabra en el sistema y otra en el papel que manda.
 *
 * Las tablas y columnas sí se llaman `cuota_fija`: ese es el nombre del **modelo de cálculo**, no el
 * de lo que se cobra, y eso no se toca.
 *
 * **Están acá porque ya existían dos veces** —en `cuota/page.tsx` y en `cuota/formulario.tsx`— y el
 * alta de período iba a ser la tercera y la cuarta. Es el caso literal que anuncia el encabezado de
 * este archivo sobre `etiquetaUnidad()`, "que existió tres veces antes de existir una". Son de
 * redacción y de nada más: no deciden nada.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */

/**
 * Cae a "expensa", que es el término del Código Civil y el que entiende todo el mundo. La
 * denominación en blanco o con solo espacios cuenta como no declarada.
 */
export const comoSeLlama = (denominacion: string | null | undefined): string =>
  denominacion?.trim() ? denominacion.trim() : "expensa";

/**
 * Si la denominación es femenina. **Mira el sustantivo núcleo, que en castellano es la PRIMERA
 * palabra**, no la última letra de la frase.
 *
 * La versión anterior hacía `d.endsWith("a")` y fallaba en dos de los tres ejemplos que su propio
 * comentario daba: *"el cuota social"* (el adjetivo `social` no lleva el género del sustantivo) y
 * *"el contribución"*. Con una sola pantalla que decía "expensa" no se notaba; con cuatro y una
 * denominación configurable por barrio, sale impreso.
 *
 * Las terminaciones son las regulares del castellano. No pretende cubrir el idioma entero: cubre lo
 * que un barrio puede poner en `denominacion_concepto` —expensa, cuota social, contribución, aporte,
 * canon—, y ante la duda cae en masculino, que es el no marcado.
 */
const esFemenino = (d: string): boolean => {
  const nucleo = d.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return /(a|ción|sión|dad|tad|umbre|ez)$/.test(nucleo);
};

/** `"expensa"` → `"la expensa"`; `"aporte"` → `"el aporte"`. */
export const laX = (d: string): string => `${esFemenino(d) ? "la" : "el"} ${d}`;

/**
 * `"expensa"` → `"de la expensa"`; `"aporte"` → `"del aporte"`.
 *
 * Existe por la contracción, que es obligatoria: `de + el` es **`del`**, y no hay forma de armarla
 * pegando `"de "` delante de `laX()` sin escribir *"de el aporte"*. Pasó: tres textos nuevos lo
 * decían así antes de que la revisión lo marcara.
 */
export const deLaX = (d: string): string => (esFemenino(d) ? `de la ${d}` : `del ${d}`);

/** La denominación con mayúscula inicial, para una etiqueta de campo o el arranque de una frase. */
export const mayus = (d: string): string => d.charAt(0).toUpperCase() + d.slice(1);

export const ESTADO_PERIODO: Record<EstadoPeriodo, string> = {
  borrador: "Borrador",
  revisada: "Revisada",
  emitida: "Emitida",
  distribuida: "Distribuida",
};

/** La segunda línea del estado: qué significa para el que lo está mirando. */
export const ESTADO_PERIODO_QUE_SIGNIFICA: Record<EstadoPeriodo, string> = {
  borrador: "se puede editar",
  revisada: "lista para emitir",
  emitida: "ya no se edita",
  distribuida: "enviada a los obligados",
};

/**
 * El estado dicho como **un hecho, en una frase** — "este período ya …".
 *
 * Existe por un error de concordancia que se ve enseguida y da vergüenza: los valores del enum están
 * en femenino porque describen la **liquidación** (`emitida`, `revisada`, `distribuida`), y
 * interpolados en una frase sobre el **período** salía "este período ya está emitida". Un diccionario
 * aparte cuesta cinco renglones y hace imposible volver a escribirlo mal.
 */
export const ESTADO_PERIODO_COMO_HECHO: Record<EstadoPeriodo, string> = {
  borrador: "está en borrador",
  revisada: "quedó marcado como revisado",
  emitida: "se emitió",
  distribuida: "se distribuyó",
};

/**
 * De dónde sale el saldo anterior. **Es la cifra que más miente sin su origen:** un `$ 0,00` con
 * `sin_movimientos` no significa "está al día", significa "todavía no existe la cuenta corriente".
 *
 * Los tres valores son los del `check` de la migración 0009: `sin_movimientos`, `carga_manual` y
 * `cuenta_corriente`. Este último todavía no lo escribe nadie —falta el módulo de cobros— pero la
 * base ya lo admite, y sin la entrada el pie de la grilla imprimiría `cuenta_corriente` con guión
 * bajo el día que aparezca.
 */
export const ORIGEN_SALDO: Record<string, string> = {
  sin_movimientos: "sin cuenta corriente todavía",
  carga_manual: "cargado a mano",
  cuenta_corriente: "de la cuenta corriente",
};

/** Tipo de concepto de gasto (art. 2048). La extraordinaria necesita respaldo de asamblea. */
export const TIPO_CONCEPTO: Record<string, string> = {
  ordinaria: "Ordinaria",
  extraordinaria: "Extraordinaria",
};

/**
 * Cómo se calcula un concepto de boleta. `Record<string, …>` como los dos de arriba y por el mismo
 * motivo: los valores viven en un enum de una migración y no en una unión de `shared`.
 *
 * Vive **acá y no en el formulario de cargos** aunque ese sea su único usuario de cliente: la tabla
 * del catálogo la renderiza el Server Component de la misma pantalla, y una función exportada desde
 * un módulo `"use client"` no se puede llamar desde el servidor —Next la reemplaza por una
 * referencia y el intento revienta en runtime con "Attempted to call … from the server". Verificado:
 * la pantalla de cargos tiraba a la frontera de error justo así.
 */
export const METODO_CONCEPTO_BOLETA: Record<string, string> = {
  monto_fijo: "Monto fijo",
  porcentaje: "Porcentaje sobre la expensa ordinaria",
  precio_x_cantidad: "Precio por cantidad",
};

/**
 * Busca en un diccionario cerrado con un valor que el servicio tipa como `string`.
 *
 * Los enums viajan como `text` desde Postgres (`::text` en las consultas) y llegan a la web tipados
 * `string`, no como la unión. El diccionario **sigue siendo exhaustivo en compilación** —agregar un
 * rol al enum rompe el build hasta que alguien lo nombre— y esto solo resuelve el último tramo: si
 * apareciera un valor que el diccionario no conoce, se muestra crudo en vez de romper la pantalla.
 */
function buscar<T extends string>(diccionario: Record<T, string>, valor: string): string {
  return (diccionario as Record<string, string | undefined>)[valor] ?? valor;
}

export const etiquetaFigura = (v: string): string => buscar(FIGURA_JURIDICA, v);
export const etiquetaFiguraCorta = (v: string): string => buscar(FIGURA_JURIDICA_CORTA, v);
export const etiquetaAdecuacion = (v: string): string => buscar(ADECUACION_2075, v);
export const etiquetaEncuadre = (v: string): string => buscar(ENCUADRE_URBANISTICO, v);
export const etiquetaServiciosInternos = (v: string): string => buscar(SERVICIOS_INTERNOS, v);
export const etiquetaTitularidad = (v: string): string => buscar(TITULARIDAD_ESPACIOS_COMUNES, v);
export const etiquetaEstadoUnidad = (v: string): string => buscar(ESTADO_UNIDAD, v);
export const etiquetaTipoObligado = (v: string): string => buscar(TIPO_OBLIGADO, v);
export const etiquetaModelo = (v: string): string => buscar(MODELO_EXPENSA, v);
export const etiquetaTipoConcepto = (v: string): string => buscar(TIPO_CONCEPTO, v);
export const etiquetaOrigenSaldo = (v: string): string => buscar(ORIGEN_SALDO, v);
export const etiquetaMetodo = (v: string): string => buscar(METODO_CONCEPTO_BOLETA, v);

const ICONO_ESTADO: Record<EstadoPeriodo, ComponentType> = {
  borrador: IconoBorrador,
  revisada: IconoRevisada,
  emitida: IconoEmitida,
  distribuida: IconoDistribuida,
};

const TONO_ESTADO: Record<EstadoPeriodo, Tono> = {
  borrador: "neutro",
  revisada: "info",
  emitida: "marca",
  distribuida: "exito",
};

/**
 * Los cuatro estados de la máquina del período con **cuatro señales redundantes**: palabra, ícono de
 * silueta distinta, color, y borde punteado o sólido según se pueda editar o no.
 *
 * El color no puede ser la única señal (doc 06 §f.2) y acá se cumple de sobra: en una captura en
 * escala de grises se distinguen igual por la forma del ícono y por el tipo de borde.
 *
 * **`editable` es obligatorio y no tiene default**, y eso es la parte importante de la firma. Un
 * `editable ?? (estado === "borrador" || estado === "revisada")` sería una **tercera** copia de la
 * regla del trigger `app.periodo_editable` (0013) escrita en un componente — justo lo que el
 * ADR-0002 §5.3 dice que ningún test puede detectar. Sin default, la única forma de dibujar el chip
 * es traer el dato, y el dato lo calcula el servicio en un solo lugar (`mapearPeriodo`).
 */
export function EstadoDelPeriodo({
  estado,
  editable,
}: {
  readonly estado: EstadoPeriodo;
  readonly editable: boolean;
}) {
  const Icono = ICONO_ESTADO[estado];
  return (
    <Chip tono={TONO_ESTADO[estado]} icono={<Icono />} punteado={editable}>
      {ESTADO_PERIODO[estado]}
    </Chip>
  );
}
