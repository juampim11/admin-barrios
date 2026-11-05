"use client";

/**
 * Las islas de Envío (T2, D5): «Enviar N boletas» con su diálogo —la única acción explícita después
 * de emitir—, el botón para hacer a mano un paso de la cadena que no arrancó, y el refresco mientras
 * algo corre.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { armarPaqueteAction, distribuirAction, emitirInformeAction } from "../../../../../../acciones/distribucion.ts";
import { generarDocumentosAction } from "../../../../../../acciones/liquidacion.ts";
import { AvisoDeFalloCompacto, BotonEnviar, Formulario, useFormulario } from "../../../../../../componentes/formulario.tsx";
import { DialogoDeConfirmacion, DatoDeConsecuencia, ListaDeConsecuencias } from "@admin-barrios/ui/cliente/dialogo-de-confirmacion";
import { nombreDelPeriodo } from "@admin-barrios/shared/fechas";

/** Mientras un trabajo corre, vuelve a pedir la página cada 4 segundos: el progreso se ve solo. */
export function RefrescarMientrasCorre({ activo }: { readonly activo: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!activo) return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [activo, router]);
  return null;
}

const ACCIONES = {
  boletas: generarDocumentosAction,
  informe: emitirInformeAction,
  paquete: armarPaqueteAction,
} as const;

/** Un paso de la cadena que no arrancó solo: se encola a mano. */
export function EncolarAMano({
  periodoId,
  que,
  texto,
}: {
  readonly periodoId: string;
  readonly que: keyof typeof ACCIONES;
  readonly texto: string;
}) {
  const router = useRouter();
  const { enviar, pendiente, resultado } = useFormulario(ACCIONES[que]);
  useEffect(() => {
    if (resultado.estado === "ok") router.refresh();
  }, [resultado, router]);
  return (
    <Formulario accion={enviar} etiqueta={texto}>
      <input type="hidden" name="periodoId" value={periodoId} />
      <BotonEnviar pendiente={pendiente} cargando="Encolando…">
        {texto}
      </BotonEnviar>
      {resultado.estado === "falla" ? <AvisoDeFalloCompacto error={resultado.error} /> : null}
    </Formulario>
  );
}

/** «Enviar N boletas», con el diálogo de la maqueta. */
export function EnviarBoletas({
  periodoId,
  cantidad,
  sinMail,
  mes,
  listo,
}: {
  readonly periodoId: string;
  /** Las unidades con mail que reciben la boleta. */
  readonly cantidad: number;
  readonly sinMail: number;
  /** `YYYY-MM`. */
  readonly mes: string;
  /** Si ya están los PDF, el informe y el paquete: antes, la base no deja enviar. */
  readonly listo: boolean;
}) {
  const router = useRouter();
  const { enviar, pendiente, resultado } = useFormulario(distribuirAction);
  useEffect(() => {
    if (resultado.estado === "ok") router.refresh();
  }, [resultado, router]);
  const texto = `Enviar ${cantidad} ${cantidad === 1 ? "boleta" : "boletas"}`;
  if (!listo) return <span>Cuando estén los PDF, el informe y el paquete.</span>;
  if (resultado.estado === "ok") return <span>Enviando…</span>;

  return (
    <DialogoDeConfirmacion
      disparador={texto}
      varianteDisparador="primario"
      titulo={`Enviar las boletas de ${nombreDelPeriodo(mes).toLowerCase()}`}
      accion={enviar}
      textoVolver="Cancelar"
      textoConfirmar={texto}
      textoPendiente="Encolando…"
      pendiente={pendiente}
    >
      <input type="hidden" name="periodoId" value={periodoId} />
      <ListaDeConsecuencias>
        <li>
          Se mandan <DatoDeConsecuencia>{cantidad}</DatoDeConsecuencia> boletas por correo, a los mails de cada unidad que
          reciben la boleta.
        </li>
        {sinMail > 0 ? (
          <li>
            {sinMail} {sinMail === 1 ? "unidad no tiene" : "unidades no tienen"} mail: imprimilas o cargá el mail antes.
          </li>
        ) : null}
      </ListaDeConsecuencias>
      <div aria-live="polite">{resultado.estado === "falla" ? <AvisoDeFalloCompacto error={resultado.error} /> : null}</div>
    </DialogoDeConfirmacion>
  );
}
