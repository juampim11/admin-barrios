import { notFound, redirect } from "next/navigation";
import { esIdValido, rutasDelPeriodo } from "../../../../../../../rutas.ts";

/** Encargo 16b: «Aplicar a una unidad» vive en «Conceptos del mes». El enlace viejo lleva ahí. */
export default async function NuevoCargo({
  params,
}: {
  readonly params: Promise<{ readonly barrio: string; readonly periodo: string }>;
}) {
  const { barrio, periodo } = await params;
  if (!esIdValido(barrio) || !esIdValido(periodo)) notFound();
  redirect(rutasDelPeriodo(barrio, periodo).aplicarConcepto);
}
