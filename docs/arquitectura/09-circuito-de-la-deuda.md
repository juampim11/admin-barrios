# ADR-0009 — El circuito de la deuda: saldo arrastrado, interés por pago fuera de término y condonación

- **Estado:** aceptado (implementado 2026-11-03, encargo 5, BL-021).
- **Migraciones:** `0062_interes_devengado`, `0063_interes_devengado_permisos`.
- **Se encadena con:** ADR-0006 (parámetros de mora de T1: el motor de interés es el mismo), ADR-0008
  (saldo calculado e `importe_exigible`).
- **Panel:** `legal-ph` y `contador` (ninguna objeción que obligue a elegir; ver §7), `security-engineer`
  y `code-reviewer`.

---

## 1. El modelo

| Qué | Dónde | En la cuenta corriente |
|---|---|---|
| **Capital**: lo que cada liquidación suma a la deuda | `liquidacion.importe_exigible` | débito al emitir |
| **Interés**: el del capital pendiente de UNA liquidación en un tramo | `interes_devengado` | débito al registrarse |
| Pago a capital | `pago_imputacion` | crédito |
| Pago a interés | `pago_imputacion_interes` | crédito |
| **Condonación** de interés devengado y no pagado | `interes_condonacion` | crédito |

Todo es append-only (las imputaciones se anulan con motivo, como antes; el interés y la condonación no
se editan ni se borran). La boleta sigue imprimiendo el `total` (período + saldo anterior + interés);
con saldo arrastrado, `importe_exigible` excluye saldo anterior e interés, porque los dos ya son deuda
(la liquidación vieja y `interes_devengado`): nada se cuenta dos veces.

## 2. Los tramos

El capital de una liquidación devenga desde su vencimiento. Cada **hecho** cierra un tramo —el interés
del capital pendiente desde donde quedó el tramo anterior hasta la fecha del hecho—:

- un **pago que llega tarde** (se registra al imputarlo, con la fecha del pago);
- el **corte de la boleta siguiente** (se calcula al generar el borrador y se registra al emitir).

Reglas (`@admin-barrios/shared/interes-pago-tardio`, sobre `calcularInteresMora` de T1, día por día con
la tasa y el «cobra» de cada día):

- **Solo el primer tramo cuenta la gracia**, como en T1: con «corre el inicio» los días de gracia no
  devengan; con «escalón», pasada la gracia devengan todos. Un tramo que da cero por gracia no se
  registra y no mueve el inicio.
- **«No se cobra»**: no devenga y no registra nada.
- **Tolerancia**: la de T1 (un saldo menor o igual no devenga) y además, si el interés de un tramo es
  **menor** que la tolerancia, no se cobra — pero queda registrado como «no cobrado por tolerancia» y el
  tramo se cierra (`legal-ph`: lo que no se cobra no desaparece sin rastro).
- **El interés no devenga interés**: solo el capital tiene tramos (decisión de producto; el art. 770
  CCyC no está cargado en `knowledge/`).
- **Nada se recalcula hacia atrás**: la base exige que un tramo empiece donde terminó el anterior y que
  su base sea el capital pendiente de ese momento. Un pago con fecha anterior al último tramo no genera
  interés; no se reabre ni se reimputa nada.

Propiedades (fast-check, 1.000 casos cada una): nunca negativo, cero dentro de la gracia, monótono en
los días, interés + capital + sobrante = pago, y **paridad con T1** cuando el pago cubre todo desde el
vencimiento.

## 3. La imputación

`app.resolver_imputacion` hace dos pasadas en el orden del barrio vigente a la fecha del pago:
**«Intereses primero»** cubre el interés pendiente (el más antiguo primero) y después el capital;
**«Capital primero»** al revés. Sin filas de interés resuelve exactamente igual que antes (los 627
tests de base existentes pasan sin cambios).

**Registrar un pago lo imputa** en el mismo acto (antes la aplicación no imputaba). Si llega fuera de
término, la primera vez no se escribe nada: se muestra el interés, los días y cómo se reparte, y se
confirma. `resolverImputacionAutomatica` pasa por el mismo camino.

## 4. La boleta siguiente

«Generar el borrador» (pantalla y seed, el mismo código) arrastra desde la cuenta corriente a la fecha
de corte (hoy en la hora del barrio, o la que se pase): **saldo anterior = capital pendiente**;
**interés por mora = interés pendiente + el de cada tramo de capital impago hasta el corte**. El
desglose queda en `parametros_mora.arrastre` y la revisión lo muestra. Al emitir se recalcula: si algo
cambió desde el borrador (un pago, una imputación, una condonación), no se emite
(`borrador_desactualizado`); si coincide, se registran los tramos al corte.

## 5. La condonación

- **Un solo mecanismo**, `interes_condonacion`, total o parcial, sobre interés devengado y no pagado.
  Motivo obligatorio (Negociación / Condonación de la comisión o asamblea / Error / Otro) más un texto
  de al menos 10 caracteres; respaldo opcional con el mismo componente que el de la tasa (tipo,
  referencia y adjunto). Queda registrado **con qué rol** se condonó (`legal-ph`: el operador del
  software no es un órgano del barrio).
