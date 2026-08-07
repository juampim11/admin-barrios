/**
 * El vocabulario visual compartido: paneles, cifras, chips, notas, tablas y paginado.
 *
 * **Ninguno de estos componentes es de cliente.** Se renderizan enteros en el servidor y no mandan
 * un byte de JavaScript al navegador: lo desplegable es `<details>` nativo y el paginado son links.
 * Es la lectura barata que pide el presupuesto de recursos (§1 y §4) y, de paso, hace que todo
 * funcione con el teclado sin que haya que programarlo.
 *
 * **Ninguno decide nada de negocio.** Reciben lo que el servicio ya calculó y eligen cómo se ve.
 * Lo más cerca que están de una cuenta es `sumarMontos()` de `@admin-barrios/shared/dinero`, que es
 * la aritmética exacta del proyecto — nunca `Number()`, nunca `Intl`.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { formatearDecimal, formatearMonto } from "@admin-barrios/shared/dinero";
import { IconoAlerta, IconoCorrecto, IconoFlecha, IconoInfo } from "./iconos.tsx";
import estilos from "./ui.module.css";

export { estilos as ui };

/** Los seis tonos del sistema. No hay un séptimo: si hace falta, primero se agrega el token. */
export type Tono = "neutro" | "marca" | "info" | "exito" | "alerta" | "peligro";

const CLASE_CHIP: Record<Tono, string> = {
  neutro: estilos.chipNeutro ?? "",
  marca: estilos.chipMarca ?? "",
  info: estilos.chipInfo ?? "",
  exito: estilos.chipExito ?? "",
  alerta: estilos.chipAlerta ?? "",
  peligro: estilos.chipPeligro ?? "",
};

const CLASE_NOTA: Record<Tono, string> = {
  neutro: estilos.notaNeutro ?? "",
  marca: estilos.notaInfo ?? "",
  info: estilos.notaInfo ?? "",
  exito: estilos.notaExito ?? "",
  alerta: estilos.notaAlerta ?? "",
  peligro: estilos.notaPeligro ?? "",
};

const clases = (...partes: ReadonlyArray<string | false | undefined>): string =>
  partes.filter(Boolean).join(" ");

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Cifras
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Un importe. **`null` no se rellena con cero.**
 *
 * "Todavía no se liquidó" y "se liquidó cero pesos" son estados distintos y acá la diferencia es
 * plata: un `$ 0,00` fabricado se lee como un hecho. Por eso `nulo` es obligatorio y se escribe con
 * palabras.
 */
export function Cifra({
  monto,
  nulo,
  signo,
}: {
  readonly monto: string | null;
  readonly nulo: string;
  /** `true` = escribe el `+` cuando el monto es positivo (columnas de cargos y descuentos). */
  readonly signo?: boolean;
}) {
  if (monto === null) return <span className={estilos.sinDato}>{nulo}</span>;

  const impreso = formatearMonto(monto);
  const negativo = impreso.startsWith("-");
  const prefijo = signo && !negativo && impreso !== "0,00" ? "+" : "";

  return (
    <span className={clases(estilos.cifra, negativo && estilos.cifraNegativa)}>
      <span className={estilos.moneda} aria-hidden>
        $
      </span>
      <span className={estilos.soloLectores}>pesos </span>
      {prefijo}
      {impreso}
    </span>
  );
}

/**
 * Un coeficiente. La base guarda 9 decimales y se muestran 4, igual que en la boleta: que el número
 * de la pantalla y el del PDF sean el mismo es lo que permite resolver un reclamo por teléfono.
 */
