"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Mientras un trabajo corre, vuelve a pedir la página: el progreso se ve solo. Con la pestaña oculta no
 * pide nada, la espera crece de 4 a 30 segundos y a los 15 minutos se detiene: si el worker se cayó, una
 * pestaña abierta no queda pidiendo para siempre (security-engineer, T2). Recargar la página lo retoma.
 */
export function RefrescarMientrasCorre({ activo }: { readonly activo: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!activo) return;
    const inicio = Date.now();
    let espera = 4000;
    let reloj: ReturnType<typeof setTimeout>;
    const tic = () => {
      if (Date.now() - inicio > 15 * 60 * 1000) return;
      if (document.visibilityState === "visible") router.refresh();
      espera = Math.min(espera * 1.5, 30_000);
      reloj = setTimeout(tic, espera);
    };
    reloj = setTimeout(tic, espera);
    return () => clearTimeout(reloj);
  }, [activo, router]);
  return null;
}