- Dos puertas: **«No cobrar interés de este pago»** al registrar un pago tardío (condona entero lo que
  ese pago devengó; la imputación queda igual que si el interés fuera cero) y **«Condonar»** desde el
  estado de cuenta de la unidad (con confirmación que dice el importe).
- Solo `admin_barrio` y `admin_plataforma`; los demás lo ven sin botones. Lo decide el trigger.
- No se condona lo pagado: el tope es lo pendiente. Lo condonado se ve en el estado de cuenta («Interés
  condonado»), en la revisión y en el total de «Interés condonado» por barrio y mes (en la hora del
  barrio). Condonar no toca ninguna liquidación emitida: compensa la deuda, no la boleta.

## 6. Días de atraso

Por unidad: del vencimiento impago más antiguo a hoy, en la hora del barrio. En el estado de cuenta y en
el panel «Cobranza» (mayor atraso y unidades por tramo: hasta 30, 31-60, 61-90, más de 90).

## 7. Panel de dominio

- **`legal-ph`**: sin objeciones que obliguen a elegir. Faltan en `knowledge/` los arts. 768-771, 886 y
  900-903 CCyC y la remisión de deuda: todo lo de este ADR es decisión de producto. Observaciones
  adoptadas: registrar lo no cobrado por tolerancia, sugerir acta con el motivo «comisión o asamblea»,
  registrar el rol de quien condona. **Pendiente**: exigir respaldo para condonar, configurable por
  barrio.
- **`contador`**: sin objeciones; alcanza con documentar. Condición mínima adoptada: en la exportación,
  lo imputado a interés va en filas propias («Interés por mora»), no mezclado con el capital ni como «a
  cuenta». **Pendiente**: una hoja de condonaciones en la exportación (gatillo: cuando el contador del
  barrio lo pida o se cargue el tratamiento fiscal en `knowledge/`).

## 8. Ejemplo (inventado)

Boleta de **$ 100.000** que vence el **10/10**. Tasa 3 % mensual, sin punitoria, 5 días de gracia «corre
el inicio», tolerancia $ 100. El vecino paga **$ 100.000 el 30/10** (20 días tarde): devengan 15 días →
100.000 × 0,03 × 15/30 = **$ 1.500**.

| | Intereses primero | Capital primero |
|---|---|---|
| Imputación del pago | $ 1.500 a interés, $ 98.500 a capital | $ 100.000 a capital, $ 0 a interés |
| Queda debiendo | $ 1.500 de capital | $ 1.500 de interés |
| Boleta siguiente (corte 01/11) | saldo anterior $ 1.500; interés de esos $ 1.500 del 30/10 al 01/11 = $ 3,00, menor que la tolerancia: **no se cobra** (queda registrado) | saldo anterior $ 0; **interés por mora $ 1.500** |

Con **condonación parcial** (capital primero): la administración condona $ 900 desde el estado de cuenta
→ la unidad debe $ 600 de interés y la boleta siguiente dice interés por mora **$ 600**; la revisión
muestra «Interés condonado: $ 900». Con «No cobrar interés de este pago» al registrar: los $ 1.500 se
registran y se condonan en el acto, el pago va entero a capital y la unidad queda en cero (en los dos
órdenes).

## 9. Revisiones y límites conocidos

**Aplicado** (`security-engineer`, `code-reviewer`): un tramo no termina en una fecha futura y un pago
con fecha futura no se registra (`0064`); cada tramo guarda con qué se calculó; `capital_pendiente` e
`interes_pendiente` con la RLS de quien consulta; lo imputado por un pago anulado no cuenta como
interés pagado; «Generar el borrador» sin fecha de corte guarda el corte que usó (era un bloqueante:
la pantalla no podía generar con interés); un tramo que redondea a $ 0,00 no se registra; la emisión
debita solo los tramos de unidades con boleta en el período; la boleta dice «Incluye interés» (no «Al
día») cuando cobra interés sin capital atrasado, y con arrastre imprime «$ X pendiente de antes + $ Y al
corte»; la casilla «No cobrar interés» recuerda su estado al volver con un error.

**Límites conocidos, anotados y no resueltos en esta tanda:**
- La **tolerancia** corta por liquidación y por tramo, no por unidad: diez boletas chicas pueden no
  devengar nunca, y con pagos parciales frecuentes cada tramo puede quedar por debajo. Es la regla
  decidida; si en la operación real molesta, se aplica al total de la unidad.
- **Dos pagos simultáneos** de la misma unidad: el segundo choca con el encadenamiento de tramos y sale
  como error genérico; reintentar alcanza.
- La **imputación manual línea por línea** (`imputarPago`) no registra el tramo antes de imputar. No la
  usa ninguna pantalla.
- **Anular un pago** no anula sus imputaciones (decisión de siempre); no hay todavía una acción para
  anular una imputación a interés.
- La confirmación del pago tardío **no queda atada** a las cifras mostradas: si algo cambia entre la
  pantalla y la confirmación, se imputa con lo de ese momento.
- Una base local con liquidaciones `calculado` emitidas **antes de `0062`** (la demo de T4) queda
  descuadrada: hay que volver a sembrar. En producción no había ninguna.
