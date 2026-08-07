# Preguntas para la administración (Las Corzuelas — Diego Galizzi)

> Lista para llevar o mandar tal cual. Son cosas que **no se pueden deducir mirando una boleta** y que
> definen cuánto tiene que hacer nuestro sistema. Cuanto antes se sepan, menos se rehace.

> ### ⚠ El bloque 1 ya NO frena el diseño del PDF *(decisión del usuario, 2026-08-05)*
>
> Este documento decía que el bloque 1 "frena el diseño del PDF". **Dejó de ser cierto**, y no porque
> se hayan contestado las preguntas: porque se decidió que **la demo no replica la boleta de Diego**.
>
> > *"No tiene que ser la boleta de Diego, porque hay info que no tenemos. Lo que le presentemos tiene
> > que demostrar la capacidad de adaptarse al sistema de cobro que se tenga (o que se vaya a
> > incorporar). (…) no tiene que replicar algo, para una demo, que no tenemos detalles de la
> > operatoria, generación de código de barras, proceso de Roela, etc."*
>
> Las preguntas de abajo **siguen valiendo para el producto** —el día que haya que emitir un código
> real hacen falta igual— pero hoy no bloquean nada. Ver `relevamiento-liquidacion.md` §9.7.1.

---

## Bloque 1 — Cobranza y el instrumento de pago (para el producto, ya no para la demo)

1. **El código de barras de la boleta, ¿lo arma el sistema de la administración o lo devuelve el
   banco?** Es decir: ¿ustedes le mandan a Roela un archivo con las unidades y los importes y él
   devuelve las boletas o los códigos, o el sistema los genera solo contra el convenio?
2. Si lo genera el sistema: **¿tienen el instructivo técnico del convenio SIRO?** (el que define el
   formato del código y el dígito verificador). Sin ese papel no se puede emitir un código válido.
3. **¿Quién asigna el número de boleta?** ¿Es un correlativo del sistema, o lo da el banco? ¿Es único
   por barrio o compartido entre todos los barrios que administran?
4. **¿Qué pasa si hay que reimprimir una boleta ya emitida?** ¿Se reusa el mismo número o se emite
   uno nuevo? ¿Y si hay que anularla y rehacerla porque tenía un error?
5. **¿Qué otros medios de cobro usan además de la red de cobranza?** Transferencia, débito
   automático, efectivo en la administración, alguna billetera. ¿Y cómo se enteran de que alguien
   pagó por cada uno?
6. **¿Cómo llega hoy la boleta al vecino?** Email, WhatsApp, papel, un portal. ¿Y quién la manda?

## Bloque 2 — La boleta y la operatoria del mes

7. **La "Fecha Tope" tiene el mismo importe que el vencimiento y el interés se cobra recién en la
   boleta del mes siguiente.** ¿Es la política del barrio, o una limitación del sistema actual?
   ¿Querrían un segundo vencimiento con recargo?
   > **Lo que le toca al sistema ya está decidido** *(usuario, 2026-08-05)*: el modelo son **dos
   > fechas configurables**, primer y segundo vencimiento, y se van al **concepto** en vez de copiar
   > el vocabulario del papel actual. *"Por más que al 2do vencimiento no haya intereses"* — que un
   > barrio no cobre recargo en la segunda es **su política**, no la ausencia de la fecha. La
   > pregunta sigue en pie para saber qué querría Diego, pero ya no condiciona el modelo.
8. **La bonificación al cumplidor**: ¿cómo se decide el monto cada mes, quién lo define y con qué
   criterio se determina que un vecino la merece? ¿Se revisa uno por uno o sale de un listado?
9. **¿A nombre de quién se emite la boleta cuando la unidad está alquilada?** Hoy dice "Inquilino /
   Propietario" a la vez. ¿Quién la recibe y quién la paga? ¿Cambia según el contrato?
10. **¿Qué le preguntan más los vecinos cuando reciben la boleta?** Es la mejor guía para saber qué
    tiene que decir y qué está faltando.
11. **¿Muestran la deuda anterior en la boleta?** Hoy no aparece: solo la leyenda de que el pago no
    libera deudas anteriores. ¿Es a propósito?

## Bloque 3 — Para dimensionar el sistema (no urgente)

12. **¿Cuántos barrios administran y cuántas unidades tiene cada uno?**
13. **¿Qué sistema usan hoy y qué es lo que más les molesta de él?** ¿Qué cosa hacen a mano o en
    Excel porque el sistema no la resuelve?
14. **¿Cuántas personas de la administración lo usan y con qué rol?** ¿Hay alguien que solo carga y
    alguien que autoriza?
15. **¿Guardan las boletas emitidas, o se regeneran cuando hace falta?** ¿Alguna vez tuvieron que
    mostrar una boleta de hace dos años?
16. **¿Qué pasa a fin de año?** ¿Rinden cuentas a asamblea con un informe del sistema, o se arma
    aparte?

## Bloque 4 — La cuota fija, y cómo se decide (salió del panel del 2026-08-04)

> El barrio piloto **no prorratea por coeficiente: cobra una cuota fija, igual para todas las
> unidades**. Eso es un modelo distinto del que se venía mostrando, y estas cuatro respuestas cambian
> qué tiene que pedir la pantalla.

17. **¿La cuota es exactamente la misma para todas las unidades?** *"Igual para todos" casi nunca es
    literal: ¿el lote baldío, el que está en construcción y las unidades del desarrollador pagan lo
    mismo? Si hay dos o tres categorías, la pantalla tiene que pedir **categorías**, no ciento diez
    números sueltos.*
18. **¿Cada cuánto se cambia la cuota, qué órgano la aprueba y qué papel la respalda?** Las dos
    boletas reales que tenemos dan $360.500 en 03/2026 y $372.000 en 04/2026: **+3,2 % en un mes**. Si
    cambiar la cuota cuesta reescribir ciento diez filas, la administración vuelve al Excel el segundo
    mes. Y el día que un vecino discuta el aumento, le van a pedir el acta: por eso ninguna versión de
    cuota debería poder existir sin **órgano que la aprobó** e **instrumento adjunto**.
19. **Cuando el gasto del mes supera lo recaudado, ¿qué hacen?** ¿Lo absorbe el excedente o el fondo,
    se ajusta la cuota del mes siguiente, o sale una extraordinaria? *(Usar una extraordinaria para
    tapar déficit operativo corriente es la práctica que después se discute; queremos saber si pasa.)*
    ¿Y si sobra sistemáticamente, qué se hace con el excedente?
20. **¿Calculan hoy el resultado del período** —lo que se esperaba recaudar contra lo que se devengó
    de gasto—? El informe mensual actual **no lo trae**, y en un barrio de cuota fija es *el* número.