export function Coeficiente({ valor, nulo }: { readonly valor: string | null; readonly nulo: string }) {
  if (valor === null) return <span className={estilos.sinDato}>{nulo}</span>;
  return <span className={estilos.cifra}>{formatearDecimal(valor, 4)}</span>;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Estructura
// ────────────────────────────────────────────────────────────────────────────────────────────────

export function Pagina({ children }: { readonly children: ReactNode }) {
  return <div className={estilos.pagina}>{children}</div>;
}

export function EncabezadoDePagina({
  titulo,
  bajada,
  acciones,
}: {
  readonly titulo: ReactNode;
  readonly bajada?: ReactNode;
  readonly acciones?: ReactNode;
}) {
  return (
    <header className={estilos.encabezado}>
      <div>
        <h1 className={estilos.titulo}>{titulo}</h1>
        {bajada ? <p className={estilos.bajada}>{bajada}</p> : null}
      </div>
      {acciones ? <div className={estilos.tiraDeChips}>{acciones}</div> : null}
    </header>
  );
}

/**
 * Una tarjeta con título y —esto es lo importante— un renglón de **origen**: de dónde salen las
 * cifras que hay adentro. La regla dura del proyecto es que ningún número va suelto, y el lugar
 * barato de cumplirla es el encabezado del panel, no un popover por celda.
 */
export function Panel({
  titulo,
  origen,
  acciones,
  pie,
  sinRelleno,
  children,
}: {
  readonly titulo?: ReactNode;
  readonly origen?: ReactNode;
  readonly acciones?: ReactNode;
  readonly pie?: ReactNode;
  readonly sinRelleno?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <section className={estilos.panel}>
      {titulo ? (
        <div className={estilos.panelCabecera}>
          <div>
            <h2 className={estilos.panelTitulo}>{titulo}</h2>
            {origen ? <p className={estilos.origen}>{origen}</p> : null}
          </div>
          {acciones ? <div className={estilos.tiraDeChips}>{acciones}</div> : null}
        </div>
      ) : null}
      <div className={clases(estilos.panelCuerpo, sinRelleno && estilos.panelCuerpoLimpio)}>{children}</div>
      {pie ? <div className={estilos.panelPie}>{pie}</div> : null}
    </section>
  );
}

/**
 * Un dato con su etiqueta y, cuando la cifra lo necesita, **su denominador o su procedencia**.
 *
 * "8 unidades" no dice nada; "8 de 50 unidades activas" sí. Ese segundo renglón es `origen`, y por
 * eso está en la firma del componente y no librado a que cada pantalla se acuerde.
 */
export function Dato({
  etiqueta,
  origen,
  grande,
  enCaja,
  children,
}: {
  readonly etiqueta: ReactNode;
  readonly origen?: ReactNode;
  readonly grande?: boolean;
  readonly enCaja?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className={clases(estilos.dato, enCaja && estilos.datoEnCaja)}>
      <span className={estilos.datoEtiqueta}>{etiqueta}</span>
      <span className={clases(estilos.datoValor, grande && estilos.datoValorGrande)}>{children}</span>
      {origen ? <span className={estilos.origen}>{origen}</span> : null}
    </div>
  );
}

export function Definiciones({ children }: { readonly children: ReactNode }) {
  return <dl className={estilos.definiciones}>{children}</dl>;
}

export function Definicion({ termino, children }: { readonly termino: ReactNode; readonly children: ReactNode }) {
  return (
    <div>
      <dt>{termino}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Señales
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Chip de estado: **color + ícono + texto**, los tres siempre (doc 06 §f.2).
 *
 * El texto va en `--text-primary` y el color vive en el ícono y el borde. No es una preferencia:
 * varios tokens de estado no llegan a 4,5:1 sobre superficie clara, así que teñir la palabra
 * rompería AA. Un ícono y un borde son componentes de UI y les alcanza con 3:1.
 */
export function Chip({
  tono = "neutro",
  icono,
  punteado,
  children,
}: {
  readonly tono?: Tono;
  readonly icono?: ReactNode;
  /**
   * Borde punteado = **provisorio**: esto todavía puede cambiar. Lo usan el estado editable de un
   * período y el chip de la sesión de demostración. Nunca se decide acá: siempre viene de un dato.
   */
  readonly punteado?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <span className={clases(estilos.chip, CLASE_CHIP[tono], punteado && estilos.chipProvisorio)}>
      {icono ? <span className={estilos.chipIcono}>{icono}</span> : null}
      {children}
    </span>
  );
}

export function TiraDeChips({ children }: { readonly children: ReactNode }) {
  return <div className={estilos.tiraDeChips}>{children}</div>;
}

/** Una línea de alerta o de contexto. El ícono acompaña; el que informa es el texto. */
export function Nota({
  tono = "info",
  titulo,
  icono,
  children,
}: {
  readonly tono?: Tono;
  readonly titulo?: ReactNode;
  readonly icono?: ReactNode;
  readonly children?: ReactNode;
}) {
  const porDefecto = tono === "alerta" || tono === "peligro" ? <IconoAlerta /> : tono === "exito" ? <IconoCorrecto /> : <IconoInfo />;
  return (
    <div className={clases(estilos.nota, CLASE_NOTA[tono])}>
      <span className={estilos.notaIcono}>{icono ?? porDefecto}</span>
      <span className={estilos.notaTexto}>
        {titulo ? <span className={estilos.notaTitulo}>{titulo}</span> : null}
        {children ? <span>{children}</span> : null}
      </span>
    </div>
  );
}

export function PilaDeNotas({ children }: { readonly children: ReactNode }) {
  return <div className={estilos.pilaDeNotas}>{children}</div>;
}

/** Nunca una tabla vacía muda: qué falta y por dónde se sigue (doc 06 §e.3). */
export function Vacio({
  icono,
  titulo,
  children,
}: {
  readonly icono?: ReactNode;
  readonly titulo: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div className={estilos.vacio}>
      {icono ? <span className={estilos.vacioIcono}>{icono}</span> : null}
      <p className={estilos.vacioTitulo}>{titulo}</p>
      {children ? <p className={estilos.vacioTexto}>{children}</p> : null}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Tablas
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * El marco que hace que una tabla ancha scrollee **dentro de sí misma** y no desborde la página
 * (doc 06 §e.7). Es `role="region"` con `tabindex`: una tabla que solo se desplaza arrastrando no
 * existe para quien navega con teclado.
 */
export function MarcoTabla({ etiqueta, children }: { readonly etiqueta: string; readonly children: ReactNode }) {
  return (
    <>
      <p className={estilos.pistaScroll}>Deslizá la tabla para ver el resto de las columnas →</p>
      <div className={estilos.marcoTabla} role="region" aria-label={etiqueta} tabIndex={0}>
        {children}
      </div>
    </>
  );
}

export function Tabla({ children }: { readonly children: ReactNode }) {
  return <table className={estilos.tabla}>{children}</table>;
}

/** El bloque colapsado donde vive lo que no corresponde tener a la vista (ver `padron/page.tsx`). */
export function Desplegable({ resumen, children }: { readonly resumen: ReactNode; readonly children: ReactNode }) {
  return (
    <details className={estilos.desplegable}>
      <summary>{resumen}</summary>
      <div className={estilos.contenidoDesplegado}>{children}</div>
    </details>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Paginado
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Paginado por links (`?pagina=N`), resuelto en el servidor.
 *
 * Los extremos **no son links muertos**: son texto con `aria-disabled`. Un "Anterior" que en la
 * primera página lleva a la primera página es una promesa rota que además ensucia el historial.
 *
 * El rango ("Mostrando 51–100 de 512") no es decorativo: es el denominador de la cifra que el
 * administrador está mirando. Sin él, "50 unidades" puede ser todo el barrio o el 10 %.
 */
export function Paginado({
  ruta,
  parametros,
  pagina,
  paginas,
  rango,
}: {
  readonly ruta: string;
  /** Los demás parámetros de la URL, que hay que conservar al cambiar de página. */
  readonly parametros: Readonly<Record<string, string>>;
  readonly pagina: number;
  readonly paginas: number;
  readonly rango: ReactNode;
}) {
  const href = (n: number): string => {
    const busqueda = new URLSearchParams({ ...parametros, pagina: `${n}` });
    return `${ruta}?${busqueda.toString()}`;
  };

  const hayAnterior = pagina > 1;
  const haySiguiente = pagina < paginas;

  return (
    <nav className={estilos.paginado} aria-label="Paginado del listado">
      <p className={estilos.rango} aria-live="polite">
        {rango}
      </p>
      <div className={estilos.controles}>
        {hayAnterior ? (
          <Link className={estilos.paso} href={href(pagina - 1)} rel="prev">
            <IconoFlecha direccion="izquierda" />
            Anterior
          </Link>
        ) : (
          <span className={clases(estilos.paso, estilos.pasoInactivo)} aria-disabled="true">
            <IconoFlecha direccion="izquierda" />
            Anterior
          </span>
        )}
        <span className={estilos.rango}>
          Página {pagina} de {paginas}
        </span>
        {haySiguiente ? (
          <Link className={estilos.paso} href={href(pagina + 1)} rel="next">
            Siguiente
            <IconoFlecha direccion="derecha" />
          </Link>
        ) : (
          <span className={clases(estilos.paso, estilos.pasoInactivo)} aria-disabled="true">
            Siguiente
            <IconoFlecha direccion="derecha" />
          </span>
        )}
      </div>
    </nav>
  );
}
