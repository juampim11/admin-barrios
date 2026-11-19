"use client";

/**
 * «Declarar caído» (P2a-1; maqueta de planes, pantalla 4). El desglose lo trae el servidor de
 * `simularCaida`: es la misma cuenta que hace la caída real, corrida y deshecha. Acá no se calcula nada.
 */

import { RenglonDelResultado, TarjetaDelResultado } from "@admin-barrios/ui";
import { DialogoDeConfirmacion } from "@admin-barrios/ui/cliente/dialogo-de-confirmacion";
import { formatearMonto, type Monto } from "@admin-barrios/shared/dinero";
import { declararCaidoAction } from "../../acciones/planes.ts";
import { AvisoDeFallo, Avisos, Campos, CampoParrafo, useFormulario } from "../formulario.tsx";

export type DesgloseDeLaCaida = {
  readonly deudaOriginal: Monto;
  readonly pagadoDelPlan: Monto;
  readonly cargo: Monto;
  readonly quedaDebiendo: Monto;
  /** «5 meses» y «junio a octubre 2026». */
  readonly meses: string;
  readonly rango: string;
  /** La fecha de firma, ya formateada. */
  readonly desde: string;
};

const pesos = (m: Monto) => `$ ${formatearMonto(m)}`;

export function DeclararCaido({
  planId,
  unidad,
  estudio,
  desglose,
}: {
  readonly planId: string;
  readonly unidad: string;
  /** El estudio al que se propone volver a derivarla (el del plan), si hay. */
  readonly estudio: string | null;
  /** null: todavía no se puede declarar caído (faltan cuotas impagas); el botón se ve apagado y el aviso dice cuántas faltan. */
  readonly desglose: DesgloseDeLaCaida | null;
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(declararCaidoAction);
  if (desglose === null) {
    return (
      <DialogoDeConfirmacion
        disparador="Declarar caído"
        varianteDisparador="peligro"
        etiquetaDisparador={`Declarar caído el plan de ${unidad}: todavía no se puede`}
        disparadorDeshabilitado
        titulo={`Declarar caído el plan de ${unidad}`}
        accion={enviar}
        textoConfirmar="Declarar caído"
        textoPendiente="Declarando…"
        pendiente={false}
        confirmarDeshabilitado
      >
        <p>Todavía no tiene las cuotas impagas que pide el barrio para que el plan caiga.</p>
      </DialogoDeConfirmacion>
    );
  }
  return (
    <DialogoDeConfirmacion
      disparador="Declarar caído"
      varianteDisparador="peligro"
      etiquetaDisparador={`Declarar caído el plan de ${unidad}`}
      titulo={`Declarar caído el plan de ${unidad}`}
      accion={enviar}
      textoConfirmar="Declarar caído"
      varianteConfirmar="peligro"
      textoPendiente="Declarando…"
      pendiente={pendiente}
      textoVolver="Cancelar"
      cerrarCon={resultado.estado === "ok" ? resultado : null}
    >
      <input type="hidden" name="planId" value={planId} />
      <TarjetaDelResultado
        titulo="Lo que queda debiendo"
        resultado={pesos(desglose.quedaDebiendo)}
        lectura="De los meses que entraron al plan, con la mora recalculada. Sale de la misma cuenta que hace la caída."
      >
        <RenglonDelResultado etiqueta={`Deuda original que vuelve (${desglose.meses})`} valor={pesos(desglose.deudaOriginal)} origen={desglose.rango} />
        <RenglonDelResultado etiqueta="Menos lo pagado del plan" valor={`− ${pesos(desglose.pagadoDelPlan)}`} />
        <RenglonDelResultado
          etiqueta={`Interés por mora de esos meses, del ${desglose.desde} a hoy`}
          valor={`+ ${pesos(desglose.cargo)}`}
          origen="Con la tasa del barrio, sobre el capital que sigue impago."
        />
      </TarjetaDelResultado>
      <p>
        Mientras el plan se cumplía, esos meses no generaban interés por mora. Como el plan cae, ese interés se cobra como si
        el plan no hubiera existido: desde el día del acuerdo hasta hoy, con la tasa del barrio. El acuerdo no reemplazó la
        deuda: vuelven los meses originales con su mora, menos lo pagado. La unidad vuelve a la lista de mora según el criterio
        del barrio{estudio ? `; si se la deriva otra vez, se propone ${estudio}` : ""}.
      </p>
      <Campos>
        <CampoParrafo
          nombre="nota"
          etiqueta="Nota"
          maximo={500}
          filas={2}
          valorInicial={previos["nota"]}
          errores={campos["nota"]}
          ayuda="Queda registrada en el plan. Opcional."
          ancho
        />
      </Campos>
      <Avisos>{resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}</Avisos>
    </DialogoDeConfirmacion>
  );
}
