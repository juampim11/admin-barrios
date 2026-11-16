import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { estadoDelMes } from "@admin-barrios/data/servicios/circuito-del-mes";
import { resultadoDelMes } from "@admin-barrios/data/servicios/presupuesto";
import { restarMontos } from "@admin-barrios/shared/dinero";
import { RenglonDelResultado, TarjetaDelResultado, TarjetasDelResultado } from "@admin-barrios/ui";
import { Nota, Pagina, Panel } from "../../../../../../componentes/ui.tsx";
import { esIdValido, rutasDeCobros, rutasDelPeriodo } from "../../../../../../rutas.ts";
import { conSesion } from "../../../../../../servidor/db.ts";
import { conSigno } from "../gastos/textos.ts";
import { EncabezadoDelMes, mesOno404 } from "../mes.tsx";
import { lecturaDeLaCuenta, lecturaDeLosPapeles, ORIGEN, quienesLoDeben, sobranteDelMes } from "./textos.ts";

export const metadata: Metadata = { title: "Resultado del mes" };

/**
 * **Resultado del mes** (encargo 16c; maqueta `devengado-conceptos.html`, pantalla 7): cómo cerró un
 * mes emitido. Lo que se pidió contra lo que se gastó («En los papeles»), la plata que entró contra la
 * que salió («En la cuenta») y lo que todavía se debe de las boletas del mes («Falta cobrar»).
 *
 * **Solo lectura y sin JavaScript.** No mueve plata: el sobrante de la cuenta se muestra en palabras, y
 * qué hacer con él (fondo de reserva, dejarlo, descontarlo del mes siguiente) todavía no se decide acá.
 *
 * Distinto de la maqueta, a propósito: «Falta cobrar» **no** es Devengado − Cobrado. Lo cobrado en el
 * mes incluye pagos de deuda de otros meses, y lo pedido en el mes se sigue pagando después: la resta
 * no dice lo que se debe. Es el capital pendiente hoy de las boletas de este mes, que da el servicio.
 */
export default async function ResultadoDelMesPagina({
  params,
}: {
  readonly params: Promise<{ readonly barrio: string; readonly periodo: string }>;
}) {
  const { barrio: barrioId, periodo: periodoId } = await params;
  if (!esIdValido(barrioId) || !esIdValido(periodoId)) notFound();
  const { periodo } = await mesOno404(barrioId, periodoId);
  const rutas = rutasDelPeriodo(barrioId, periodoId);

  // Un mes en preparación no tiene resultado: la pestaña no aparece, y si se llega por la URL se dice.
  if (estadoDelMes(periodo.estado) === "preparando") {
    return (
      <Pagina>
        <EncabezadoDelMes barrioId={barrioId} periodoId={periodoId} pestana="resultado" />
        <Nota tono="info" titulo="El resultado es de un mes emitido.">
          Cuando el mes se emita, acá se va a ver cómo cerró. Mientras tanto, lo que se va gastando está en{" "}
          <a href={rutas.gastos}>Gastos y pagos</a>.
        </Nota>
      </Pagina>
    );
  }

  const r = await conSesion((tx) => resultadoDelMes(tx, { periodoId }));
  const papeles = conSigno(r.enLosPapeles.diferencia);
  const cuenta = conSigno(r.enLaCuenta.diferencia);
  const menos = (monto: string) => conSigno(restarMontos("0.00", monto)).texto;
  const pesos = (monto: string) => conSigno(monto).texto;

  return (
    <Pagina>
      <EncabezadoDelMes barrioId={barrioId} periodoId={periodoId} pestana="resultado" />

      <TarjetasDelResultado etiqueta="Cómo cerró el mes">
        <TarjetaDelResultado
          titulo="En los papeles"
          resultado={papeles.texto}
          negativo={papeles.negativo}
          lectura={lecturaDeLosPapeles(r.enLosPapeles.diferencia)}
        >
          <RenglonDelResultado etiqueta="Devengado" valor={pesos(r.enLosPapeles.devengado)} origen={ORIGEN.devengado} />
          <RenglonDelResultado etiqueta="Gastado" valor={menos(r.enLosPapeles.gastado)} origen={ORIGEN.gastado} />
        </TarjetaDelResultado>

        <TarjetaDelResultado
          titulo="En la cuenta"
          resultado={cuenta.texto}
          negativo={cuenta.negativo}
          lectura={lecturaDeLaCuenta(r.enLaCuenta.diferencia)}
        >
          <RenglonDelResultado etiqueta="Cobrado" valor={pesos(r.enLaCuenta.cobrado)} origen={ORIGEN.cobrado} />
          <RenglonDelResultado etiqueta="Pagado" valor={menos(r.enLaCuenta.pagado)} origen={ORIGEN.pagado} />
        </TarjetaDelResultado>

        <TarjetaDelResultado
          titulo="Falta cobrar"
          resultado={pesos(r.faltaCobrar.monto)}
          lectura={
            <>
              <span>{ORIGEN.faltaCobrar}</span>
              <br />
              {quienesLoDeben(r.faltaCobrar.unidades)}
              {r.faltaCobrar.unidades > 0 ? (
                <>
                  {" · "}
                  <a href={rutasDeCobros(barrioId).grilla}>Ver en Cobros</a>
                </>
              ) : null}
            </>
          }
        />
      </TarjetasDelResultado>

      <Panel titulo="Sobrante del mes" origen="El que se puede usar es el de la cuenta: lo que entró menos lo que salió.">
        <p>{sobranteDelMes(r.periodo, r.enLaCuenta.diferencia)}</p>
      </Panel>
    </Pagina>
  );
}
