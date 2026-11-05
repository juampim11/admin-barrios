import { notFound, redirect } from "next/navigation";
import { esIdValido, rutaDeCuota } from "../../../../../rutas.ts";

/** T2, D4 (ADR-0011): la cuota fija vive en Configuración del barrio. El enlace viejo lleva ahí. */
export default async function ValorDeLaExpensa({ params }: { readonly params: Promise<{ readonly barrio: string }> }) {
  const { barrio } = await params;
  if (!esIdValido(barrio)) notFound();
  redirect(rutaDeCuota(barrio));
}
