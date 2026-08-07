# ADR-0001 — Generación de documentos (PDF, email HTML y vista web)

**Estado:** Aceptado
**Fecha:** 2026-07-26
**Contexto de origen:** Fase 6C. Revisa y **reemplaza** la decisión de motor de `docs/diseno/07-liquidacion-pdf.md` §A
(que a su vez había reemplazado a `docs/diseno/03-modelo-datos.md` §C). El resto del doc 07 —estructura
del documento (§B), alcance del contenido (§C), respaldo (§D), lenguaje prohibido (§E) y los tres
controles de seguridad (§F)— **sigue vigente sin cambios**: son decisiones independientes del motor.

---

## 1. Contexto

Hay que emitir la **boleta de expensas** en PDF: una por unidad, cientos por período, en lote. Después
vienen la liquidación completa, el estado de cuenta y el certificado de deuda. **El mismo contenido
tiene que poder salir además como email HTML y como vista web** (y la vista web es, según el doc 07 §B,
el único camino accesible para lectores de pantalla: el PDF sale sin etiquetar).

Tres restricciones que no estaban sobre la mesa cuando se decidió el motor en el doc 07:

1. **`admin-barrios` es un producto para comercializar**, multi-cliente. Las Corzuelas es el primer
   piloto. La plantilla es **white-label**: logo, razón social, domicilio, acento y pie por
   administración y por barrio. Nada de "Las Corzuelas" en el código.
2. **El medio de cobranza no se puede hardcodear.** Hoy el piloto cobra por una red bancaria concreta;
   el próximo cliente va a usar otro banco, débito automático o una billetera. El bloque de pago
   (código de barras, código de pago electrónico, CBU/alias, QR, leyendas de la red) es **otra
   abstracción de portabilidad**, en la misma línea que `AuthProvider` y `ObjectStorage` del ADR-0000
   §3. La plantilla no puede saber qué red es.
3. **El objetivo inmediato es una demo de venta**, no la integración productiva. La especificación del
   convenio bancario se releva **después** del "sí". Entre dos motores, gana el que llegue antes a algo
   que se vea impecable, siempre que no nos deje encerrados después.

El ADR-0000 §7 fija la propiedad que no se negocia: el mismo diseño se despliega en AWS, en
Vercel+Supabase o self-hosted **cambiando sólo configuración**. Cualquier motor que le ponga un veto a
un proveedor está descartado.

---

## 2. Mediciones

> Regla madre de `docs/devops/03-reglas-desarrollo-optimizado.md` §0: **medir antes de optimizar**.
> Acá se midió antes de *decidir*, que es lo mismo un escalón más arriba.

**Entorno:** Windows 11, 8 vCPU, Node 24.14, `@react-pdf/renderer` 4.5.1, `pdfkit` 0.15, `pdf-lib` 1.17,
Chrome 150 (estable, no el *headless shell*), `bwip-js` 4.11, `zxing-wasm` 2. Boleta A4 real: cabecera, cupón, tabla de 13
líneas de 5 columnas, dos totales, notas, código de barras de 58 dígitos y pie. Dos familias
tipográficas TTF embebidas, dos pesos cada una. Los tiempos absolutos en un contenedor Linux van a
diferir; **lo que importa es el orden relativo**, que se sostuvo en todas las corridas.

### 2.1. Tiempo, memoria y peso

| Opción | ms por boleta (mediana) | 200 boletas, 1 proceso | RAM pico | Imagen Docker |
|---|---|---|---|---|
| `@react-pdf/renderer` (plantilla completa) | **385** (p95 767) | **85 s** | 330 MB | `node:22-alpine` **163 MB** |
| `@react-pdf/renderer` (plantilla reducida) | 200 (p95 250) | ~40 s | 330 MB | ídem |
| `pdfkit` imperativo, mismo contenido | 177 (p95 259) | 37 s | 369 MB | ídem |
| Chromium, **un PDF por vez** (`setContent` + `pdf()`) | 725 (p95 913) | 149 s | +345 MB en vacío | **897 MB** |
| **Chromium, lote en un solo pase + split con `pdf-lib`** | **39** | **14,4 s** (7,8 render + 6,6 split) | +780 MB (200) · **+520 MB (chunk de 50)** | **897 MB** |
| `@react-pdf/renderer` en 4 *worker threads* | — | 17,9 s | **3,2 GB** (787 MB × 4) | 163 MB |

Imágenes medidas con `docker images` sobre builds reales: `node:22-alpine` **163 MB**,
`node:22-bookworm-slim` **227 MB**, y `bookworm-slim + chromium + fonts-liberation`
(`apt --no-install-recommends`) **897 MB**. El delta real de Chromium es **+734 MB**, no los ~1,4 GB que
cita el doc 07 §A (esa cifra corresponde a la imagen oficial de Playwright con los tres navegadores).

### 2.2. Dónde se va el tiempo

Aislando en `pdfkit` el mismo documento con y sin fuentes propias:

| | mediana |
|---|---|
| Documento con las 14 fuentes base de PDF | **12,4 ms** |
| Mismo documento con 3 TTF embebidas | **78,9 ms** |

**~66 ms por documento son puro *subsetting* de fuentes**, y los pagan por igual `pdfkit` y
`@react-pdf/renderer` (comparten `fontkit`). Es un costo por-documento que no se amortiza: cada PDF
re-embebe sus fuentes. Chromium, en un lote de un solo pase, lo paga **una vez para las 200 páginas** —
de ahí el 39 ms contra 385 ms. El código de barras **no es el cuello**: `bwip-js` genera el SVG de 58
dígitos en **3,2 ms** (p95 5,2).

