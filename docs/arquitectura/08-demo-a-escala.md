# ADR-0008 — La demo a escala real: datos, saldo arrastrado, hora del barrio y gate de volumen

- **Estado:** aceptado (implementado 2026-11-02, encargo T4).
- **Alcance:** BL-004 (datos de la demo), BL-010 (zona horaria), BL-016 (volumen), BL-020 (b) (cupón).
- **Migraciones:** `0060_importe_exigible_liquidacion`, `0061_zona_horaria_barrio`.
- **Se encadena con:** ADR-0006 (mora configurable), ADR-0007 (código de pago), ADR-0005 de
  aclade-cobranzas (gate de volumen).

---

## 1. Los datos de la demo (BL-004)

`pnpm db:seed` siembra una administración inventada («Estudio Demo — Administración») con cuatro
barrios inventados, unas 2.000 UF:

| Barrio         | Figura           | Modelo      | UF  | Medio de cobro   | Para mostrar                                   |
|----------------|------------------|-------------|-----|------------------|------------------------------------------------|
| Los Aromos     | Asociación civil | coeficiente | 460 | genérico de demo | tasa propia (2,5 %); un período en borrador    |
| Las Cortaderas | Asociación civil | coeficiente | 340 | transferencia-QR | «No se cobra» interés                          |
| Los Talas      | S.A.             | cuota fija  | 700 | transferencia-QR | el paginado (> 500) y la evolución de la cuota |
| El Algarrobal  | S.A.             | cuota fija  | 500 | genérico de demo | la tasa general y el cambio programado         |

- **Nada del piloto.** Manzanas y lotes se generan por código (manzanas de 10 a 33 lotes, una de cada
  cuatro con huecos); se sacó la traza real de 510 lotes que tenía Los Talas. Nombres, documentos y
  correos (`@ejemplo.test`) salen de un generador con **semilla fija**: dos corridas dan la misma demo.
- **Un mes completo y el anterior.** El mes anterior, emitido y cobrado: ~84 % en término, ~9 % fuera
  de término, ~7 % impagos. El mes actual, emitido, con el saldo de los impagos arrastrado y su
  interés. En cuota fija el "mes actual" es el mes en curso (se cobra dentro del mes); al prorratear es
  el mes que terminó (se liquida después de cerrar). Las fechas son relativas al mes en curso.
- **Por el camino real.** Liquidaciones y emisiones con los servicios de la aplicación; los pagos se
  registran como `extracto` y se imputan con `app.resolver_imputacion`, la misma función de la
  pantalla. La firma de emisión se lleva al 1° del mes en que vence (puerta de mantenimiento, solo en
  el seed) para que el estado de cuenta se lea en orden.
- **La limpieza lee el catálogo** (toda tabla con `barrio_id`) en vez de una lista a mano, que se
  quedaba atrás con cada tabla nueva.
- **Los tests ya no vacían la demo.** Cuatro borrados sin `where` en `documentos-rls`,
  `distribucion-rls` y `tenancy-rls` (boletas emitidas, trabajos, paquetes, excepciones de tenancía
  y períodos de ciertos meses de **todos** los barrios) quedaron acotados a los barrios del fixture.

## 2. El saldo anterior que sale de la cuenta corriente no se cobra dos veces (`0060`)

El seed es el primer lugar que arrastra el saldo **desde la cuenta corriente** (`saldo_uf`) y no
tipeado a mano. Ahí apareció un defecto de modelo: `liquidacion.total` es lo que la boleta dice "a
pagar" (período + saldo anterior + interés), y la cuenta corriente debitaba ese total. Si el saldo
anterior ya era un débito —la liquidación vieja sin pagar—, la unidad que no pagó un mes aparecía
debiendo **el doble**.

**Decisión:** `liquidacion.importe_exigible`, columna generada: el `total` menos el saldo anterior
**cuando su origen es `calculado`** (el valor que `0040` había dejado previsto y nadie escribía). Con
cualquier otro origen es igual al total, así que **ninguna fila existente cambia**. Lo usan los cuatro
lugares que tratan una liquidación como deuda: la vista del estado de cuenta, el débito al emitir, el
tope de una imputación y la imputación automática. Lo impreso y lo enviado sigue siendo el `total`.
Pagar el total de la boleta reparte el pago entre la liquidación vieja y la nueva y deja la unidad en
cero (test `importe-exigible.test.ts`).

