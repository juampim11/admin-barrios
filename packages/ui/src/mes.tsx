/**
 * Las piezas del circuito del mes (ADR-0011, T2), portadas de la maqueta aprobada
 * `mes-liquidacion.html`: las tres etapas, el próximo paso, lo que falta (Bloquea / Avisa), las
 * pestañas del mes con su conteo, la cadena de Envío, la boleta de ejemplo y la tarjeta de un barrio
 * en el Inicio.
 *
 * Son de servidor y no traen datos: reciben lo que la pantalla ya leyó. Las cifras llegan formateadas.
 */

import type { ReactNode } from "react";
import { IconoCheck } from "./iconos.tsx";

// ── Las tres etapas ───────────────────────────────────────────────────────────────────────────────

export type EstadoDeEtapa = "hecha" | "actual" | "pendiente";

export function EtapasDelMes({ children }: { readonly children: ReactNode }) {
  return (
    <ol
      data-admin-barrios-ui
      aria-label="Etapas del mes"
      className="mb-base grid grid-cols-1 overflow-hidden rounded-xl border border-border bg-surface md:grid-cols-3"
    >
      {children}
    </ol>
  );
}

export function EtapaDelMes({
  numero,
  titulo,
  estado,
  children,
}: {
  readonly numero: number;
  readonly titulo: ReactNode;
  readonly estado: EstadoDeEtapa;
  /** El hecho de la etapa en una línea: «1 cosa bloquea · 2 avisos». */
  readonly children: ReactNode;
}) {
  const marca =
    estado === "hecha"
      ? "border-success bg-success/15 text-success"
      : estado === "actual"
        ? "border-primary text-marca-aa"
        : "border-border-strong text-text-muted";
  return (
    <li
      aria-current={estado === "actual" ? "step" : undefined}
      className={`flex items-start gap-sm border-b border-border px-base py-sm last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0 ${
        estado === "actual" ? "bg-primary-subtle" : ""
      }`}
    >
      <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-pill border text-sm font-semibold ${marca}`} aria-hidden>
        {estado === "hecha" ? <IconoCheck /> : numero}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="font-semibold text-text-primary">
          <span className="sr-only">{estado === "hecha" ? "Hecha: " : estado === "actual" ? "Ahora: " : "Después: "}</span>
          {titulo}
        </span>
        <span className="mt-xs text-sm text-text-secondary">{children}</span>
      </span>
    </li>
  );
}

// ── Próximo paso ──────────────────────────────────────────────────────────────────────────────────

export function ProximoPaso({
  titulo,
  detalle,
  acciones,
}: {
  readonly titulo: ReactNode;
  readonly detalle: ReactNode;
  readonly acciones?: ReactNode;
}) {
  return (
    <section
      data-admin-barrios-ui
      aria-label="Próximo paso"
      className="mb-base grid grid-cols-1 items-center gap-sm rounded-xl border border-border bg-surface p-base shadow-sm md:grid-cols-[minmax(0,1fr)_auto]"
    >
      <div className="flex min-w-0 flex-col">
        <span className="text-sm text-text-secondary">Próximo paso</span>
        <h2 className="mt-xs text-lg font-semibold text-text-primary">{titulo}</h2>
        <span className="text-sm text-text-secondary">{detalle}</span>
      </div>
      {acciones ? <div className="flex flex-wrap gap-sm">{acciones}</div> : null}
    </section>
  );
}

// ── Lo que falta ──────────────────────────────────────────────────────────────────────────────────

export function ListaDeFaltas({ children }: { readonly children: ReactNode }) {
  return (
    <ul data-admin-barrios-ui aria-label="Lo que falta" className="mb-base rounded-lg border border-border bg-surface">
      {children}
    </ul>
  );
}

export function ItemDeFalta({
  tipo,
  titulo,
  detalle,
  accion,
}: {
  readonly tipo: "bloquea" | "avisa";
  readonly titulo: ReactNode;
  readonly detalle: ReactNode;
  readonly accion?: ReactNode;
}) {
  return (
    <li className="grid grid-cols-1 items-start gap-x-base gap-y-xs border-b border-border px-base py-sm text-sm last:border-b-0 md:grid-cols-[6rem_minmax(0,1fr)_auto]">
      <span
        className={`w-fit rounded-pill border px-sm py-[0.1rem] text-xs font-semibold ${
          tipo === "bloquea" ? "border-danger text-danger" : "border-warning text-warning"
        }`}
      >
        {tipo === "bloquea" ? "Bloquea" : "Avisa"}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="font-semibold text-text-primary">{titulo}</span>
        <span className="text-text-secondary">{detalle}</span>
      </span>
      {accion ? <span>{accion}</span> : null}
    </li>
  );
}

// ── Pestañas del mes ──────────────────────────────────────────────────────────────────────────────

export function PestanasDelMes({ children }: { readonly children: ReactNode }) {
  return (
    <nav data-admin-barrios-ui aria-label="Partes del mes" className="mb-lg flex flex-wrap gap-xs border-b border-border">
      {children}
    </nav>
  );
}

export function PestanaDelMes({
  href,
  activa,
  cantidad,
  children,
}: {
  readonly href: string;
  readonly activa: boolean;
  /** El conteo al lado del nombre («Gastos y pagos 6»); sin conteo, nada. */
  readonly cantidad?: number | null;
  readonly children: ReactNode;
}) {
  return (
    <a
      href={href}
      aria-current={activa ? "page" : undefined}
      className={`-mb-px border-b-2 px-sm py-sm text-sm no-underline ${
        activa ? "border-primary font-semibold text-marca-aa" : "border-transparent text-text-secondary hover:text-text-primary"
      }`}
    >
      {children}
      {cantidad != null ? <span className="ml-xs font-mono text-xs text-text-muted">{cantidad}</span> : null}
    </a>
  );
}

// ── Cifras del mes ────────────────────────────────────────────────────────────────────────────────

export function CifrasDelMes({ children }: { readonly children: ReactNode }) {
  return (
    <div data-admin-barrios-ui className="mb-base grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-sm">
      {children}
    </div>
  );
}

export function CifraDelMes({ valor, etiqueta }: { readonly valor: ReactNode; readonly etiqueta: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-sm">
      <div className="font-mono text-lg font-semibold text-text-primary">{valor}</div>
      <div className="text-xs text-text-muted">{etiqueta}</div>
    </div>
  );
}

// ── Envío: la cadena de después de emitir ─────────────────────────────────────────────────────────

export function CadenaDeEnvio({ children }: { readonly children: ReactNode }) {
  return (
    <ol data-admin-barrios-ui aria-label="Después de emitir" className="mb-base grid gap-sm">
      {children}
    </ol>
  );
}

export function PasoDeEnvio({
  numero,
  titulo,
  hecho,
  detalle,
  progreso,
  accion,
}: {
  readonly numero: ReactNode;
  readonly titulo: ReactNode;
  readonly hecho: boolean;
  readonly detalle: ReactNode;
  /** De 0 a 100, para la barra; `null` sin barra. */
  readonly progreso?: number | null;
  readonly accion?: ReactNode;
}) {
  return (
    <li className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-sm rounded-lg border border-border bg-surface px-sm py-sm text-sm">
      <span
        className={`grid h-6 w-6 place-items-center rounded-pill border text-xs ${
          hecho ? "border-success bg-success/15 text-success" : "border-border-strong text-text-muted"
        }`}
        aria-hidden
      >
        {hecho ? <IconoCheck /> : numero}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="font-semibold text-text-primary">
          {hecho ? <span className="sr-only">Hecho: </span> : null}
          {titulo}
        </span>
        <span className="text-text-secondary">{detalle}</span>
        {progreso != null ? (
          <span className="mt-xs block h-1.5 overflow-hidden rounded-sm bg-border" role="progressbar" aria-valuenow={progreso} aria-valuemin={0} aria-valuemax={100}>
            <span className="block h-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, progreso))}%` }} />
          </span>
        ) : null}
      </span>
      {accion ? <span>{accion}</span> : null}
    </li>
  );
}

