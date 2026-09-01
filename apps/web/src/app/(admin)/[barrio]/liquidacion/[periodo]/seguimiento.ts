"use client";

/**
 * El seguimiento de un trabajo encolado: el polling, su cadencia y su techo.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTO ES POLLING Y NO UNA CONEXIÓN ABIERTA
 *
 * Una conexión de tiempo real por administrador es un canal más que operar y que sobrevivir a un
 * balanceador, para un proceso que dura quince segundos y ocurre doce veces al año por barrio. La
 * regla §4 del presupuesto de recursos es explícita: tiempo real solo si el negocio lo exige.
 *
 * Y el polling **es espaciado**, no de dos segundos: 2 · 4 · 6 · 8 y de ahí cada 10, con techo de
 * cinco minutos. Una emisión típica son ~5 pedidos. Al terminar hace **un** `router.refresh()`, no
 * una cascada.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ VIVE ACÁ Y NO EN LA PANTALLA QUE LO ESTRENÓ
 *
 * Nació adentro de `documentos/generacion.tsx`, que era su único usuario. La pantalla de
 * distribución sigue **tres** trabajos a la vez, así que copiarlo habría dejado cuatro copias del
 * mismo backoff — y una cadencia que se afloja en un archivo y no en los otros tres es un pedido
 * cada dos segundos que después nadie sabe de dónde sale. Se extrajo sin cambiarle un número.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Trabajo } from "@admin-barrios/data/servicios/trabajos";

/** Los intervalos, en milisegundos. El último se repite hasta el techo. */
const ESPERAS = [2_000, 4_000, 6_000, 8_000, 10_000] as const;
/** Cinco minutos. Pasado esto, la pantalla deja de preguntar y ofrece recargar a mano. */
const TECHO_MS = 5 * 60_000;

export function terminado(t: Trabajo): boolean {
  return t.estado === "terminado" || t.estado === "fallado";
}

/**
 * **El tiempo transcurrido desde que el worker arrancó**, en `m:ss`. *(Pedido del usuario,
 * 2026-08-04: "podría mostrar también un contador para ir viendo el tiempo transcurrido".)*
 *
 * Sirve para lo que ninguna barra dice: **si está avanzando o si se colgó**. Una barra quieta en
 * 250 de 510 puede ser un lote pesado o un proceso muerto, y la diferencia entre las dos es cuánto
 * hace que no se mueve.
 *
 * `Date.now()` y no `new Date()`: esto es un **instante**, no una fecha de negocio, y la distinción
 * es la que hace la regla 7 del test de arquitectura. El arranque lo pone la base (`iniciadoAt`), no
 * el reloj del navegador — que puede estar corrido.
 */
export function useTranscurrido(desdeIso: string | null): string | null {
  const [ahora, setAhora] = useState(() => Date.now());

  useEffect(() => {
    if (!desdeIso) return;
    // Un intervalo de un segundo mientras hay algo corriendo. No pide nada al servidor: solo
    // repinta un contador, así que no toca el presupuesto de red del polling.
    const id = setInterval(() => setAhora(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [desdeIso]);

  if (!desdeIso) return null;
  const inicio = Date.parse(desdeIso);
  if (Number.isNaN(inicio)) return null;

  const segundos = Math.max(0, Math.floor((ahora - inicio) / 1_000));
  const minutos = Math.floor(segundos / 60);
  return `${minutos}:${String(segundos % 60).padStart(2, "0")}`;
}

/**
 * Sigue un trabajo hasta que termina.
 *
 * `trabajoInicial` es el que había al cargar la página; `encolado` es el que acaba de devolver la
 * acción, y cuando aparece reemplaza al anterior y reinicia el ciclo.
 */
export function useSeguimientoDeTrabajo(
  trabajoInicial: Trabajo | null,
  encolado: Trabajo | null,
): {
  readonly trabajo: Trabajo | null;
  readonly seRindio: boolean;
  readonly enCurso: boolean;
} {
  const router = useRouter();
  const [trabajo, setTrabajo] = useState<Trabajo | null>(trabajoInicial);
  const [seRindio, setSeRindio] = useState(false);
  const yaRefresco = useRef(false);

  useEffect(() => {
    if (encolado) {
      setTrabajo(encolado);
      setSeRindio(false);
      yaRefresco.current = false;
    }
  }, [encolado]);

  const seguir = useCallback(
    (id: string) => {
      let vivo = true;
      let vuelta = 0;
      const arranque = Date.now();

      async function preguntar(): Promise<void> {
        if (!vivo) return;
        if (Date.now() - arranque > TECHO_MS) {
          setSeRindio(true);
          return;
        }
        try {
          const respuesta = await fetch(`/api/trabajos/${id}`, { cache: "no-store" });
          if (respuesta.ok) {
            const nuevo = (await respuesta.json()) as Trabajo;
            if (!vivo) return;
            setTrabajo(nuevo);
            if (terminado(nuevo)) {
              // UNA vez, al final. Es lo que trae el estado ya escrito en la base.
              if (!yaRefresco.current) {
                yaRefresco.current = true;
                router.refresh();
              }
              return;
            }
          }
        } catch {
          // Un pedido que falla no corta el seguimiento: se reintenta en la próxima vuelta.
        }
        // `vuelta` se incrementa ANTES de leer la espera: si no, la segunda consulta repetía los 2 s
        // de la primera y el backoff real era 2 · 2 · 4 · 6 · 8 · 10, no el que dice el docstring.
        vuelta += 1;
        const espera = ESPERAS[Math.min(vuelta, ESPERAS.length - 1)] ?? 10_000;
        setTimeout(() => void preguntar(), espera);
      }

      setTimeout(() => void preguntar(), ESPERAS[0]);
      return () => {
        vivo = false;
      };
    },
    [router],
  );

  useEffect(() => {
    if (!trabajo || terminado(trabajo)) return;
    return seguir(trabajo.id);
    // Solo el id: si dependiera del objeto entero, cada respuesta del polling arrancaría otro ciclo.
  }, [trabajo?.id, seguir]); // eslint-disable-line react-hooks/exhaustive-deps

  return { trabajo, seRindio, enCurso: trabajo !== null && !terminado(trabajo) };
}
