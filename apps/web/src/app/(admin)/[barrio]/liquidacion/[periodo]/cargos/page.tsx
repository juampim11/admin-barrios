import { notFound, redirect } from "next/navigation";
import { esIdValido, rutasDelPeriodo } from "../../../../../../rutas.ts";

/** Encargo 16b: «Cargos y descuentos» pasó a ser «Conceptos del mes». El enlace viejo lleva ahí. */
export default async function Cargos({
  params,
}: {
  readonly params: Promise<{ readonly barrio: string; readonly periodo: string }>;
}) {
  const { barrio, periodo } = await params;
  if (!esIdValido(barrio) || !esIdValido(periodo)) notFound();
  redirect(rutasDelPeriodo(barrio, periodo).conceptos);
}