`generarLiquidaciones` recibe `origenSaldo` (`carga_manual` por defecto, o `calculado`) **solo por
parámetro de script**: el formulario sigue sin ofrecer el saldo. Con `calculado` **el saldo lo lee el
propio servicio** de `saldo_uf`, en la misma transacción, y rechaza uno que venga de afuera: un
valor que no coincidiera con la deuda real dejaría plata impresa sin débito (security-engineer). Que
la pantalla "Generar el borrador" arrastre el saldo sola es el próximo paso del módulo de cobros, no
de esta tanda.

La **exportación al contador** compara cada imputación contra lo exigible para decir «Cubre la
boleta completa» (el tope de imputación es ése); la columna del total sigue siendo lo impreso.

**Lo que no hace todavía:** cobrar interés por un pago **fuera de término** que canceló todo (el
interés se calcula sobre el saldo al corte), ni distinguir días de atraso por unidad (son por período).

## 3. La hora del barrio (BL-010, `0061`)

`barrio.zona_horaria` (IANA, validada contra el catálogo de la base; inicial
`America/Argentina/Buenos_Aires`, la hora oficial de la jurisdicción del producto, no la del piloto;
cerrada para `app_request` como el formato del código de pago). **Un solo helper**:
`app.en_hora_del_barrio(instante, barrio)` → `YYYY-MM-DD HH24:MI`, que imprime `formatearFechaHora`.
Lo usan documentos, recibos, órdenes de pago (lista y detalle) y el paquete de distribución, que
dejó de decir «UTC». No depende del `TimeZone` de la sesión (test `hora-del-barrio.test.ts`).

## 4. El tablero muestra la cobranza

Panel «Cobranza»: unidades con **deuda vencida** (liquidaciones emitidas con primer vencimiento
anterior a hoy en la hora del barrio, menos lo imputado; usa `importe_exigible`; más la deuda traída
a mano —`carga_manual`—, que está vencida desde que se cargó aunque viaje en una boleta que todavía
no venció) y el **saldo
pendiente total**, que además incluye la boleta que todavía no venció. Nunca «morosos»: se cuentan
unidades, no personas (ux-designer). El saldo sale de `resumirSaldosPendientes`, el mismo helper que
la pantalla de Cobros, que además dejó de contar un saldo a favor como deuda.

## 5. El cupón de `generico-demo` (BL-020 b)

La nota de «Pago electrónico» pasa a «Solo para LINK y Pago Mis Cuentas». Sin renglones nuevos: el
vecino que transfiere queda con un solo candidato, el «Código de pago», cuya nota ya dice dónde va
(ux-designer). Si más adelante se quiere precisar «referencia» en vez de «concepto», va en los dos
adapters, este ADR y ADR-0007 a la vez.

## 6. El gate de volumen (BL-016)

Paso propio, `pnpm test:volumen` (proyecto `volumen`): un proceso, un archivo por vez, después de los
tests de base; en CI con el Chromium del runner. Escenario propio de 700 UF (no depende del seed).
Topes en un solo archivo, `tests/volumen/topes.ts`, sacados de 3 corridas con margen; tiempos en
`docs/devops/04-tiempos-del-gate.md`.

- Liquidación de 700 UF; emisión del período; las cuatro lecturas de la pantalla del período; las 700
  boletas en PDF por el camino del worker (`emitirDocumentosDelPeriodo`, lotes de 50), con el pico de
  memoria del proceso.
- **Lo que encontró:** generar el borrador de 700 UF tardaba **30 s**, porque insertaba fila por fila
  (tres consultas por unidad más una por línea). Ahora van todas las liquidaciones en una sentencia y
  todas las líneas en otra: **~7 s**, con los mismos valores (los tests de plata no cambiaron un
  resultado esperado) y el seed bajó de 4:53 a 1:17.
