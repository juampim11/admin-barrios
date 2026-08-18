import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import { listarSaldosUF } from "@admin-barrios/data/servicios/cobros";
import { comoSeLlama } from "../../../../../componentes/etiquetas.tsx";
import { EncabezadoDePagina, Nota, Pagina } from "../../../../../componentes/ui.tsx";
import { esIdValido, salidasDeCobros } from "../../../../../rutas.ts";
import { conSesion } from "../../../../../servidor/db.ts";
import { FormularioDePago } from "./formulario.tsx";

export const metadata: Metadata = { title: "Registrar pago" };

/**
 * El alta de un pago — **carga manual**.
 *
 * Solo esto: efectivo, cheque en mano, transferencia avisada por fuera de cualquier circuito
 * automático. Los pagos por banco o agregador se van a conciliar solos cuando ese módulo exista
 * (`origen = 'extracto'`, ya admitido por el esquema, todavía sin ningún productor); mientras tanto
 * esto es lo único que carga un pago, y por eso el título lo dice.
 *
 * **La lista de unidades sale de `listarSaldosUF`, no de `listarPadron`.** Dos motivos, no uno solo:
 * `listarPadron` pagina a 50 (regla deliberada contra el volumen de PII que carga cada fila — ver su
 * comentario) y este selector necesita el barrio **entero**, sin cortar; y de paso `listarSaldosUF`
 * ya trae el saldo de cada unidad, que es exactamente lo que el panel de contexto de la opción B
 * necesita mostrar **sin una llamada de cliente nueva**: el servidor manda la lista completa
 * (`unidadFuncionalId`, `etiqueta`, `saldoActual`, `fechaUltimoMovimiento` — nada de PII) y el
 * formulario busca ahí adentro la unidad que se va eligiendo. Es la misma consulta que ya usa la
 * grilla (`cobros/page.tsx`), sin agregar una lectura nueva al contrato.
 *
 * **Gate de rol, igual que `documentos/page.tsx` (líneas 93-103).** No es autorización —eso lo decide
 * la policy de `insert` de `pago`— sino honestidad: no se le ofrece el formulario a quien la base va
 * a rechazar.
 */
export default async function NuevoPago({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly barrio: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { barrio: barrioId } = await params;
  if (!esIdValido(barrioId)) notFound();

  const crudos = await searchParams;
  // Preselección opcional por querystring (p. ej. desde un enlace futuro del estado de cuenta). Si el
  // valor no tiene forma de id o no está entre las unidades del barrio, el formulario simplemente no
  // preselecciona nada — no es un 404, es un dato que se ignora.
  const unidadPreseleccionada = typeof crudos["unidad"] === "string" ? crudos["unidad"] : null;

  const datos = await conSesion(async (tx) => ({
    barrio: await leerBarrio(tx, { barrioId }),
    saldos: await listarSaldosUF(tx, { barrioId }),
  }));

  if (!datos.barrio) notFound();
  const barrio = datos.barrio;
  const { puedeRegistrarPago, saldos } = datos.saldos;
  const denominacion = comoSeLlama(barrio.denominacionConcepto);

  return (
    <Pagina>
      <EncabezadoDePagina
        titulo="Registrar un pago — carga manual"
        bajada={`${barrio.nombre}. Un pago que no llega por ningún circuito automático de cobranza.`}
      />

      <Nota tono="info" titulo="Esto es para lo que entra por fuera de la conciliación automática.">
        Los pagos por banco o agregador se van a conciliar solos cuando ese módulo exista. Este
        formulario es para lo que entra por fuera de ese circuito: efectivo, cheque en mano,
        transferencia avisada.
      </Nota>

      {!puedeRegistrarPago ? (
        <Nota tono="info" titulo="Los pagos los registra quien administra el barrio.">
          Con tu rol podés ver la grilla de cobros y el estado de cuenta de cada unidad, pero no cargar
          un pago nuevo.
        </Nota>
      ) : (
        <FormularioDePago
          saldos={saldos}
          unidadPreseleccionada={unidadPreseleccionada}
          denominacion={denominacion}
          salidas={salidasDeCobros(barrio.id)}
        />
      )}
    </Pagina>
  );
}