### 2.3. Las dos premisas del doc 07 §A que no se sostuvieron

| Lo que dice el doc 07 §A | Lo medido |
|---|---|
| "500 PDFs: ~20-30 s con `@react-pdf/renderer` vs ~60-90 s con Chromium" | **Al revés y por más margen.** `@react-pdf/renderer`: 500 → 100-190 s en un proceso. Chromium en lote: 500 → ~35 s en un proceso. Ninguno de los dos hace 500 en 20-30 s. |
| "Chromium suma ~1,4 GB … condicionaría de hecho la decisión de hosting" | Suma **+734 MB**, y **sólo a la imagen del worker**. La app Next sigue en `node:22-alpine` de 163 MB y se despliega donde sea, Vercel incluido. El veto sobre el hosting desaparece si el renderizador no vive en la imagen de la app — y el doc 07 §A **ya exigía** que el render corriera en un proceso aparte. |

Queda en pie, y se acepta, el tercer argumento del doc 07 §A: **Chromium renderizando texto cargado por
usuarios abre SSRF/exfiltración**. Se mitiga en §3.2 con una medida verificada, no con confianza.

Un cuarto punto, que no estaba: **ninguno de los dos motores entra en una función serverless.** 200
boletas son 14 s (Chromium en lote) o 40-85 s (`@react-pdf/renderer`) de cómputo continuo. El techo de
una función de Vercel es 60 s en el plan base. La emisión necesita un worker con cualquiera de los dos
motores, así que "se despliega sin contenedor" nunca fue una ventaja real de `@react-pdf/renderer`.

---

## 3. Decisión — el motor: HTML + CSS renderizado por Chromium, en imagen aparte

**Decidido: una plantilla HTML/CSS por documento, renderizada a PDF por Chromium headless, ejecutando
en el worker (imagen propia), detrás de la interfaz `GeneradorDocumento` (§4.2).**

Fundamento, en orden de peso:

1. **Una sola plantilla para PDF, email HTML y vista web.** Es un requisito explícito del alcance, no
   una comodidad. El doc 07 §A lo descartó con "el reuso de *markup* es marginal" — era razonable
   cuando el destinatario era un único barrio con un único bloque de pago. Con **white-label por
   cliente**, **bloque de pago variable por barrio** y la **vista web como único camino accesible**, el
   mismo markup se necesita genuinamente en tres lugares. Mantener dos renderizaciones divergentes del
   mismo documento es la clase de deuda que se paga todos los meses.
2. **Fidelidad visual, que es el criterio de la demo.** Grid, `font-variant-numeric: tabular-nums`,
   `@page`, control tipográfico fino, `hsl()` moderno. El §B del doc 07 es, leído de cerca, una lista de
   *workarounds* para las limitaciones de `@react-pdf/renderer`: sin grid, sin `font-variant-numeric`,
   sin motor de notas al pie, `hyphenation` propia, TTF estáticas vendorizadas con checksum porque el
   motor no soporta ejes variables y **degrada a la fuente por defecto en silencio**, y
   `acentoBarrioHex()` porque no parsea la sintaxis `hsl()` que ya devuelve `barrio-accent.ts`. Cada uno
   es tiempo antes de que algo se vea impecable.
3. **Es más rápido en lote**, que es la única forma en que se emite (§2.1): 14,4 s contra 85 s para 200,
   en un solo proceso y sin *pool*.
4. **Desaparece la necesidad de *worker threads* con timeout artificial.** El doc 07 §A los exigía
   porque `@react-pdf/renderer` es síncrono y "un `Promise.race` no dispararía nunca". Chromium
   renderiza **fuera del proceso Node**: el timeout es un `Promise.race` que sí funciona y el escape es
   cerrar la página. Una pieza menos.
5. **No hay encierro.** Chromium no es un SDK propietario: no toca la regla dura del ADR-0000 §3. El
   único costo de portabilidad es el peso de **una** imagen, y §3.3 deja el plan B con su gatillo
   escrito.

**Dónde vive cada cosa** (el punto que hace que la decisión no contamine el resto):

```
packages/shared/src/documentos/vista-boleta.ts   ← view model + Zod (puro, sin HTML ni PDF)
packages/documentos/
  ├── plantillas/boleta.ts        VistaBoleta → HTML   ← la usan PDF, email y vista web
  ├── simbolos.ts                 InstrumentoPago → SVG, con las guardas de geometría (§7)
  ├── generador.ts                interfaz GeneradorDocumento
  └── adapters/chromium.ts        única implementación por ahora  ← SÓLO la importa el worker
apps/worker/                       job-runner + imagen con Chromium
```

> **Regla de importación, verificable en CI:** `apps/web` puede importar `plantillas/` y `simbolos.ts`;
> **no puede importar `adapters/chromium.ts`**. Si Chromium entra al bundle de Next, la imagen de la app
> se infla y volvemos al problema que este ADR evita. Se chequea con un test que falla si
> `puppeteer-core` aparece en el grafo de dependencias de `apps/web`.

### 3.1. Chromium sí, Playwright no

Se usa **`puppeteer-core` contra un Chromium instalado por el gestor de paquetes de la imagen**, no
Playwright ni `puppeteer` completo. Playwright trae los tres navegadores y su imagen oficial es la que
justifica la cifra de 1,4 GB; acá alcanza con uno solo y ya presente en el sistema. `puppeteer-core` no
descarga nada (12 MB en `node_modules`) y en GitHub Actions usa el Chrome que `ubuntu-latest` ya trae:
**cero descarga en CI**.

