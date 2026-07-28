import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "admin-barrios", template: "%s · admin-barrios" },
  description: "Administración de barrios privados, consorcios y PH",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
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
