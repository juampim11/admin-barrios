import { notFound, redirect } from "next/navigation";
import { abrirMesEnCurso } from "@admin-barrios/data/servicios/circuito-del-mes";
import { esIdValido, rutaDeMesesAnteriores, rutasDelPeriodo } from "../../../../rutas.ts";
import { conSesion } from "../../../../servidor/db.ts";

/**
 * **Liquidación lleva al mes en curso** (T2, ADR-0011). Si el barrio no tiene abierto el período del
 * mes, se abre al entrar —con el modelo y el vencimiento del barrio—, sin botón «Abrir período». Quien
 * no puede abrirlo (un rol de solo lectura) va a los meses anteriores.
 */
export default async function Liquidacion({ params }: { readonly params: Promise<{ readonly barrio: string }> }) {
  const { barrio: barrioId } = await params;
  if (!esIdValido(barrioId)) notFound();
  const mes = await conSesion((tx) => abrirMesEnCurso(tx, { barrioId }));
  redirect(mes ? rutasDelPeriodo(barrioId, mes.periodoId).resumen : rutaDeMesesAnteriores(barrioId));
}
