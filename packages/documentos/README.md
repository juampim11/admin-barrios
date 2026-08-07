# `@admin-barrios/documentos`

Generación de documentos. Implementa **ADR-0001** (`docs/arquitectura/01-generacion-de-documentos.md`);
el diseño de la boleta es `docs/diseno/09-boleta-de-expensas.md` §E.

## La idea en una línea

El dominio produce un **modelo de vista puro** (`VistaBoleta`), la plantilla lo convierte en HTML, y
un motor detrás de una interfaz lo convierte en PDF. El dinero se verifica en el modelo de vista;
nunca sobre el PDF.

```
packages/shared/src/documentos/     ← VistaBoleta + BloquePago (puro, sin HTML ni PDF)
packages/documentos/src/
  ├── plantillas/boleta.ts          VistaBoleta → HTML   ← lo usan PDF, email y vista web
  ├── simbolos.ts                   InstrumentoPago → SVG, con las guardas de geometría (§7)
  ├── cobranza/                     puerto MedioCobranza + adapter `generico-demo`
  ├── emision.ts                    VistaBoleta → DocumentoSolicitado (fuerza la marca de agua)
  ├── generador.ts                  interfaz GeneradorDocumento
  └── adapters/chromium.ts          única implementación  ← SÓLO la importa el worker
```

## Reglas que este paquete hace cumplir

| Regla | Dónde vive | Test que la sostiene |
|---|---|---|
| **`apps/web` no puede importar el adapter de Chromium** | `exports` del `package.json` | `src/importaciones-web.test.ts` (camina el grafo entero, no los imports directos) |
| **El dinero cierra** (líneas = total del período; +saldo +interés = total a pagar; el cupón lleva el mismo importe que el titular) | `shared/documentos/vista-boleta.ts`, `superRefine` | `src/vista-boleta.test.ts` |
| **El texto impreso sale del monto** — cierra el bug de ICU (`Intl` degradando a formato en-US en un Node sin ICU completo) | `Cifra` / `FechaImpresa` (`shared/documentos/primitivas.ts`) | `shared/src/formato.test.ts` + humo del PDF |
| **Fondo blanco opaco en todo símbolo** — con fondo transparente el código **no se lee** | `simbolos.ts` (no hay parámetro para cambiarlo) | `src/simbolos.test.ts` |
| **Cantidad par de dígitos en Interleaved 2 of 5** — con impar la librería antepone un `0` en silencio y el símbolo codifica otro número que el impreso | `revisarCargaSimbolo()` | `test/codigo-de-barras.test.ts` (round-trip con lector real) |
| **X-dimension y zona muda en mm** — si no entra en el ancho útil, no se emite | `renderizarSimbolo()` | `src/simbolos.test.ts` |
| **Marca de agua `MUESTRA — SIN VALOR DE PAGO`** cuando el medio declara `sinValorDePago` | `emision.ts` la decide, `adapters/chromium.ts` la estampa sobre el DOM | `src/emision.test.ts` + humo del PDF |
| **Red apagada en el renderizador** — se aborta todo lo que no sea `data:` | `adapters/chromium.ts` | `test/humo-pdf.test.ts` |
| **Nada se pierde por desborde** — si una zona no entra, la emisión falla | `buscarDesbordes()` en el adapter | `test/humo-pdf.test.ts` |
| **Ninguna frase del lenguaje prohibido** (doc 07 §E) | `lenguaje-prohibido.ts` | `src/plantillas/boleta.test.ts`, `cobranza/generico-demo.test.ts` |

## Tests

```bash
pnpm test        # gate barato: modelo de vista, plantilla, símbolos, cobranza, regla de importación
pnpm test:pdf    # caro: round-trip del código de barras con lector real + humo del PDF con Chromium
```

`pnpm test:pdf` necesita `CHROME_PATH` (en CI, `ubuntu-latest` ya trae el navegador: cero descarga).
Sin Chromium, el humo del PDF se saltea y el round-trip del código de barras corre igual (es WASM).

## Demo

```bash
pnpm db:up && pnpm db:migrate && pnpm db:setup && pnpm db:seed
CHROME_PATH=... pnpm demo:boleta            # último período del barrio demo → tmp/boletas
CHROME_PATH=... pnpm demo:boleta -- --periodo 2026-06 --limite 3 --salida ./tmp/x
```

Medido en este entorno: **50 boletas en 8 s, una sola pasada** (161 ms por boleta con el navegador
frío incluido), ~120 KB por PDF.

## Lo que falta (§E que todavía no se cumple)

Ver la entrada del `HANDOFF.md` del 2026-07-26. En resumen: **el dorso** (página 2), la marca del
barrio y del emisor (no hay columnas), la fecha tope de la red, el renglón de bonificación **no**
aplicada, y las fuentes propias embebidas como `data:`.