### 3.2. Lo que se pierde, y cómo se acota

| Costo | Medida concreta |
|---|---|
| **SSRF / exfiltración** desde texto cargado por el administrador (`<img src="http://169.254.169.254/…">`) | **Red apagada en el renderizador.** Se activa intercepción de requests y se **aborta todo** lo que no sea `data:` o `about:blank`. Verificado en la corrida de 200 boletas: **0 requests salieron**. Nada de fuentes remotas, hojas de estilo externas ni imágenes por URL: las fuentes se embeben con `@font-face` en `data:` y los logos se traen de `ObjectStorage` y se inyectan como `data:` **antes** de render. Se suma escapado estricto de todo campo de origen humano. |
| **+734 MB de imagen** | Confinados al worker. La app Next sigue en `node:22-alpine` (163 MB). La imagen del worker no se despliega en cada push de UI. |
| **RAM del navegador** | Chunk de **50 boletas por pase**: techo medido **~520 MB** contra ~780 MB con 200. Contenedor de 1 vCPU / 1 GB. |
| **Operación de Chromium en contenedor** (fuentes ausentes, zombies, `/dev/shm`) | `--no-sandbox --disable-dev-shm-usage --disable-gpu`, `fonts-liberation` en la imagen, navegador **efímero por job** (se abre y se cierra), y un `pnpm test:pdf` en CI que renderiza contra la misma imagen. |
| **PDF sin etiquetar** (accesibilidad) | Igual que con cualquier motor evaluado. No se declara AA sobre el PDF: el camino accesible es la vista web de la misma plantilla — que con esta decisión **existe gratis**. |

### 3.3. Plan B, con gatillo escrito

Si el hosting elegido **no admite un contenedor propio para el worker** (serverless puro y nada más), o
si el techo de memoria del entorno queda por debajo de 512 MB, se cambia el adapter:

- **Plan B: `@react-pdf/renderer` detrás de la misma interfaz `GeneradorDocumento`.**
- **Qué se pierde, medido:** el lote pasa de 14 s a ~85 s en un proceso (o ~18 s con 4 workers y 3,2 GB
  de RAM total); se cae el reuso de markup con email y vista web (hay que mantener **dos** plantillas
  del mismo documento); se pierden grid, `font-variant-numeric`, `hsl()` y el motor de notas; y vuelven
  las TTF estáticas vendorizadas con checksum.
- **Qué NO se pierde:** el `VistaDocumento` (§4.1) es el contrato compartido. El email y la vista web
  siguen saliendo del mismo view model; lo que se duplica es el markup, no los datos ni las reglas.
  Ningún número de dinero cambia de lugar.

Este ADR **no** manda implementar los dos adapters. Uno solo, y la interfaz que permite el otro.

---

## 4. Decisión — las abstracciones

Cuatro piezas, en la línea de `AuthProvider` / `ObjectStorage` del ADR-0000 §3. Todas ilustrativas: el
contrato, no la implementación.

### 4.1. `VistaDocumento` — el view model es la pieza que sobrevive a todo

El dominio **no produce HTML ni PDF**: produce un objeto plano, validado con Zod, con **todo ya
resuelto y formateado**.

```ts
// packages/shared/src/documentos/vista-boleta.ts — ilustrativo
export interface VistaBoleta {
  readonly version: string;            // "boleta/1" — viaja con el documento guardado (§6)
  readonly marca: MarcaDocumento;      // white-label (§4.3)
  readonly barrio: { nombre: string; figuraJuridica: FiguraJuridica; domicilio: string };
  readonly unidad: { etiqueta: string; destinatario: string };  // sólo el mínimo (doc 07 §F)
  readonly periodo: { etiqueta: string; desde: string; hasta: string };
  readonly lineas: ReadonlyArray<{
    concepto: string; clase: ClaseItem; clasificacion2048: Clasificacion2048;
    gastoDelPeriodo: string | null;    // ya formateado en es-AR
    coeficiente: string | null; importe: string; marcadorNota: number | null;
  }>;
  readonly totales: { delPeriodo: string; saldoAnterior: string; interes: string; aPagar: string };
  readonly interes: { base: string; tasa: string; dias: number; computadoHasta: string } | null;
  readonly bloquePago: BloquePago;     // (§4.4) — la plantilla no sabe de qué red salió
  readonly notas: readonly string[];
  readonly leyendas: readonly string[];
}
```

Tres propiedades que hacen que esto sea el centro y no un detalle:

- **Todo el dinero se formatea en Node con el helper compartido, nunca en la plantilla.** Node slim sin
  ICU completo degrada `Intl.NumberFormat("es-AR")` a formato en-US **en silencio** (doc 07 §A). Un
  total que en pantalla dice `359.000,00` y en el PDF dice `359,000.00` es un bug de dinero invisible en
  desarrollo. Con el formateo en un solo lugar, el test compara **la misma cadena** en los tres
  destinos.
- **El mismo view model alimenta PDF, email HTML y vista web.** Es lo que garantiza que los tres digan
  lo mismo, con o sin Chromium.
- **Se congela junto con el documento** (§6): es lo que permite explicar una boleta emitida hace un año
  sin volver a correr la liquidación.

### 4.2. `GeneradorDocumento` — el motor detrás de una interfaz