// ── La boleta de ejemplo ──────────────────────────────────────────────────────────────────────────

export function BoletaDeEjemplo({
  titulo,
  renglones,
  total,
  pie,
}: {
  readonly titulo: ReactNode;
  readonly renglones: readonly { readonly concepto: ReactNode; readonly importe: ReactNode }[];
  readonly total: { readonly concepto: ReactNode; readonly importe: ReactNode };
  readonly pie?: ReactNode;
}) {
  return (
    <section data-admin-barrios-ui aria-label="Boleta de ejemplo" className="rounded-lg border border-dashed border-border-strong bg-surface p-base text-sm">
      <h3 className="mb-sm font-semibold text-text-primary">{titulo}</h3>
      {renglones.map((r, i) => (
        <div key={i} className="flex justify-between gap-sm py-xs">
          <span className="text-text-secondary">{r.concepto}</span>
          <span className="font-mono text-text-primary">{r.importe}</span>
        </div>
      ))}
      <div className="mt-xs flex justify-between gap-sm border-t border-border-strong pt-sm font-semibold">
        <span>{total.concepto}</span>
        <span className="font-mono">{total.importe}</span>
      </div>
      {pie ? <div className="mt-sm">{pie}</div> : null}
    </section>
  );
}

// ── Inicio: la tarjeta de un barrio ───────────────────────────────────────────────────────────────

export function TarjetasDeBarrios({ children }: { readonly children: ReactNode }) {
  return (
    <div data-admin-barrios-ui className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-sm">
      {children}
    </div>
  );
}

export function TarjetaDeBarrio({
  nombre,
  href,
  chips,
  datos,
  mes,
}: {
  readonly nombre: ReactNode;
  readonly href: string;
  readonly chips: ReactNode;
  readonly datos: readonly { readonly termino: ReactNode; readonly valor: ReactNode }[];
  /** El renglón del mes: «Noviembre: <chip>» y «Ir al mes →». */
  readonly mes: ReactNode;
}) {
  return (
    <article className="flex flex-col gap-sm rounded-xl border border-border bg-surface p-base shadow-sm">
      <a href={href} className="text-lg font-semibold text-text-primary no-underline hover:underline">
        {nombre}
      </a>
      <div className="flex flex-wrap gap-xs">{chips}</div>
      <dl className="mt-xs grid grid-cols-[1fr_auto] gap-x-sm gap-y-xs text-sm">
        {datos.map((d, i) => (
          <div key={i} className="contents">
            <dt className="text-text-secondary">{d.termino}</dt>
            <dd className="m-0 text-right font-mono">{d.valor}</dd>
          </div>
        ))}
      </dl>
      <div className="flex items-center justify-between gap-sm border-t border-border pt-sm text-sm">{mes}</div>
    </article>
  );
}
