import type { Metadata } from "next";
import type { ReactNode } from "react";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "admin-barrios", template: "%s · admin-barrios" },
  description: "Administración de barrios privados, consorcios y PH",
};

/*
 * **La tipografía del producto, servida por la aplicación.**
 *
 * `design-tokens` declara Geist desde el primer día (`font.sans`, `font.mono`), pero los archivos no
 * estaban en ninguna parte: la aplicación entera corría con la pila de reserva del sistema —Segoe UI
 * en Windows— y ninguna pantalla se veía como el sistema de diseño dice que se ve.
 *
 * Va con el paquete oficial: **los archivos viajan con la aplicación y no se pide nada a ningún CDN
 * en tiempo de ejecución**. Es la misma regla que ya cumple el PDF, que embebe sus fuentes y aborta
 * toda salida a la red — una pantalla que depende de un servidor ajeno para verse bien es una
 * pantalla que un día se ve mal, y encima en la máquina de otro.
 *
 * Las clases van en el `<html>` para que las variables existan también en los portales de Base UI,
 * que se montan fuera del `<body>` de la aplicación.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        {/*
          Primera parada del tabulador en toda la app: la tira de navegación del barrio tiene varios
          links y sin esto quien navega con teclado los recorre enteros en cada pantalla antes de
          llegar al contenido (doc 06 §f.4). Solo se ve al enfocarlo.
        */}
        <a href="#contenido" className="saltar">
          Saltar al contenido
        </a>
        {children}
      </body>
    </html>
  );
}