```ts
// packages/documentos/generador.ts — ilustrativo
export interface DocumentoSolicitado {
  readonly html: string;                    // salida de la plantilla
  readonly formato: "A4";
  readonly margenesMm: { top: number; right: number; bottom: number; left: number };
}

export interface GeneradorDocumento {
  readonly motor: string;                   // "chromium/150" — se persiste con el documento (§6)
  /** Un documento. */
  generar(doc: DocumentoSolicitado, opciones: { timeoutMs: number }): Promise<Buffer>;
  /** Un lote: una sola pasada del motor, un PDF por elemento de entrada, en el mismo orden. */
  generarLote(docs: readonly DocumentoSolicitado[], opciones: { timeoutMs: number; chunk: number }): Promise<Buffer[]>;
}
```

`generarLote` **está en la interfaz a propósito**: es donde vive la diferencia de 6× medida en §2.1, y un
adapter que no sepa lotear (Plan B) lo implementa como un `for` sin que el llamador cambie. El adapter
Chromium arma un HTML con `page-break-after: always` por documento, renderiza una vez y parte el
resultado con `pdf-lib` (33 ms por boleta, medido).

### 4.3. `MarcaDocumento` — white-label, sin nombres propios en el código

```ts
// Ilustrativo. Sale de la base: administración → barrio, el segundo pisa al primero.
export interface MarcaDocumento {
  readonly razonSocial: string;
  readonly domicilio: string;
  readonly cuit: string | null;
  readonly logo: { dataUri: string; altoMm: number } | null;   // resuelto desde ObjectStorage antes de render
  readonly acentoHex: string;                                   // #rrggbb, ya convertido desde tokens
  readonly pie: readonly string[];                              // leyendas propias de la administración
}
```

`packages/design-tokens` sigue siendo la fuente de verdad de la tipografía, la escala y el esquema
`print`; la **marca** es lo que varía por cliente sobre esos tokens. Ninguna cadena de un cliente
concreto vive en el repo: todas vienen de la base, y el seed de demo las carga con datos de un barrio
ficticio.

### 4.4. `MedioCobranza` — el bloque de pago, enchufable por barrio

La pieza nueva. La plantilla **no sabe** que existe una red de cobranza determinada: recibe un
descriptor y lo pinta.

```ts
// packages/cobranza/medio-cobranza.ts — ilustrativo
export type InstrumentoPago =
  | { tipo: "simbolo"; etiqueta: string;
      simbologia: "interleaved2of5" | "code128" | "qrcode";
      carga: string;              // lo que se codifica
      leible: string;             // lo que se imprime debajo, para el humano y el cajero
      anchoModuloMm: number;      // X-dimension — se valida contra un piso duro (§7)
      zonaMudaModulos: number }
  | { tipo: "texto"; etiqueta: string; valor: string };   // CBU, alias, código electrónico

export interface BloquePago {
  readonly medio: string;                         // clave del adapter, se persiste (§6)
  readonly instrumentos: readonly InstrumentoPago[];
  readonly fechas: { vencimiento: string; tope: string | null };
  readonly importes: { alVencimiento: string; alTope: string | null };
  readonly leyendas: readonly string[];           // pasan por la lista prohibida del doc 07 §E
  readonly logos: readonly string[];              // claves de ObjectStorage, resueltas a data: antes de render
  readonly sinValorDePago: boolean;               // true ⇒ marca de agua obligatoria (§10)
}

export interface MedioCobranza {
  readonly clave: string;                         // "generico-demo", "<banco>-<convenio>", "debito-cbu"
  /** Puro: no toca red ni base. Todo lo que necesita viene en la entrada. */
  armarBloquePago(entrada: EntradaBloquePago): BloquePago;
  /** Verificación estructural propia del adapter. Se corre ANTES de emitir. */
  verificar(bloque: BloquePago): ResultadoVerificacion;   // { ok } | { ok: false; motivos: string[] }
}

export interface RegistroMediosCobranza {
  resolver(claveBarrio: string): MedioCobranza;   // barrio.medio_cobranza_clave → adapter
}
```

**El corte de responsabilidades es lo que hace que esto escale a N clientes:**

- El **adapter** decide **simbología, carga y dígito verificador** — todo lo que depende del convenio.
- El **renderizador** (`simbolos.ts`) decide **geometría** — ancho de módulo, zona muda, fondo,
  proporción. Las guardas de §7 viven acá, así que **todo adapter futuro las hereda gratis**.
- La **plantilla** recorre `instrumentos` y pinta. No tiene un `if` por banco. Nunca.

Un cliente nuevo = un archivo en `packages/cobranza/adapters/` + una fila en el barrio. Cero cambios en
la plantilla, en el generador y en el worker.

---

## 5. Dónde corre: en el job-runner, nunca en el request

**La emisión es un job.** No admite discusión con los números de §2: 200 boletas son 14 s de cómputo
continuo y ~520 MB. Un request HTTP que haga eso viola la regla de
`03-reglas-desarrollo-optimizado.md` §2 ("¿función pesada? → ¿corre en job con presupuesto de tiempo, no
en cada request?") y no entra en el techo de una función serverless.

```ts
// Ilustrativo — el disparador es intercambiable (ADR-0000 §4 y §7)
export interface EncoladorTrabajos {
  encolar(t: { tipo: "emitir_periodo"; barrioId: string; periodoId: string; solicitadoPor: string }): Promise<string>;
  estado(trabajoId: string): Promise<EstadoTrabajo>;
}
```

Reglas de ejecución, alineadas con doc 07 §F.1 y con las reglas de recursos:

1. **Disparo por evento, jamás por cron.** El administrador aprieta "emitir". Un cron ancho correría en
   vacío 364 días (`03-reglas-desarrollo-optimizado.md` §5).
2. **El `barrio_id` nunca viaja en el request:** se deriva del `periodo_id` **bajo RLS antes de
   encolar**, queda fijado en la fila del trabajo, y el job corre con la **conexión de request y la
   identidad del usuario**, no con la conexión de jobs (doc 07 §F.1). Antes de cada escritura se
   verifica que la clave de storage empiece por `barrios/{barrioFijado}/`.
3. **Idempotencia:** único trabajo pendiente por `(periodo_id, tipo)`. Un reintento **no** duplica
   documentos: cada boleta se escribe una sola vez por corrida, y el período no pasa a `distribuida` si
   `archivos ≠ count(liquidacion)`.
4. **Chunk de 50 y timeout duro por chunk.** Con Chromium el timeout funciona de verdad (§3, punto 4):
   se cierra la página y el job falla con el detalle, sin dejar el proceso colgado.
5. **La UI hace polling espaciado y refresca al final**, no cada dos segundos
   (`03-reglas-desarrollo-optimizado.md` §4).
6. **Guard de early-exit barato**: si el período ya tiene todos sus documentos, el job retorna sin
   escanear nada.

Vista previa de **una** boleta desde la UI: eso sí puede ir por request (39 ms en lote, ~725 ms si es un
render suelto con navegador frío). Se sirve desde el mismo worker vía el mismo `GeneradorDocumento`, con
navegador ya caliente, y con un techo de una boleta por request.

---

## 6. Dónde se guarda el PDF emitido: **se persiste, no se regenera**

**Decisión: el PDF emitido se guarda en `ObjectStorage` y nunca se vuelve a generar para reimprimirlo.**

El argumento no es de performance, es de correctitud. La base ya congela lo que *sabe* congelar: un
período `emitida` no se edita, y la liquidación guarda snapshots del catálogo, del coeficiente, de la
cuota fija y de la clasificación fiscal. Pero el documento depende **además** de cosas que la
liquidación no snapshotea:

| Depende de… | ¿Está congelado hoy? |
|---|---|
| Catálogo de conceptos, coeficientes, cuota fija, clasificación | **Sí** (snapshots en la liquidación) |
| **Plantilla** (versión del markup y del layout) | No |
| **Fuentes** — un cambio de fuente **reflowea** el documento | No |
| **Marca**: logo, razón social, domicilio, acento del barrio | No — se edita en cualquier momento |
| **Bloque de pago**: convenio, leyendas de la red, medio configurado | No — el barrio puede cambiar de banco |
| **Motor** — una versión distinta de Chromium mide el texto distinto | No |

Regenerar produce **un documento distinto del que se envió**. Y lo que un vecino reclama, o lo que un
profesional revisa, es el papel que recibió.

**Cómo se guarda** (extiende doc 07 §F.3, sin cambiarlo):

```
barrios/{barrio_id}/periodos/{periodo_id}/liquidaciones/{liquidacion_id}/{token}.pdf
```

y una fila **append-only** por documento:

```sql
-- Ilustrativo (packages/data/migrations/NNNN_documentos.sql)
create table documento_liquidacion (
  id              uuid primary key default gen_random_uuid(),
  barrio_id       uuid not null references barrio(id),      -- redundante a propósito: RLS y verificación por archivo
  liquidacion_id  uuid not null references liquidacion(id),
  storage_key     text not null unique,
  sha256          char(64) not null,
  bytes           integer not null,
  vista           jsonb  not null,        -- el VistaBoleta congelado (§4.1)
  vista_version   text   not null,        -- "boleta/1"
  motor           text   not null,        -- "chromium/150"
  plantilla_hash  char(64) not null,      -- hash del módulo de plantilla usado
  medio_cobranza  text   not null,        -- clave del adapter (§4.4)
  emitido_at      timestamptz not null default now(),
  emitido_por     uuid not null           -- lo escribe la base con app.current_user_id(), no la app
);
-- Sin UPDATE ni DELETE para el rol de request (misma convención que 0013_seguridad_periodo.sql).
```

- **`vista jsonb` es la pieza que más rinde por su peso** (unos pocos KB): permite explicar, auditar y
  *diffear* un documento emitido sin volver a correr la liquidación, y es contra lo que se compara en
  los tests (§8) en vez de contra bytes de PDF.
- **Reimprimir ≠ regenerar.** Reimprimir es servir el objeto guardado con una URL firmada corta.
  Regenerar es un **documento nuevo**, con `{token}` nuevo, fila nueva y su propio hash: nunca pisa al
  anterior, y la URL emitida ayer sigue apuntando al PDF que se auditó ayer (doc 07 §F).
- **Retención:** default **no purgar nunca** (`retencion_meses` por barrio, doc 07 §G.2). El corte real
  no es borrar archivos: es dejar de emitir URLs.

**Costo de almacenamiento, con números:** 73 KB por boleta (medido). Un barrio de 200 unidades =
**14,6 MB por período**, **175 MB al año**. Diez barrios así ≈ **1,8 GB al año**. Entra sin discusión en
cualquier presupuesto de storage; no hay ningún caso para regenerar y ahorrar bytes.

---

## 7. El bloque de pago y el código de barras

**Se genera del lado del servidor, como SVG vectorial embebido en el HTML** (`bwip-js`, 3,2 ms medidos).
SVG y no imagen: es nítido a cualquier DPI de impresora, no agrega un request de red (§3.2) y el ancho se
declara **en milímetros**, que es la unidad en la que un lector láser falla o no falla.

### 7.1. Tres fallas silenciosas medidas en este entorno

Ninguna de las tres tira un error. Las tres terminan en un vecino que no puede pagar en la caja.

| Falla | Qué se midió | Guarda |
|---|---|---|
| **Fondo transparente** | El default de `bwip-js` es fondo transparente. El mismo símbolo de 58 dígitos, con zona muda amplia y escala correcta: **con fondo transparente NO SE LEE; con `#FFFFFF` lee perfecto.** | El renderizador **fuerza fondo blanco opaco**. No es un parámetro de la plantilla. |
| **Cantidad impar de dígitos en Interleaved 2 of 5** | I2of5 codifica de a pares. Con 55 dígitos `bwip-js` **genera sin error** y **antepone un `0` en silencio**: se pidió `3450012…7890` (55) y el lector devolvió `03450012…7890` (56). **El símbolo codifica un número distinto del que está impreso debajo.** | Validación de longitud y **paridad** en `verificar()` del adapter, y round-trip obligatorio (§7.2). |
| **Escalado de impresión** | Un símbolo correcto reducido por el "ajustar a página" del diálogo de impresión deja de leerse. | El SVG declara ancho en **mm fijos**; el renderizador valida un **piso de X-dimension** (`anchoModuloMm`) y una **zona muda mínima**, y falla la emisión si no entran en el ancho útil. |

### 7.2. Cómo se verifica, en tres compuertas

1. **Compuerta de construcción — `MedioCobranza.verificar()`.** Zod sobre la carga: longitud, alfabeto
   permitido, paridad, dígito verificador del convenio, y que `leible` sea exactamente lo que se
   codifica. Si falla, **la emisión de esa unidad se bloquea**; no sale un documento con un instrumento
   dudoso.
2. **Compuerta de render — round-trip real, verificado.** Se rasteriza el **mismo descriptor** con
   `bwip-js.toBuffer()` (fondo blanco forzado) y se **decodifica con un lector de verdad**
   (`zxing-wasm`, el binding de ZXing-C++). Se afirma `decodificado === carga` **y**
   `decodificado === leible`. Comprobado en este entorno: Code 128, Interleaved 2 of 5 de 58 dígitos y
   QR de pago **decodifican correctamente**, y el mismo test **atrapa** las dos fallas silenciosas de
   §7.1. Costo: ~45 ms por símbolo. Corre **en CI sobre un fixture por adapter**, y **una vez por lote**
   como canario sobre la primera boleta — no por boleta.
3. **Compuerta física — una vez por convenio y por cliente, sin excepción.** Imprimir en papel **al
   100 %** (sin "ajustar a página"), pasar por un lector real, y cruzar contra el archivo de prueba del
   banco. Lo firma la administración. **Ningún test automatizado reemplaza esta compuerta**, y este ADR
   no pretende que lo haga: el modo de falla vive en la caja de un Rapipago, no en el repositorio.

---

## 8. Cómo se testea, sin volverlo frágil

Regla que ordena todo lo demás: **la correctitud del dinero y del texto legal nunca depende de un
diff de píxeles.** Cinco capas, de la más barata y estable a la más cara y frágil.

| Capa | Qué afirma | Dónde corre |
|---|---|---|
| **1. View model** (puro) | Los números. Que `gastoDelPeriodo × coeficiente = importe`, que los dos totales cierran, que el resto del prorrateo no se acumula, que el interés declara base, tasa, días y hasta qué fecha. **Acá se testea el dinero, no en el PDF.** | proyecto `unit` (ya existe) |
| **2. Plantilla → HTML** | Estructura, no apariencia: que estén todos los campos obligatorios; que **no se omita** saldo anterior, interés ni total aunque valgan cero (doc 07 §B); que **ninguna frase de la lista prohibida** del doc 07 §E aparezca; que **no haya ninguna URL externa** en el markup (guarda anti-SSRF de §3.2); que las cadenas de dinero sean idénticas a las del view model. | proyecto `unit` |
| **3. Bloque de pago** | Round-trip de §7.2 + geometría (X-dimension y zona muda en mm) + `verificar()` del adapter contra fixtures válidos e **inválidos** (el test importante es el que **debe** fallar). | proyecto `pdf` |
| **4. Humo de PDF** (~pocos segundos) | Que el artefacto existe y es sano: cabecera `%PDF-`, cantidad de páginas esperada, fuentes embebidas presentes, y **el texto extraído contiene el total formateado exactamente igual que en el view model** — que es el que atrapa el bug de ICU/`Intl`. Extracción con **`unpdf`**, la librería que el ADR-0000 §4 ya bendijo. | proyecto `pdf` |
| **5. Regresión visual** | **Una** página dorada por plantilla, con datos fijos, rasterizada y comparada con tolerancia. **No bloqueante**: informa, no frena el merge. Se actualiza a mano cuando el diseño cambia a propósito. | job aparte |

**Lo que nunca se hace:** afirmar sobre los **bytes** del PDF ni sobre su hash en un test. Un PDF trae
fecha de creación e identificadores propios: el hash cambia en cada corrida. El `sha256` de §6 es para
**auditar lo que se emitió**, no para comparar en un test.

**En CI:** se agrega un tercer proyecto de Vitest, `pdf`, junto a `unit` y `db`. `pnpm test` (el gate
barato) **no lo incluye**, así que el ciclo normal no paga Chromium. En `ubuntu-latest` el navegador ya
viene instalado: `puppeteer-core` + `CHROME_PATH`, **cero descarga**. El paso nuevo del workflow corre
después de "Tests puros" y antes de las migraciones.

---

## 9. Encaje con el presupuesto de recursos

| Recurso | Impacto medido | Cómo queda acotado |
|---|---|---|
| Cómputo | 14,4 s por barrio de 200 unidades, **una vez por período** (12 al año por barrio) | Job por evento, nunca cron |
| Memoria | ~520 MB de pico con chunk de 50 | Worker de 1 vCPU / 1 GB; el chunk es el dial |
| Imagen | +734 MB, **sólo el worker** | La app Next sigue en 163 MB; el worker se redeploya poco |
| Storage | 73 KB por boleta → ~1,8 GB/año con 10 barrios de 200 unidades | `retencion_meses`, default no purgar |
| Egress | Una URL firmada por descarga, TTL ≤ 10 min, `no-store` | doc 07 §F.2 |
| Base | El job escribe una fila por documento; cero lecturas anchas | El view model se arma con las queries ya existentes de la liquidación |
| CI | Chromium ya instalado en el runner; proyecto `pdf` fuera del gate barato | Cero descarga |

---

## 10. Alcance de la demo, y qué falta para producción

Para la demo se implementa **un solo adapter de `MedioCobranza`: `generico-demo`.** Nada específico de
una red concreta.

**Qué incluye:** un código de barras que **renderiza de verdad y un lector decodifica** (simbología real,
número bien formado, dígito verificador propio y consistente), un código de pago electrónico, CBU y
alias, y un QR. Sobre un convenio ficticio.

**Salvaguarda obligatoria, no opcional:** cuando el medio resuelto es `generico-demo`, `sinValorDePago`
es `true` y **el renderizador estampa la marca de agua `MUESTRA — SIN VALOR DE PAGO`**. Un documento
con un código de barras legible y un importe se parece demasiado a un instrumento de pago real como para
que esa marca dependa de que alguien se acuerde de activarla. Vive en el renderizador, no en la
plantilla ni en una opción de configuración.

**Lo que queda pendiente para producción, y que la demo no demuestra:**

1. **Especificación del convenio bancario** del cliente: layout exacto de la carga, simbología que exige
   la red, ancho de módulo y zona muda mínimos que homologa.
2. **Dígito verificador real** del convenio (el de la demo es propio y no vale para ninguna red).
3. **Quién asigna el número de boleta**: si lo emite nuestro sistema contra el convenio o lo devuelve el
   banco. De eso depende si emitimos el instrumento o sólo lo imprimimos (pregunta ya abierta en
   `docs/diseno/09-boleta-de-expensas.md`).
4. **Archivo de novedades / rendición** hacia la red: formato, canal y frecuencia.
5. **Conciliación** del archivo de cobranzas contra las liquidaciones — se apoya en el motor que el doc
   `docs/diseno/02-reuso-conciliacion.md` ya prevé reusar del sistema de gas.
6. **Compuerta física firmada** (§7.2, punto 3) antes de la primera emisión real.

Hasta que esos seis puntos estén cerrados, **lo emitido es una muestra**. Que se vea impecable no lo
convierte en un instrumento de pago.

---

## 11. Consecuencias

- Aparece un **worker con imagen propia** (`apps/worker`): una unidad de despliegue más, con su
  Dockerfile, su entrada en `docker-compose.yml` y su lugar en el pipeline. Es el costo real de esta
  decisión, y es lo que a cambio deja la app Next liviana y desplegable en cualquiera de las tres
  columnas del ADR-0000 §7.
- **Una sola plantilla** por documento sirve al PDF, al email y a la vista web. También quiere decir que
  un cambio de markup los toca a los tres: la capa 2 de los tests (§8) es la que evita que eso duela.
- **Chromium hay que operarlo**: fuentes en la imagen, `--no-sandbox`, `/dev/shm`, procesos que hay que
  cerrar. Está acotado a un adapter de ~150 líneas y a la imagen del worker.
- **Se revierte la decisión de motor del doc 07 §A.** Todo lo demás de ese documento sigue vigente y no
  se toca. `docs/diseno/07-liquidacion-pdf.md` §A y `docs/diseno/03-modelo-datos.md` §C quedan
  **desactualizados** y hay que sincronizarlos apuntando acá (tarea de `documentador`; no se editan en
  este ADR para no pisar trabajo en curso sobre `docs/diseno/`).
- Aparecen dos paquetes nuevos (`packages/documentos`, `packages/cobranza`) y un módulo de view models
  en `packages/shared`. La regla de importación de §3 (la web no importa el adapter) hay que
  **verificarla en CI**, porque es fácil de romper sin darse cuenta.
- El `sha256` + el `vista jsonb` por documento hacen que cada boleta emitida sea **explicable y
  auditable años después** sin volver a correr nada.

---

## 12. Alternativas consideradas

### 12.1. `@react-pdf/renderer` (la decisión previa del doc 07 §A)

Descartada como motor principal, **conservada como plan B con gatillo escrito** (§3.3). Sus dos
argumentos decisivos no sobrevivieron a la medición (§2.3): es **más lento** que Chromium en lote
(85 s vs 14,4 s para 200) y el peso de Chromium es **+734 MB en el worker**, no 1,4 GB en la app. Su
tercer argumento (superficie SSRF) es válido y se paga con la mitigación verificada de §3.2. En contra,
además: no reusa markup con email ni con la vista web, y el §B del doc 07 documenta seis limitaciones de
CSS y tipografía que hay que rodear —justo lo que más cuesta cuando el criterio es "que se vea
impecable, rápido".

### 12.2. `pdfkit` / `pdf-lib` imperativos

`pdfkit` fue el **más rápido de la familia TypeScript** (177 ms, contra 385 de `@react-pdf/renderer`
sobre el mismo contenido: la diferencia es React + Yoga). Aun así queda 4,5× por detrás de Chromium en
lote, y el layout se programa a mano: cada columna, cada salto de página y cada corte de texto es
código. Con un documento que cambia de marca, de bloque de pago y de idioma visual por cliente, eso es
exactamente lo que no queremos escribir a mano. `pdf-lib` **sí se usa**, pero para lo que es bueno:
partir el PDF del lote en un archivo por unidad (33 ms por boleta, medido).

### 12.3. Motor tipográfico externo (Typst, WeasyPrint, wkhtmltopdf)

- **wkhtmltopdf:** descartado. Proyecto archivado, WebKit congelado hace más de una década, sin flexbox
  ni grid. Elegirlo es heredar un motor sin mantenimiento para un documento que va a durar años.
- **WeasyPrint:** buen soporte de CSS de impresión, pero es **Python**. Mete un segundo runtime en la
  imagen del worker, en el CI y en el `docker-compose`, para un equipo y un repo que son TypeScript de
  punta a punta (ADR-0000 §2). El costo de operación supera lo que aporta sobre Chromium.
- **Typst:** el más interesante de los tres — binario estático (~30 MB, un orden de magnitud menos que
  Chromium), tipografía excelente y muy rápido. Se descarta por una razón puntual: **es otro lenguaje de
  plantillas**, así que no da la plantilla única para email HTML y vista web, que es el requisito que
  ordena toda esta decisión. Si algún día el volumen creciera a decenas de miles de documentos y el
  reuso con email/web dejara de importar, Typst es el candidato natural a reevaluar — detrás del mismo
  `GeneradorDocumento`.

### 12.4. Servicio de terceros (DocRaptor, PDFMonkey, Api2Pdf y equivalentes)

**Descartado.** Y conviene ser preciso sobre qué regla rompe, porque la primera que viene a la cabeza no
es la correcta:

- **NO es la regla del ADR-0000 §3** ("ningún servicio de negocio llama directo a un SDK propietario").
  Esa se cumpliría poniendo el SDK detrás de `GeneradorDocumento`, igual que cualquier otro adapter.
- **Rompe el ADR-0000 §7, la portabilidad de despliegue.** La tabla de §7 exige que el sistema corra
  igual en AWS, en Vercel+Supabase y **self-hosted**, cambiando sólo configuración. Un servicio de
  terceros **no tiene fila self-hosted**: sin internet y sin cuenta, no hay boleta. Deja de ser un
  adapter intercambiable para pasar a ser una dependencia dura de la que el producto no puede salir.
- **Rompe la regla de datos personales** (`CLAUDE.md` §1.3 y doc 07 §F). Emitir por un tercero significa
  mandarle, todos los meses, el nombre del obligado, su unidad y su deuda de **todos los residentes de
  todos los barrios**. Eso exige un acuerdo de tratamiento de datos por cliente y contradice el mínimo
  de §F ("del PDF sale sólo el mínimo").
- **Costo variable sobre un volumen que crece con las ventas**, para reemplazar 150 líneas de adapter y
  una imagen de contenedor.

Se descarta también cualquier variante de "servicio propio de PDF as-a-service" externo al repo: es el
mismo worker, con más piezas móviles.

---

## 13. A confirmar (abierto — no inventado)

- **Especificación del convenio de cobranza del primer cliente** (los seis puntos de §10). Hasta
  entonces, `generico-demo` y marca de agua.
- **Quién asigna el número de boleta** — sistema o banco (`docs/diseno/09-boleta-de-expensas.md`). Si lo
  asigna el banco, el `MedioCobranza` necesita un método asíncrono de reserva de numeración y el bloque
  de pago deja de ser puro; la interfaz de §4.4 habría que ampliarla con un paso previo de
  `reservarNumeracion()`.
- **Versión exacta de Chromium** a fijar en la imagen del worker, y su política de actualización: subir
  de versión puede reflowear documentos futuros (los emitidos no se regeneran, así que no los afecta —
  §6). Se persiste en `documento_liquidacion.motor`.
- **Retención de los PDFs**: plazo a definir por `legal-ph` / `contador` con fuente (doc 07 §G.2).
  Mientras tanto, no purgar.
- **Endpoint del PDF para `propietario` / `residente`**: sigue **cerrado** hasta que exista el vínculo
  usuario → unidad funcional (doc 07 §F, último párrafo). Este ADR no lo abre.
- **Dónde vive el worker en cada hosting** (ECS task, contenedor en el VPS, máquina dedicada): depende
  del hosting, que sigue abierto en el ADR-0000 §10. El ADR es válido para los tres; lo que cambia es
  quién ejecuta la imagen.

---

_Ver también `docs/arquitectura/00-stack-infra.md` (ADR-0000: stack, abstracciones y portabilidad),
`docs/diseno/07-liquidacion-pdf.md` (estructura del documento, seguridad y lenguaje — vigente salvo §A),
`docs/diseno/09-boleta-de-expensas.md` (qué trae la boleta real) y
`docs/devops/03-reglas-desarrollo-optimizado.md` (presupuesto de recursos)._
